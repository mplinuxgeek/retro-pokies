#!/usr/bin/env python3
"""Renders the web build's control panel pieces (web/play.html's own CSS, in Chromium through Playwright) at the desktop player's scale,
1.6 screen pixels per CSS pixel (the 800 px wide web panel over the 1280 px wide game), into one atlas: assets/webpanel.png and
assets/webpanel.json. Pieces: the brushed-steel fascia, every key style in each lamp state (plain, hovered, pressed) with its borders,
shadows and glows but no text, the four bet-key suits, and the banknote acceptor (plain, hovered, a note going in; its chevrons apart, so
they can bob). The player draws the key labels itself, with Liberation Sans Narrow (play.html's "Arial Narrow"). Each piece is trimmed to
its visible pixels; 'ox', 'oy' place it relative to the top left of its key (or of the fascia / acceptor) in screen pixels.
usage: python3 tools/import-webpanel.py [retro-pokies folder]"""
import sys, os, re, json, io, tempfile
from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
RP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..'); WEB = os.path.abspath(os.path.join(RP, 'web'))
Z = 1.6; CELL = 135; M = 35   # CSS pixels: one piece per cell, the key 35 px in (56 screen pixels, a whole number)
css = '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', open(os.path.join(WEB, 'play.html'), encoding='utf-8').read(), re.S))
LAMP = 'data-lamp="1"'
# name: (classes, extra attributes, extra style)
KEYS = {
    'bet': ('cb bet', '', ''), 'bet.lamp': ('cb bet', LAMP, ''), 'bet.sel': ('cb bet sel', '', ''),
    'play': ('cb play', '', ''), 'play.lamp': ('cb play', LAMP, ''), 'play.sel': ('cb play sel', LAMP, ''),
    'special': ('cb play special', '', ''), 'special.lit': ('cb play special on', '', ''),
    'spin': ('cb spin', '', ''), 'spin.lamp': ('cb spin', LAMP, ''),
    'auto': ('cb blank', '', ''), 'auto.lit': ('cb blank lit', '', ''),
    'gamble': ('cb gamble', '', ''), 'gamble.lamp': ('cb gamble', LAMP, ''),
    'fkey': ('cb fkey', '', ''), 'fkey.lamp': ('cb fkey', LAMP, ''),
    # lampflash's lit step (play.html: a prompt key the ROM gives no lamp)
    'fkey.ring': ('cb fkey', '', 'box-shadow:0 4px 0 #1b1b1d, 0 0 14px 4px #ffd862; border-color:#ffd862'),
}
NOTE = '<i class="led"></i><span class="bezel"><i class="slot"></i></span><span class="chev" style="visibility:hidden">▲<br>▲</span><b>INSERT NOTE</b><em style="visibility:hidden">$100</em>'   # the value is drawn by the app; held here so INSERT NOTE sits where it does
CHEV = '<i class="led" style="visibility:hidden"></i><span class="bezel" style="visibility:hidden"><i class="slot"></i></span><span class="chev">▲<br>▲</span><b style="visibility:hidden">INSERT NOTE</b><em style="visibility:hidden">$100</em>'
BARE = 'background:none !important; border-color:transparent !important; box-shadow:none !important'

