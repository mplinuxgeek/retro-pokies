// Drawing on an RGBA screen buffer: the 5x7 bitmap font of mk6c (src/frontend/font5x7.c; lower case drawn with the capitals), filled and
// blended rectangles, scaled image blits and a small PNG writer; and for the web build's look: the web build's fonts (assets/fonts.*,
// made by tools/import-fonts.py) with gradient fills, anti-aliased rounded boxes, soft shadows and glows (blurred coverage masks), and
// smooth scaling, blur and colour adjustment of pictures. Sizes are screen pixels, twice the web build's CSS pixels.
const zlib = require('zlib'), path = require('path'), fs = require('fs');
const FJ = require('../assets/fonts.json');

const GLYPHS = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14], 6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12], ':': [0, 4, 0, 0, 0, 4, 0],
  '.': [0, 0, 0, 0, 0, 12, 12], '-': [0, 0, 0, 31, 0, 0, 0], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], "'": [4, 4, 8, 0, 0, 0, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], _: [0, 0, 0, 0, 0, 0, 31], '&': [12, 18, 20, 8, 21, 18, 13], ',': [0, 0, 0, 0, 12, 4, 8], '!': [4, 4, 4, 4, 4, 0, 4],
  '+': [0, 4, 4, 31, 4, 4, 0], '*': [0, 4, 21, 14, 21, 4, 0], '<': [2, 4, 8, 16, 8, 4, 2], '>': [8, 4, 2, 1, 2, 4, 8], '#': [10, 10, 31, 10, 31, 10, 10],
  '%': [24, 25, 2, 4, 8, 19, 3], $: [4, 15, 20, 14, 5, 30, 4], '?': [14, 17, 1, 2, 4, 0, 4],
};
const ADV = 6;   // glyph advance in font pixels (5 wide + 1 gap)

