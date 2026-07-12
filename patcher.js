const FAKE_SAMPLE = Buffer.from([0, 0, 0, 4, 0, 0, 0, 0]);
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst"]);

function u32(buf, offset) { return buf.readUInt32BE(offset); }
function u64(buf, offset) { return Number(buf.readBigUInt64BE(offset)); }
function w32(val) { const b = Buffer.alloc(4); b.writeUInt32BE(val >>> 0, 0); return b; }
function box(type, payload) { return Buffer.concat([w32(payload.length + 8), Buffer.from(type, "latin1"), payload]); }
function boxType(buf, offset) { return buf.toString("latin1", offset + 4, offset + 8); }

function sizeAt(buf, offset, end) { 
  if (offset + 8 > end) return 0; 
  const s = u32(buf, offset); 
  if (s === 1) { if (offset + 16 > end) return 0; return u64(buf, offset + 8); } 
  if (s === 0) return end - offset; 
  return s; 
}

function parseBoxes(buf, start, end) { 
  const boxes = []; 
  let offset = start; 
  while (offset + 8 <= end) { 
    const size = sizeAt(buf, offset, end); 
    if (!size || offset + size > end) break; 
    const type = boxType(buf, offset); 
    const header = u32(buf, offset) === 1 ? 16 : 8; 
    const item = { type, start: offset, end: offset + size, size, header, children: null }; 
    let cStart = offset + header; 
    if (type === "meta") cStart += 4; 
    if (CONTAINERS.has(type) && cStart < offset + size) item.children = parseBoxes(buf, cStart, offset + size); 
    boxes.push(item); 
    offset += size; 
  } 
  return boxes; 
}

function raw(buf, node) { return buf.subarray(node.start, node.end); }
function payload(buf, node) { return buf.subarray(node.start + node.header, node.end); }
function findChild(node, type) { return (node.children || []).find(c => c.type === type); }
function childPath(node, path) { let cur = node; for (const t of path) { cur = findChild(cur, t); if (!cur) return null; } return cur; }
function isVideoTrak(buf, node) { const h = childPath(node, ["mdia", "hdlr"]); return Boolean(h && payload(buf, h).toString("latin1", 8, 12) === "vide"); }
function findStbl(node) { return childPath(node, ["mdia", "minf", "stbl"]); }
function stszInfo(buf, node) { const p = payload(buf, node); return { sampleSize: u32(p, 4), count: u32(p, 8) }; }

function patchMdhdLang(buf, node) { 
  const p = Buffer.from(payload(buf, node)); 
  const v = p[0]; 
  const offset = v === 1 ? 28 : 16; 
  if (offset + 2 <= p.length) p.writeUInt16BE(21956, offset); 
  return box("mdhd", p); 
}

function patchHdlrName(buf, node) { 
  const p = Buffer.from(payload(buf, node)); 
  const tag = p.length >= 12 ? p.toString("latin1", 8, 12) : ""; 
  const name = tag === "vide" ? "VideoHandler\0" : tag === "soun" ? "SoundHandler\0" : null; 
  if (!name) return raw(buf, node); 
  return box("hdlr", Buffer.concat([p.subarray(0, 24), Buffer.from(name, "utf8")])); 
}

function patchStsz(buf, node, extra) { 
  if (extra < 1) return raw(buf, node); 
  const p = payload(buf, node); 
  const flags = p.subarray(0, 4); 
  const fixedSize = u32(p, 4); 
  const count = u32(p, 8); 
  const list = []; 
  if (fixedSize !== 0) { for (let i = 0; i < count; i++) list.push(fixedSize); } 
  else { for (let i = 0, off = 12; i < count && off + 4 <= p.length; i++, off += 4) list.push(u32(p, off)); } 
  if (list.length !== count) throw new Error("stsz parse mismatch"); 
  for (let i = 0; i < extra; i++) list.push(8); 
  const outBuf = Buffer.alloc(12 + list.length * 4); 
  flags.copy(outBuf, 0); 
  outBuf.writeUInt32BE(0, 4); 
  outBuf.writeUInt32BE(list.length, 8); 
  list.forEach((sz, i) => outBuf.writeUInt32BE(sz >>> 0, 12 + i * 4)); 
  return box("stsz", outBuf); 
}

function patchStsc(buf, node, extra) { 
  if (extra < 1) return raw(buf, node); 
  const p = payload(buf, node); 
  const flags = p.subarray(0, 4); 
  const count = u32(p, 4); 
  const list = []; 
  for (let i = 0, off = 8; i < count && off + 12 <= p.length; i++, off += 12) { 
    list.push([u32(p, off), u32(p, off + 4), u32(p, off + 8)]); 
  } 
  const sampleIdx = list.length ? list[list.length - 1][2] : 1; 
  list.push([extra + 1, 1, sampleIdx]); 
  const outBuf = Buffer.alloc(8 + list.length * 12); 
  flags.copy(outBuf, 0); 
  outBuf.writeUInt32BE(list.length, 4); 
  list.forEach((row, i) => { 
    outBuf.writeUInt32BE(row[0] >>> 0, 8 + i * 12); 
    outBuf.writeUInt32BE(row[1] >>> 0, 12 + i * 12); 
    outBuf.writeUInt32BE(row[2] >>> 0, 16 + i * 12); 
  }); 
  return box("stsc", outBuf); 
}

