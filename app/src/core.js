// The engine is not copied: it is loaded from this repository's web/js folder, so the desktop build and the web player always run the
// same code. openGame() boots a ROM zip with its map the way play.html does: VM, Host, power-up, default bet.
const fs = require('fs'), path = require('path');
const RP = path.join(__dirname, '..', '..');
const js = n => require(path.join(RP, 'web', 'js', n));
const MK6 = js('mk6.js'), { VM } = js('mk6vm.js'), { Host } = js('mk6host.js'), RD = js('mk6render.js'), T = js('mk6tables.js'), D = js('denoms.js');

const slug = n => path.basename(n).replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mapFor = id => { const f = path.join(RP, 'web', 'maps', id + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };

// PNG and JPEG decoding spread over worker threads (one core left for the rest): a handheld's launch is mostly image decoding
let pool = null;
// a handheld with 1 GB (and EmulationStation holding a third of it) has no room for the pool's threads: their heaps came to about 100 MB
const LOW_MEM = require('os').totalmem() < 1.5 * 2 ** 30;
function decoders() {
  if (pool) return pool;
  const { Worker } = require('worker_threads'), n = Math.max(1, Math.min(3, require('os').cpus().length - 1)), wait = new Map(); let seq = 0, next = 0;
  const ws = Array.from({ length: n }, () => { const w = new Worker(path.join(__dirname, 'decode-worker.js'));
    w.on('message', ({ n, im, err }) => { const p = wait.get(n); wait.delete(n); if (!wait.size) ws.forEach(w => w.unref()); if (err) p[1](new Error(err)); else p[0](im); }); w.unref(); return w; });   // held (ref) only while decoding, so they never keep the app from exiting; unref after on(), which refs again
  const run = png => b => new Promise((ok, no) => { const k = seq++; if (!wait.size) ws.forEach(w => w.ref()); wait.set(k, [ok, no]); const c = b.slice(); ws[next++ % n].postMessage({ n: k, png, b: c }, [c.buffer]); });   // its own copy: a view would send the whole ROM
  return (pool = { png: run(true), jpeg: run(false) });
}

async function openGame(zipPath, opts = {}) {   // opts.fast: wins are collected at once (no take-win prompt), as the scanner plays; opts.denom: cents per credit (default: the map's); opts.rtp: the RTP set (default: the game's best, as play.html)
  const id = slug(zipPath), map = mapFor(id);
  if (!map) throw new Error('no map for ' + id);
  if (map.touch) throw new Error(id + ' is a two-screen touch game, not supported yet');
  const step = opts.progress || (() => {});   // opts.progress(fraction, text, force): awaited at each step (a loading screen)
  await step(0, 'Reading the ROM'); const zip = fs.readFileSync(zipPath);
  await step(0.05, 'Unzipping (' + (zip.length / 1048576).toFixed(1) + ' MB)'); const rom = await MK6.openZip(zip);
  await step(0.1, 'Reading the game data');
  const vm = new VM(rom, Object.assign({ options: { lineIdx: map.lineIdx ?? 1, betIdx: map.betIdx ?? 0, ...(D.maxCost(map) ? { denom: opts.denom || D.forMap(map).def } : {}) } }, T));
  // all images decoded before power-up, as play.html: the ROM sizes its meter windows from the font images. In parallel on the decoder pool
  const pics = (done, total) => step(0.15 + 0.8 * done / total, 'Decoding the graphics: ' + done + ' of ' + total);
  if (vm.preload && opts.workers !== false && !LOW_MEM) { const p = decoders(); vm.decodePng = p.png; vm.decodeJpeg = p.jpeg; const recs = (vm.db.sections[1] || { recs: [] }).recs; let done = 0;
    try { await Promise.all(recs.map((r, i) => r ? vm.loadImage(i).then(x => { pics(++done, recs.length); return x; }) : (++done, null))); } finally { delete vm.decodePng; delete vm.decodeJpeg; } }
  else if (vm.preload) await vm.preload(pics);
  await step(0.95, 'Starting the game', true);
  const lines = Object.keys(map.lineKeys).map(Number), bets = Object.keys(map.betKeys).map(Number);
  const host = new Host(vm, { map, lines: Math.max(...lines), bet: bets.length ? Math.max(...bets) : 1, fast: !!opts.fast, ...(opts.credits !== undefined ? { credits: opts.credits } : {}), ...(opts.limit ? { limit: opts.limit } : {}) });
  const sets = host.rtpSets(), rtp = sets.some(r => r.set === opts.rtp) ? opts.rtp : host.bestRtpSet(sets); host.init(map.lineIdx ?? 1, map.betIdx ?? 0, rtp);   // max lines, max bet, as play.html (a design choice; the ROM preselects the lowest bet)
  vm.reuseOut = true;   // one picture for every frame: the app is done with each before the next
  return { id, zip: zipPath, map, vm, host, denom: vm.options.denom || 0, rtpSets: sets, rtp, frame: () => RD.compose(vm) };   // frame(): Promise of the 640 x 480 RGBA picture
}

module.exports = { RP, MK6, VM, RD, T, D, mapFor, openGame, slug, W: 640, H: 480, FRAME_MS: 33.07 / 2 };
