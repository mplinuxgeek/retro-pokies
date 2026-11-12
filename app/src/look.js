// The web build's look (games.html, play.html, ui/marquee.css) for the desktop screens: its colours, the warm dark background, the title
// marquee (the game's attract art dimmed behind its name in gold Bungee, a lamp-lit glow, a vignette), the backlit CREDIT / BET / WIN LCD,
// key hints, buttons, pills and toasts. Sizes are screen pixels, twice the web build's CSS pixels.
const U = require('./ui.js'), { hex, Mask } = U;

const C = {
  bg: hex('#0b0704'), bg2: hex('#140c06'), card: hex('#1b120a'), card2: hex('#24180d'), line: hex('#3b2814'), line2: hex('#5c3d1c'),
  text: hex('#f4e7c8'), muted: hex('#b9a37a'), faint: hex('#8a7552'), gold: hex('#ffd862'), gold2: hex('#e8a93a'), edge: hex('#1c1209'),
  ready: hex('#4cd471'), maybe: hex('#f3b63f'), broken: hex('#e0675a'), unknown: hex('#9a9a9f'), focus: hex('#ffd862'),
};
const GOLD = [[0, hex('#fffbe0')], [0.42, hex('#ffe27a')], [0.58, hex('#f0a030')], [1, hex('#ffcf5a')]];
// LCD backlights (ui/marquee.css #lcd[data-theme]): lcd0..2 the backlight from the hot spot out, ink the segments, shade their shadow
const LCD = {
  green: { lcd0: '#dcec74', lcd1: '#bfd34c', lcd2: '#98af30', ink: '#1b2606', grid: [20, 34, 0, 0.07], glow: [40, 60, 0, 0.5], shade: [30, 45, 0, 0.22] },
  amber: { lcd0: '#ffd27a', lcd1: '#e8a93a', lcd2: '#b87a1c', ink: '#2a1600', grid: [60, 30, 0, 0.08], glow: [90, 50, 0, 0.5], shade: [80, 40, 0, 0.22] },
  blue: { lcd0: '#8fd8ff', lcd1: '#4aa8e6', lcd2: '#2a6fb0', ink: '#06192e', grid: [0, 20, 50, 0.09], glow: [0, 30, 80, 0.5], shade: [0, 30, 70, 0.22] },
  white: { lcd0: '#f4f4ec', lcd1: '#d2d4c6', lcd2: '#a6a89a', ink: '#16180f', grid: [0, 0, 0, 0.07], glow: [0, 0, 0, 0.35], shade: [0, 0, 0, 0.18] },
  red: { lcd0: '#ff9a86', lcd1: '#e2543c', lcd2: '#a8321f', ink: '#2a0804', grid: [60, 0, 0, 0.09], glow: [90, 0, 0, 0.5], shade: [80, 0, 0, 0.22] },
};

// a radial gradient over the box (x, y, w, h): centre (cx, cy), radii (rx, ry), stops [[t, [r, g, b], alpha], ...]; mode as Screen.paint
function radial(s, x, y, w, h, cx, cy, rx, ry, st, mode, clip) {
  const d = s.rgba, x0 = Math.max(0, Math.round(x)), x1 = Math.min(s.w, Math.round(x + w)), y0 = Math.max(0, Math.round(y)), y1 = Math.min(s.h, Math.round(y + h));
  const cs = st.map(([t, c, a]) => [t, [...c, a === undefined ? 1 : a]]), o = [0, 0, 0, 0];
  for (let yy = y0; yy < y1; yy++) for (let xx = x0, i = (yy * s.w + x0) * 4; xx < x1; xx++, i += 4) {
    const t = Math.hypot((xx - cx) / rx, (yy - cy) / ry), [r, g, b, a0] = U.stops(cs, t, o), a = a0 * (clip ? clip.a[(yy - y0) * clip.w + xx - x0] : 1); if (a <= 0.002) continue;
    if (mode === 'screen') { d[i] += (255 - d[i]) * r / 255 * a; d[i + 1] += (255 - d[i + 1]) * g / 255 * a; d[i + 2] += (255 - d[i + 2]) * b / 255 * a; }
    else { d[i] += (r - d[i]) * a; d[i + 1] += (g - d[i + 1]) * a; d[i + 2] += (b - d[i + 2]) * a; }
    d[i + 3] = 255;
  }
}

// games.html's page: near black with a warm glow from the top edge. Over a whole screen it is kept by the screen's size (BG) and copied
// the next time
const BG = new Map();
function background(s, x = 0, y = 0, w = s.w, h = s.h) {
  const all = x === 0 && y === 0 && w === s.w && h === s.h, key = s.w + 'x' + s.h, got = all && BG.get(key);
  if (got) return s.u32.set(got);
  s.rect(x, y, w, h, C.bg);
  radial(s, x, y, w, Math.min(h, 800), x + w / 2, y - 240, 2400 / 2, 1000 / 2, [[0, hex('#3a220c'), 1], [0.7, hex('#3a220c'), 0]]);
  if (all) { if (BG.size >= 4) BG.delete(BG.keys().next().value); BG.set(key, s.u32.slice()); }
}
// a cabinet section's surround: a soft shadow and the dark edge ring (box-shadow 0 0 0 3px --edge, 0 8px 24px #000)
function surround(s, x, y, w, h, r = 12, edge = 6) {   // r 0: square corners
  const R = r ? r + edge : 0;
  s.shadow(x - edge, y - edge, w + 2 * edge, h + 2 * edge, R, 48, 0.9, 16);
  s.round(x - edge, y - edge, w + 2 * edge, h + 2 * edge, R, C.edge);
}

