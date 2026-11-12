#!/usr/bin/env node
// Server-side screenshots for games.html: boots each ROM headless (like web/js/shot-worker.js), plays one spin and saves the finished
// frame as data/games/<id>/shot.png (640x480) with meta.json "shot": {at, w, h, by: "server"} (the store server.py serves at /api/games).
// It also caches the game's marquee (the ROM's attract art, IMG_ATTRACT and look-alikes) as data/games/<id>/marquee.png; play.html shows it on the loading screen.
// A ROM without attract art gets no marquee file: the loading screen shows the game title until play.html has cached one.
// usage: node tools/shots.js [romsDir] [name-filter]   env: ARISTO_DATA (default data/), JOBS=4, ALL=1 (redo games that have a screenshot),
//        ONLY=<game id>[,<id>] or * (just those games or all, redone even if they have a screenshot), MARQUEE_ONLY=1 (cache missing marquees only: no spin, no new screenshots),
//        STALE=1 (also redo screenshots taken by other code, tools/engine.js, at least MIN_AGE_H=24 hours ago, oldest first; FORCE=1 drops the age rule)
const fs = require('fs'), path = require('path'), zlib = require('zlib'), cp = require('child_process');
const R = path.join(__dirname, '..');
const ENGINE = require('./engine.js').engine();
const DATA = process.env.ARISTO_DATA || path.join(R, 'data');
const IMG = process.env.ARISTO_IMG || null;   // images in <ARISTO_IMG>/<id>/ instead of data/games/<id>/ (server.py does the same)
const imgDir = id => IMG ? path.join(IMG, id) : path.join(DATA, 'games', id);
const slug = n => n.toLowerCase().replace(/\.zip$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const validMap = m => m && m.state && m.stopBuf && m.starter && Object.keys(m.lineKeys || {}).length && Object.keys(m.betKeys || {}).length;

function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', data); fs.renameSync(file + '.tmp', file);
}

// one ROM, in its own process (a hung VM call cannot stall the others)
async function one(zip) {
  const MK6 = require(R + '/web/js/mk6.js'), { VM } = require(R + '/web/js/mk6vm.js'), { Host } = require(R + '/web/js/mk6host.js'), RD = require(R + '/web/js/mk6render.js');
  console.warn = () => {};
  const id = slug(path.basename(zip)), mapFile = R + '/web/maps/' + id + '.json', cached = R + '/tools/cache/maps/' + id + '.json';
  const map = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile)) : fs.existsSync(cached) ? JSON.parse(fs.readFileSync(cached)) : null;
  const rom = await MK6.openZip(fs.readFileSync(zip));
  const vm = new VM(rom, { syscalls: require(R + '/tools/data/syscalls.json'), exports: require(R + '/tools/data/exports.json'), options: { lineIdx: map?.lineIdx ?? 1, betIdx: map?.betIdx ?? 0 } });
  if (vm.preload) await vm.preload();
  const dir = path.join(DATA, 'games', id);
  // marquee: the same image play.html puts behind the title (RD.marquee); it needs only the ROM, so a game without a map still gets one
  { const im = await RD.marquee(vm).catch(() => null);
    if (im) writeAtomic(path.join(imgDir(id), 'marquee.png'), png(new Uint8ClampedArray(im.rgba.buffer, im.rgba.byteOffset, im.w * im.h * 4), im.w, im.h)); }
  if (!validMap(map)) throw new Error('no map');
  if (process.env.MARQUEE_ONLY) return;
  const lines = Math.max(...Object.keys(map.lineKeys).map(Number)), bet = +Object.keys(map.betKeys)[0] || 1;
  const h = new Host(vm, { map, lines, bet, fast: true, credits: 100000 });
  h.init(map.lineIdx ?? 1, map.betIdx ?? 0, h.bestRtpSet());
  let k = 0;
  // idle, one spin (reels show their stops), then let the ROM redraw the background and indicators after the result
  for (; k < 60; k++) h.frame();
  h.credits = 100000;
  if (h.spin()) { k = 0; while (h.frame() && k++ < 40000); }
  for (k = 0; k < 300; k++) h.frame();
  const rgba = await RD.compose(vm);
  writeAtomic(path.join(imgDir(id), 'shot.png'), png(rgba, 640, 480));
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'))); } catch (e) {}
  meta.shot = { at: Math.floor(Date.now() / 1000), w: 640, h: 480, by: 'server', engine: ENGINE };
  writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
}

if (process.argv[2] === '--one') {
  one(process.argv[3]).then(() => process.exit(0), e => { console.error(String(e && e.message || e).slice(0, 200)); process.exit(1); });
} else {
  const dir = process.argv[2] || path.join(R, 'roms'), filter = (process.argv[3] || '').toLowerCase(), JOBS = +process.env.JOBS || 4;
  const has = id => (process.env.MARQUEE_ONLY ? ['marquee.png', 'marquee.jpg'] : ['shot.png', 'shot.jpg']).some(f => fs.existsSync(path.join(imgDir(id), f)));
  const only = process.env.ONLY && new Set(process.env.ONLY.split(','));
  const shotMeta = id => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'games', id, 'meta.json'))).shot || {}; } catch (e) { return {}; } };
  const now = Date.now() / 1000, minAge = +(process.env.MIN_AGE_H ?? 24) * 3600;
  const stale = id => { const m = shotMeta(id); return process.env.STALE === '1' && m.engine !== ENGINE && (process.env.FORCE === '1' || now - (m.at || 0) >= minAge); };
  const zips = fs.readdirSync(dir).filter(f => /\.zip$/i.test(f) && f.toLowerCase().includes(filter))
    .filter(f => only ? only.has('*') || only.has(slug(f)) : process.env.ALL || !has(slug(f)) || stale(slug(f)))
    .sort((a, b) => (shotMeta(slug(a)).at || 0) - (shotMeta(slug(b)).at || 0)).map(f => path.join(dir, f));
  console.log(`[shots] ${zips.length} ROMs to capture, ${JOBS} at a time, into ${DATA}`);
  let next = 0, live = 0, ok = 0, bad = 0;
  const run = () => {
    while (live < JOBS && next < zips.length) {
      const zip = zips[next++]; live++;
      cp.execFile(process.execPath, [__filename, '--one', zip], { timeout: 180000 }, (err, out, errOut) => {
        live--;
        if (err) { bad++; console.log(`[shots] ${path.basename(zip)}: failed ${(errOut || err.message).trim().slice(0, 120)}`); }
        else { ok++; console.log(`[shots] ${path.basename(zip)}: ok`); }
        if (next < zips.length) run(); else if (!live) console.log(`[shots] done: ${ok} saved, ${bad} failed`);
      });
    }
  };
  run();
}
