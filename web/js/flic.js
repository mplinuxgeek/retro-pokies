// Decoder for the MK6 'FLIC' animations (section 7): a 44-byte private header followed by standard Autodesk FLC frames
// (chunks: 4 COLOR_256, 11 COLOR_64, 7 DELTA_FLC, 12 DELTA_FLI, 13 BLACK, 15 BYTE_RUN, 16 LITERAL) and three Aristocrat chunks with 2-byte [index, alpha] pixels and their own alpha (64 palette of 256 B,G,R,A entries after a
// 6-byte header, 73 BYTE_RUN, 74 DELTA_FLC; QOTN's gamble cards FLC_GBL_*). Header words (LE32):
// [0] 'FLIC', [1] size, [2] frame rate (frames per second, typically 15), [3] width, [4] height, [5] 8 bpp, [7] offset of a mask FLIC of the
// same geometry (0xffffffff = none), [8] frame count, [9] offset of the first frame. Frames: size u32, 0xF1FA u16, chunk count u16, 8 pad bytes.
(function (root) {
  'use strict';
  const u16 = (b, o) => b[o] | b[o + 1] << 8, u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;

  // one decoder per stream: keeps the indexed screen and palette between frames
  class Stream {
    constructor(b, at, w, h, count) { this.b = b; this.w = w; this.h = h; this.count = count; this.start = at + 44; this.pal = null; this.idx = new Uint8Array(w * h); this.alpha = null; this.pos = this.start; this.n = 0; }
    reset() { this.pos = this.start; this.n = 0; this.idx.fill(0); if (this.alpha) this.alpha.fill(0); }
    next() {                                                         // decode the next frame into this.idx (and this.pal); wraps after the last
      const b = this.b, w = this.w, h = this.h, idx = this.idx;
      if (this.n >= this.count) this.reset();
      const f = this.pos; if (u16(b, f + 4) !== 0xf1fa) throw new Error('FLIC: bad frame magic at ' + f);
      const chunks = u16(b, f + 6); let c = f + 16;
      for (let k = 0; k < chunks; k++) {
        const size = u32(b, c), type = u16(b, c + 4); let p = c + 6;
        if (type === 4 || type === 11) {                             // palette (COLOR_256 8-bit / COLOR_64 6-bit)
          const sh = type === 11 ? 2 : 0, pal = this.pal || (this.pal = new Uint8Array(768)); let col = 0, packets = u16(b, p); p += 2;
          while (packets-- > 0) { col += b[p++]; let n = b[p++] || 256; while (n-- > 0 && col < 256) { pal[3 * col] = b[p] << sh; pal[3 * col + 1] = b[p + 1] << sh; pal[3 * col + 2] = b[p + 2] << sh; p += 3; col++; } }
        } else if (type === 64) {                                    // Aristocrat palette: 6-byte header, then 256 x B,G,R,A (the alpha is per pixel)
          // body: u16 ?, u16 ?, u16 palette count n, then n u32 offsets from the body start, each a run of B,G,R,A entries. The offset table
          // is n * 4 bytes, so for n = 1 the colours start 4 bytes after the 6-byte header: reading them from the header end would shift every index by one entry
          // (the dark-red edge pixels of Cashman Tonight's Love Meter hearts, index 57, would come out lime). Palette 0 is current; chunk 72 selects another.
          const n = u16(b, p + 4), end = c + size; this.pals = [];
          for (let k = 0; k < n; k++) {
            const pal = new Uint8Array(768); let q = p + u32(b, p + 6 + 4 * k);
            for (let col = 0; col < 256 && q + 4 <= end; col++, q += 4) { pal[3 * col] = b[q + 2]; pal[3 * col + 1] = b[q + 1]; pal[3 * col + 2] = b[q]; }
            this.pals.push(pal);
          }
          if (this.pals.length) this.pal = this.pals[0];
        } else if (type === 72) {                                    // Aristocrat: select palette k of the type 64 chunk
          const k = u16(b, p); if (this.pals && k < this.pals.length) this.pal = this.pals[k];
        } else if (type === 73) {                                    // Aristocrat BYTE_RUN of [index, alpha] pixels, no line header
          const al = this.alpha || (this.alpha = new Uint8Array(w * h));
          for (let y = 0; y < h; y++) { let x = 0; while (x < w) { const n = (b[p++] << 24) >> 24; if (n >= 0) { const v = b[p], a = b[p + 1]; p += 2; for (let i = 0; i < n && x < w; i++, x++) { idx[y * w + x] = v; al[y * w + x] = a; } } else for (let i = 0; i < -n && x < w; i++, x++, p += 2) { idx[y * w + x] = b[p]; al[y * w + x] = b[p + 1]; } } }
        } else if (type === 74) {                                    // Aristocrat DELTA_FLC of [index, alpha] pixels: counts are pixels
          const al = this.alpha || (this.alpha = new Uint8Array(w * h)); let lines = u16(b, p), y = 0; p += 2;
          while (lines > 0 && y < h) {
            let op = u16(b, p); p += 2;
            if (op & 0x8000) { if (op & 0x4000) { y += 65536 - op; continue; } op = u16(b, p); p += 2; }
            let x = 0, packets = op;
            while (packets-- > 0) {
              x += b[p++]; const n = (b[p++] << 24) >> 24;
              if (n >= 0) { for (let i = 0; i < n; i++, x++, p += 2) { idx[y * w + x] = b[p]; al[y * w + x] = b[p + 1]; } }
              else { const v = b[p], a = b[p + 1]; p += 2; for (let i = 0; i < -n; i++, x++) { idx[y * w + x] = v; al[y * w + x] = a; } }
            }
            y++; lines--;
          }
        } else if (type === 15) {                                    // BYTE_RUN
          for (let y = 0; y < h; y++) { p++; let x = 0; while (x < w) { const n = (b[p++] << 24) >> 24; if (n >= 0) { const v = b[p++]; for (let i = 0; i < n && x < w; i++) idx[y * w + x++] = v; } else for (let i = 0; i < -n && x < w; i++) idx[y * w + x++] = b[p++]; } }
        } else if (type === 7) {                                     // DELTA_FLC (word oriented)
          let lines = u16(b, p), y = 0; p += 2;
          while (lines > 0 && y < h) {
            let op = u16(b, p); p += 2;
            if (op & 0x8000) { if (op & 0x4000) { y += 65536 - op; continue; } idx[y * w + w - 1] = op & 255; op = u16(b, p); p += 2; }   // 11: skip lines; 10: last byte of the line
            let x = 0, packets = op;
            while (packets-- > 0) {
              x += b[p++]; const n = (b[p++] << 24) >> 24;
              if (n >= 0) { for (let i = 0; i < n; i++) { idx[y * w + x++] = b[p++]; idx[y * w + x++] = b[p++]; } }
              else { const v0 = b[p++], v1 = b[p++]; for (let i = 0; i < -n; i++) { idx[y * w + x++] = v0; idx[y * w + x++] = v1; } }
            }
            y++; lines--;
          }
        } else if (type === 12) {                                    // DELTA_FLI (byte oriented)
          let y = u16(b, p), lines = u16(b, p + 2); p += 4;
          while (lines-- > 0) { let packets = b[p++], x = 0; while (packets-- > 0) { x += b[p++]; const n = (b[p++] << 24) >> 24; if (n >= 0) { for (let i = 0; i < n; i++) idx[y * w + x++] = b[p++]; } else { const v = b[p++]; for (let i = 0; i < -n; i++) idx[y * w + x++] = v; } } y++; }
        } else if (type === 16) { idx.set(b.subarray(p, p + w * h)); }
        else if (type === 13) idx.fill(0);
        c += size;
      }
      this.pos = f + u32(b, f); this.n++;
    }
  }

  // parse a FLIC record body: { w, h, count, delay, frames(palette) -> [{w,h,rgba}] }
  function parse(body) {
    if (body[0] !== 0x46 || body[1] !== 0x4c || body[2] !== 0x49 || body[3] !== 0x43) return null;
    const w = u32(body, 12), h = u32(body, 16), count = u32(body, 32), delay = u32(body, 8), maskAt = u32(body, 28);
    return {
      w, h, count, delay, hasMask: maskAt !== 0xffffffff,
      // decode every frame to RGBA; `pal` (768 bytes, optional) supplies colours when the stream carries no palette chunk. Index 0 stays opaque unless a mask FLIC says otherwise.
      frames(pal) {
        const st = new Stream(body, 0, w, h, count), mk = maskAt !== 0xffffffff ? new Stream(body, maskAt, w, h, count) : null, out = [];
        for (let i = 0; i < count; i++) {
          st.next(); if (mk) mk.next();
          const P = st.pal || pal, rgba = new Uint8ClampedArray(w * h * 4);
          for (let k = 0; k < w * h; k++) {
            const c = st.idx[k]; rgba[4 * k] = P ? P[3 * c] : c; rgba[4 * k + 1] = P ? P[3 * c + 1] : c; rgba[4 * k + 2] = P ? P[3 * c + 2] : c;
            rgba[4 * k + 3] = st.alpha ? st.alpha[k] : mk ? (mk.pal ? mk.pal[3 * mk.idx[k]] : mk.idx[k]) : 255;     // mask: grey level = opacity
          }
          out.push({ w, h, rgba });
        }
        return out;
      }
    };
  }
  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FLIC = api;
})(typeof window !== 'undefined' ? window : globalThis);
