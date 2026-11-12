#!/usr/bin/env python3
"""Static build (dist/pages) with ROMs added by the user: file input, synthetic drop, reload persistence, remove, then play. No /api or /roms request may reach the server.
python3 tests/browser_pages_upload.py [zip for the file input] [zip for the drop]  (defaults: 5 Dragons, Queen Of The Nile in $ROMS or roms/)"""
import sys, os, re, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); OUT = os.path.join(ROOT, 'dist', 'pages')
RD = os.environ.get('ROMS', os.path.join(ROOT, 'roms'))
z1 = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RD, '5 Dragons.zip'); z2 = sys.argv[2] if len(sys.argv) > 2 else os.path.join(RD, 'Queen Of The Nile.zip')
slug = lambda p: re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', os.path.basename(p).lower().removesuffix('.zip')))
id1, id2 = slug(z1), slug(z2); hits = []
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): hits.append(self.path)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=OUT)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
errs = []; fails = []
def check(what, ok):
    print('ok  ' if ok else 'FAIL', what); (not ok) and fails.append(what)
def wait_rom(i):   # poll: wait_for_function does not await a promise
    for _ in range(120):
        if i in p.evaluate('RomStore.list()'): return
        p.wait_for_timeout(250)
    raise SystemExit('timeout waiting for ' + i)
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(); p = ctx.new_page()
    p.on('pageerror', lambda e: errs.append(str(e)))
    url = f'http://127.0.0.1:{port}/games.html'
    p.goto(url); p.wait_for_timeout(1500)
    check('starts with no cached ROM', p.evaluate('RomStore.list()') == [])
    p.evaluate("document.getElementById('addbtn').click()")
    p.set_input_files('#files', z1)
    wait_rom(id1)
    check('file input stored ' + id1, True)
    b64 = base64.b64encode(open(z2, 'rb').read()).decode()
    p.evaluate("""async ([name, b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([u], name, { type: 'application/zip' }));
      for (const t of ['dragenter', 'dragover', 'drop']) dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })); }""", [os.path.basename(z2), b64])
    wait_rom(id2)
    check('drop stored ' + id2, True)
    p.reload(); p.wait_for_timeout(1500)
    l = p.evaluate('RomStore.list()'); check('both survive a reload', id1 in l and id2 in l)
    check('exactly the two cached games offer Remove', p.locator('.rmrom').count() == 2)
    p.goto(f'http://127.0.0.1:{port}/play.html?game={id1}')
    p.wait_for_function('window.vm && vm.display.items.length > 20 && !document.getElementById("boot")', timeout=90000)
    check('game boots from the cached ROM', True)
    p.goto(url); p.wait_for_timeout(1500)
    p.locator('.rmrom').first.click(); p.wait_for_timeout(1000); p.reload(); p.wait_for_timeout(1500)
    l = p.evaluate('RomStore.list()'); check('Remove button deletes one ROM, it stays gone after reload', len(l) == 1 and p.locator('.rmrom').count() == 1)
    b.close()
srv.shutdown()
bad = [h for h in hits if re.match(r'/(api|roms)/', h)]
check('no /api or /roms request reached the server', not bad); print('requests to server:', len(hits), bad[:3], 'errors', errs[:3])
sys.exit(1 if fails or errs else 0)
