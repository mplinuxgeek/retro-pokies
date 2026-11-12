#!/usr/bin/env python3
"""Manual-key test for the touch games in web/play.html (Cashman Tonight): the cabinet panel's BET / LINES / PLAY keys and Space, by mouse click and by touch tap, not AUTO.
Picks a game and denomination, then checks that a bet key and a lines key change what a game stakes, that PLAY after a refused PLAY (no credit) still starts a game, and that
Space plays. python3 tests/browser_touch_keys.py [Cashman Tonight.zip]"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); WEB = os.path.join(ROOT, 'web')
zip_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('ROMS', os.path.join(ROOT, 'roms')), 'Cashman Tonight.zip'); gid = 'cashman-tonight'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
b64 = base64.b64encode(open(zip_path, 'rb').read()).decode(); fails = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: fails.append(what)
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for name, kw in (('mouse 560', dict(viewport={'width': 560, 'height': 1100})), ('mouse 900', dict(viewport={'width': 900, 'height': 1000})), ('touch Pixel 7', dict(pw.devices['Pixel 7']))):
        touch = 'touch' in name; ctx = b.new_context(**kw); p = ctx.new_page(); errs = []
        p.on('pageerror', lambda e: errs.append(str(e)))
        p.goto(f'http://127.0.0.1:{port}/games.html')
        p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid, b64])
        p.goto(f'http://127.0.0.1:{port}/play.html?mute=1&speed=4&game={gid}')
        p.wait_for_function('window.touchplay && !document.getElementById("boot")', timeout=120000); p.wait_for_timeout(1500)
        codes = lambda: p.evaluate('host.enabledCodes()')
        def hit(sel):   # a mouse click or a touch tap on the element's centre
            p.evaluate('(s) => document.querySelector(s).scrollIntoView({block: "center"})', sel); p.wait_for_timeout(200)
            r = p.evaluate('(s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }', sel)
            (p.touchscreen.tap if touch else p.mouse.click)(r[0], r[1]); p.wait_for_timeout(600)
        def tile(x, y):
            p.evaluate('document.getElementById("stage").scrollIntoView({block: "center"})'); p.wait_for_timeout(200)
            r = p.evaluate('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()')
            (p.touchscreen.tap if touch else p.mouse.click)(r[0] + x * r[2] / 640, r[1] + (y + 480) * r[3] / 960); p.wait_for_timeout(3000)
        def stake():   # play with PLAY, wait for the game to end, give the stake in cents
            t0 = p.evaluate('vm.meters.get(0x14)|0'); hit('#spin')
            for _ in range(120):
                p.wait_for_timeout(250)
                if not p.evaluate('host.enabledCodes().includes(0x3fb)') and p.evaluate('(vm.meters.get(0x14)|0)') != t0: break
            p.wait_for_timeout(1500)
            return (p.evaluate('vm.meters.get(0x14)|0')) - t0
        tile(120, 246); check(p.evaluate('host.enabledCodes().includes(30)'), name + ': PLAY enabled after the denomination pick')
        hit('#add'); hit('button[aria-label^="Lines 1"]'); hit('button[aria-label^="Bet 1"]'); base = stake()
        check(base > 0, f'{name}: PLAY starts a game (stake {base})')
        hit('button[aria-label^="Bet 3"]'); s3 = stake(); check(s3 == base * 5, f'{name}: bet key 5 raises the stake {base} -> {s3}')
        hit('button[aria-label^="Lines 2"]'); s4 = stake(); check(s4 == base * 25, f'{name}: lines key 2 (5 lines) at bet 5 stakes 25 credits (got {s4}, one credit is {base})')
        check(p.evaluate('document.querySelector(\'button[aria-label^="Lines 2"]\').classList.contains("on")'), name + ': the chosen lines key is lit')
        p.evaluate('vm.meters.set(0, 0); host.machineEvent()'); p.wait_for_timeout(1500); c = p.evaluate('vm.meters.get(0x14)|0'); hit('#spin'); p.wait_for_timeout(2500)   # a refused PLAY (no credit)
        hit('#add'); p.wait_for_timeout(1000); s5 = stake(); check(s5 > 0, f'{name}: PLAY after a refused PLAY starts a game (stake {s5})')
        if not touch:
            t0 = p.evaluate('vm.meters.get(0x14)|0'); p.keyboard.press('Space'); p.wait_for_timeout(3000); check((p.evaluate('vm.meters.get(0x14)|0')) != t0 or p.evaluate('host.enabledCodes().includes(0x3fb)'), name + ': Space plays')
        check(not errs, name + ': no page errors ' + str(errs)); ctx.close()
    # Players Choice By Demand (Black Panther, first tile): the keys follow the game's own on-screen buttons and the first game's result is stake minus win
    pc = os.path.join(os.path.dirname(zip_path), 'Players Choice By Demand.zip')
    if os.path.exists(pc):
        gid2 = 'players-choice-by-demand'; b64b = base64.b64encode(open(pc, 'rb').read()).decode(); ctx = b.new_context(viewport={'width': 1000, 'height': 1300}); p = ctx.new_page(); errs = []
        p.on('pageerror', lambda e: errs.append(str(e)))
        p.goto(f'http://127.0.0.1:{port}/games.html')
        p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid2, b64b])
        p.goto(f'http://127.0.0.1:{port}/play.html?mute=1&speed=8&game={gid2}')
        p.wait_for_function('window.touchplay && !document.getElementById("boot")', timeout=120000); p.wait_for_timeout(1500)
        p.evaluate('host.send(101)'); p.wait_for_timeout(3000)
        keys = lambda row: p.evaluate('(r)=>[...document.querySelectorAll("#"+r+" .cb")].map(b=>b.style.visibility==="hidden"?"-":(b.querySelector("big")||{}).textContent).join(" ")', row)
        check(keys('betrow') == '1 2 3 4 -' and keys('playrow') == '1 2 3 4 5', 'Players Choice Black Panther: keys follow the on-screen buttons (BET ' + keys('betrow') + ' PLAY ' + keys('playrow') + ')')
        c0 = p.evaluate('vm.meters.get(0)|0'); t0 = p.evaluate('vm.meters.get(0x14)|0'); p.evaluate('touchplay.playKey()')
        for _ in range(200):
            p.wait_for_timeout(250)
            if p.evaluate('host.enabledCodes().includes(0x1e) && !host.enabledCodes().includes(0x3fb)'): break
        p.wait_for_timeout(1500); c1 = p.evaluate('vm.meters.get(0)|0'); t1 = p.evaluate('vm.meters.get(0x14)|0'); win = p.inner_text('#hwin'); cost = t1 - t0
        check(0 < cost < 10000 and c1 - c0 + cost >= 0 and '-' not in win, f'Players Choice: first game credit {c0} -> {c1}, stake {cost}, win shown {win}')
        check(not errs, 'Players Choice: no page errors ' + str(errs)); ctx.close()
    b.close()
print('FAILED' if fails else 'passed'); sys.exit(1 if fails else 0)
