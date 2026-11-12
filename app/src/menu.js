// The window menu, after mk6c's (src/frontend/menu.c), drawn like the web build's play.html menu: a dark drop-down under the Menu button
// with gold group headings, each row's setting on the right (a switch for on / off, a chevron for a list). F10 (or the Menu button)
// opens and closes it. Up/Down/Home/End move, Enter or Space picks, Left/Backspace goes back from a list, Esc closes.
// Mouse: hover selects, click picks, a click outside closes, the wheel moves. Taller than the screen (H), it shows the rows that fit and
// scrolls to keep the chosen one in view, with arrows where there are more.
// items() is given by the app: [{ head: 'Group' } | { label, act: () => result, list?: () => items } | { info }]. A label "Name: value"
// shows the value on the right; a value of on / off is drawn as a switch; "..." at the end means a list; "* " in front marks the current choice.
const U = require('./ui.js'), K = require('./look.js'), { hex } = U, { C } = K;

const W0 = 620, ROW = 60, HEAD = 46, PAD = 14, ARROW = 32;

class Menu {
  constructor(W, items) { this.W = W; this.H = 0; this.root = items; this.stack = []; this.open = false; this.sel = 0; this.first = 0; this.at = { right: W - 24, top: 80 }; this.build(); }
  build() {
    const src = this.stack.length ? this.stack[this.stack.length - 1] : this.root;
    this.items = src(); if (this.stack.length) this.items.unshift({ label: '‹ Back', back: true });
    if (!this.ok(this.sel)) this.step(1, -1);
  }
  ok(i) { const it = this.items[i]; return !!it && !it.head && it.head !== '' && !it.info; }
  step(d, from = this.sel) { const n = this.items.length; for (let k = 1; k <= n; k++) { const i = ((from + d * k) % n + n) % n; if (this.ok(i)) { this.sel = i; return; } } }
  show() { this.open = true; this.stack = []; this.sel = 0; this.first = 0; this.build(); }
  hide() { this.open = false; }
  toggle() { if (this.open) this.hide(); else this.show(); }
  back() { if (!this.stack.length) return this.hide(); this.stack.pop(); this.sel = 0; this.first = 0; this.build(); }
  pick(i = this.sel) {
    const it = this.items[i]; if (!this.ok(i)) return;
    if (it.back) return this.back();
    if (it.list) { this.stack.push(it.list); this.sel = 0; this.first = 0; return this.build(); }
    const r = it.act && it.act(); if (r !== 'stay') this.hide(); else this.build();
  }
  key(k) {
    switch (k) {
      case 'up': this.step(-1); break; case 'down': this.step(1); break;
      case 'home': this.sel = -1; this.step(1, -1); break; case 'end': this.step(-1, 0); break;
      case 'return': case 'enter': case 'space': this.pick(); break;
      case 'left': case 'backspace': this.back(); break;
      case 'escape': case 'f10': this.hide(); break;
    }
  }
  h(it) { return it.head !== undefined ? (it.head ? HEAD : 18) : ROW; }
  // the rows shown, first to last (exclusive), the box's inner height and its padding (more room for the arrows when it scrolls). Scrolled,
  // the box keeps one height (the screen's), so the app's half-size picture of it is not made again at each step
  view() {
    const n = this.items.length, hs = this.items.map(it => this.h(it)), sum = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += hs[i]; return t; };
    const total = sum(0, n); if (!this.H || this.at.top + total + 2 * PAD + 24 <= this.H) { this.first = 0; return { first: 0, last: n, h: total, pad: PAD }; }
    const max = this.H - this.at.top - 24 - 2 * ARROW, sel = Math.max(0, this.sel);
    let f = Math.min(this.first, sel); while (f < sel && sum(f, sel + 1) > max) f++;
    if (f === sel && f > 0 && this.items[f - 1].head !== undefined && sum(f - 1, sel + 1) <= max) f--;   // its heading with it
    let l = f; while (l < n && sum(f, l + 1) <= max) l++;
    while (l === n && f > 0 && sum(f - 1, l) <= max) f--;   // no gap under the last row
    this.first = f; return { first: f, last: l, h: max, pad: ARROW };
  }
  box() { const v = this.view(); return { x: this.at.right - W0, y: this.at.top, w: W0, h: v.h + 2 * v.pad }; }
  rowAt(x, y) {
    const b = this.box(), v = this.view(); if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return -2;
    let yy = b.y + v.pad; for (let i = v.first; i < v.last; i++) { const h = this.h(this.items[i]); if (y >= yy && y < yy + h) return i; yy += h; }
    return -1;
  }
  hover(x, y) { const i = this.rowAt(x, y); if (i >= 0 && this.ok(i)) this.sel = i; }
  click(x, y) { const i = this.rowAt(x, y); if (i === -2) this.hide(); else if (i >= 0) this.pick(i); }
  draw(s) { if (!this.open) return; this.drawBox(s); this.drawRows(s); }
  // the panel with its shadow, then what is on it (the app's half-size frames keep the first and redraw the second only when it changes)
  // z: the scale (the app draws the box at half size for a small screen)
  drawBox(s, z = 1) { const b = this.box(), x = b.x * z, y = b.y * z, w = b.w * z, h = b.h * z;
    s.shadow(x, y, w, h, 16 * z, 40 * z, 0.75, 16 * z); s.round(x, y, w, h, 16 * z, hex('#1a110a'), 0.97); s.round(x, y, w, h, 16 * z, C.line2, 1, 2 * z); }
  drawRows(s) { this.arrows(s); for (const [i, x, y, w, h] of this.rows()) this.drawRow(s, i, x, y, w, h); }
  // the rows shown: [item, x, y, w, h]
  rows() {
    const b = this.box(), v = this.view(), out = []; let y = b.y + v.pad;
    for (let i = v.first; i < v.last; i++) { const h = this.h(this.items[i]); out.push([i, b.x + PAD, y, b.w - 2 * PAD, h]); y += h; }
    return out;
  }
  // more rows above or below: a small arrow in the padding (z: the scale)
  arrows(s, z = 1) {
    const b = this.box(), v = this.view(), cx = Math.round((b.x + b.w / 2) * z), n = 8 * z;
    const arrow = (y0, d) => { y0 = Math.round(y0 * z); for (let i = 0; i < n; i++) s.rect(cx - i - 1, y0 + (d > 0 ? i : n - 1 - i), 2 * i + 2, 1, C.muted); };
    if (v.first > 0) arrow(b.y + 12, 1); if (v.last < this.items.length) arrow(b.y + b.h - 20, -1);
  }
  // item i's row at (x, y), w by h
  drawRow(s, i, x, y, w, h) {
    {
      const it = this.items[i];
      if (it.head !== undefined) {
        if (it.head) s.print('uisb', it.head.toUpperCase(), x + 14, y + 34, { color: C.gold2, spacing: 1.5 });
        else s.rect(x + 14, y + 8, w - 28, 2, C.line);
        return;
      }
      if (i === this.sel) { s.round(x, y + 4, w, h - 8, 12, hex('#2c1d0e')); s.round(x, y + 4, w, h - 8, 12, C.gold, 1, 3); }
      let label = it.label || it.info, value = null, more = false, mark = false;
      if (/\.\.\.$/.test(label)) { more = true; label = label.slice(0, -3); }
      if (/^\* /.test(label)) { mark = true; label = label.slice(2); } else label = label.replace(/^ +/, '');
      const m = /^(.*?): (.+)$/.exec(label); if (m && !it.info) { label = m[1]; value = m[2]; }
      const base = y + h / 2 + 10;
      if (mark) s.print('uib', '✓', x + 20, base, { color: C.gold });
      s.print('ui', U.fitText('ui', label, w - 240), x + (mark ? 56 : 20), base, { color: it.info ? C.faint : C.text });
      let rx = x + w - 20;
      if (more) { s.print('uib', '›', rx, base, { color: C.muted, align: 'right' }); rx -= 30; }
      if (value === 'on' || value === 'off') {   // a switch, as games.html's
        const on = value === 'on'; s.round(rx - 68, y + h / 2 - 20, 68, 40, 20, on ? hex('#5a3f12') : hex('#3a2a18')); s.round(rx - 68, y + h / 2 - 20, 68, 40, 20, C.line2, 1, 2);
        s.round(on ? rx - 34 : rx - 64, y + h / 2 - 16, 32, 32, 16, on ? C.gold : C.muted);
      } else if (value) s.print('uis', value, rx, base - 2, { color: C.muted, align: 'right' });
    }
  }
}

module.exports = { Menu };
