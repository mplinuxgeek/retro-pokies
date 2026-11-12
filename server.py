#!/usr/bin/env python3
"""
Simple HTTP server for Aristocrat MK6 Web Emulator.
Serves static files from web/ and ROM files from roms/ (/roms/<filename>).
Provides /api/roms endpoint listing available ROMs in the roms/ directory.

Game library store (ARISTO_DATA, default data/; one folder per game: data/games/<id>/meta.json plus files such as shot.jpg):
  GET    /api/library                     every game with stored data: {games: {id: {meta, files: [{name, size, mtime}]}}, writable}
  GET    /api/games/<id>                  one game: {meta, files}
  PATCH  /api/games/<id>/meta             merge a JSON object into meta.json (a null value deletes the key)
  GET    /api/games/<id>/files/<name>     a stored file
  PUT    /api/games/<id>/files/<name>     store a file (raw body, at most MAX_FILE bytes, extensions in FILE_TYPES)
  DELETE /api/games/<id>/files/<name>     remove it
  POST   /api/jobs/shots                  start tools/shots.js on the server ({all: redo existing, id: just that game, jobs: parallel ROMs, default SHOT_JOBS or 8})
  GET    /api/jobs/shots                  its progress: {running, started, jobs, total, ok, failed, log, finished, exit}
  POST   /api/jobs/rescan                 ask the scanner service (tools/scan-loop.sh) to rescan now: {id: one game} or {} for every game whose
                                          result came from other code; leaves ARISTO_DATA/rescan-request.json, which the scanner picks up within a minute
  GET    /api/jobs/rescan                 {state: the scanner's scan-state.json (engine, since, phase, at, request), request: still waiting or null}
ARISTO_ROMS=<folder> serves the ROM zips from there instead of roms/.
ARISTO_IMG=<folder> keeps game images (screenshots, banners) in <folder>/<id>/ instead of data/games/<id>/ (the self-hosted image uses the ROM folder's IMG/).
ARISTO_READONLY=1 turns the writes off (403). There is no login: the writes are meant for a trusted LAN.
"""
import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.parse

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT_DIR, 'web')
ROMS_DIR = os.path.abspath(os.environ.get('ARISTO_ROMS') or os.path.join(ROOT_DIR, 'roms'))   # ARISTO_ROMS: folder of ROM zips anywhere (the self-hosted image maps it read-only)
DATA_DIR = os.environ.get('ARISTO_DATA') or os.path.join(ROOT_DIR, 'data')   # writable (docker mounts roms/ read-only)
STATUS_PATH = os.environ.get('ARISTO_STATUS') or os.path.join(DATA_DIR, 'rom-status.json')   # scan results (the scanner writes them)
FB_PATH = os.environ.get('ARISTO_FEEDBACK') or os.path.join(DATA_DIR, 'visual-feedback.json')   # roms/ holds only the ROM zips (and IMG/)
GAMES_DIR = os.path.join(DATA_DIR, 'games')
IMG_DIR = os.environ.get('ARISTO_IMG') or None   # ARISTO_IMG: images (screenshots, banners) in <folder>/<id>/ instead of data/games/<id>/, e.g. the ROM folder's IMG/ (meta.json and notes stay in ARISTO_DATA)
IMAGE_TYPES = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
READONLY = os.environ.get('ARISTO_READONLY') == '1'
RESCAN_REQ = os.path.join(DATA_DIR, 'rescan-request.json')
SCAN_STATE = os.path.join(DATA_DIR, 'scan-state.json')


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None
MAX_FILE = 8 * 1024 * 1024
MAX_META = 64 * 1024
FILE_TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
              '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'}
GAME_ID = re.compile(r'[a-z0-9][a-z0-9-]{0,79}')
FILE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}')
META_LOCK = threading.Lock()


def game_dir(gid):
    if not GAME_ID.fullmatch(gid):
        raise ValueError('bad game id')
    return os.path.join(GAMES_DIR, gid)


def file_path(gid, name):
    if not FILE_NAME.fullmatch(name) or name == 'meta.json' or os.path.splitext(name)[1].lower() not in FILE_TYPES:
        raise ValueError('bad file name')
    if IMG_DIR and os.path.splitext(name)[1].lower() in IMAGE_TYPES:
        return os.path.join(IMG_DIR, gid, name)
    return os.path.join(game_dir(gid), name)