// a name in the marquee lettering: gold Bungee with a brown under-cut and a dark halo, centred on cx; the smaller face, then an ellipsis,
// when it is wider than maxw. Returns the font used.
function title(s, str, cx, base, maxw, big = 'title') {
  str = str.toUpperCase(); let f = big; const sp = f => U.font(f).size * 0.03;
  if (U.textW(f, str, sp(f)) > maxw) f = 'brand';
  str = U.fitText(f, str, maxw, sp(f));
  const w = U.textW(f, str, sp(f)), x = cx - w / 2, m = Mask.text(f, str, sp(f));
  s.paint(m.blur(20), x, base, [0, 0, 0], 0.85);
  s.print(f, str, x, base + 4, { color: hex('#5a1d00'), spacing: sp(f) });
  s.print(f, str, x, base, { grad: GOLD, spacing: sp(f) });
  return f;
}

// the title marquee, drawn once per game: art is the game's attract picture (or null), name its title
function marquee(...a) { const it = marqueeParts(...a); while (!it.next().done); }
// the same in parts, yielding the fraction done between the slow ones (for a loading bar)
function* marqueeParts(s, x, y, w, h, art, name, opts = {}) {
  const R = 12; surround(s, x, y, w, h, R);
  const clip = Mask.round(w, h, R);
  const bg = [[0, hex('#5a2a0c')], [0.55, hex('#2a1306')], [1, hex('#120803')]], o = [0, 0, 0];
  s.paint(clip, x, y, (px, py) => U.stops(bg, Math.hypot((px - x - w / 2) / (w * 0.75), (py - y) / (h * 1.2)), o)); yield 0.2;
  if (art) {
    const im = U.adjust(U.cover(art, w, h, 0.35, 1.05), 0.42, 1.1, 3);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) im.rgba[(yy * w + xx) * 4 + 3] = 255 * clip.a[yy * w + xx];
    s.draw(im, x, y); yield 0.45;
  }
  // backlight: a warm hot spot behind the title and two dimmer blotches
  radial(s, x, y, w, h, x + w * 0.5, y + h * 0.42, w * 0.55, h * 0.75, [[0, [255, 196, 110], 0.30], [0.72, [255, 196, 110], 0]], 'screen', clip);
  radial(s, x, y, w, h, x + w * 0.2, y + h * 0.58, w * 0.26, h * 0.5, [[0, [255, 160, 70], 0.15], [0.7, [255, 160, 70], 0]], 'screen', clip);
  radial(s, x, y, w, h, x + w * 0.8, y + h * 0.38, w * 0.24, h * 0.46, [[0, [255, 184, 96], 0.13], [0.7, [255, 184, 96], 0]], 'screen', clip);
  yield 0.7;
  // vignette: inset 0 0 34px rgba(0,0,0,.62)
  const b = clip.blur(34), v = new Mask(w, h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) v.a[yy * w + xx] = clip.a[yy * w + xx] * (1 - b.a[(yy + 34) * b.w + xx + 34]);
  s.paint(v, x, y, [0, 0, 0], 0.62 * 1.6); yield 0.9;
  if (name) title(s, name, x + w / 2, y + (opts.titleBase || h * 0.38), w - 240);
}