class Screen {
  constructor(w, h) { this.w = w; this.h = h; this.rgba = new Uint8ClampedArray(w * h * 4); this.u32 = new Uint32Array(this.rgba.buffer); }
  clear([r, g, b]) { this.u32.fill((255 << 24 | b << 16 | g << 8 | r) >>> 0); }
  // rectangle in colour [r, g, b], blended with alpha a (0..1)
  rect(x, y, w, h, [r, g, b], a = 1) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0), p = this.rgba;
    for (let yy = y0; yy < y1; yy++) for (let i = (yy * this.w + x0) * 4, e = (yy * this.w + x1) * 4; i < e; i += 4) {
      p[i] += (r - p[i]) * a; p[i + 1] += (g - p[i + 1]) * a; p[i + 2] += (b - p[i + 2]) * a; p[i + 3] = 255; }
  }
  frame(x, y, w, h, c, t = 2, a = 1) { this.rect(x, y, w, t, c, a); this.rect(x, y + h - t, w, t, c, a); this.rect(x, y + t, t, h - 2 * t, c, a); this.rect(x + w - t, y + t, t, h - 2 * t, c, a); }
  static textW(s, px = 2) { return s.length * ADV * px - px; }
  text(x, y, s, c, px = 2, shadow = true) {
    if (shadow) this.text(x + px / 2, y + px / 2, s, [0, 0, 0], px, false);
    for (const ch of s) { const g = GLYPHS[ch.toUpperCase()];
      if (g) for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r] >> (4 - k) & 1) this.rect(x + k * px, y + r * px, px, px, c);
      x += ADV * px; }
  }
  // text cut to fit max pixels wide, with '...' when it was cut
  static fit(s, max, px = 2) { if (Screen.textW(s, px) <= max) return s; while (s && Screen.textW(s + '...', px) > max) s = s.slice(0, -1); return s + '...'; }
  // image { w, h, rgba } scaled to dw x dh at (dx, dy), nearest neighbour; source window [sx, sy, sw, sh]
  blit(im, dx, dy, dw, dh, sx = 0, sy = 0, sw = im.w, sh = im.h) {
    const s32 = new Uint32Array(im.rgba.buffer, im.rgba.byteOffset, im.w * im.h), d = this.u32;
    const x0 = Math.max(0, dx | 0), x1 = Math.min(this.w, (dx + dw) | 0), y0 = Math.max(0, dy | 0), y1 = Math.min(this.h, (dy + dh) | 0);
    const xs = new Int32Array(Math.max(0, x1 - x0)); for (let x = x0; x < x1; x++) xs[x - x0] = sx + Math.min(sw - 1, ((x - dx) * sw / dw) | 0);
    for (let y = y0; y < y1; y++) { const sr = (sy + Math.min(sh - 1, ((y - dy) * sh / dh) | 0)) * im.w, dr = y * this.w; for (let x = x0; x < x1; x++) d[dr + x] = s32[sr + xs[x - x0]] | 0xff000000; }
  }
  // atlas sprite: source rect r of image im at (dx, dy) 1:1, alpha blended; colour multiplied by mul [r, g, b] (1 = as drawn), opacity alpha
  sprite(im, r, dx, dy, mul = [1, 1, 1], alpha = 1) {
    dx = Math.round(dx); dy = Math.round(dy);
    const src = im.rgba, d = this.rgba, x0 = Math.max(0, -dx), y0 = Math.max(0, -dy), x1 = Math.min(r.w, this.w - dx), y1 = Math.min(r.h, this.h - dy), [mr, mg, mb] = mul;
    for (let y = y0; y < y1; y++) {
      let si = ((r.y + y) * im.w + r.x + x0) * 4, di = ((dy + y) * this.w + dx + x0) * 4;
      for (let x = x0; x < x1; x++, si += 4, di += 4) { const a = src[si + 3] * alpha / 255; if (a <= 0) continue;
        d[di] += (src[si] * mr - d[di]) * a; d[di + 1] += (src[si + 1] * mg - d[di + 1]) * a; d[di + 2] += (src[si + 2] * mb - d[di + 2]) * a; d[di + 3] = 255; }
    }
  }

  // the rectangle (x, y, w, h) of screen src at half size into this one at (x / 2, y / 2), each pixel the average of four (x, y, w, h even)
  halfFrom(src, x, y, w, h) {
    const a = src.u32, d = this.u32, row = src.w;
    for (let yy = 0; yy < h; yy += 2) {
      let i = (y + yy) * row + x, o = ((y + yy) >> 1) * this.w + (x >> 1);
      for (let xx = 0; xx < w; xx += 2, i += 2, o++) {
        const p = a[i], q = a[i + 1], r = a[i + row], t = a[i + row + 1];
        d[o] = 0xff000000 | ((((p >>> 16) & 255) + ((q >>> 16) & 255) + ((r >>> 16) & 255) + ((t >>> 16) & 255) + 2) >> 2) << 16
          | ((((p >>> 8) & 255) + ((q >>> 8) & 255) + ((r >>> 8) & 255) + ((t >>> 8) & 255) + 2) >> 2) << 8 | (((p & 255) + (q & 255) + (r & 255) + (t & 255) + 2) >> 2);
      }
    }
  }
  // a screen of the same size copied in except its rectangle (x, y, w, h), no blending
  copyAround(src, x, y, w, h) {
    const a = src.u32, d = this.u32, W = this.w, y0 = Math.max(0, y), y1 = Math.min(this.h, y + h), x0 = Math.max(0, Math.min(W, x)), x1 = Math.max(x0, Math.min(W, x + w));
    d.set(a.subarray(0, y0 * W)); d.set(a.subarray(y1 * W), y1 * W);
    for (let r = y0; r < y1; r++) { const o = r * W; d.set(a.subarray(o, o + x0), o); d.set(a.subarray(o + x1, o + W), o + x1); }
  }
  // opaque picture im ({ w, h, rgba }) at twice its size at (dx, dy), each pixel 2 x 2: blit's picture at exactly 2x, (dx, dy) inside
  put2x(im, dx, dy) {
    const s32 = new Uint32Array(im.rgba.buffer, im.rgba.byteOffset, im.w * im.h), d = this.u32, W = this.w, w = Math.min(im.w, (W - dx) >> 1);
    for (let y = 0; y < im.h && dy + 2 * y + 1 < this.h; y++) { const o = (dy + 2 * y) * W + dx;
      for (let x = 0, i = y * im.w, j = o; x < w; x++, i++, j += 2) { const v = s32[i] | 0xff000000; d[j] = v; d[j + 1] = v; }
      d.copyWithin(o + W, o, o + 2 * w); }
  }
  // the rectangle (x, y, w, h) of a screen of the same size copied in, no blending
  copyRect(src, x, y, w, h) { for (let r = y; r < y + h; r++) this.u32.set(src.u32.subarray(r * src.w + x, r * src.w + x + w), r * this.w + x); }
  // a layer drawn twice, over black (k) and over white (wt), both the size of this screen, laid over rows y.. of this one. runs: per row
  // [x0, x1, kind, ...], kind 0 clear (skipped), 1 opaque (k copied), 2 blended: each channel k + this * (wt - k) / 255, rounded
  layer(k, wt, y, runs) {
    const d = this.u32, a = k.u32, b = wt.u32;
    for (let j = 0; j < runs.length; j++) { const r = runs[j], row = (y + j) * this.w;
      for (let n = 0; n < r.length; n += 3) { const t = r[n + 2]; if (!t) continue;
        if (t === 1) { d.set(a.subarray(row + r[n], row + r[n + 1]), row + r[n]); continue; }
        for (let i = row + r[n], e = row + r[n + 1]; i < e; i++) {
          const p = d[i], q = a[i], u = b[i];
          let c = q & 255, m = (p & 255) * ((u & 255) - c) + 128; const r0 = c + ((m + (m >> 8)) >> 8);
          c = (q >>> 8) & 255; m = ((p >>> 8) & 255) * (((u >>> 8) & 255) - c) + 128; const g0 = c + ((m + (m >> 8)) >> 8);
          c = (q >>> 16) & 255; m = ((p >>> 16) & 255) * (((u >>> 16) & 255) - c) + 128;
          d[i] = 0xff000000 | (c + ((m + (m >> 8)) >> 8)) << 16 | g0 << 8 | r0;
        } } }
  }
  // opaque picture im ({ w, h, rgba }) copied in 1:1 at (dx, dy), no blending; putRows: its rows y0..y1 only
  put(im, dx, dy) { this.putRows(im, dx, dy, 0, im.h); }
  putRows(im, dx, dy, y0, y1) {
    const s32 = new Uint32Array(im.rgba.buffer, im.rgba.byteOffset, im.w * im.h), w = Math.min(im.w, this.w - dx);
    for (let y = Math.max(0, y0); y < Math.min(y1, im.h) && dy + y < this.h; y++) this.u32.set(s32.subarray(y * im.w, y * im.w + w), (dy + y) * this.w + dx);
  }

  // ---- the web look ----
  // another screen or picture of the same size copied in, no blending
  copy(src) { this.u32.set(src.u32 || new Uint32Array(src.rgba.buffer, src.rgba.byteOffset, src.w * src.h)); }
  // a picture that no longer changes (the games list's cards) marked with its rows as runs [x0, x1, kind, ...] (0 clear, 1 opaque,
  // 2 blended; runs under 16 pixels join their neighbours as blended): draw then skips the clear ones and copies the opaque ones whole
  seal() {
    this.runs = [];
    for (let y = 0; y < this.h; y++) { const r = []; let k = -1, x0 = 0;
      const end = (x1, t) => { if (t !== 2 && x1 - x0 < 16) t = 2; if (r.length && r[r.length - 1] === t) r[r.length - 2] = x1; else r.push(x0, x1, t); };
      for (let x = 0, i = y * this.w * 4 + 3; x < this.w; x++, i += 4) { const a = this.rgba[i], t = a === 255 ? 1 : a ? 2 : 0; if (t !== k) { if (k >= 0) end(x, k); x0 = x; k = t; } }
      if (k >= 0) end(this.w, k); this.runs.push(Int32Array.from(r)); }
    return this;
  }
  // picture im (alpha honoured) at (dx, dy) 1:1, with opacity alpha; rows of the region [sy, sy + sh) of im only
  draw(im, dx, dy, alpha = 1, sy = 0, sh = im.h) {
    dx = Math.round(dx); dy = Math.round(dy);
    const src = im.rgba, d = this.rgba, x0 = Math.max(0, -dx), x1 = Math.min(im.w, this.w - dx), y0 = Math.max(sy, -dy), y1 = Math.min(sy + sh, im.h, this.h - dy);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, im.w * im.h), d32 = this.u32, runs = alpha === 1 && im.runs;
    for (let y = y0; y < y1; y++) {
      const ro = runs && runs[y], n = ro ? ro.length : 3;
      for (let k = 0; k < n; k += 3) {
        const lo = ro ? Math.max(x0, ro[k]) : x0, hi = ro ? Math.min(x1, ro[k + 1]) : x1; if (lo >= hi || (ro && !ro[k + 2])) continue;
        if (ro && ro[k + 2] === 1) { d32.set(s32.subarray(y * im.w + lo, y * im.w + hi), (dy + y) * this.w + dx + lo); continue; }
        for (let x = lo, si = y * im.w + lo, di = (dy + y) * this.w + dx + lo; x < hi; x++, si++, di++) {
          const a8 = src[si * 4 + 3]; if (!a8) continue;
          if (a8 === 255 && alpha === 1) { d32[di] = s32[si]; continue; }
          const a = a8 * alpha / 255, p = di * 4, q = si * 4;
          d[p] += (src[q] - d[p]) * a; d[p + 1] += (src[q + 1] - d[p + 1]) * a; d[p + 2] += (src[q + 2] - d[p + 2]) * a; d[p + 3] = 255;
        }
      }
    }
  }
  // coverage mask m (see Mask) at (x, y): colour c ([r, g, b], or (x, y) => [r, g, b] in screen pixels), opacity alpha;
  // mode 'add' brightens (a light: lamp halos), 'screen' lightens softly (the marquee's backlight); only the screen's rows [top, bottom)
  paint(m, x, y, c, alpha = 1, mode, top = 0, bottom = this.h) {
    x = Math.round(x + m.ox); y = Math.round(y + m.oy);
    const d = this.rgba, fn = typeof c === 'function', x0 = Math.max(0, -x), x1 = Math.min(m.w, this.w - x), y0 = Math.max(0, top - y), y1 = Math.min(m.h, bottom - y);
    let [r, g, b] = fn ? [0, 0, 0] : c; const sp = m.spans();
    for (let yy = y0; yy < y1; yy++) for (let k = 0, sr = sp[yy]; k < sr.length; k += 2) {
      const lo = Math.max(x0, sr[k]), hi = Math.min(x1, sr[k + 1]);
      for (let xx = lo, mi = yy * m.w + lo, di = ((y + yy) * this.w + x + lo) * 4; xx < hi; xx++, mi++, di += 4) {
      const a = m.a[mi] * alpha; if (a <= 0.002) continue;
      if (fn) [r, g, b] = c(x + xx, y + yy);
      if (mode === 'add') { d[di] += r * a; d[di + 1] += g * a; d[di + 2] += b * a; }
      else if (mode === 'screen') { d[di] += (255 - d[di]) * r / 255 * a; d[di + 1] += (255 - d[di + 1]) * g / 255 * a; d[di + 2] += (255 - d[di + 2]) * b / 255 * a; }
      else { d[di] += (r - d[di]) * a; d[di + 1] += (g - d[di + 1]) * a; d[di + 2] += (b - d[di + 2]) * a; }
      d[di + 3] = 255;
    } }
  }
  // anti-aliased rounded box, filled (c as in paint) or, with t, a t-pixel outline
  round(x, y, w, h, r, c, alpha = 1, t = 0) { this.paint(t ? Mask.ring(w, h, r, t) : Mask.round(w, h, r), x, y, c, alpha); }
  // a soft drop shadow under a rounded box: blur pixels, dy down, black at opacity alpha
  shadow(x, y, w, h, r, blur, alpha = 0.5, dy = 0, c = [0, 0, 0]) { this.paint(Mask.round(w, h, r).blur(blur), x, y + dy, c, alpha); }
  // text in font f (a name in assets/fonts.json) with its baseline at y; o: { color | grad: [[t, [r, g, b]], ...] over the capitals' height,
  // align: 'left' | 'center' | 'right', alpha, spacing (extra pixels between letters), shadow: [dx, dy, [r, g, b], alpha] }; returns the width
  print(f, str, x, y, o = {}) {
    const F = font(f), sp = o.spacing || 0, w = textW(f, str, sp), A = o.alpha === undefined ? 1 : o.alpha;
    if (o.align === 'center') x -= w / 2; else if (o.align === 'right') x -= w;
    if (o.shadow) { const [dx, dy, c, a] = o.shadow; this.print(f, str, x + dx, y + dy, { color: c, alpha: a * A, spacing: sp }); }
    const cap = F.asc * 0.72, im = atlas(), src = im.rgba, d = this.rgba;
    const rowC = o.grad ? yy => stops(o.grad, (yy - (y - cap)) / cap) : () => o.color || [255, 255, 255];
    let px = x;
    for (const ch of str) {
      const g = F.glyphs[ch] || F.glyphs['?']; const [gx, gy, gw, gh, ox, oy, adv] = g;
      const dx = Math.round(px + ox), dy = Math.round(y + oy);
      for (let r = Math.max(0, -dy); r < gh && dy + r < this.h; r++) {
        const [cr, cg, cb] = rowC(dy + r);
        for (let k = Math.max(0, -dx), si = ((gy + r) * im.w + gx + k) * 4 + 3, di = ((dy + r) * this.w + dx + k) * 4; k < gw && dx + k < this.w; k++, si += 4, di += 4) {
          const a = src[si] * A / 255; if (!a) continue;
          d[di] += (cr - d[di]) * a; d[di + 1] += (cg - d[di + 1]) * a; d[di + 2] += (cb - d[di + 2]) * a; d[di + 3] = 255;
        }
      }
      px += adv + sp;
    }
    return w;
  }
}

