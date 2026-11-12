#!/usr/bin/env python3
"""the banner / LCD display settings (js/uiprefs.js) on games.html and play.html: defaults, the control, and that a choice survives a reload.
python3 tests/browser_ui_prefs.py [zip] [outdir]   (no zip or a missing zip: games.html only)"""
import sys, os, threading, http.server, functools, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'); WEB = os.path.join(ROOT, 'web')
zip_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get('ROMS', os.path.join(ROOT, 'roms')), 'Queen Of The Nile.zip')
out = sys.argv[2] if len(sys.argv) > 2 else None; gid = 'queen-of-the-nile'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=WEB)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
errs = []
def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok: errs.append(what)
shot = lambda p, name: out and p.screenshot(path=os.path.join(out, name))
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={'width': 1000, 'height': 1200})
    p.on('pageerror', lambda e: errs.append(str(e))); p.on('console', lambda m: m.type == 'error' and '404' not in m.text and errs.append(m.text))
    base = f'http://127.0.0.1:{port}/'
    # games.html: the control sets how a game opens; the list keeps only its totals LCD, never a banner
    p.goto(base + 'games.html'); p.wait_for_selector('#uiprefs')
    st = lambda: p.evaluate("({ b: !document.getElementById('marquee').classList.contains('nobanner'), l: !document.getElementById('lcd').hidden, theme: document.getElementById('lcd').dataset.theme || 'green', brand: getComputedStyle(document.querySelector('.brand')).display, mq: getComputedStyle(document.getElementById('marquee')).display, cr: document.getElementById('hcr').textContent })")
    s = st(); check(not s['b'] and s['l'] and s['theme'] == 'green' and s['brand'] != 'none' and s['mq'] != 'none', 'games.html: totals LCD, no banner, brand line shown ' + str(s))
    check(p.evaluate("document.querySelector('#uiprefs > summary').textContent.includes('Menu')"), 'games.html control is labelled Menu')
    check(s['cr'] == '$1000.00', 'games.html LCD with nothing saved shows the new wallet: ' + s['cr'])
    shot(p, 'games_default.png')
    # the control changes the saved settings for play.html; the list stays LCD only (colour follows)
    p.click('#uiprefs > summary'); p.wait_for_selector('#ui-banner', state='visible')
    p.uncheck('#ui-banner'); p.uncheck('#ui-lcd'); p.select_option('#ui-lcdtheme', 'amber') if p.is_enabled('#ui-lcdtheme') else None
    s = st(); check(not s['b'] and s['l'] and s['mq'] != 'none', 'games.html list unchanged by the play settings: ' + str(s))
    p.reload(); p.wait_for_selector('#uiprefs')
    sv = p.evaluate("JSON.parse(localStorage.getItem('mk6-ui'))"); check(sv['banner'] is False and sv['lcd'] is False, 'one key mk6-ui holds the settings, remembered: ' + str(sv))
    p.click('#uiprefs > summary'); p.click('#ui-reset'); sv = p.evaluate("UIPREFS.load()"); check(sv['banner'] and sv['lcd'] and sv['lcdTheme'] == 'green', 'reset to defaults ' + str(sv))
    # the shared wallet and a game's saved stats show on the games.html LCD (wallet $100.00; 5c game, 300 bet, 120 won)
    p.evaluate("() => { localStorage.setItem('emu-wallet', '10000'); localStorage.setItem('emu-denom-x', '5'); localStorage.setItem('emu-stats-x', JSON.stringify({ wagered: 300, won: 120 })); }")
    p.reload(); p.wait_for_selector('#uiprefs')
    t = p.evaluate("[document.getElementById('hcr').textContent, document.getElementById('hbet').textContent, document.getElementById('hwin').textContent]")
    check(t == ['$100.00', '$15.00', '$6.00'], 'games.html LCD totals from the wallet and saved stats: ' + str(t))
    p.once('dialog', lambda d: d.accept()); p.click('#uiprefs > summary'); p.click('#ui-clearstats')
    t = p.evaluate("[document.getElementById('hcr').textContent, document.getElementById('hbet').textContent, document.getElementById('hwin').textContent, localStorage.getItem('emu-stats-x')]")
    check(t == ['$100.00', '$0.00', '$0.00', None], 'Menu > Clear empties the bet and won totals, keeps the wallet: ' + str(t))
    p.evaluate("() => { ['emu-credits-x', 'emu-denom-x', 'emu-stats-x'].forEach(k => localStorage.removeItem(k)); }")
    # play.html with a ROM
    if os.path.exists(zip_path):
        b64 = base64.b64encode(open(zip_path, 'rb').read()).decode()
        p.evaluate("async ([id,b64]) => { const u = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); await RomStore.put(id, id, u.buffer); }", [gid, b64])
        p.goto(base + 'play.html?game=' + gid)
        p.wait_for_function('window.vm && vm.display.items.length > 20 && !document.getElementById("boot")', timeout=90000); p.wait_for_timeout(800)
        ps = lambda: p.evaluate("({ cls: document.getElementById('marquee').className, l: !document.getElementById('lcd').hidden, theme: document.getElementById('lcd').dataset.theme || 'green', h: document.getElementById('marquee').offsetHeight, art: !!document.querySelector('#marquee .art').style.backgroundImage, title: getComputedStyle(document.getElementById('gtitle')).display })")
        s = ps(); check('nobanner' not in s['cls'] and s['l'] and s['theme'] == 'green' and s['title'] != 'none', 'play.html defaults unchanged: ' + str(s))
        h0 = s['h']; shot(p, 'play_default.png')
        # play.html: the #uiprefs control sits in the hidden options bar; users reach the same settings in the window menu (Display group)
        def mset(label, val):
            if p.locator('#wmenu').is_hidden(): p.click('#wmenubtn')
            c = p.locator('#wmenu [aria-label="%s"]' % label)
            if isinstance(val, bool): c.set_checked(val)
            else: c.select_option(val)
            p.wait_for_timeout(300)
        mset('Banner', False)
        s = ps(); check('nobanner' in s['cls'] and s['title'] == 'none' and s['h'] < h0, 'play.html banner off shrinks the marquee: %d -> %d' % (h0, s['h']))
        topbar = p.evaluate("[document.getElementById('topbar').getBoundingClientRect().bottom, document.getElementById('lcd').getBoundingClientRect().top]")
        check(topbar[1] >= topbar[0], 'LCD clears the top buttons with the banner off: ' + str(topbar))
        shot(p, 'play_nobanner.png')
        check(p.evaluate("getComputedStyle(document.getElementById('notes')).display") == 'none', 'play.html banner off hides the key shortcuts')
        # banner and LCD off: no strip above the game, the Menu button on the game's top right corner
        mset('LCD panel', False)
        r = p.evaluate("(() => { const b = document.getElementById('wmenubtn').getBoundingClientRect(), g = document.getElementById('stage').getBoundingClientRect(); return { mq: getComputedStyle(document.getElementById('marquee')).display, on: document.getElementById('wmenubtn').parentNode.id, dr: Math.round(g.right - b.right), dt: Math.round(b.top - g.top) }; })()")
        check(r['mq'] == 'none' and r['on'] == 'stage' and 0 <= r['dr'] <= 20 and 0 <= r['dt'] <= 20, 'play.html banner and LCD off: no marquee, Menu on the game top right ' + str(r))
        shot(p, 'play_bare.png')
        mset('LCD panel', True)
        r = p.evaluate("({ mq: getComputedStyle(document.getElementById('marquee')).display, on: document.getElementById('wmenubtn').parentNode.id })")
        check(r['mq'] != 'none' and r['on'] == 'topbar', 'play.html LCD back on: marquee and Menu back ' + str(r))
        mset('Banner', True); mset('Banner shows', 'name'); mset('LCD colour', 'blue')
        s = ps(); check('noart' in s['cls'] and 'tall' not in s['cls'] and s['theme'] == 'blue', 'play.html name only + blue: ' + str(s))
        shot(p, 'play_nameonly_blue.png')
        mset('Banner shows', 'artonly')
        s = ps(); check('notitle' in s['cls'] and s['title'] == 'none', 'play.html art only: ' + str(s))
        mset('LCD panel', False)
        s = ps(); check(not s['l'], 'play.html LCD off')
        shot(p, 'play_artonly_nolcd.png')
        p.reload(); p.wait_for_function('window.vm && vm.display.items.length > 20 && !document.getElementById("boot")', timeout=90000); p.wait_for_timeout(800)
        s = ps(); check('notitle' in s['cls'] and not s['l'], 'play.html remembered after reload: ' + str(s))
        p.goto(base + 'games.html'); p.wait_for_selector('#uiprefs')
        s = st(); check(not s['b'] and s['l'] and p.evaluate("!UIPREFS.load().lcd"), 'games.html sees the same settings, list LCD stays: ' + str(s))
        p.evaluate("UIPREFS.save(UIPREFS.DEFAULTS)")
    else: print('no ROM zip at', zip_path, ': play.html not tested')
    b.close()
print('errors:', errs); sys.exit(1 if errs else 0)
