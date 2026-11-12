// Baseline JPEG decoder (SOF0, Huffman, 8-bit, any chroma subsampling, restart markers) -> { w, h, rgba }.
// The browser decodes images with createImageBitmap; Node has no decoder, so server-side screenshots (tools/shots.js) use this one.
// Every JPEG in the ROM set is baseline (693 images in 113 ROMs); progressive or arithmetic-coded files return null.
(function (root) {
  'use strict';
  const ZIGZAG = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
  // separable IDCT: COS[x * 8 + u] = C(u) / 2 * cos((2x + 1) u pi / 16)
  const COS = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16);

  // canonical Huffman table: lookup by (length, code) through maxcode / valptr
  function huffman(counts, symbols) {
    const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
    let code = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
      valptr[len] = k; mincode[len] = code; code += counts[len - 1]; k += counts[len - 1];
      maxcode[len] = counts[len - 1] ? code - 1 : -1; code <<= 1;
    }
    return { maxcode, valptr, mincode, symbols };
  }

  function decodeJpeg(u8) {
    const qt = [], dc = [], ac = [];
    let frame = null, restart = 0, adobe = -1, p = 2;
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    const u16 = a => (u8[a] << 8) | u8[a + 1];
    while (p < u8.length) {
      if (u8[p] !== 0xff) { p++; continue; }
      const m = u8[p + 1]; p += 2;
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { if (m === 0xff) p--; continue; }
      if (m === 0xd9) break;
      const len = u16(p), end = p + len;
      if (m === 0xdb) {                                                // DQT
        for (let q = p + 2; q < end;) {
          const pq = u8[q] >> 4, tq = u8[q] & 15, t = new Uint16Array(64); q++;
          for (let i = 0; i < 64; i++) { t[ZIGZAG[i]] = pq ? u16(q) : u8[q]; q += pq ? 2 : 1; }
          qt[tq] = t;
        }
      } else if (m === 0xc4) {                                         // DHT
        for (let q = p + 2; q < end;) {
          const tc = u8[q] >> 4, th = u8[q] & 15, counts = u8.subarray(q + 1, q + 17); let n = 0;
          for (let i = 0; i < 16; i++) n += counts[i];
          (tc ? ac : dc)[th] = huffman(counts, u8.subarray(q + 17, q + 17 + n)); q += 17 + n;
        }
      } else if (m === 0xc0 || m === 0xc1) {                           // SOF0 / SOF1: baseline and extended sequential Huffman
        if (u8[p + 2] !== 8) return null;
        frame = { h: u16(p + 3), w: u16(p + 5), comps: [] };
        for (let i = 0, q = p + 8; i < u8[p + 7]; i++, q += 3) frame.comps.push({ id: u8[q], hs: u8[q + 1] >> 4, vs: u8[q + 1] & 15, tq: u8[q + 2] });
        frame.hmax = Math.max(...frame.comps.map(c => c.hs)); frame.vmax = Math.max(...frame.comps.map(c => c.vs));
        frame.mcux = Math.ceil(frame.w / (8 * frame.hmax)); frame.mcuy = Math.ceil(frame.h / (8 * frame.vmax));
        for (const c of frame.comps) { c.bw = frame.mcux * c.hs; c.bh = frame.mcuy * c.vs; c.data = new Uint8Array(c.bw * 8 * c.bh * 8); }
      } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return null;                                                   // progressive, lossless or arithmetic coding
      } else if (m === 0xdd) restart = u16(p + 2);                     // DRI
      else if (m === 0xee && len >= 12 && u8[p + 2] === 0x41 && u8[p + 3] === 0x64) adobe = u8[p + 13];   // APP14 "Adobe": colour transform
      else if (m === 0xda) {                                           // SOS
        if (!frame) return null;
        const ns = u8[p + 2], sc = [];
        for (let i = 0, q = p + 3; i < ns; i++, q += 2) { const c = frame.comps.find(x => x.id === u8[q]); if (!c) return null; c.dct = u8[q + 1] >> 4; c.act = u8[q + 1] & 15; sc.push(c); }
        p = scan(u8, end, frame, sc, qt, dc, ac, restart);
        continue;
      }
      p = end;
    }
    if (!frame) return null;
    return colour(frame, adobe);
  }

  // entropy-coded segment: MCUs of every component in the scan, restart markers reset the DC predictors
  function scan(u8, p, frame, sc, qt, dc, ac, restart) {
    let bits = 0, nbits = 0, marker = false;
    const bit = () => {
      if (nbits === 0) {
        if (marker) { bits = 0; nbits = 8; }                          // past a marker: feed zeros
        else {
          let b = u8[p++];
          if (b === 0xff) { const n = u8[p]; if (n === 0) p++; else { marker = true; p--; b = 0; } }
          bits = b; nbits = 8;
        }
      }
      nbits--; return (bits >> nbits) & 1;
    };
    const receive = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit(); return v; };
    const extend = (v, n) => n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v;
    const decode = t => {
      let code = 0;
      for (let len = 1; len <= 16; len++) { code = (code << 1) | bit(); if (t.maxcode[len] >= 0 && code <= t.maxcode[len] && code >= t.mincode[len]) return t.symbols[t.valptr[len] + code - t.mincode[len]]; }
      return 0;
    };
    const blk = new Float64Array(64), tmp = new Float64Array(64);
    const block = (c, row, col) => {
      blk.fill(0);
      const q = qt[c.tq], t = decode(dc[c.dct]);
      c.pred += extend(receive(t), t); blk[0] = c.pred * q[0];
      for (let k = 1; k < 64;) {
        const rs = decode(ac[c.act]), r = rs >> 4, s = rs & 15;
        if (s === 0) { if (r === 15) { k += 16; continue; } break; }
        k += r; if (k > 63) break;
        blk[ZIGZAG[k]] = extend(receive(s), s) * q[ZIGZAG[k]]; k++;
      }
      // IDCT rows then columns
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let s = 0; for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * blk[y * 8 + u]; tmp[y * 8 + x] = s; }
      const stride = c.bw * 8, o = row * 8 * stride + col * 8;
      for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
        let s = 0; for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
        const px = Math.round(s + 128); c.data[o + y * stride + x] = px < 0 ? 0 : px > 255 ? 255 : px;
      }
    };
    for (const c of sc) c.pred = 0;
    const single = sc.length === 1, c0 = sc[0];
    const total = single ? Math.ceil(Math.ceil(frame.w * c0.hs / frame.hmax) / 8) * Math.ceil(Math.ceil(frame.h * c0.vs / frame.vmax) / 8) : frame.mcux * frame.mcuy;
    const perRow = single ? Math.ceil(Math.ceil(frame.w * c0.hs / frame.hmax) / 8) : frame.mcux;
    for (let n = 0; n < total; n++) {
      if (restart && n > 0 && n % restart === 0) {                    // RSTn: realign to the byte after the marker
        nbits = 0; marker = false;
        while (p < u8.length && !(u8[p] === 0xff && u8[p + 1] >= 0xd0 && u8[p + 1] <= 0xd7)) p++;
        p += 2; for (const c of sc) c.pred = 0;
      }
      const my = Math.floor(n / perRow), mx = n % perRow;
      if (single) block(c0, my, mx);
      else for (const c of sc) for (let v = 0; v < c.vs; v++) for (let h = 0; h < c.hs; h++) block(c, my * c.vs + v, mx * c.hs + h);
    }
    // continue after the scan: find the next marker
    while (p < u8.length - 1 && !(u8[p] === 0xff && u8[p + 1] !== 0 && !(u8[p + 1] >= 0xd0 && u8[p + 1] <= 0xd7))) p++;
    return p;
  }

  // upsample each component to full size and convert YCbCr (or RGB / greyscale) to RGBA
  function colour(f, adobe) {
    const { w, h, comps } = f, out = new Uint8ClampedArray(w * h * 4);
    const at = (c, x, y) => c.data[Math.floor(y * c.vs / f.vmax) * c.bw * 8 + Math.floor(x * c.hs / f.hmax)];
    const rgb = comps.length === 3 && adobe === 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4; out[o + 3] = 255;
      if (comps.length === 1) { out[o] = out[o + 1] = out[o + 2] = at(comps[0], x, y); continue; }
      const Y = at(comps[0], x, y), Cb = at(comps[1], x, y), Cr = at(comps[2], x, y);
      if (rgb) { out[o] = Y; out[o + 1] = Cb; out[o + 2] = Cr; continue; }
      out[o] = Y + 1.402 * (Cr - 128); out[o + 1] = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128); out[o + 2] = Y + 1.772 * (Cb - 128);
    }
    return { w, h, rgba: out };
  }

  const api = { decodeJpeg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.JPEG = api;
})(typeof self !== 'undefined' ? self : this);
