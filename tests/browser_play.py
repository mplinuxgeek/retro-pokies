#!/usr/bin/env python3
"""Smoke test for web/play.html (cabinet UI driving the ROM emulator): store a ROM zip in IndexedDB, load the page, press lines/bet/note/spin, screenshot.
python3 tests/browser_play.py [zip] [out.png] [id]"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); WEB = os.path.join(ROOT, 'web')
zip_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('ROMS', os.path.join(ROOT, 'roms')), 'Queen Of The Nile.zip'); out = sys.argv[2] if len(sys.argv) > 2 else None; gid = sys.argv[3] if len(sys.argv) > 3 else 'queen-of-the-nile'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
b64 = base64.b64encode(open(zip_path, 'rb').read()).decode()
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={'width': 900, 'height': 1400}); errs = []
    p.on('pageerror', lambda e: errs.append(str(e))); p.on('console', lambda m: m.type == 'error' and '404' not in m.text and errs.append(m.text))   # the static test server has no /api
    p.goto(f'http://127.0.0.1:{port}/games.html')
    p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid, b64])
    p.goto(f'http://127.0.0.1:{port}/play.html?game={gid}')
    p.wait_for_function('window.vm && vm.display.items.length > 20 && !document.getElementById("boot")', timeout=90000); p.wait_for_timeout(1000)
    if p.evaluate('!!window.touchplay'):
        # a touch game (Cashman Tonight; js/touchplay.js): the panel has no .cb.bet / .cb.play keys and the denomination is picked on the game's own screen (tile at 120,246).
        # Pick it, put a note in, choose lines and bet by the panel's aria-labels, PLAY, and check a game was staked and ends.
        p.evaluate('document.getElementById("stage").scrollIntoView({block: "center"})'); p.wait_for_timeout(200)
        r = p.evaluate('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()')
        p.mouse.click(r[0] + 120 * r[2] / 640, r[1] + (246 + 480) * r[3] / 960); p.wait_for_timeout(3000)
        p.click('#add'); p.wait_for_timeout(1000); p.click('button[aria-label^="Lines 1"]'); p.click('button[aria-label^="Bet 1"]'); p.wait_for_timeout(300)
        print('before', p.inner_text('#hcr'), p.inner_text('#hbet')); t0 = p.evaluate('vm.meters.get(0x14)|0'); p.click('#spin')
        try: p.wait_for_function('(vm.meters.get(0x14)|0) != %d' % t0, timeout=60000)
        except Exception: errs.append('touch game: PLAY did not stake a game')
        try: p.wait_for_function('!host.enabledCodes().includes(0x3fb)', timeout=60000)
        except Exception: errs.append('touch game: game did not end')
        p.wait_for_timeout(1500)
        print('after touch game: stake', (p.evaluate('vm.meters.get(0x14)|0')) - t0, 'credits', p.inner_text('#hcr'), 'win', p.inner_text('#hwin'), 'errors', errs[:3])
        if out: p.screenshot(path=out)
        b.close(); sys.exit(1 if errs else 0)
    p.click('#wmenubtn'); p.locator('#wmenu .mi', has_text='Denomination').locator('select').select_option('5'); p.wait_for_timeout(300); print('5c credits', p.inner_text('#hcr'))   # the denomination is set from the menu (the strip under the panel is hidden)
    p.click('#add'); p.wait_for_function('![...document.querySelectorAll(".cb.bet")].some(b => b.disabled)', timeout=30000)   # the keys are disabled while the note goes in
    p.click('.cb.bet >> nth=1'); p.wait_for_timeout(300)
    print('before', p.inner_text('#hcr'), p.inner_text('#hbet'))
    # A winning spin waits at the take-win prompt (host.gamble set) until the player acts; SPIN there is PLAY ON: it takes
    # the win and starts the next game. Spin until a losing and a winning game were both seen (at most MAX_GAMES), pressing SPIN at each prompt.
    MAX_GAMES = 12; seen = set(); games = 0
    state = lambda: p.evaluate('({ phase: host.phase, gamble: !!host.gamble, screen: !!(host.gamble && host.gamble.screen), state: vm.mem.r32(host.map.state), credits: host.credits })')
    p.click('.cb.play >> nth=1'); p.wait_for_timeout(600); games += 1   # a Play key sets the lines and starts the game, as on the cabinet
    if out: p.screenshot(path=out.replace('.png', '_spin.png'))
    while True:
        try: p.wait_for_function('!window.host.phase || (host.gamble && !host.gamble.screen && !host.gamble.busy)', timeout=60000)
        except Exception: errs.append('game did not end or reach the take-win prompt within 60 s: ' + str(state())); break
        if p.evaluate('!!window.host.gamble'):
            seen.add('win'); print('take-win prompt, win', p.inner_text('#hwin'), 'at game', games)
            if len(seen) == 2:   # both outcomes seen: take the win (no PLAY ON) and stop; a high-hit game (5 Dragons) can be at a prompt when the second outcome turns up
                p.evaluate('host.collect()'); p.wait_for_function('!host.phase && !host.gamble', timeout=60000); break
            if games >= MAX_GAMES: errs.append('still at the take-win prompt after ' + str(MAX_GAMES) + ' games: ' + str(state())); break
            p.click('#spin'); p.wait_for_timeout(600); games += 1; continue   # PLAY ON: collect and play the next game
        seen.add('lose'); p.wait_for_timeout(500)
        if len(seen) == 2 or games >= MAX_GAMES: break
        p.click('#spin'); p.wait_for_timeout(600); games += 1
    if not p.evaluate('!window.host.phase && !host.gamble'): errs.append('game not idle after collecting: ' + str(state()))
    print('after', games, 'games, outcomes seen', sorted(seen), 'credits', p.inner_text('#hcr'), 'win', p.inner_text('#hwin'), 'spins stat', p.inner_text('#sl div:first-child dd'))
    p.keyboard.press('c'); p.wait_for_timeout(500)
    if out: p.screenshot(path=out)
    print('items', p.evaluate('vm.display.items.length'), 'errors', errs[:3])
    b.close()
sys.exit(1 if errs else 0)
