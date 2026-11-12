// The ROM's compiled sound bank ("AVLSoundControl", section 9 record of tag 3). It is not an event table (the ROM names the sound it wants and the
// player plays that record); it holds the compiled form of every sound: record word b (+0x2c) is the offset, from the start of the MK6MF container, of the
// sound's block:  u32 nvoices, u32 voice_offset[nvoices] (from the block start); a voice is a list of 2-dword events ending at w0 == 0:
//   w0: bits 0..24 length of the event in units of 32 output samples (the note, then silence up to this length); bits 25..31 pitch index n,
//       playback step 0.5 * 2^(n/12) for n <= 24 (n = 12 plays at the sample's own rate), larger n has no step (no note)
//   w1: bits 0..24 0 = rest, else offset (from the container start) of an instrument WAV's 'data' chunk size (PCM int16 follows); bits 25..31 velocity
// The mixer runs at 21480 Hz; a note longer than its event is cut 32 samples short with a 32-sample fade.
(function (root) {
  'use strict';
  const RATE = 21480, MAX_VOICES = 16;
  const caches = new WeakMap();
  const stepOf = n => n <= 24 ? 0.5 * Math.pow(2, n / 12) : 0;

  // db: the record's own pack (rec.pack.db for multi-pack ROMs, else the opened container). Returns null when the block is not a valid bank block.
  function decode(db, rec) {
    if (!rec) return null; if (rec.bank !== undefined) return rec.bank;
    rec.bank = null; const F = db && db.F; if (!F || !rec.b || rec.b + 8 > F.length) return null;
    const V = db.V || new DataView(F.buffer, F.byteOffset, F.byteLength), u32 = o => V.getUint32(o, true), nv = u32(rec.b);
    if (nv < 1 || nv > MAX_VOICES || rec.b + 4 + 4 * nv > F.length) return null;
    const voices = []; let total = 0;
    for (let i = 0; i < nv; i++) {
      let p = rec.b + u32(rec.b + 4 + 4 * i), ev = [], len = 0; if (p + 8 > F.length) return null;
      for (let k = 0; ; k++) {
        if (p + 8 > F.length || k > 100000) return null;
        const w0 = u32(p), w1 = u32(p + 4); if (!w0) break;
        const e = { len: (w0 & 0x1ffffff) * 32, step: stepOf(w0 >>> 25), off: w1 & 0x1ffffff, vel: w1 >>> 25 };
        if (e.off) { if (e.off + 4 > F.length || e.off + 4 + u32(e.off) > F.length) return null; }
        ev.push(e); len += e.len; p += 8;
      }
      voices.push(ev); total = Math.max(total, len);
    }
    return rec.bank = { voices, samples: total, ms: total * 1000 / RATE, F, V };
  }

  // the int16 PCM of an instrument sample as Float32 (cached on the bank's container)
  function pcm(bank, off) {
    let c = caches.get(bank.F); if (!c) caches.set(bank.F, c = new Map()); let a = c.get(off); if (a) return a;
    const n = bank.V.getUint32(off, true) >> 1; a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = bank.V.getInt16(off + 4 + 2 * i, true) / 32768;
    c.set(off, a); return a;
  }

  const api = { decode, pcm, stepOf, RATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SNDBANK = api;
})(typeof window !== 'undefined' ? window : globalThis);