// ---- fonts ----
let ATLAS = null;
// the glyph atlas is a PNG; decoded once (any PNG decoder: the app passes the engine's)
async function loadFonts(decodePng) { if (!ATLAS) ATLAS = await decodePng(new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts.png')))); return ATLAS; }
const atlas = () => { if (!ATLAS) throw new Error('fonts not loaded'); return ATLAS; };
const font = f => FJ.fonts[f] || FJ.fonts.ui;
function textW(f, str, sp = 0) { const F = font(f); let w = 0, n = 0; for (const ch of str) { const g = F.glyphs[ch] || F.glyphs['?']; w += g[6]; n++; } return Math.ceil(w + sp * Math.max(0, n - 1)); }
// str cut to fit max pixels wide, with an ellipsis when it was cut
function fitText(f, str, max, sp = 0) { if (textW(f, str, sp) <= max) return str; while (str && textW(f, str + '…', sp) > max) str = str.slice(0, -1); return str.trimEnd() + '…'; }
// colour at t (0..1) along gradient stops [[t, [r, g, b]], ...] (any number of components: [r, g, b, a] too); into out when given (a
// gradient painted pixel by pixel: no new array each time). The result is read at once, never kept: it can be a stop's own colour
function stops(st, t, out) {
  if (t <= st[0][0]) return st[0][1]; for (let i = 1; i < st.length; i++) if (t <= st[i][0]) {
    const [t0, a] = st[i - 1], [t1, b] = st[i], k = (t - t0) / (t1 - t0 || 1), o = out || new Array(a.length);
    for (let j = 0; j < a.length; j++) o[j] = a[j] + (b[j] - a[j]) * k; return o; }
  return st[st.length - 1][1];
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ---- coverage masks: a w x h float alpha map drawn offset (ox, oy) from where it is painted ----
const MCACHE = new Map();
class Mask {
  constructor(w, h, ox = 0, oy = 0) { this.w = w; this.h = h; this.ox = ox; this.oy = oy; this.a = new Float32Array(w * h); }
  // each row's runs of covered pixels [x0, x1, ...], worked out once (paint passes over the rest): a mask is not changed once painted
  spans() {
    if (this._spans) return this._spans; const sp = this._spans = [];
    for (let y = 0; y < this.h; y++) { const r = []; let on = false;
      for (let x = 0, i = y * this.w; x < this.w; x++, i++) { const c = this.a[i] > 0; if (c !== on) { r.push(x); on = c; } }
      if (on) r.push(this.w); sp.push(Int32Array.from(r)); }
    return sp;
  }
  static cached(key, make) { let m = MCACHE.get(key); if (!m) { if (MCACHE.size > 400) MCACHE.clear(); m = make(); MCACHE.set(key, m); } return m; }
  // a rounded box, anti-aliased by its distance to the edge
  static round(w, h, r) {
    w = Math.round(w); h = Math.round(h); r = Math.min(r, w / 2, h / 2);
    return Mask.cached('r' + w + ',' + h + ',' + r, () => { const m = new Mask(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cx = Math.max(r - x - 0.5, x + 0.5 - (w - r), 0), cy = Math.max(r - y - 0.5, y + 0.5 - (h - r), 0);
        m.a[y * w + x] = cx || cy ? Math.max(0, Math.min(1, r - Math.hypot(cx, cy) + 0.5)) : 1; }
      return m; });
  }
  static ring(w, h, r, t) {
    return Mask.cached('g' + [w, h, r, t], () => { const o = Mask.round(w, h, r), i = Mask.round(w - 2 * t, h - 2 * t, Math.max(0, r - t)), m = new Mask(o.w, o.h); m.a.set(o.a);
      for (let y = 0; y < i.h; y++) for (let x = 0; x < i.w; x++) m.a[(y + t) * m.w + x + t] *= 1 - i.a[y * i.w + x]; return m; });
  }
  // text coverage (font f, pen at the left of the baseline)
  static text(f, str, sp = 0) {
    const F = font(f), im = atlas(), w = textW(f, str, sp) + 4, m = new Mask(w, F.asc + F.desc + 4, -2, -F.asc - 2);
    let px = 2; for (const ch of str) { const [gx, gy, gw, gh, ox, oy, adv] = F.glyphs[ch] || F.glyphs['?'], dx = Math.round(px + ox), dy = F.asc + 2 + oy;
      for (let r = 0; r < gh; r++) for (let k = 0; k < gw; k++) { const yy = dy + r, xx = dx + k; if (yy >= 0 && yy < m.h && xx >= 0 && xx < m.w) m.a[yy * m.w + xx] = Math.max(m.a[yy * m.w + xx], im.rgba[((gy + r) * im.w + gx + k) * 4 + 3] / 255); }
      px += adv + sp; }
    return m;
  }
  // a softened copy, grown by r on every side (three box blurs, close to a gaussian of radius r)
  blur(r) {
    r = Math.max(1, Math.round(r)); const key = this, c = this._blur || (this._blur = new Map()); if (c.has(r)) return c.get(r);
    const m = new Mask(this.w + 2 * r, this.h + 2 * r, this.ox - r, this.oy - r);
    for (let y = 0; y < this.h; y++) m.a.set(this.a.subarray(y * this.w, (y + 1) * this.w), (y + r) * m.w + r);
    const k = Math.max(1, Math.round(r / 2)), tmp = new Float32Array(Math.max(m.w, m.h));
    const pass = (n, len, stride, step) => { for (let l = 0; l < n; l++) { const o = l * stride; let acc = 0;
      for (let i = -k; i <= k; i++) acc += i >= 0 && i < len ? m.a[o + i * step] : 0;
      for (let i = 0; i < len; i++) { tmp[i] = acc / (2 * k + 1); const a = i - k, b = i + k + 1; if (a >= 0) acc -= m.a[o + a * step]; if (b < len) acc += m.a[o + b * step]; }
      for (let i = 0; i < len; i++) m.a[o + i * step] = tmp[i]; } };
    for (let it = 0; it < 3; it++) { pass(m.h, m.w, m.w, 1); pass(m.w, m.h, 1, m.w); }
    c.set(r, m); return m;
  }
}

// ---- pictures ----
const image = (w, h) => ({ w, h, rgba: new Uint8ClampedArray(w * h * 4) });
// region [sx, sy, sw, sh] of im resampled to dw x dh: area average when shrinking, bilinear when growing
function resize(im, dw, dh, sx = 0, sy = 0, sw = im.w, sh = im.h) {
  const o = image(dw, dh), s = im.rgba, kx = sw / dw, ky = sh / dh;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    if (kx > 1 || ky > 1) {
      const x0 = sx + x * kx, x1 = x0 + kx, y0 = sy + y * ky, y1 = y0 + ky;
      for (let yy = Math.floor(y0); yy < Math.min(im.h, Math.ceil(y1)); yy++) for (let xx = Math.floor(x0); xx < Math.min(im.w, Math.ceil(x1)); xx++) { const i = (yy * im.w + xx) * 4; r += s[i]; g += s[i + 1]; b += s[i + 2]; a += s[i + 3]; n++; }
    } else {
      const fx = Math.max(0, sx + (x + 0.5) * kx - 0.5), fy = Math.max(0, sy + (y + 0.5) * ky - 0.5), x0 = Math.min(im.w - 1, fx | 0), y0 = Math.min(im.h - 1, fy | 0), x1 = Math.min(im.w - 1, x0 + 1), y1 = Math.min(im.h - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      const tap = (xx, yy, wgt) => { const i = (yy * im.w + xx) * 4; r += s[i] * wgt; g += s[i + 1] * wgt; b += s[i + 2] * wgt; a += s[i + 3] * wgt; };
      tap(x0, y0, (1 - ax) * (1 - ay)); tap(x1, y0, ax * (1 - ay)); tap(x0, y1, (1 - ax) * ay); tap(x1, y1, ax * ay);
      n = 1;
    }
    const i = (y * dw + x) * 4; o.rgba[i] = r / n; o.rgba[i + 1] = g / n; o.rgba[i + 2] = b / n; o.rgba[i + 3] = a / n;
  }
  return o;
}
// im resized to cover w x h (cropped, centred; fy: where the crop sits vertically, 0 top .. 1 bottom), scale k (1.05 = a little larger)
function cover(im, w, h, fy = 0.5, k = 1) {
  const s = Math.max(w / im.w, h / im.h) * k, sw = w / s, sh = h / s;
  return resize(im, w, h, Math.max(0, (im.w - sw) / 2), Math.max(0, (im.h - sh) * fy), Math.min(im.w, sw), Math.min(im.h, sh));
}
// CSS filter: brightness b, saturation s, then a box blur of r pixels (in place)
function adjust(im, b = 1, sat = 1, r = 0) {
  const p = im.rgba;
  for (let i = 0; i < p.length; i += 4) { const l = 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
    for (let c = 0; c < 3; c++) p[i + c] = (l + (p[i + c] - l) * sat) * b; }
  if (r > 0) for (let c = 0; c < 3; c++) {
    const m = new Mask(im.w, im.h); for (let i = 0; i < im.w * im.h; i++) m.a[i] = p[i * 4 + c]; const bl = m.blur(r);
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) p[(y * im.w + x) * 4 + c] = bl.a[(y + r) * bl.w + x + r];
  }
  return im;
}
// im with its corners cut round (alpha)
function rounded(im, r, top = true, bottom = true) {
  const m = Mask.round(im.w, im.h, r);
  for (let y = 0; y < im.h; y++) { if ((y < r && !top) || (y >= im.h - r && !bottom)) continue; for (let x = 0; x < im.w; x++) im.rgba[(y * im.w + x) * 4 + 3] *= m.a[y * im.w + x]; }
  return im;
}

function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { Screen, png, Mask, loadFonts, font, textW, fitText, stops, hex, image, resize, cover, adjust, rounded };
