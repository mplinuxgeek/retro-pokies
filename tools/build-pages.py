#!/usr/bin/env python3
"""Static build for GitHub Pages (or any HTTPS static host): copies web/ to dist/pages/ without the developer pages, adds the web app manifest,
icons, the service worker (deploy/pages/sw.js, with the file list and a version hash filled in) and pwa.js to every page.

Publish only dist/pages/, for example in its own repository (tools/build-pages.py && cd dist/pages && git init ...).
No ROMs are copied: players add their own in the browser (romstore.js).
Test locally with: python3 -m http.server -d dist/pages 8080, then open http://localhost:8080/ (localhost counts as a secure context)."""
import hashlib, json, os, re, shutil, sys
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WEB, TPL = os.path.join(ROOT, 'web'), os.path.join(ROOT, 'deploy', 'pages')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'dist', 'pages')
SKIP = {'debug.html', 'js/scan-worker.js'}   # the debug (ROM scan) page, LAN only
HEAD = ('<link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#0c0703">'
        '<link rel="apple-touch-icon" href="icons/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes">'
        '<meta name="mobile-web-app-capable" content="yes"><script src="pwa.js"></script>')
SERVER_NOTE = "ROMs in the server's <code>roms/</code> folder show up by themselves."
STATIC_NOTE = "They are saved in this browser only (nothing is uploaded) and are still here next time; use <b>Remove from this browser</b> on a game to delete its copy."

def trim_catalogue(text):
    """Published games.json: only what games.html and play.html read (id, title, zip name and size to match a player's zip, reel count for the card
    subtitle; profiles: id/title/zip). ROM-derived metadata (symbols, strip lengths, pay values, status, reasons) is dropped if a fuller catalogue is laid over web/games.json (the repository's copy is already in this trimmed form)."""
    d = json.loads(text)
    games = []
    for g in d.get('games', []):
        t = {k: g[k] for k in ('id', 'title', 'zip', 'size') if k in g}
        n = len((g.get('found') or {}).get('strip_lengths') or [])
        if n: t['found'] = {'reels': n}
        games.append(t)
    profiles = [{k: p[k] for k in ('id', 'title', 'zip') if k in p} for p in d.get('profiles', [])]
    return json.dumps({'profiles': profiles, 'games': games}, separators=(',', ':'), ensure_ascii=False) + '\n'

def main():
    if os.path.exists(OUT) and os.listdir(OUT) and not os.path.exists(os.path.join(OUT, 'sw.js')): sys.exit('%s exists and is not a previous build; refusing to write into it' % OUT)
    old = set()   # files of an earlier build: overwritten, never deleted here (stale ones are listed, not deleted)
    if os.path.exists(OUT):
        for d, ds, fs in os.walk(OUT):
            ds[:] = [x for x in ds if x != '.git']
            old |= {os.path.relpath(os.path.join(d, f), OUT).replace(os.sep, '/') for f in fs}
    os.makedirs(OUT, exist_ok=True)
    files = []
    for d, ds, fs in os.walk(WEB):
        rel = os.path.relpath(d, WEB).replace(os.sep, '/'); rel = '' if rel == '.' else rel + '/'
        ds[:] = [x for x in ds if rel + x not in SKIP and x != '__pycache__']
        for f in fs:
            r = rel + f
            if r in SKIP: continue
            os.makedirs(os.path.join(OUT, rel), exist_ok=True)
            src, dst = os.path.join(d, f), os.path.join(OUT, r)
            if f.endswith('.html'):
                s = open(src, encoding='utf-8').read()
                m = re.search(r'<link rel="icon"[^>]*>', s)
                s = s[:m.end()] + HEAD + s[m.end():] if m else s.replace('<head>', '<head>' + HEAD, 1)
                s = s.replace(SERVER_NOTE, STATIC_NOTE)
                open(dst, 'w', encoding='utf-8').write(s)
            elif r == 'games.json': open(dst, 'w', encoding='utf-8').write(trim_catalogue(open(src, encoding='utf-8').read()))
            else: shutil.copy2(src, dst)
            files.append(r)
    os.makedirs(os.path.join(OUT, 'icons'), exist_ok=True)
    ico = Image.open(os.path.join(WEB, 'favicon.png')).convert('RGBA')
    for n in (192, 512): ico.resize((n, n), Image.LANCZOS).save(os.path.join(OUT, 'icons', 'icon-%d.png' % n))
    m = Image.new('RGBA', (512, 512), (12, 7, 3, 255)); m.alpha_composite(ico.resize((360, 360), Image.LANCZOS), (76, 76))   # maskable: art inside the safe circle
    m.save(os.path.join(OUT, 'icons', 'icon-maskable-512.png'))
    for f in ('manifest.webmanifest', 'pwa.js', 'NOTICE.md', 'README.md'): shutil.copy2(os.path.join(TPL, f), os.path.join(OUT, f))
    shutil.copy2(os.path.join(ROOT, 'LICENSE'), os.path.join(OUT, 'LICENSE'))
    files += ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'manifest.webmanifest', 'pwa.js', 'NOTICE.md', 'README.md', 'LICENSE', './']
    files.sort()
    h = hashlib.sha1()
    for r in files:
        if r != './': h.update(r.encode()); h.update(open(os.path.join(OUT, r), 'rb').read())
    sw = open(os.path.join(TPL, 'sw.js'), encoding='utf-8').read().replace('__VERSION__', h.hexdigest()[:12]).replace('__FILES__', json.dumps(files))
    open(os.path.join(OUT, 'sw.js'), 'w', encoding='utf-8').write(sw)
    open(os.path.join(OUT, '.nojekyll'), 'w').close()   # GitHub Pages: serve files as they are
    stale = sorted(old - set(files) - {'sw.js', '.nojekyll'})
    if stale: print('stale files from an earlier build (not in this one; move them out before publishing):\n  ' + '\n  '.join(stale))
    total = sum(os.path.getsize(os.path.join(OUT, r)) for r in files if r != './')
    print('%s: %d files, %.1f MB, version %s' % (OUT, len(files), total / 1e6, h.hexdigest()[:12]))

if __name__ == '__main__': main()