function patchStco(buf, node, moovOffset, mdatEnd, extra) { 
  const p = payload(buf, node); 
  const flags = p.subarray(0, 4); 
  const count = u32(p, 4); 
  const list = []; 
  for (let i = 0, off = 8; i < count && off + 4 <= p.length; i++, off += 4) list.push(u32(p, off) + moovOffset); 
  for (let i = 0; i < extra; i++) list.push(mdatEnd); 
  const outBuf = Buffer.alloc(8 + list.length * 4); 
  flags.copy(outBuf, 0); 
  outBuf.writeUInt32BE(list.length, 4); 
  list.forEach((val, i) => outBuf.writeUInt32BE(val >>> 0, 8 + i * 4)); 
  return box("stco", outBuf); 
}

function patchCo64(buf, node, moovOffset, mdatEnd, extra) { 
  const p = payload(buf, node); 
  const flags = p.subarray(0, 4); 
  const count = u32(p, 4); 
  const list = []; 
  for (let i = 0, off = 8; i < count && off + 8 <= p.length; i++, off += 8) list.push(BigInt(u64(p, off) + moovOffset)); 
  for (let i = 0; i < extra; i++) list.push(BigInt(mdatEnd)); 
  const outBuf = Buffer.alloc(8 + list.length * 8); 
  flags.copy(outBuf, 0); 
  outBuf.writeUInt32BE(list.length, 4); 
  list.forEach((val, i) => outBuf.writeBigUInt64BE(val, 8 + i * 8)); 
  return box("co64", outBuf); 
}

async function patchSharkSampleTableMethod(buf) {
  const boxes = parseBoxes(buf, 0, buf.length);
  const moov = boxes.find(b => b.type === "moov");
  const mdat = boxes.find(b => b.type === "mdat");
  
  if (!moov || !mdat) throw new Error("moov/mdat not found");
  if (mdat.header !== 8) throw new Error("64-bit mdat header is not supported");

  const traks = (moov.children || []).filter(b => b.type === "trak");
  const videoTrak = traks.find(t => isVideoTrak(buf, t));
  if (!videoTrak) throw new Error("video track not found");

  const stbl = findStbl(videoTrak);
  if (!stbl) throw new Error("video stbl not found");

  const stsz = findChild(stbl, "stsz");
  const stsc = findChild(stbl, "stsc");
  const stco = findChild(stbl, "stco") || findChild(stbl, "co64");
  if (!stsz || !stsc || !stco) throw new Error("video stsz/stsc/stco was not found");

  const sampleCount = stszInfo(buf, stsz).count;
  const targetCount = Math.floor(sampleCount * 20 / 3);
  const extraSamples = Math.max(0, targetCount - sampleCount);

  let currentTrak = null;

  function patchBox(node, moovOffset, mdatEnd) {
    if (node.type === "udta") return null;
    if (node.type === "mdhd") return patchMdhdLang(buf, node);
    if (node.type === "hdlr") return patchHdlrName(buf, node);
    
    const isVideo = currentTrak === videoTrak;
    if (isVideo && node.type === "stsz") return patchStsz(buf, node, extraSamples);
    if (isVideo && node.type === "stts") return raw(buf, node);
    if (isVideo && node.type === "stsc" && extraSamples > 0) {
      const co = findChild(stbl, "stco") || findChild(stbl, "co64");
      const chunkCount = u32(payload(buf, co), 4);
      return patchStsc(buf, node, chunkCount);
    }
    if (node.type === "stco") return patchStco(buf, node, moovOffset, mdatEnd, extraSamples);
    if (node.type === "co64") return patchCo64(buf, node, moovOffset, mdatEnd, extraSamples);
    
    if (node.children) {
      const parts = [];
      if (node.type === "meta") parts.push(payload(buf, node).subarray(0, 4));
      for (const child of node.children) {
        const prev = currentTrak;
        if (child.type === "trak") currentTrak = child;
        const result = patchBox(child, moovOffset, mdatEnd);
        currentTrak = prev;
        if (result) parts.push(result);
      }
      return box(node.type, Buffer.concat(parts));
    }
    return raw(buf, node);
  }

  function buildMoov(moovOffset, mdatEnd) {
    currentTrak = null;
    return patchBox(moov, moovOffset, mdatEnd);
  }

  let mdatEnd = mdat.end;
  let newMoov = buildMoov(0, mdatEnd);
  let delta = newMoov.length - raw(buf, moov).length;
  
  mdatEnd = mdat.end + delta;
  newMoov = buildMoov(delta, mdatEnd);
  delta = newMoov.length - raw(buf, moov).length;
  
  mdatEnd = mdat.end + delta;
  newMoov = buildMoov(delta, mdatEnd);

  const mdatData = buf.subarray(mdat.start + 8, mdat.end);
  const newMdat = extraSamples > 0 ? Buffer.concat([w32(8 + mdatData.length + 8), Buffer.from("mdat", "latin1"), mdatData, FAKE_SAMPLE]) : raw(buf, mdat);

  const out = [];
  const freeBox = Buffer.concat([w32(8), Buffer.from("free", "latin1")]);
  
  for (const b of boxes) {
    if (b.type === "ftyp") {
      out.push(raw(buf, b));
      out.push(freeBox);
    } else if (b.type === "moov") {
      out.push(newMoov);
    } else if (b.type === "mdat") {
      out.push(newMdat);
    } else if (b.type === "free" || b.type === "wide") {
      continue;
    } else {
      out.push(raw(buf, b));
    }
  }

  return {
    output: Buffer.concat(out)
  };
}

module.exports = { patchSharkSampleTableMethod };
