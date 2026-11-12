// Cabinet light show on an addressable strip: game events from the host pick an effect, played through the button-lamp driver layer (leds.js).
// Events come from what Host already tracks, so the ROM is not touched: attract (idle N s or no credit), credit, spin, reelstop (play.html's reel
// tracker), win (scaled by win / cost into small, medium, big), feature (free games start), free (each free game), featureEnd, gamble, jackpot.
// Effects are WLED presets (driver.preset) or a built-in pattern rendered here and streamed with driver.pixels(rgb, offset). A driver with neither
// (serial, PacDrive) ignores the show. Opt-in like leds.js: play.html builds a LightShow only from a saved config (localStorage mk6-lightshow).
(function (root) {
  'use strict';
  // config: { pixels, offset, idleSecs, theme: [r,g,b], win: { medium, big } (x bet), events: { name: { preset } | { pattern, color, speed, ms } } }
  const DEFAULT_SHOW = { pixels: 60, offset: 0, idleSecs: 60, theme: [255, 160, 0], win: { medium: 5, big: 20 },
    events: { attract: { pattern: 'rainbow', speed: 0.2 }, idle: { pattern: 'solid', color: 'theme', bri: 0.15 }, credit: { pattern: 'flash', color: [0, 255, 0], ms: 600 },
      spin: { pattern: 'chase', color: 'theme', speed: 2 }, reelstop: { pattern: 'flash', color: [255, 255, 255], ms: 120 },
      winSmall: { pattern: 'pulse', color: [255, 200, 0], ms: 1500 }, winMedium: { pattern: 'chase', color: [255, 120, 0], speed: 3, ms: 3000 }, winBig: { pattern: 'rainbow', speed: 1.5, ms: 6000 },
      feature: { pattern: 'flash', color: [255, 0, 255], ms: 2000 }, free: { pattern: 'chase', color: [160, 0, 255], speed: 1 }, featureEnd: { pattern: 'pulse', color: [255, 0, 255], ms: 2000 },
      gamble: { pattern: 'alt', color: [255, 0, 0], color2: [0, 0, 0], speed: 2 }, jackpot: { pattern: 'rainbow', speed: 3, ms: 10000 }, off: { pattern: 'solid', color: [0, 0, 0] } } };
  const hsv = h => { const f = (n, k = (n + h * 6) % 6) => 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))); return [f(5), f(3), f(1)]; };
  // built-in patterns: (t ms since start, i pixel, n pixels, e effect, col its colour) -> [r, g, b]
  const PATTERNS = {
    solid: (t, i, n, e, c) => c.map(v => v * (e.bri ?? 1)),
    flash: (t, i, n, e, c) => (Math.floor(t / 125) & 1 ? [0, 0, 0] : c),
    pulse: (t, i, n, e, c) => c.map(v => v * (0.5 - 0.5 * Math.cos(t / 1000 * Math.PI * 2 * (e.speed || 1)))),
    chase: (t, i, n, e, c) => ((i + Math.floor(t / 1000 * (e.speed || 1) * n / 4)) % 6 < 2 ? c : c.map(v => v * 0.08)),
    alt: (t, i, n, e, c) => ((i + Math.floor(t / 1000 * (e.speed || 1) * 2)) & 1 ? c : (e.color2 || [0, 0, 0])),
    rainbow: (t, i, n, e) => hsv((i / n + t / 1000 * (e.speed || 0.5)) % 1),
  };
  // the effect for a win: thresholds in multiples of the bet, by design (small, medium, big)
  const winEvent = (win, cost, th) => { const x = cost > 0 ? win / cost : 0; return x >= th.big ? 'winBig' : x >= th.medium ? 'winMedium' : 'winSmall'; };

  class LightShow {
    constructor(driver, cfg, opts = {}) { this.driver = driver; this.cfg = Object.assign({}, DEFAULT_SHOW, cfg || {}); this.cfg.events = Object.assign({}, DEFAULT_SHOW.events, (cfg || {}).events); this.cfg.win = Object.assign({}, DEFAULT_SHOW.win, (cfg || {}).win);
      this.now = opts.now || (() => (root.performance || Date).now()); this.base = 'idle'; this.cur = null; this.until = 0; this.t0 = 0; this.lastFrame = ''; this.busy = false; this.log = []; this.idleSince = this.now(); }
    color(c) { return c === 'theme' || !c ? this.cfg.theme : c; }
    // fire an event: a timed effect (ms) plays over the base one and then gives way; an untimed one becomes the new base (spin, free, gamble, attract)
    fire(name, extra) { const e = this.cfg.events[name]; this.log.push(name); if (this.log.length > 50) this.log.shift(); if (!e) return false;
      const t = this.now(); if (name !== 'attract') this.idleSince = t; if (e.ms) { this.cur = name; this.until = t + e.ms; } else { this.base = name; this.cur = null; }
      this.t0 = t; this.lastFrame = ''; if (e.preset !== undefined && this.driver.preset) Promise.resolve(this.driver.preset(e.preset)).catch(() => {}); return true; }
    win(win, cost) { if (this.cur === 'jackpot' && this.now() < this.until) return true; return win > 0 && this.fire(winEvent(win, cost, this.cfg.win)); }   // the jackpot's own show plays out over the game's win
    active() { if (this.cur && this.now() >= this.until) { this.cur = null; this.t0 = this.now(); this.lastFrame = ''; } return this.cur || this.base; }
    // pixels for the active effect at time t (Uint8Array, 3 bytes a pixel); null for a preset effect (WLED plays it)
    frame(t = this.now()) { const name = this.active(), e = this.cfg.events[name]; if (!e || e.preset !== undefined) return null; const p = PATTERNS[e.pattern] || PATTERNS.solid, n = this.cfg.pixels | 0, c = this.color(e.color), rgb = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { const v = p(t - this.t0, i, n, e, c); rgb[i * 3] = v[0]; rgb[i * 3 + 1] = v[1]; rgb[i * 3 + 2] = v[2]; } return rgb; }
    // per-frame: attract after idleSecs at idle, then stream the pattern (only changed frames; one write in flight at a time, so a slow WLED drops frames)
    tick(idle) { const t = this.now(); if (idle && this.base === 'idle' && !this.cur && t - this.idleSince > this.cfg.idleSecs * 1000) this.fire('attract');
      if (!this.driver.pixels || this.busy) return; const rgb = this.frame(t); if (!rgb) return; const sig = rgb.join(); if (sig === this.lastFrame) return; this.lastFrame = sig;
      this.busy = true; Promise.resolve(this.driver.pixels(rgb, this.cfg.offset | 0)).catch(() => {}).finally(() => { this.busy = false; }); }
  }
  // Watches a Host frame by frame and fires the events; play.html calls watch() after each host.frame() and reelStop() from its reel tracker
  class HostEvents {
    constructor(host, show) { this.host = host; this.show = show; this.phase = null; this.inFree = false; this.gameNo = 0; this.credits = host.credits; this.gamble = false; this.jp = this.levels(); }
    // progressive levels (jackpot.js: meter 0x95 + 2i): a hit resets a level to its start value, the only time one falls
    levels() { const m = this.host.vm && this.host.vm.meters; return m ? [0, 1, 2, 3].map(i => m.get(0x95 + 2 * i) | 0) : []; }
    // reel stops: the ROM plays one sound scene per reel as it stops (vm.sound.play); wrap the player installed by emusound.js. In the
    // sound records of all 120 ROMs the sound is 'reel_clink'
    // (119 ROMs; Ruby Magic and Wild Ways also have 'SND_whirring_clink'), once per reel 463 ms apart. A REEL + STOP name test matches
    // none of those (only HL_CASHBOX_REEL_STOP in one Queen Of The Nile family ROM has both words). So clink first, REEL + STOP kept as a fallback
    static isReelStop(name) { return /clink/i.test(name || '') || (/reel/i.test(name || '') && /stop/i.test(name || '')); }
    hookSounds(vm) { const snd = vm.sound; if (!snd || snd.lightshow) return; const play = snd.play.bind(snd); snd.lightshow = true;
      snd.play = (rec, scene, info) => { if (rec && HostEvents.isReelStop(rec.name)) this.reelStop(); return play(rec, scene, info); }; }
    watch() { const h = this.host, s = this.show, jp = this.levels(); if (jp.some((v, i) => v < (this.jp[i] | 0))) s.fire('jackpot'); this.jp = jp;
      if (h.credits > this.credits && !h.phase && !this.phase) s.fire('credit');   // not the win a game just paid in (phase ended this frame)
      this.credits = h.credits;
      if (h.phase === 'spinning' && this.phase !== 'spinning' && !h.inFree) s.fire('spin');
      if (h.inFree && !this.inFree) s.fire('feature'); else if (h.inFree && (h.gameNo | 0) !== this.gameNo) s.fire('free');
      if (!h.inFree && this.inFree) s.fire('featureEnd');
      if (!!(h.gamble && h.gamble.screen) !== this.gamble) { this.gamble = !!(h.gamble && h.gamble.screen); s.fire(this.gamble ? 'gamble' : 'idle'); }
      if (this.phase && !h.phase && h.last) { if (!s.win(h.last.win, h.last.cost)) s.fire('idle'); else s.base = 'idle'; }   // game over: the win effect plays, then idle underneath
      this.phase = h.phase; this.inFree = !!h.inFree; this.gameNo = h.gameNo | 0; s.tick(!h.phase); }
    reelStop() { this.show.fire('reelstop'); }
    jackpot() { this.show.fire('jackpot'); }
  }
  const api = { DEFAULT_SHOW, PATTERNS, LightShow, HostEvents, winEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6SHOW = api;
})(typeof window !== 'undefined' ? window : globalThis);
