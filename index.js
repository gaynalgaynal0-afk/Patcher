var TARGET_TS = 60000;
var MAX_BYTES = 100 * 1024 * 1024;

function strToBytes(str) {
  var out = new Uint8Array(str.length);
  for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function makeId() {
  var arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  var hex = '';
  for (var i = 0; i < arr.length; i++) {
    hex += ('0' + arr[i].toString(16)).slice(-2);
  }
  return hex;
}

function indexOf(buf, pattern, start) {
  var plen = pattern.length;
  var limit = buf.length - plen;
  outer: for (var i = start; i <= limit; i++) {
    for (var j = 0; j < plen; j++) {
      if (buf[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function patchAtom(name, buf, targetTs) {
  var view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  var pattern = strToBytes(name);
  var count = 0;
  var start = 0;
  while (true) {
    var found = indexOf(buf, pattern, start);
    if (found === -1) break;
    var h = found - 4;
    if (h < 0 || h + 8 >= buf.length) { start = found + 4; continue; }
    var boxSize = view.getUint32(h, false);
    if (boxSize < 8) { start = found + 4; continue; }
    var ver = buf[h + 8];
    if (ver === 0) {
      var to = h + 20, doff = h + 24;
      if (doff + 4 > buf.length) { start = found + 4; continue; }
      var ots = view.getUint32(to, false);
      var od  = view.getUint32(doff, false);
      if (ots === 0) { start = found + 4; continue; }
      var sc = targetTs / ots;
      view.setUint32(to,   (ots * sc) >>> 0, false);
      view.setUint32(doff, (od  * sc) >>> 0, false);
      count++;
    } else if (ver === 1) {
      var to1 = h + 28, doff1 = h + 32;
      if (doff1 + 8 > buf.length) { start = found + 4; continue; }
      var ots1 = view.getUint32(to1, false);
      var hi   = view.getUint32(doff1,     false);
      var lo   = view.getUint32(doff1 + 4, false);
      var od1  = hi * 4294967296 + lo;
      if (ots1 === 0) { start = found + 4; continue; }
      var sc1  = targetTs / ots1;
      var nts  = (ots1 * sc1) >>> 0;
      var nd   = Math.round(od1 * sc1);
      var nhi  = Math.floor(nd / 4294967296) >>> 0;
      var nlo  = nd >>> 0;
      view.setUint32(to1,      nts, false);
      view.setUint32(doff1,    nhi, false);
      view.setUint32(doff1 + 4,nlo, false);
      count++;
    }
    start = found + 4;
  }
  return count;
}

function patchMp4(raw) {
  var buf  = new Uint8Array(raw.slice(0));
  var n    = patchAtom('mvhd', buf, TARGET_TS) + patchAtom('mdhd', buf, TARGET_TS);
  return { buf: buf, total: n };
}

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

addEventListener('fetch', function(event) {
  event.respondWith(handle(event.request));
});

async function handle(req) {
  var url = new URL(req.url);
  var method = req.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (url.pathname === '/' || url.pathname === '/health') {
    return jsonRes({ status: 'ok', service: 'JV-60FPS Patch Server', timescale: TARGET_TS });
  }

  if (url.pathname === '/patch' && method === 'POST') {
    var form;
    try { form = await req.formData(); }
    catch(e) { return jsonRes({ error: 'Invalid form data' }, 400); }

    var field = form.get('video') || form.get('file');
    if (!field || typeof field === 'string') return jsonRes({ error: 'No video field' }, 400);

    var raw = await field.arrayBuffer();
    if (!raw || raw.byteLength === 0) return jsonRes({ error: 'Empty file' }, 400);
    if (raw.byteLength > MAX_BYTES) return jsonRes({ error: 'File too large (max 100MB)' }, 413);

    var result;
    try { result = patchMp4(raw); }
    catch(e) { return jsonRes({ error: String(e) }, 500); }

    if (result.total === 0) return jsonRes({ error: 'No mvhd/mdhd atoms found' }, 422);

    var id  = makeId();
    var out = 'jv_' + id + '.mp4';

    return new Response(result.buf, {
      status: 200,
      headers: Object.assign({}, CORS, {
        'Content-Type':        'video/mp4',
        'Content-Disposition': 'attachment; filename="' + out + '"',
        'X-File-Id':           id
      })
    });
  }

  return jsonRes({ error: 'Not found' }, 404);
}
