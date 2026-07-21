"""
JV-60FPS Server
Detects input FPS, applies -itsscale to make output 60fps
POST /patch — multipart: field "video" (mp4)
Returns patched mp4 with unique file ID
"""

import os, subprocess, tempfile, uuid, json
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)
MAX_SIZE = 500 * 1024 * 1024  # 500MB

def get_fps(path):
    """Detect FPS using ffprobe"""
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=r_frame_rate',
            '-of', 'json',
            path
        ], capture_output=True, text=True, timeout=30)
        data = json.loads(result.stdout)
        rate = data['streams'][0]['r_frame_rate']  # e.g. "30/1" or "60000/1001"
        num, den = rate.split('/')
        fps = round(int(num) / int(den), 4)
        return fps
    except Exception as e:
        print(f'[FPS detect error] {e}')
        return None

def patch_to_60fps(input_path, output_path, original_fps):
    """
    Same method as the extension:
    ffmpeg -itsscale (originalFps/60) -i input -c copy output
    """
    target_fps  = 60
    itsscale    = round(original_fps / target_fps, 4)

    result = subprocess.run([
        'ffmpeg', '-y',
        '-itsscale', str(itsscale),
        '-i', input_path,
        '-c', 'copy',
        output_path
    ], capture_output=True, text=True, timeout=600)

    return result.returncode == 0, result.stderr

# ── CORS ──
@app.after_request
def cors(r):
    r.headers['Access-Control-Allow-Origin']  = '*'
    r.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    r.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return r

@app.route('/', methods=['GET'])
def index():
    return jsonify({"status": "ok", "service": "JV-60FPS Server"})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"})

@app.route('/patch', methods=['OPTIONS'])
def patch_options():
    return '', 204

@app.route('/patch', methods=['POST'])
def patch():
    f = request.files.get('video') or request.files.get('file')
    if not f:
        return jsonify({"error": "No video field"}), 400

    raw = f.read()
    if not raw:
        return jsonify({"error": "Empty file"}), 400
    if len(raw) > MAX_SIZE:
        return jsonify({"error": "File too large (max 500MB)"}), 413

    # Write input to temp file
    tmp_in  = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    tmp_in.write(raw)
    tmp_in.flush()
    tmp_in.close()
    in_path = tmp_in.name

    file_id  = uuid.uuid4().hex
    out_path = in_path + '_out_' + file_id + '.mp4'

    try:
        # Step 1: detect FPS
        fps = get_fps(in_path)
        if fps is None or fps <= 0:
            return jsonify({"error": "Could not detect FPS — make sure it is a valid MP4"}), 422

        # Step 2: if already 60fps just return with new unique ID
        if abs(fps - 60) < 0.5:
            out_path = in_path  # use input as output
            file_id  = uuid.uuid4().hex
        else:
            # Step 3: patch using itsscale
            ok, stderr = patch_to_60fps(in_path, out_path, fps)
            if not ok:
                print(f'[FFmpeg error] {stderr}')
                return jsonify({"error": "FFmpeg failed — " + stderr[-200:]}), 500

        out_name = 'jv_' + file_id + '.mp4'

        response = send_file(
            out_path,
            mimetype='video/mp4',
            as_attachment=True,
            download_name=out_name
        )
        response.headers['X-File-Id']       = file_id
        response.headers['X-Original-Fps']  = str(fps)
        response.headers['X-Target-Fps']    = '60'
        return response

    finally:
        # Cleanup temp files
        for p in [in_path, out_path]:
            if p and p != in_path and os.path.exists(p):
                try: os.remove(p)
                except: pass
        if os.path.exists(in_path):
            try: os.remove(in_path)
            except: pass

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