def read_meta(gid):
    try:
        with open(os.path.join(game_dir(gid), 'meta.json'), encoding='utf-8') as f:
            meta = json.load(f)
        return meta if isinstance(meta, dict) else {}
    except (OSError, ValueError):
        return {}


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.replace(tmp, path)


def game_record(gid):
    files = []
    for d in [game_dir(gid)] + ([os.path.join(IMG_DIR, gid)] if IMG_DIR else []):
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            if name != 'meta.json' and not name.endswith('.tmp') and os.path.isfile(full) and not any(f['name'] == name for f in files):
                try:
                    if os.path.realpath(file_path(gid, name)) != os.path.realpath(full):
                        continue   # an image also present in data/games/<id>/ while ARISTO_IMG is set: the copy in ARISTO_IMG is the one served
                except ValueError:
                    continue
                st = os.stat(full)
                files.append({'name': name, 'size': st.st_size, 'mtime': int(st.st_mtime)})
    files.sort(key=lambda f: f['name'])
    return {'meta': read_meta(gid), 'files': files}


class ShotsJob:
    """One server-side screenshot scan at a time: tools/shots.js over roms/, SHOT_JOBS (default 8) ROMs in parallel."""
    def __init__(self):
        self.lock, self.proc, self.state = threading.Lock(), None, {'running': False}

    def start(self, redo_all, jobs, only=None):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                raise RuntimeError('a screenshot scan is already running')
            import subprocess
            env = dict(os.environ, ARISTO_DATA=DATA_DIR, JOBS=str(jobs))
            env.pop('ALL', None)
            env.pop('ONLY', None)
            if redo_all:
                env['ALL'] = '1'
            if only:
                env['ONLY'] = only
            self.proc = subprocess.Popen(['node', os.path.join(ROOT_DIR, 'tools', 'shots.js'), ROMS_DIR], cwd=ROOT_DIR, env=env,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.state = {'running': True, 'started': int(time.time()), 'jobs': jobs, 'only': only, 'total': None, 'ok': 0, 'failed': [], 'log': []}
            threading.Thread(target=self.follow, args=(self.proc, self.state), daemon=True).start()

    def follow(self, proc, st):
        for line in proc.stdout:
            line = line.rstrip()
            st['log'] = (st['log'] + [line])[-40:]
            m = re.match(r'\[shots\] (\d+) ROMs to capture', line)
            if m:
                st['total'] = int(m.group(1))
            elif line.endswith(': ok'):
                st['ok'] += 1
            elif ': failed' in line:
                st['failed'].append(line[len('[shots] '):][:160])
        st.update(running=False, finished=int(time.time()), exit=proc.wait())


SHOTS = ShotsJob()


class AristoHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        # Disable caching for development
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self, limit):
        n = int(self.headers.get('Content-Length') or 0)
        if n > limit:
            raise ValueError('too large (max %d bytes)' % limit)
        return self.rfile.read(n)

    # /api/games/<id>[/meta | /files/<name>] -> (id, kind, name), or None for other paths
    def game_route(self):
        m = re.fullmatch(r'/api/games/([^/]+)(?:/(meta|files)(?:/([^/]+))?)?', urllib.parse.urlparse(self.path).path)
        return (urllib.parse.unquote(m.group(1)), m.group(2), urllib.parse.unquote(m.group(3) or '')) if m else None

    def library_write(self, method):
        r = self.game_route()
        if not r:
            return self.send_error(404)
        if READONLY:
            return self.send_json({'ok': False, 'error': 'read-only server'}, 403)
        gid, kind, name = r
        try:
            if kind == 'meta' and not name and method == 'PATCH':
                patch = json.loads(self.read_body(MAX_META) or b'{}')
                if not isinstance(patch, dict):
                    raise ValueError('meta patch must be a JSON object')
                with META_LOCK:
                    meta = read_meta(gid)
                    for k, v in patch.items():
                        if v is None:
                            meta.pop(k, None)
                        else:
                            meta[str(k)[:64]] = v
                    data = json.dumps(meta, indent=1, sort_keys=True).encode()
                    if len(data) > MAX_META:
                        raise ValueError('meta too large')
                    write_atomic(os.path.join(game_dir(gid), 'meta.json'), data)
                return self.send_json({'ok': True, 'meta': meta})
            if kind == 'files' and name and method == 'PUT':
                write_atomic(file_path(gid, name), self.read_body(MAX_FILE))
                return self.send_json({'ok': True, 'file': next(f for f in game_record(gid)['files'] if f['name'] == name)})
            if kind == 'files' and name and method == 'DELETE':
                path = file_path(gid, name)
                if os.path.isfile(path):
                    os.remove(path)
                return self.send_json({'ok': True})
            self.send_error(405)
        except ValueError as e:
            self.send_json({'ok': False, 'error': str(e)}, 400)
        except OSError as e:
            self.send_json({'ok': False, 'error': 'storage: ' + str(e.strerror)}, 500)

    def do_PUT(self):
        self.library_write('PUT')

    def do_PATCH(self):
        self.library_write('PATCH')

    def do_DELETE(self):
        self.library_write('DELETE')

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == '/api/jobs/rescan':
            if READONLY:
                return self.send_json({'ok': False, 'error': 'read-only server'}, 403)
            try:
                d = json.loads(self.read_body(4096) or b'{}')
                gid = d.get('id')
                if gid is not None and not GAME_ID.fullmatch(str(gid)):
                    raise ValueError('bad game id')
                # merge with a request the scanner has not picked up yet: any request for every game wins
                old = read_json(RESCAN_REQ)
                if gid is None or (old is not None and not old.get('ids')):
                    req = {'ids': []}
                else:
                    req = {'ids': sorted(set((old or {}).get('ids', [])) | {gid})}
                req['at'] = int(time.time())
                os.makedirs(DATA_DIR, exist_ok=True)
                with open(RESCAN_REQ + '.tmp', 'w') as f:
                    json.dump(req, f)
                os.replace(RESCAN_REQ + '.tmp', RESCAN_REQ)
                return self.send_json({'ok': True, 'request': req})
            except (ValueError, TypeError) as e:
                return self.send_json({'ok': False, 'error': str(e)}, 400)
        if urllib.parse.urlparse(self.path).path == '/api/jobs/shots':
            if READONLY:
                return self.send_json({'ok': False, 'error': 'read-only server'}, 403)
            try:
                d = json.loads(self.read_body(4096) or b'{}')
                jobs = max(1, min(32, int(d.get('jobs') or os.environ.get('SHOT_JOBS') or 8)))
                only = d.get('id')
                if only is not None and not GAME_ID.fullmatch(str(only)):
                    raise ValueError('bad game id')
                SHOTS.start(bool(d.get('all')), jobs, only)
                return self.send_json({'ok': True, **SHOTS.state})
            except RuntimeError as e:
                return self.send_json({'ok': False, 'error': str(e)}, 409)
            except (ValueError, TypeError) as e:
                return self.send_json({'ok': False, 'error': str(e)}, 400)
            except OSError as e:
                return self.send_json({'ok': False, 'error': 'could not start node: ' + str(e.strerror)}, 500)
        # Visual-failure feedback from play.html: {id, type, sub?} stored in data/visual-feedback.json (type '' clears)
        if urllib.parse.urlparse(self.path).path != '/api/feedback':
            self.send_error(404)
            return
        try:
            n = min(int(self.headers.get('Content-Length', 0)), 4096)
            d = json.loads(self.rfile.read(n))
            gid = str(d.get('id', ''))
            if not re.fullmatch(r'[a-z0-9-]+', gid):
                raise ValueError('bad id')
            fb_path = FB_PATH
            try:
                with open(fb_path) as f:
                    fb = json.load(f)
            except Exception:
                fb = {}
            if d.get('type'):
                fb[gid] = {'type': str(d['type'])[:40], 'sub': str(d.get('sub', ''))[:60], 'at': int(time.time())}
            else:
                fb.pop(gid, None)
            tmp = fb_path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(fb, f, indent=1, sort_keys=True)
            os.replace(tmp, fb_path)
            body = b'{"ok":true}'
            self.send_response(200)
        except Exception as e:
            body = json.dumps({'ok': False, 'error': str(e)}).encode()
            self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # rom-status.json is served with visual feedback merged in as "visual": {type, sub, at}; the files on disk are not changed,
        # so a new scan can keep rewriting rom-status.json without losing reports.
        if path == '/visual-feedback.json':
            try:
                with open(FB_PATH, 'rb') as f:
                    body = f.read()
            except Exception:
                body = b'{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == '/rom-status.json':
            try:
                with open(STATUS_PATH) as f:
                    rows = json.load(f)
                try:
                    with open(FB_PATH) as f:
                        fb = json.load(f)
                except Exception:
                    fb = {}
                for r in rows:
                    slug = r.get('id') or re.sub(r'[^a-z0-9]+', '-', str(r.get('name', '')).lower())
                    if slug in fb:
                        r['visual'] = fb[slug]
                body = json.dumps(rows, indent=1).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            except Exception:
                pass   # fall through to the plain static file

        if path == '/api/jobs/shots':
            return self.send_json(SHOTS.state)
        if path == '/api/jobs/rescan':
            return self.send_json({'state': read_json(SCAN_STATE), 'request': read_json(RESCAN_REQ)})
        if path == '/api/library':
            games = {}
            for root in [GAMES_DIR] + ([IMG_DIR] if IMG_DIR else []):
                if os.path.isdir(root):
                    for gid in sorted(os.listdir(root)):
                        if gid not in games and GAME_ID.fullmatch(gid) and os.path.isdir(os.path.join(root, gid)):
                            games[gid] = game_record(gid)
            games = dict(sorted(games.items()))
            return self.send_json({'games': games, 'writable': not READONLY})
        r = self.game_route()
        if r:
            gid, kind, name = r
            try:
                if not kind:
                    return self.send_json(game_record(gid))
                if kind == 'meta' and not name:
                    return self.send_json(read_meta(gid))
                if kind == 'files' and name:
                    fp = file_path(gid, name)
                    if not os.path.isfile(fp):
                        return self.send_error(404, 'file not found')
                    with open(fp, 'rb') as f:
                        body = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', FILE_TYPES[os.path.splitext(name)[1].lower()])
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
            except ValueError as e:
                return self.send_json({'ok': False, 'error': str(e)}, 400)
            return self.send_error(404)

        # API endpoint: List ROM files in roms/ directory
        if path == '/api/roms':
            files = []
            if os.path.isdir(ROMS_DIR):
                try:
                    for f in sorted(os.listdir(ROMS_DIR)):
                        if f.lower().endswith('.zip'):
                            full_path = os.path.join(ROMS_DIR, f)
                            files.append({
                                'name': f,
                                'size': os.path.getsize(full_path),
                                'url': f'/roms/{urllib.parse.quote(f)}'
                            })
                except Exception as e:
                    pass
            body = json.dumps({'roms': files}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # Direct ROM file streaming: /roms/<filename>
        if path.startswith('/roms/'):
            filename = urllib.parse.unquote(path[6:])
            # Prevent directory traversal
            clean_filename = os.path.basename(filename)
            target = os.path.join(ROMS_DIR, clean_filename)
            if os.path.isfile(target):
                size = os.path.getsize(target)
                self.send_response(200)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Length', str(size))
                self.end_headers()
                with open(target, 'rb') as f:
                    while chunk := f.read(65536):
                        self.wfile.write(chunk)
                return
            else:
                self.send_error(404, 'ROM file not found')
                return

        # Default static web serving from web/
        return super().do_GET()

def start_autoscan():
    autoscan_script = os.path.join(ROOT_DIR, 'emu', 'autoscan.js')
    if os.path.isfile(autoscan_script):
        try:
            import subprocess
            subprocess.Popen(['node', autoscan_script], cwd=ROOT_DIR, env=dict(os.environ, ROMS_DIR=ROMS_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print("[server] Started background autoscan (emu/autoscan.js)")
        except Exception as e:
            print(f"[server] Could not start background autoscan: {e}")

def run(port=8791, bind='0.0.0.0'):
    server_address = (bind, port)
    httpd = http.server.ThreadingHTTPServer(server_address, AristoHandler)
    print(f"Aristoweb server running on http://{bind}:{port} (Serving web/ from {WEB_DIR}, roms/ from {ROMS_DIR}, game data in {DATA_DIR}{', read-only' if READONLY else ''})")
    start_autoscan()
    try:
        import signal
        signal.signal(signal.SIGTERM, lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))   # as PID 1 in a container, docker stop must end it at once
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    bind = sys.argv[2] if len(sys.argv) > 2 else '0.0.0.0'
    run(port=port, bind=bind)