// the LCD's glass and backlight (static); lcdText draws the figures on it
function lcdBox(s, x, y, w, h, theme = 'green') {
  const T = LCD[theme] || LCD.green, R = 12;
  s.shadow(x - 8, y - 8, w + 16, h + 16, R + 8, 28, 0.66, 12);
  s.round(x - 8, y - 8, w + 16, h + 16, R + 8, hex('#15170c')); s.round(x - 6, y - 6, w + 12, h + 12, R + 6, hex('#3a372a')); s.round(x, y, w, h, R, hex('#15170c'));
  const ix = x + 4, iy = y + 4, iw = w - 8, ih = h - 8, clip = Mask.round(iw, ih, R - 4), st = [[0, hex(T.lcd0)], [0.55, hex(T.lcd1)], [1, hex(T.lcd2)]];
  const o = [0, 0, 0]; s.paint(clip, ix, iy, (px, py) => U.stops(st, Math.hypot((px - ix - iw / 2) / (iw * 0.62), (py - iy - ih * 0.35) / (ih * 0.9)), o));
  const g = T.grid, gl = T.glow, b = clip.blur(28), d = s.rgba;
  for (let yy = 0; yy < ih; yy++) for (let xx = 0; xx < iw; xx++) {
    const a = clip.a[yy * iw + xx]; if (!a) continue; const i = ((iy + yy) * s.w + ix + xx) * 4;
    const gridA = ((yy % 6) < 2 ? g[3] : 0) + ((xx % 6) < 2 ? g[3] : 0), inset = gl[3] * (1 - b.a[(yy + 28) * b.w + xx + 28]) * 1.5, top = yy < 8 ? 0.35 * (1 - yy / 8) : 0;
    for (let c = 0; c < 3; c++) { let v = d[i + c]; v += (g[c] - v) * gridA * a; v += (gl[c] - v) * Math.min(1, inset) * a; v += (0 - v) * top * a; d[i + c] = v; }
  }
}
// cells: [[label, value], ...] spread evenly across the LCD
function lcdText(s, x, y, w, h, cells, theme = 'green') {
  const T = LCD[theme] || LCD.green, ink = hex(T.ink), sh = T.shade.slice(0, 3), n = cells.length;
  cells.forEach(([label, value], i) => {
    const cx = x + w * (i + 0.5) / n;
    s.print('lcds', label, cx, y + 30, { color: ink, alpha: 0.8, align: 'center', spacing: 21 * 0.16, shadow: [2, 2, sh, T.shade[3]] });
    s.print('lcd', value, cx, y + h - 16, { color: ink, align: 'center', spacing: 44 * 0.04, shadow: [2, 2, sh, T.shade[3]] });
  });
}

// key hints: parts are [kbd, text] pairs, e.g. [['Space', 'spin'], ...], centred on cx with ' · ' between them
function hints(s, parts, cx, base) {
  const F = 'uisb', sep = '  ·  ', chip = t => U.textW(F, t) + 16;
  let w = 0; parts.forEach(([k, t], i) => { for (const kk of k.split(' ')) w += chip(kk) + 6; w += U.textW(F, t) + (i < parts.length - 1 ? U.textW(F, sep) : 0); });
  let x = cx - w / 2;
  parts.forEach(([k, t], i) => {
    for (const kk of k.split(' ')) { const cw = chip(kk); s.round(x, base - 22, cw, 30, 6, hex('#e9e1cf')); s.round(x, base + 4, cw, 4, 2, [0, 0, 0], 0.35); s.print(F, kk, x + 8, base, { color: hex('#2a1c0c') }); x += cw + 6; }
    x += s.print(F, t, x, base, { color: C.text, shadow: [0, 2, [0, 0, 0], 0.8] });
    if (i < parts.length - 1) x += s.print(F, sep, x, base, { color: C.muted });
  });
}

// a rounded button (the web build's .btn): primary is the gold one
function button(s, x, y, w, h, label, o = {}) {
  const r = o.r === undefined ? h / 2 : o.r;
  if (o.primary) { const st = [[0, hex(o.hover ? '#ffe285' : '#ffd862')], [1, hex(o.hover ? '#f0b448' : '#e8a93a')]], c = [0, 0, 0]; s.paint(Mask.round(w, h, r), x, y, (px, py) => U.stops(st, (py - y) / h, c)); s.round(x, y, w, h, r, hex('#f6c24d'), 1, 2); }
  else { s.round(x, y, w, h, r, o.on ? hex('#3a2810') : o.hover ? hex('#33220f') : C.card2, o.alpha || 1); s.round(x, y, w, h, r, o.on ? C.gold : o.hover ? hex('#7a5326') : C.line2, 1, 2); }
  s.print(o.font || 'uis', label, x + w / 2, y + h / 2 + U.font(o.font || 'uis').asc * 0.36, { color: o.primary ? hex('#2a1803') : o.on ? C.gold : C.text, align: 'center' });
}
// a message in a pill at the bottom of the box (x, w) above y
function toast(s, msg, cx, y, maxw) {
  const t = U.fitText('ui', msg, maxw - 64), w = U.textW('ui', t) + 64;
  s.shadow(cx - w / 2, y - 64, w, 64, 32, 24, 0.7, 8); s.round(cx - w / 2, y - 64, w, 64, 32, hex('#160d06'), 0.95); s.round(cx - w / 2, y - 64, w, 64, 32, C.line2, 1, 2);
  s.print('ui', t, cx, y - 22, { color: C.text, align: 'center' });
}
// a copy of a screen region, to put back later (the LCD under its figures)
function grab(s, x, y, w, h) { const im = U.image(w, h); for (let r = 0; r < h; r++) im.rgba.set(s.rgba.subarray(((y + r) * s.w + x) * 4, ((y + r) * s.w + x + w) * 4), r * w * 4); return im; }
function put(s, im, x, y) { for (let r = 0; r < im.h; r++) s.rgba.set(im.rgba.subarray(r * im.w * 4, (r + 1) * im.w * 4), ((y + r) * s.w + x) * 4); }

const money = c => '$' + (c / 100).toFixed(2);

module.exports = { C, GOLD, LCD, radial, background, surround, title, marquee, marqueeParts, lcdBox, lcdText, hints, button, toast, grab, put, money };
