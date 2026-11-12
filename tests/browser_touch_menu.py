#!/usr/bin/env python3
"""Multi-game menu flow in web/play.html: Cashman Tonight, Players Choice By Demand / Favourites. For each ROM, by mouse click and by touch tap: pick every game on the menu
(tile's denomination button, confirming where the ROM asks), play a game with PLAY, come back with GAME MENU, pick the next one. Taps go to where the menu's touch box lies on
the stage, never to a code sent by script. python3 tests/browser_touch_menu.py [rom name ...]   (ROMS=<dir> to find the zips)"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); WEB = os.path.join(ROOT, 'web'); ROMS = os.environ.get('ROMS', os.path.join(ROOT, 'roms'))
ALL = [('Cashman Tonight', 'cashman-tonight'), ('Players Choice By Demand', 'players-choice-by-demand'), ('Players Choice Favourites', 'players-choice-favourites')]
want = sys.argv[1:]; roms = [r for r in ALL if not want or r[0] in want]
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start(); fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what, flush=True)
    if not ok: fails.append(what)
PLAY, MENU, CONFIRM = 0x1e, 0x20, 0x384
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for name, gid in roms:
        zp = os.path.join(ROMS, name + '.zip')
        if not os.path.exists(zp): print('skip ' + name); continue
        b64 = base64.b64encode(open(zp, 'rb').read()).decode()
        for mode, kw in (('mouse', dict(viewport={'width': 900, 'height': 1300})), ('touch', dict(pw.devices['Pixel 7']))):
            touch = mode == 'touch'; tag = f'{name} {mode}'; ctx = b.new_context(**kw); p = ctx.new_page(); errs = []
            p.on('pageerror', lambda e: errs.append(str(e)))
            p.goto(f'http://127.0.0.1:{port}/games.html')
            p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid, b64])
            p.goto(f'http://127.0.0.1:{port}/play.html?mute=1&speed=2&game={gid}')
            p.wait_for_function('window.touchplay && !document.getElementById("boot")', timeout=120000); p.wait_for_timeout(2000)
            en = lambda: p.evaluate('host.enabledCodes()')
            def box(code):   # an enabled touch box's centre, game coordinates
                return p.evaluate('(c) => { const b = vm.touchBoxes().find(b => b.code === c && b.w > 0 && vm.touchEnabled(c)); return b ? [b.x + (b.w >> 1), b.y + (b.h >> 1)] : null; }', code)
            def tap(x, y, wait=300):   # game coordinates -> a click or tap on the stage
                p.evaluate('document.getElementById("stage").scrollIntoView({block: "center"})'); p.wait_for_timeout(200)
                r = p.evaluate('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()')
                (p.touchscreen.tap if touch else p.mouse.click)(r[0] + x * r[2] / 640, r[1] + (y + 480) * r[3] / 960); p.wait_for_timeout(wait)
            def panel(sel):
                p.evaluate('(s) => document.querySelector(s).scrollIntoView({block: "center"})', sel); p.wait_for_timeout(200)
                r = p.evaluate('(s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }', sel)
                (p.touchscreen.tap if touch else p.mouse.click)(r[0], r[1]); p.wait_for_timeout(800)
            def menu_up(): return PLAY not in en() and 0x64 in en()
            def pick(n, d):   # game n, denomination button d (0-based among the tile's buttons)
                tile = 0x64 * (n + 1); ds = [c for c in range(tile + 1, tile + 4) if box(c)]
                if d >= len(ds): return None
                x, y = box(ds[d]); tap(x, y)
                for _ in range(12):   # the dearer denominations ask to confirm with a dialog that times out by itself
                    if PLAY in en() or box(CONFIRM): break
                    p.wait_for_timeout(100)
                if PLAY not in en() and box(CONFIRM): tap(*box(CONFIRM))
                for _ in range(40):
                    if PLAY in en(): break
                    p.wait_for_timeout(250)
                return PLAY in en()
            def play():
                if p.evaluate('(vm.meters.get(0)|0) < 20000'): panel('#add')
                t0 = p.evaluate('vm.meters.get(0x14)|0'); panel('#spin')
                for _ in range(160):
                    p.wait_for_timeout(250)
                    if p.evaluate('(vm.meters.get(0x14)|0)') != t0 and not p.evaluate('host.enabledCodes().includes(0x3fb)'): break
                p.wait_for_timeout(1500); return (p.evaluate('vm.meters.get(0x14)|0')) - t0
            def back():
                for _ in range(10):   # a win can be waiting to be taken
                    if not p.evaluate('document.querySelector("#fk .fkey").disabled'): break
                    panel('#spin'); p.wait_for_timeout(1500)
                panel('#fk .fkey'); p.wait_for_timeout(2500)
                for _ in range(20):
                    if menu_up(): break
                    p.wait_for_timeout(500)
                return menu_up()
            check(menu_up(), tag + ': the game menu is up at start')
            nden = len([c for c in range(0x65, 0x68) if box(c)])
            done = 0
            for n in range(4):
                for d in ([0] if n else range(nden)):   # every denomination of the first game, the first of the others
                    ok = pick(n, d)
                    check(ok, f'{tag}: game {n + 1} denomination {d + 1} picked by a {mode} on its button')
                    if not ok: break
                    s = play(); check(s > 0, f'{tag}: game {n + 1} denomination {d + 1} plays (stake {s})')
                    check(back(), f'{tag}: GAME MENU returns to the menu after game {n + 1}')
                    if not menu_up(): break
                    done += 1
            check(not errs, tag + ': no page errors ' + str(errs)); ctx.close()
    b.close()
print('FAILED' if fails else 'passed'); sys.exit(1 if fails else 0)
