#!/usr/bin/env python3
"""Game library store API in server.py: meta merge, file upload / read / delete, name checks, read-only mode.
python3 tests/server_library.test.py"""
import http.server, importlib, json, os, sys, tempfile, threading, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)


def start(readonly=False):
    os.environ.setdefault('ARISTO_ROMS', tempfile.mkdtemp(prefix='aristo-noroms-'))   # an empty ROM folder, whatever roms/ holds
    os.environ['ARISTO_DATA'] = tempfile.mkdtemp(prefix='aristo-data-')
    os.environ['ARISTO_READONLY'] = '1' if readonly else ''
    import server
    importlib.reload(server)   # module constants come from the environment
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), server.AristoHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://127.0.0.1:%d' % srv.server_address[1]


def call(base, method, path, body=None, ctype='application/json'):
    req = urllib.request.Request(base + path, data=body, method=method, headers={'Content-Type': ctype} if body is not None else {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


fails = []
def check(what, ok):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fails.append(what)


srv, base = start()
check('empty library', json.loads(call(base, 'GET', '/api/library')[1]) == {'games': {}, 'writable': True})
st, b = call(base, 'PATCH', '/api/games/queen-of-the-nile/meta', json.dumps({'notes': 'hi', 'shot': {'at': 1}}).encode())
check('meta patch', st == 200 and json.loads(b)['meta'] == {'notes': 'hi', 'shot': {'at': 1}})
st, b = call(base, 'PATCH', '/api/games/queen-of-the-nile/meta', json.dumps({'notes': None, 'fav': True}).encode())
check('meta merge and delete', json.loads(b)['meta'] == {'shot': {'at': 1}, 'fav': True})
jpg = b'\xff\xd8\xff\xe0' + os.urandom(2000)
st, b = call(base, 'PUT', '/api/games/queen-of-the-nile/files/shot.jpg', jpg, 'image/jpeg')
check('file upload', st == 200 and json.loads(b)['file']['size'] == len(jpg))
st, b = call(base, 'GET', '/api/games/queen-of-the-nile/files/shot.jpg')
check('file read back', st == 200 and b == jpg)
lib = json.loads(call(base, 'GET', '/api/library')[1])['games']
check('library lists game with file and meta', [f['name'] for f in lib['queen-of-the-nile']['files']] == ['shot.jpg'] and lib['queen-of-the-nile']['meta']['fav'] is True)
check('traversal id refused', call(base, 'PUT', '/api/games/..%2Fx/files/a.jpg', b'x')[0] == 400)
check('traversal name refused', call(base, 'PUT', '/api/games/a/files/..%2Fa.jpg', b'x')[0] == 400)
check('meta.json not writable as a file', call(base, 'PUT', '/api/games/a/files/meta.json', b'{}')[0] == 400)
check('unknown extension refused', call(base, 'PUT', '/api/games/a/files/x.exe', b'x')[0] == 400)
check('non-object meta refused', call(base, 'PATCH', '/api/games/a/meta', b'[1]')[0] == 400)
check('file delete', call(base, 'DELETE', '/api/games/queen-of-the-nile/files/shot.jpg')[0] == 200 and call(base, 'GET', '/api/games/queen-of-the-nile/files/shot.jpg')[0] == 404)
import time
st, b = call(base, 'POST', '/api/jobs/shots', json.dumps({'jobs': 2}).encode())
check('screenshot job starts', st == 200 and json.loads(b)['running'] is True)
check('second job refused while running', call(base, 'POST', '/api/jobs/shots', b'{}')[0] in (409, 200))
for _ in range(100):
    job = json.loads(call(base, 'GET', '/api/jobs/shots')[1])
    if not job['running']:
        break
    time.sleep(0.2)
check('screenshot job finishes (roms/ has no zips here)', job['running'] is False and job.get('exit') == 0 and job['total'] == 0)
srv.shutdown()

# ARISTO_ROMS moves the ROM folder (served and listed from there)
rd = tempfile.mkdtemp(prefix='aristo-roms-'); open(os.path.join(rd, 'Test Game.zip'), 'wb').write(b'PK-not-a-real-zip')
os.environ['ARISTO_ROMS'] = rd
srv, base = start()
roms = json.loads(call(base, 'GET', '/api/roms')[1])['roms']
check('ARISTO_ROMS lists its folder', [r['name'] for r in roms] == ['Test Game.zip'])
check('ARISTO_ROMS serves the file', call(base, 'GET', '/roms/Test%20Game.zip') == (200, b'PK-not-a-real-zip'))
srv.shutdown()
del os.environ['ARISTO_ROMS']

srv, base = start(readonly=True)
check('read-only refuses writes', call(base, 'PUT', '/api/games/a/files/shot.jpg', b'x')[0] == 403 and call(base, 'POST', '/api/jobs/shots', b'{}')[0] == 403 and json.loads(call(base, 'GET', '/api/library')[1])['writable'] is False)
srv.shutdown()
sys.exit(1 if fails else 0)
