// Sound: the web build's own players (web/js/audio.js: plain WAV, the MIDI sampler, the ROM's compiled voice bank; web/js/emusound.js: which
// sound plays when, on which channel) run unchanged over a small stand-in for WebAudio: buffer sources and gain nodes with their timed
// ramps, mixed here in JS and queued to an SDL playback device. Each game gets fresh copies of the two players (audio.js keeps its sounds
// by name, and names repeat between ROMs); the mixer and the device are shared.
const fs = require('fs'), path = require('path');
const { RP } = require('./core.js');
const SB = require(path.join(RP, 'web', 'js', 'sndbank.js'));
const AUDIO_JS = fs.readFileSync(path.join(RP, 'web', 'js', 'audio.js'), 'utf8'), EMUSOUND_JS = fs.readFileSync(path.join(RP, 'web', 'js', 'emusound.js'), 'utf8');

const RATE = 24000;          // the ROMs' sounds are 21484 and 24170 Hz (one 11111 Hz)
const CHUNK = 240;           // frames mixed at a time (10 ms)
// chunks kept queued: few, as a sound is heard only after the queue ahead of it; a queue that runs dry while something plays grows by two
// (the game's frames are slower than they should be), and shrinks back by one after 10 s without that
const AHEAD_MIN = 4, AHEAD_MAX = 16;

// a WAV file (PCM, 8 or 16 bits) as mono samples
function wav(ab) {
  const v = new DataView(ab), tag = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (ab.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null, p = 12;
  while (p + 8 <= ab.byteLength) {
    const id = tag(p), n = v.getUint32(p + 4, true), o = p + 8;
    if (id === 'fmt ') fmt = { code: v.getUint16(o, true), ch: v.getUint16(o + 2, true), rate: v.getUint32(o + 4, true), bits: v.getUint16(o + 14, true) };
    else if (id === 'data' && fmt) {
      if (fmt.code !== 1 || (fmt.bits !== 8 && fmt.bits !== 16)) throw new Error('WAV format ' + fmt.code + '/' + fmt.bits);
      const bs = fmt.bits / 8, len = Math.floor(Math.min(n, ab.byteLength - o) / (bs * fmt.ch)), b = new Buffer_(1, Math.max(1, len), fmt.rate), d = b.getChannelData(0);
      for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < fmt.ch; c++) { const q = o + (i * fmt.ch + c) * bs; s += bs === 2 ? v.getInt16(q, true) / 32768 : (v.getUint8(q) - 128) / 128; } d[i] = s / fmt.ch; }
      return b;
    }
    p = o + n + (n & 1);
  }
  throw new Error('no WAV data');
}

class Buffer_ {   // AudioBuffer (one channel)
  constructor(ch, length, sampleRate) { this.numberOfChannels = 1; this.length = length; this.sampleRate = sampleRate; this.duration = length / sampleRate; this.data = new Float32Array(length); }
  getChannelData() { return this.data; }
}

