// WebAudio layer: PCM effects + a tiny sampler-based Standard MIDI player using the ROM's own instrument samples
// (samples named <GM program>c<octave> = pitch anchors at note 12*(oct+1); r<key> = percussion).
(function () {
  'use strict';
  let M = window.QOTN_AUDIO, byteFn = null; let ctx = null, master = null, muted = false, volume = 1;     // configure() swaps in a manifest + byte source (the emulator reads sounds straight from the ROM)
  const bufs = {}, midis = {}, loading = {};
  const url = (n, ext) => `${window.GAME_DIR}assets/audio/${n}.${ext}`;

  const MAX_GAIN = 0.75;                  // the slider shows 0..100 % but the master gain tops out here
  const gain = () => muted ? 0 : volume * MAX_GAIN;
  function init() {                       // must be called from a user gesture
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = gain(); master.connect(ctx.destination);
    const names = [...M.sfx, ...Object.values(M.drums), ...Object.values(M.instruments).flat().map(x => x[1])];
    names.forEach(loadBuf);
  }
  const bytes = (n, ext) => byteFn ? Promise.resolve(byteFn(n, ext)) : window.GAME_RES ? GAME_RES.bytes(`audio/${n}.${ext}`).then(u => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)) : fetch(url(n, ext)).then(r => r.arrayBuffer());
  function loadBuf(n) {
    if (bufs[n] || loading[n]) return loading[n];
    return loading[n] = bytes(n, 'wav').then(a => ctx.decodeAudioData(a)).then(b => { bufs[n] = b; }).catch(e => console.warn('audio', n, e));
  }

  function play(name, o = {}) {
    if (!ctx || !bufs[name]) return null;
    const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = bufs[name]; s.loop = !!o.loop; s.playbackRate.value = o.rate || 1;
    g.gain.value = o.gain == null ? 1 : o.gain; s.connect(g); g.connect(master); s.start(o.when || 0);
    return { duration: s.loop ? Infinity : s.buffer.duration / (o.rate || 1), stop(fade = 0.05) { try { g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3); s.stop(ctx.currentTime + fade * 2); } catch (e) {} } };
  }

  // ---- Standard MIDI file ------------------------------------------------------------
  function parseMidi(d) {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let p = 0;
    const str = n => { const s = String.fromCharCode(...d.subarray(p, p + n)); p += n; return s; };
    if (str(4) !== 'MThd') throw new Error('not midi'); p += 4;
    const fmt = v.getUint16(p), ntr = v.getUint16(p + 2), div = v.getUint16(p + 4); p += 6;
    const ev = [], tempos = [[0, 500000]];
    for (let t = 0; t < ntr; t++) {
      if (str(4) !== 'MTrk') break; const len = v.getUint32(p); p += 4; const end = p + len; let tick = 0, run = 0;
      const vlq = () => { let x = 0, b; do { b = d[p++]; x = (x << 7) | (b & 127); } while (b & 128); return x; };
      while (p < end) {
        tick += vlq(); let s = d[p];
        if (s === 0xff) { p++; const type = d[p++], l = vlq(); if (type === 0x51) tempos.push([tick, (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]]); p += l; continue; }
        if (s === 0xf0 || s === 0xf7) { p++; p += vlq(); continue; }
        if (s & 128) { run = s; p++; } else s = run;
        const hi = s >> 4, ch = s & 15;
        if (hi === 0xc || hi === 0xd) { const a = d[p++]; if (hi === 0xc) ev.push({ tick, k: 'pc', ch, a }); }
        else { const a = d[p++], b = d[p++]; if (hi === 9) ev.push({ tick, k: b ? 'on' : 'off', ch, a, b }); else if (hi === 8) ev.push({ tick, k: 'off', ch, a }); else if (hi === 0xb && a === 7) ev.push({ tick, k: 'vol', ch, a: b }); }
      }
      p = end;
    }
    tempos.sort((a, b) => a[0] - b[0]);
    const sec = tick => { let t = 0, last = 0, us = 500000; for (const [tk, u] of tempos) { if (tk >= tick) break; t += (tk - last) * us / div / 1e6; last = tk; us = u; } return t + (tick - last) * us / div / 1e6; };
    ev.forEach(e => e.t = sec(e.tick)); ev.sort((a, b) => a.t - b.t || (a.k === 'off' ? -1 : 1));
    return ev;
  }

  function pickSample(prog, note) {
    const list = M.instruments[prog] || M.instruments['0'];
    let best = null; for (const [oct, name] of list) { const root = 12 * (oct + 1); if (!best || Math.abs(root - note) < Math.abs(best.root - note)) best = { root, name }; }
    return best;
  }

  async function playMidi(name, o = {}) {
    if (!ctx) return null;
    if (!midis[name]) { try { midis[name] = parseMidi(new Uint8Array(await bytes(name, 'mid'))); } catch (e) { console.warn('midi', name, e); return null; } }
    const ev = midis[name], t0 = ctx.currentTime + 0.05, prog = Array(16).fill(0), vol = Array(16).fill(100), on = {}, handles = [];
    const gainAll = o.gain == null ? 0.7 : o.gain;
    for (const e of ev) {
      if (e.k === 'pc') prog[e.ch] = e.a; else if (e.k === 'vol') vol[e.ch] = e.a;
      else if (e.k === 'on') {
        let nm, rate = 1, loopLen = 0;
        if (e.ch === 9) { nm = M.drums[e.a]; } else { const s = pickSample(prog[e.ch], e.a); if (s) { nm = s.name; rate = Math.pow(2, (e.a - s.root) / 12); } }
        if (!nm || !bufs[nm]) continue;
        const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = bufs[nm]; src.playbackRate.value = rate;
        g.gain.value = gainAll * (e.b / 127) * (vol[e.ch] / 127); src.connect(g); g.connect(master); src.start(t0 + e.t);
        (on[e.ch + ':' + e.a] = on[e.ch + ':' + e.a] || []).push({ src, g }); handles.push({ src, g });
      } else if (e.k === 'off' && e.ch !== 9) {
        const a = on[e.ch + ':' + e.a]; const n = a && a.shift(); if (n) { n.g.gain.setTargetAtTime(0, t0 + e.t, 0.06); try { n.src.stop(t0 + e.t + 0.4); } catch (x) {} }
      }
    }
    const dur = ev.length ? ev[ev.length - 1].t : 0;
    return { duration: dur, stop() { handles.forEach(h => { try { h.g.gain.cancelScheduledValues(0); h.g.gain.setTargetAtTime(0, ctx.currentTime, 0.03); h.src.stop(ctx.currentTime + 0.2); } catch (e) {} }); } };
  }

  // ---- the ROM's compiled voice bank (js/sndbank.js): voices of notes (instrument sample at a pitch step) and rests, scheduled a little ahead ------------------------
  // Each event lasts ev.len output samples (21480 Hz): the note plays from its start (cut 32 samples before the end of the event, with a 32-sample fade, when it
  // is longer), the rest is silence. A voice is a chain of events; all voices of a sound start together. o.loop restarts each voice when it ends.
  const BANK_GAIN = 0.7;   // the original hardware mix of a bank sound peaks at 0.70 of the plain sum of velocity / 128 (QOTN reel_clink 7746 against 11217, betbeep1 6803 against 9646)
  function playBank(bank, SB, o = {}) {
    if (!ctx || !bank) return null;
    const R = SB.RATE, FADE = 32 / R, LOOK = 1.5, gainAll = (o.gain == null ? 1 : o.gain) * BANK_GAIN, t0 = ctx.currentTime + 0.03;
    const abufs = playBank.bufs || (playBank.bufs = new WeakMap());
    const bufOf = off => { let m = abufs.get(bank.F); if (!m) abufs.set(bank.F, m = new Map()); let b = m.get(off); if (!b) { const a = SB.pcm(bank, off); b = ctx.createBuffer(1, Math.max(1, a.length), R); b.getChannelData(0).set(a); m.set(off, b); } return b; };
    const vs = bank.voices.map(ev => ({ ev, i: 0, n: 0, t: t0 })), live = []; let stopped = false, timer = 0;
    const endT = t0 + bank.samples / R;
    function note(v, e) {
      const seg = e.len / R; if (!e.off || !e.step || e.vel === 0) return;
      const b = bufOf(e.off), np = Math.floor(b.length / e.step) / R, cut = seg - FADE;
      if (cut <= 0) return;
      const src = ctx.createBufferSource(), g = ctx.createGain(), peak = gainAll * e.vel / 128;
      src.buffer = b; src.playbackRate.value = e.step; g.gain.value = peak; src.connect(g); g.connect(master); src.start(v.t);
      if (np > cut) { g.gain.setValueAtTime(peak, v.t + cut - FADE); g.gain.linearRampToValueAtTime(0, v.t + cut); src.stop(v.t + cut + 0.005); } else src.stop(v.t + np + 0.05);
      const rec = { src, g }; live.push(rec); src.onended = () => { const k = live.indexOf(rec); if (k >= 0) live.splice(k, 1); };
    }
    function pump() {
      if (stopped) return; const horizon = ctx.currentTime + LOOK; let more = false;
      for (const v of vs) {
        while (v.t < horizon) {
          if (v.i >= v.ev.length) { if (o.loop && v.ev.length && (o.loop === true || ++v.n < o.loop)) { v.i = 0; continue; } break; }
          const e = v.ev[v.i++]; note(v, e); v.t += e.len / R;
        }
        if (v.i < v.ev.length || (o.loop && (o.loop === true || v.n + 1 < o.loop))) more = true;
      }
      if (!more && timer) { clearInterval(timer); timer = 0; }
    }
    if (o.loop === true) setTimeout(() => { if (!stopped) h.stop(0.5); }, 180000);   // safety: a looping sound nobody stops ends after 3 minutes
    pump(); if (vs.some(v => v.i < v.ev.length || o.loop)) timer = setInterval(pump, 250);
    const h = { duration: o.loop === true ? Infinity : (endT - t0) * (o.loop || 1), stop(fade = 0.05) { stopped = true; if (timer) clearInterval(timer); timer = 0; for (const n of live.splice(0)) { try { n.g.gain.cancelScheduledValues(0); n.g.gain.setTargetAtTime(0, ctx.currentTime, fade / 3); n.src.stop(ctx.currentTime + fade * 2); } catch (e) {} } } };
    return h;
  }

  window.QotnAudio = {
    init, play, playMidi, playBank, parseMidi, configure(manifest, fn) { M = manifest; byteFn = fn; },
    get muted() { return muted; },
    setMuted(m) { muted = m; if (master) master.gain.value = gain(); },
    get volume() { return volume; },
    setVolume(v) { volume = Math.min(1, Math.max(0, Number(v) || 0)); if (master) master.gain.value = gain(); },
  };
})();
