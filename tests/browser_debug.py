#!/usr/bin/env python3
"""Smoke test for web/debug.html (the ROM scan page): store a few ROM zips in IndexedDB, run a short scan, screenshot.
python3 tests/browser_debug.py [out.png]"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); WEB = os.path.join(ROOT, 'web')
ROMS = os.environ.get('ROMS', os.path.join(ROOT, 'roms')); out = sys.argv[1] if len(sys.argv) > 1 else None
GAMES = [('queen-of-the-nile', 'Queen Of The Nile.zip'), ('spring-carnival', 'Spring Carnival.zip')]
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={'width': 1200, 'height': 500}); errs = []
    p.on('pageerror', lambda e: errs.append(str(e))); p.on('console', lambda m: m.type == 'error' and '404' not in m.text and errs.append(m.text))
    p.on('response', lambda r: r.status == 404 and print('404', r.url))
    p.goto(f'http://127.0.0.1:{port}/games.html')
    for gid, f in GAMES:
        b64 = base64.b64encode(open(os.path.join(ROMS, f), 'rb').read()).decode()
        p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid, b64])
    p.goto(f'http://127.0.0.1:{port}/debug.html'); p.wait_for_timeout(800)
    p.fill('#spins', '40'); p.fill('#jobs', '2'); p.click('#go'); p.wait_for_timeout(3000)
    if out: p.screenshot(path=out.replace('.png', '_run.png'))
    p.wait_for_function('document.getElementById("go").disabled === false', timeout=240000)
    if out: p.screenshot(path=out)
    print(p.inner_text('#sum')); print(p.inner_text('#rows')[:600]); print('errors', errs[:3])
    b.close()
sys.exit(1 if errs else 0)