// AudioParam: a value with timed changes (set, linear ramp from the change before, exponential approach), read at a time by at(t)
class Param {
  constructor(ctx, v) { this.ctx = ctx; this.v0 = v; this.ev = []; }
  get value() { return this.at(this.ctx.currentTime); }
  set value(v) { this.v0 = v; this.ev = []; }
  add(e) { let i = this.ev.length; while (i && this.ev[i - 1].t > e.t) i--; this.ev.splice(i, 0, e); return this; }
  setValueAtTime(v, t) { return this.add({ k: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { return this.add({ k: 'lin', v, t }); }
  setTargetAtTime(v, t, tau) { return this.add({ k: 'target', v, t, tau: Math.max(1e-4, tau) }); }
  still(t) { return this.ev.every(e => e.t <= t && (e.k !== 'target' || t - e.t > 12 * e.tau)); }   // no change from time t on (an approach is done after 12 time constants)
  cancelScheduledValues(t) { const v = this.at(this.ctx.currentTime); this.ev = this.ev.filter(e => e.t < t); if (!this.ev.length) this.v0 = v; return this; }
  at(t) {
    const ev = this.ev; if (!ev.length) return this.v0;
    let v = this.v0, tp = -Infinity;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.k === 'lin') { if (t < e.t) return tp <= t && tp > -Infinity ? v + (e.v - v) * (t - tp) / (e.t - tp) : v; v = e.v; tp = e.t; continue; }
      if (t < e.t) return v;
      if (e.k === 'set') { v = e.v; tp = e.t; continue; }
      const end = i + 1 < ev.length ? Math.min(t, ev[i + 1].t) : t; v = e.v + (v - e.v) * Math.exp(-(end - e.t) / e.tau); tp = end;
      if (t <= end) return v;
    }
    return v;
  }
}
class Gain { constructor(ctx) { this.ctx = ctx; this.gain = new Param(ctx, 1); this.out = null; } connect(n) { this.out = n; return n; } disconnect() { this.out = null; } }
class Source {   // AudioBufferSourceNode
  constructor(ctx) { this.ctx = ctx; this.buffer = null; this.loop = false; this.playbackRate = new Param(ctx, 1); this.out = null; this.onended = null; this.startF = -1; this.stopF = Infinity; this.pos = 0; this.done = false; }
  connect(n) { this.out = n; return n; }
  disconnect() { this.out = null; }
  start(when = 0) { if (this.startF >= 0) throw new Error('started twice'); this.startF = Math.round(Math.max(when, this.ctx.currentTime) * RATE); this.ctx.mixer.add(this); }
  stop(when = 0) { if (this.startF < 0) throw new Error('not started'); this.stopF = Math.round(Math.max(when, this.ctx.currentTime) * RATE); }
}
// AudioContext for one game's players; close() silences what it made (audio.js's timers may still make more: they are not mixed)
class Context {
  constructor(mixer) { this.mixer = mixer; this.state = 'running'; this.destination = { dest: true }; this.closed = false; }
  get currentTime() { return this.mixer.frames / RATE; }
  get sampleRate() { return RATE; }
  resume() { return Promise.resolve(); }
  createGain() { return new Gain(this); }
  createBufferSource() { return new Source(this); }
  createBuffer(ch, length, rate) { return new Buffer_(ch, length, rate); }
  decodeAudioData(ab) { try { return Promise.resolve(wav(ab)); } catch (e) { return Promise.reject(e); } }
  close() { this.closed = true; this.mixer.drop(this); }
}

class Mixer {
  // open(): a playback device. Silent (volume 0: the games list, Volume off) the device is closed and the mixer keeps time by the clock
  constructor(open) { this.open = open; this.dev = null; this.frames = 0; this.srcs = []; this.volume = 1; this.out = new Float32Array(CHUNK); this.ahead = AHEAD_MIN; this.dryAt = 0; this.quiet = null; this.timer = setInterval(() => this.fill(), 5); this.timer.unref(); }
  add(s) { if (!s.ctx.closed) this.srcs.push(s); }
  drop(ctx) { this.srcs = this.srcs.filter(s => s.ctx !== ctx); }
  fill() {
    const now = performance.now();
    if (this.volume === 0) {
      if (this.dev) { try { this.dev.close(); } catch (e) {} this.dev = null; }
      if (!this.quiet) this.quiet = { at: now, f: this.frames };
      try { while (this.frames < this.quiet.f + ((now - this.quiet.at) / 1000 + AHEAD_MIN * CHUNK / RATE) * RATE) this.mix(); } catch (e) { clearInterval(this.timer); console.error('sound stopped:', e.message); }
      return;
    }
    this.quiet = null;
    let fresh = false;
    if (!this.dev) { try { this.dev = this.open(); this.dev.play(); fresh = true; } catch (e) { clearInterval(this.timer); console.error('sound stopped:', e.message); return; } }
    const q = this.dev.queued;
    if (q === 0 && !fresh && this.srcs.length) { this.ahead = Math.min(AHEAD_MAX, this.ahead + 2); this.dryAt = now; }
    else if (this.ahead > AHEAD_MIN && now - this.dryAt > 10000) { this.ahead--; this.dryAt = now; }
    try { while (this.dev.queued < this.ahead * CHUNK * 4) { this.mix(); this.dev.enqueue(Buffer.from(this.out.buffer.slice(0))); } }
    catch (e) { clearInterval(this.timer); console.error('sound stopped:', e.message); }
  }
  // the next CHUNK frames: each source from its start to its stop or end, linearly interpolated at its rate, times the gains on its way out
  mix() {
    const out = this.out, T = this.frames, ended = []; out.fill(0);
    for (const s of this.srcs) {
      if (s.startF >= T + CHUNK) continue;
      const b = s.buffer && s.buffer.data; if (!b || !b.length) { s.done = true; ended.push(s); continue; }
      const gs = []; for (let n = s.out; n && !n.dest; n = n.out) gs.push(n.gain); const reach = (() => { let n = s.out; while (n && !n.dest) n = n.out; return !!n; })();
      const t0 = T / RATE, len = b.length, inc = s.playbackRate.v0 * s.buffer.sampleRate / RATE, fixed = gs.every(g => g.still(t0)), k0 = fixed ? gs.reduce((a, g) => a * g.at(t0), 1) : 0;
      let i = Math.max(0, s.startF - T), p = s.pos, k = fixed ? k0 : 1; if (!fixed) { k = 1; for (const g of gs) k *= g.at((T + i) / RATE); }
      const end = Math.min(CHUNK, s.stopF - T);
      for (; i < end; i++) {
        let ip = p | 0;
        if (ip >= len) { if (!s.loop) break; p -= len * Math.floor(p / len); ip = p | 0; }
        const nx = ip + 1 < len ? b[ip + 1] : s.loop ? b[0] : b[ip], x = b[ip] + (nx - b[ip]) * (p - ip);
        if (!fixed && !(i & 15)) { const t = (T + i) / RATE; k = 1; for (const g of gs) k *= g.at(t); }   // a changing gain is read every 16 frames (0.7 ms)
        if (reach) out[i] += x * k;
        p += inc;
      }
      s.pos = p;
      if (T + i >= s.stopF || (!s.loop && (p | 0) >= len)) { s.done = true; ended.push(s); }
    }
    if (ended.length) { this.srcs = this.srcs.filter(s => !s.done); for (const s of ended) if (s.onended) setImmediate(() => s.onended()); }
    const v = this.volume; for (let i = 0; i < CHUNK; i++) { const x = out[i] * v; out[i] = x > 1 ? 1 : x < -1 ? -1 : x; }
    this.frames += CHUNK;
  }
  close() { clearInterval(this.timer); this.srcs = []; try { if (this.dev) this.dev.close(); } catch (e) {} this.dev = null; }
}

// sdl: @kmamal/sdl. Returns { attach(vm, host) (a game's sounds; the last game's stop), detach(), volume (0..1, 0 silent) }, or null without a sound device
function create(sdl) {
  let mixer;
  // Batocera's ALSA default device is PipeWire, found through XDG_RUNTIME_DIR (set for games EmulationStation starts, not for a login)
  if (!process.env.XDG_RUNTIME_DIR && fs.existsSync('/var/run/pipewire-0')) process.env.XDG_RUNTIME_DIR = '/var/run';
  const open = () => sdl.audio.openDevice({ type: 'playback' }, { channels: 1, frequency: RATE, format: 'f32', buffered: 512 });
  try { open().close(); mixer = new Mixer(open); }   // a first open tells whether there is a device at all
  catch (e) { console.error('no sound:', e.message); return null; }
  let ctx = null;
  const api = {
    attach(vm, host) {
      api.detach();
      const c = ctx = new Context(mixer), win = { AudioContext: function () { return c; }, SNDBANK: SB };
      new Function('window', AUDIO_JS)(win); new Function('window', 'module', EMUSOUND_JS)(win, undefined);
      win.EMUSOUND.install(vm, host); win.QotnAudio.init();
    },
    detach() { if (ctx) ctx.close(); ctx = null; },
    get volume() { return mixer.volume; }, set volume(v) { mixer.volume = Math.max(0, Math.min(1, v)); },
    close() { api.detach(); mixer.close(); },
    _mixer: mixer,   // tests mix by hand
  };
  return api;
}

module.exports = { create, Mixer, Context, wav, RATE };
