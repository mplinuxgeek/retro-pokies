#!/usr/bin/env python3
"""Smoke test for the games.html screenshot scanner: store a ROM, click Scan screenshots, check a card gets a thumbnail.
python3 tests/browser_shots.py [out.png]"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); WEB = os.path.join(ROOT, 'web')
ROMS = os.environ.get('ROMS', os.path.join(ROOT, 'roms')); out = sys.argv[1] if len(sys.argv) > 1 else None
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={'width': 1200, 'height': 700}); errs = []
    p.on('pageerror', lambda e: errs.append(str(e))); p.on('console', lambda m: m.type == 'error' and '404' not in m.text and errs.append(m.text))
    p.goto(f'http://127.0.0.1:{port}/games.html')
    b64 = base64.b64encode(open(os.path.join(ROMS, 'Queen Of The Nile.zip'), 'rb').read()).decode()
    p.evaluate("async b64 => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put('queen-of-the-nile', 'queen-of-the-nile', u.buffer); }", b64)
    p.evaluate("localStorage.setItem('mk6-dev', '1')")   # the scan button is in the Developer view
    p.reload(); p.wait_for_timeout(1000)
    p.get_by_text('Scan screenshots').click()
    # the browser scan reports in #dropmsg; a finished shot is kept in LOCAL_SHOTS (no img.shot: cards show it on hover, as the peek)
    p.wait_for_function('/^Screenshots done/.test(document.getElementById("dropmsg").textContent)', timeout=180000)
    msg = p.inner_text('#dropmsg')[:200]
    p.hover('.card .thumb'); p.wait_for_timeout(300)
    peek = p.evaluate('(document.querySelector("#peek img") || {}).src || ""')
    print('shots', msg, '| peek', peek[:40])
    if 'Failed' in msg: errs.append('screenshot failed: ' + msg)
    if not peek.startswith('data:image/jpeg'): errs.append('card peek has no screenshot: ' + peek[:60])
    if out: p.screenshot(path=out)
    print('errors', errs[:3]); b.close()
sys.exit(1 if errs else 0)
