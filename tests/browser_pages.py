#!/usr/bin/env python3
"""Offline test of the static build (tools/build-pages.py): serve dist/pages, store a ROM in IndexedDB, wait for the service worker, stop the server,
then reload games.html and play.html from the cache and boot the ROM. python3 tests/browser_pages.py [zip] [id]"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); OUT = os.path.join(ROOT, 'dist', 'pages')
zip_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('ROMS', os.path.join(ROOT, 'roms')), 'Queen Of The Nile.zip'); gid = sys.argv[2] if len(sys.argv) > 2 else 'queen-of-the-nile'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=OUT)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
b64 = base64.b64encode(open(zip_path, 'rb').read()).decode(); errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(); p = ctx.new_page()
    p.on('pageerror', lambda e: errs.append(str(e)))
    p.goto(f'http://127.0.0.1:{port}/games.html')
    p.wait_for_function('navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)', timeout=30000)
    p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid, b64])
    p.reload(); p.wait_for_function('!!navigator.serviceWorker.controller', timeout=30000)
    print('manifest', p.evaluate('!!document.querySelector("link[rel=manifest]")'), 'cached files', p.evaluate("caches.keys().then(ks => caches.open(ks[0])).then(c => c.keys()).then(k => k.length)"))
    srv.shutdown(); srv.server_close(); ctx.set_offline(True)
    p.goto(f'http://127.0.0.1:{port}/games.html'); print('offline games.html title:', p.title())
    p.goto(f'http://127.0.0.1:{port}/play.html?game={gid}')
    p.wait_for_function('window.vm && vm.display.items.length > 20 && !document.getElementById("boot")', timeout=90000)
    print('offline play.html booted', gid, 'items', p.evaluate('vm.display.items.length'), 'errors', errs[:3])
    b.close()
sys.exit(1 if errs else 0)
