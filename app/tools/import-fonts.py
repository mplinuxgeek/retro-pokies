#!/usr/bin/env python3
"""Rasterises the fonts the desktop player draws with into one glyph atlas: assets/fonts.png (white glyphs, coverage in alpha) and
assets/fonts.json (per font: size, ascent, descent, and per character [x, y, w, h, ox, oy, adv], the glyph's offset from the pen on the
baseline). The faces are the web build's (Bungee for titles, Share Tech Mono for the LCD; retro-pokies/web/fonts, SIL OFL) and Noto Sans
for the interface text, Liberation Sans for the control panel keys, with DejaVu Sans for the few symbols Noto Sans lacks. Their licences are copied to assets/fonts/.
usage: python3 tools/import-fonts.py [retro-pokies folder]"""
import sys, os, json, shutil
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..')
RP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..')
WF = os.path.join(RP, 'web', 'fonts'); NOTO = '/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf'
LSB = '/usr/share/fonts/liberation-sans-fonts/LiberationSans-Bold.ttf'
DJ = {'Regular': '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf', 'Bold': '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf'}
TEXT = ''.join(chr(c) for c in range(32, 127)) + '·…×›'; SYMBOLS = '★☆☰←→↑↓✓'
# name: (file, size in screen pixels (the screen is drawn at twice the game's 640 x 480), Noto weight)
FONTS = {
    'title': (os.path.join(WF, 'Bungee-Regular-latin.woff2'), 68, None),
    'brand': (os.path.join(WF, 'Bungee-Regular-latin.woff2'), 52, None),
    'lcd': (os.path.join(WF, 'ShareTechMono-Regular-latin.woff2'), 44, None),
    'lcds': (os.path.join(WF, 'ShareTechMono-Regular-latin.woff2'), 21, None),
    # the control panel keys (play.html: 800 "Arial Narrow"; Chromium draws Liberation Sans, as Arial, when Arial Narrow is not installed) at 1.6 screen pixels per CSS pixel, the
    # panel's scale: label 0.18 of the 64 px key, the big number 0.28, the small print 0.125, SPIN / AUTO 0.27, prompt keys 0.16, a labelled
    # play key's name 0.82 of the big size; the note acceptor's value (800 15px Arial)
    'kb': (LSB, 18.43, None), 'kbig': (LSB, 28.67, None), 'ksm': (LSB, 12.8, None), 'kspin': (LSB, 27.65, None), 'kfk': (LSB, 16.38, None),
    'ksp': (LSB, 23.51, None), 'nem': (LSB, 24, None),
    'ui': (NOTO, 28, 'Regular'), 'uis': (NOTO, 24, 'Regular'), 'uib': (NOTO, 30, 'Bold'), 'uisb': (NOTO, 22, 'SemiBold'), 'big': (NOTO, 40, 'Bold'),
}

def face(file, size, weight):
    f = ImageFont.truetype(file, size)
    if weight: f.set_variation_by_name(weight)
    return f

glyphs, out = [], {}
for name, (file, size, weight) in FONTS.items():
    f = face(file, size, weight); asc, desc = f.getmetrics()
    sym = face(DJ['Bold' if weight in ('Bold', 'SemiBold') else 'Regular'], round(size * 0.9), None) if weight else None
    out[name] = {'size': size, 'asc': asc, 'desc': desc, 'glyphs': {}}
    for ch in TEXT + (SYMBOLS if sym else ''):
        ff = sym if ch in SYMBOLS else f
        if ch not in TEXT and ff is f: continue
        x0, y0, x1, y1 = ff.getbbox(ch, anchor='ls'); adv = ff.getlength(ch)
        w, h = max(0, x1 - x0), max(0, y1 - y0); im = None
        if w and h:
            im = Image.new('L', (w, h), 0); ImageDraw.Draw(im).text((-x0, -y0), ch, font=ff, fill=255, anchor='ls')
        glyphs.append((name, ch, im, x0, y0, adv))

# shelf packing, tallest first, 2 px apart
AW = 1024; x = y = row = 0; place = {}
for g in sorted(glyphs, key=lambda g: -(g[2].height if g[2] else 0)):
    im = g[2]
    if not im: place[id(g)] = (0, 0); continue
    if x + im.width + 2 > AW: x = 0; y += row + 2; row = 0
    place[id(g)] = (x, y); x += im.width + 2; row = max(row, im.height)
AH = y + row + 2
atlas = Image.new('RGBA', (AW, AH), (255, 255, 255, 0))
for g in glyphs:
    name, ch, im, ox, oy, adv = g; px, py = place[id(g)]
    if im: atlas.paste(Image.merge('RGBA', (Image.new('L', im.size, 255),) * 3 + (im,)), (px, py))
    out[name]['glyphs'][ch] = [px, py, im.width if im else 0, im.height if im else 0, ox, oy, round(adv, 2)]

os.makedirs(os.path.join(ROOT, 'assets', 'fonts'), exist_ok=True)
atlas.save(os.path.join(ROOT, 'assets', 'fonts.png'), optimize=True)
json.dump({'source': 'tools/import-fonts.py', 'w': AW, 'h': AH, 'fonts': out}, open(os.path.join(ROOT, 'assets', 'fonts.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
for src, dst in [(os.path.join(WF, 'OFL-Bungee.txt'), 'OFL-Bungee.txt'), (os.path.join(WF, 'OFL-ShareTechMono.txt'), 'OFL-ShareTechMono.txt'),
                 ('/usr/share/licenses/google-noto-fonts-common/LICENSE', 'OFL-NotoSans.txt'), ('/usr/share/licenses/dejavu-sans-fonts/LICENSE', 'LICENSE-DejaVu.txt'),
                 ('/usr/share/licenses/liberation-sans-fonts/LICENSE', 'OFL-LiberationSans.txt')]:
    if os.path.exists(src): shutil.copy(src, os.path.join(ROOT, 'assets', 'fonts', dst))
    else: print('licence not found:', src)
print('atlas', AW, 'x', AH, 'glyphs', len(glyphs))