cells, html = [], []
def cell(name, inner, w=64, h=64, mode=None):
    i = len(cells); x, y = (i % 8) * CELL * 2, (i // 8) * CELL * 2 if w > 64 or h > 64 else (i // 8) * CELL * 2
    cells.append((name, x, y, w, h, mode)); html.append(f'<div id="cab" class="w" style="left:{x + M}px; top:{y + M}px">{inner}</div>')
for name, (cls, attr, st) in KEYS.items():
    for mode in (None, 'hover', 'active'):
        cell(name + ('.' + mode if mode else ''), f'<button class="{cls}" {attr} style="{st}"></button>', mode=mode)
for i in range(4): cell('suit%d' % i, f'<button class="cb bet s{i}" style="{BARE}"></button>')
for mode in (None, 'hover', 'feed'): cell('note' + ('.' + mode if mode else ''), f'<button class="note{" feed" if mode == "feed" else ""}" data-note="10000" style="{"" if mode != "feed" else ""}">{NOTE}</button>', 96, 138, 'hover' if mode == 'hover' else None)
cell('chev', f'<button class="note" style="{BARE}">{CHEV}</button>', 96, 138)
cell('steel', '<div id="cab" style="width:800px; height:156px; margin:0; display:block"></div>', 800, 156)

page = f'''<!doctype html><html><head><meta charset="utf-8"><base href="file://{WEB}/"><style>{css}
html, body {{ background:transparent !important; margin:0; }} *, *::before, *::after {{ animation:none !important; transition:none !important; }}
.w {{ position:absolute; --key:64px; --gap:10px; width:auto !important; max-width:none !important; padding:0 !important; margin:0 !important; border:0 !important;
  background:none !important; box-shadow:none !important; display:block !important; container-type:normal !important; }}
.w > .cb, .w > .note {{ position:relative; }}
</style></head><body>{''.join(html)}</body></html>'''
# the fascia's cell is its own grid: give it room (steel is the last cell, on a row of its own)
name, x, y, w, h, mode = cells[-1]; y = ((len(cells) - 2) // 8 + 1) * CELL * 2; cells[-1] = (name, 0, y, w, h, mode)
page = page.replace(html[-1], f'<div id="cab" class="w" style="left:{M}px; top:{y + M}px">' + html[-1].split('">', 1)[1])
with sync_playwright() as pw:
    b = pw.chromium.launch(); p = b.new_page(viewport={'width': 8 * CELL * 2, 'height': y + 156 + 2 * M + 10}, device_scale_factor=Z, reduced_motion='reduce')
    # from a file, so the fascia's url(ui/steel.jpg) loads (a page set from a string is about:blank and may not read files)
    with tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8') as f: f.write(page)
    p.goto('file://' + f.name); p.wait_for_load_state('load'); p.evaluate('document.fonts.ready'); os.unlink(f.name)
    def shot(x, y, w, h):
        return Image.open(io.BytesIO(p.screenshot(clip={'x': x, 'y': y, 'width': w + 2 * M, 'height': h + 2 * M}, omit_background=True))).convert('RGBA')
    pieces = []
    for name, x, y, w, h, mode in cells:
        if mode: p.mouse.move(x + M + w / 2, y + M + h / 2)
        if mode == 'active': p.mouse.down()
        im = shot(x, y, w, h)
        if mode == 'active': p.mouse.up()
        if mode: p.mouse.move(0, 0)
        bb = im.getbbox() or (0, 0, 1, 1); pieces.append((name, im.crop(bb), bb[0] - round(M * Z), bb[1] - round(M * Z)))
    b.close()
# shelf packing, tallest first
AW = 2048; X = Yp = row = 0; out = {}; place = []
for name, im, ox, oy in sorted(pieces, key=lambda t: -t[1].height):
    if X + im.width + 2 > AW: X = 0; Yp += row + 2; row = 0
    place.append((name, im, X, Yp)); out[name] = {'x': X, 'y': Yp, 'w': im.width, 'h': im.height, 'ox': ox, 'oy': oy}; X += im.width + 2; row = max(row, im.height)
atlas = Image.new('RGBA', (AW, Yp + row + 2), (0, 0, 0, 0))
for name, im, X, Yp in place: atlas.paste(im, (X, Yp))
atlas.save(os.path.join(ROOT, 'assets', 'webpanel.png'), optimize=True)
json.dump({'source': 'tools/import-webpanel.py', 'scale': Z, 'pieces': out}, open(os.path.join(ROOT, 'assets', 'webpanel.json'), 'w'), separators=(',', ':'))
print('atlas', atlas.size, 'pieces', len(out))
