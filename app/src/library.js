// The games list: ROM zips found in the ROM folders, whether this build can play them (a map, not a two-screen touch game) and their card art.
// Art, first hit: <retro-pokies>/data/games/<id>/{marquee,shot}.{jpg,png} (made by the web build's tools/shots.js), then the art cache,
// <cache>/art/<id>.png, filled by art-worker.js from the ROM's own attract art (the same MK6RENDER.marquee picture play.html shows).
const fs = require('fs'), path = require('path'), os = require('os'), { Worker } = require('worker_threads');
const { RP, MK6, mapFor, slug } = require('./core.js'), JPEG = require(path.join(RP, 'web', 'js', 'jpeg.js'));

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'retro-pokies-desktop');

// ROM folders, first ones first, duplicates dropped: the folder given, ROMS, ./Roms, ./roms, the web build's roms/,
// then roms and mk6roms in the user's home folder
function romDirs(given) {
  const c = [given, process.env.ROMS, 'Roms', 'roms', path.join(RP, 'roms'), path.join(os.homedir(), 'roms'), path.join(os.homedir(), 'mk6roms')].filter(Boolean).map(d => path.resolve(d));
  return [...new Set(c)].filter(d => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
}

function scan(dirs) {
  const seen = new Map();
  for (const d of dirs) for (const f of fs.readdirSync(d)) {
    if (!/\.zip$/i.test(f)) continue;
    const id = slug(f); if (seen.has(id)) continue;
    const map = mapFor(id);
    seen.set(id, { id, name: f.replace(/\.zip$/i, ''), zip: path.join(d, f), ok: !!map && !map.touch, why: !map ? 'not supported' : map.touch ? 'touch game' : '' });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

async function decode(file) {
  const b = new Uint8Array(fs.readFileSync(file));
  return b[0] === 0xff ? JPEG.decodeJpeg(b) : await MK6.decodePngRGBA(b);
}

// card art: loads what exists, asks the worker (one at a time, low priority) for the rest; onArt(game) when a picture arrives
class Art {
  constructor(onArt) { this.onArt = onArt; this.queue = []; this.busy = null; this.worker = null; }
  file(g) {
    for (const n of ['marquee.jpg', 'marquee.png', 'shot.jpg', 'shot.png']) { const f = path.join(RP, 'data', 'games', g.id, n); if (fs.existsSync(f)) return f; }
    const f = path.join(CACHE, 'art', g.id + '.png'); return fs.existsSync(f) ? f : null;
  }
  // the card will be on screen: its art loaded now when there is a file for it (the boot screen waits, so the cards are drawn once, with it)
  async ready(g) {
    if (g.art !== undefined || g.loading) return; const f = this.file(g); if (!f) return;
    g.loading = true; try { g.art = await decode(f) || null; } catch (e) { g.art = null; } g.loading = false;
  }
  want(g) {   // the card is on screen
    if (g.art !== undefined || g.loading) return;
    const f = this.file(g); g.loading = true;
    if (f) decode(f).then(im => { g.art = im || null; g.loading = false; this.onArt(g); }, () => { g.art = null; g.loading = false; });
    else { this.queue.push(g); this.next(); }
  }
  // paused while a game loads or plays: the worker's ROM work would slow the game (a handheld has few cores); the ROM it was on goes back on the queue
  pause(on) {
    this.paused = on; if (!on) return this.next();
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.busy) { this.queue.unshift(this.busy); this.busy = null; }
  }
  next() {
    if (this.paused || this.busy || !this.queue.length) return;
    if (!this.worker) {
      const w = this.worker = new Worker(path.join(__dirname, 'art-worker.js'), { workerData: { cache: path.join(CACHE, 'art') } });
      w.unref();
      // a reply from a worker stopped by pause() is dropped: its ROM is back on the queue
      w.on('message', ({ id, ok }) => { if (w !== this.worker || !this.busy) return; const g = this.busy; this.busy = null; g.loading = false;
        if (ok) this.want(g); else g.art = null;
        this.next(); });
      w.on('error', () => { if (w !== this.worker) return; if (this.busy) { this.busy.loading = false; this.busy.art = null; } this.busy = null; this.worker = null; this.next(); });
    }
    this.busy = this.queue.pop();   // the newest request first: the cards just scrolled to
    this.worker.postMessage({ id: this.busy.id, zip: this.busy.zip });
  }
  close() { this.queue.length = 0; if (this.worker) this.worker.terminate(); this.worker = null; }
}

module.exports = { CACHE, romDirs, scan, Art, decode };
