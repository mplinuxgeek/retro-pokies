// The games list, after the web build's games.html (and mk6c's selector.c for the keys): the LCD strip with the wallet and the totals
// played, the RETRO POKIES brand, a search box, the pills (All games, Favourites) and a scrolling grid of cards: attract art with the scan's verdict and a favourite star, the name and what the scan played.
// Keys: arrows, PgUp/PgDn, Home/End move, Enter/Space launch, typing searches, Backspace edits the search, Esc clears it (or closes),
// Tab / Shift+Tab change the pill, Ctrl+D marks a favourite. Mouse: hover focuses, click launches, the star marks, wheel scrolls.
const fs = require('fs'), path = require('path');
const U = require('./ui.js'), K = require('./look.js'), { Mask, hex } = U, { C } = K;
const { RP } = require('./core.js');

const COLS = 3, M = 40, GAP = 28, TOP = 476, INFO = 98, R = 28;
const GROUPS = [['all', 'All games'], ['fav', '★ Favourites']];
const DOT = { ready: C.ready, maybe: C.maybe, broken: C.broken, unknown: C.unknown, off: C.unknown };

// the latest scan (retro-pokies/data/rom-status.json) and the catalogue (web/games.json), as games.html reads them
function loadInfo() {
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const B = require(path.join(RP, 'web', 'js', 'rtp-bands.js')), L = B.L;
  const GROUP_OF = { [L.normal]: 'ready', [L.abitlow]: 'maybe', [L.low]: 'maybe', [L.high]: 'maybe',
    [L.verylow]: 'broken', [L.never]: 'broken', [L.rarely]: 'broken', [L.always]: 'broken', [L.error]: 'broken', [L.timeout]: 'broken' };
  const st = {}, cat = {};
  for (const r of read(path.join(RP, 'data', 'rom-status.json')) || []) st[r.id] = r;
  for (const g of (read(path.join(RP, 'web', 'games.json')) || {}).games || []) cat[g.id] = g;
  return g => {
    const r = st[g.id] || {}, f = (cat[g.id] || {}).found || {}, label = r.status ? B.current(r.status) : null, bits = [];
    if (r.lines) bits.push(r.lines + (r.lines === 1 ? ' line' : ' lines'));
    const nr = f.reels || (f.strip_lengths && f.strip_lengths.length); if (nr) bits.push(nr + ' reels');
    if (r.features || r.hasFree) bits.push('free games');
    const group = !g.ok ? 'off' : label ? GROUP_OF[label] || 'unknown' : 'unknown';
    const title = (cat[g.id] || {}).title || r.name || null;   // the name games.html shows: the catalogue's title, else the scan's
    return { group, title, label: !g.ok ? (g.why === 'touch game' ? 'Touch game: web build only' : 'Not supported yet') : label || 'Not checked yet', meta: bits.join(' · ') };
  };
}
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
let cardSeq = 0;
// picture im at half size, each byte (alpha too) the average of four
const halfPic = im => { const w = im.w >> 1, h = im.h >> 1, o = new U.Screen(w, h), a = im.rgba, d = o.rgba;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (2 * y * im.w + 2 * x) * 4, j = i + im.w * 4, q = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) d[q + c] = (a[i + c] + a[i + 4 + c] + a[j + c] + a[j + 4 + c] + 2) >> 2; }
  return o.seal(); };   // each card picture made gets the next number: the list's picture is redrawn when one in view is new
const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return [f(0) * 255, f(8) * 255, f(4) * 255]; };

class Selector {
  // ctx: { favs: Set of ids (kept by the app), saveFavs(), lcd: () => [[label, text], ...], theme: () => LCD colour }
  constructor(games, art, W, H, ctx = {}) {
    this.games = games; this.art = art; this.ctx = ctx; this.filter = ''; this.group = 'all'; this.sel = 0; this.scroll = 0; this.goal = 0;
    const info = loadInfo(); for (const g of games) { g.info = info(g); if (g.info.title) g.name = g.info.title; }
    // titles compare with numbers as numbers (5 Dragons, 50 Lions, 100 Lions), as games.html sorts them
    games.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    this.list = games.filter(g => this.favs().has(g.id)).concat(games.filter(g => !this.favs().has(g.id))); this.current = null; this.hot = null; this.px = -1; this.py = -1;
    this.resize(W, H);
  }
  resize(W, H) {
    this.W = W; this.H = H; this.cw = (W - 2 * M - (COLS - 1) * GAP) / COLS | 0; this.ah = Math.round(this.cw * 0.47); this.ch = this.ah + INFO; this.rh = this.ch + GAP;
    this.bg = null; this.head = null; this.sigs = null; for (const g of this.games) g.card = null; this.clamp();
  }
  favs() { return this.ctx.favs || (this.ctx.favs = new Set()); }
  inGroup(g, k) { return k === 'all' || (k === 'fav' ? this.favs().has(g.id) : g.info.group === k); }
  apply() {
    const keep = this.list[this.sel], words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    this.list = this.games.filter(g => this.inGroup(g, this.group) && words.every(w => g.name.toLowerCase().includes(w))); this.listV = (this.listV || 0) + 1;
    const f = this.favs(); this.list.sort((a, b) => f.has(b.id) - f.has(a.id));   // favourites first, as the web list's shelf (the sort is stable)
    this.sel = Math.max(0, this.list.indexOf(keep)); this.reveal();
  }
  setFilter(f) { this.filter = f; this.apply(); }
  setGroup(k) { this.group = k; this.apply(); }
  toggleFav(g) { if (!g) return; const f = this.favs(); if (f.has(g.id)) f.delete(g.id); else f.add(g.id); g.card = null; if (this.ctx.saveFavs) this.ctx.saveFavs(); this.apply(); }
  focus(id) { const i = this.list.findIndex(g => g.id === id); if (i >= 0) { this.sel = i; this.reveal(true); } }
  rows() { return Math.ceil(this.list.length / COLS); }
  view() { return this.H - TOP - 16; }
  reveal(now) {   // scroll so the focused card is in view
    const y = Math.floor(this.sel / COLS) * this.rh;
    if (y < this.goal) this.goal = y; else if (y + this.ch > this.goal + this.view()) this.goal = y + this.ch - this.view() + 8;
    this.clamp(); if (now) this.scroll = this.goal;
  }
  clamp() { this.goal = Math.max(0, Math.min(this.goal, this.rows() * this.rh - this.view())); }
  move(d) { if (!this.list.length) return; this.sel = Math.max(0, Math.min(this.list.length - 1, this.sel + d)); this.reveal(); }
  // returns the game to launch, 'close' or null
  key(k, e = {}) {
    const page = COLS * Math.max(1, Math.floor(this.view() / this.rh));
    if (e.ctrl && k === 'd') { this.toggleFav(this.list[this.sel]); return null; }
    switch (k) {
      case 'left': this.move(-1); break; case 'right': this.move(1); break; case 'up': this.move(-COLS); break; case 'down': this.move(COLS); break;
      case 'pageUp': this.move(-page); break; case 'pageDown': this.move(page); break; case 'home': this.move(-1e9); break; case 'end': this.move(1e9); break;
      case 'tab': { const i = GROUPS.findIndex(g => g[0] === this.group), n = GROUPS.length; this.setGroup(GROUPS[(i + (e.shift ? n - 1 : 1)) % n][0]); break; }
      case 'return': case 'enter': case 'space': return this.list[this.sel] || null;
      case 'backspace': if (this.filter) this.setFilter(this.filter.slice(0, -1)); break;
      case 'escape': if (this.filter) this.setFilter(''); else return 'close'; break;
    }
    return null;
  }
  text(t) { if (t === ' ' && !this.filter) return; if (this.filter.length < 30) this.setFilter(this.filter + t); }
  cardXY(i) { return [M + (i % COLS) * (this.cw + GAP), TOP + Math.floor(i / COLS) * this.rh - Math.round(this.scroll)]; }
  at(x, y) {   // card index under a screen point, or -1
    if (y < TOP) return -1;
    const c = Math.floor((x - M) / (this.cw + GAP)), r = Math.floor((y - TOP + this.scroll) / this.rh);
    if (c < 0 || c >= COLS || x - M - c * (this.cw + GAP) > this.cw || (y - TOP + this.scroll) - r * this.rh > this.ch) return -1;
    const i = r * COLS + c; return i < this.list.length ? i : -1;
  }
  onStar(i, x, y) { const [cx, cy] = this.cardXY(i); return Math.hypot(x - (cx + this.cw - 40), y - (cy + 40)) < 30; }
  hover(x, y) { this.px = x; this.py = y; const i = this.at(x, y); if (i >= 0) this.sel = i; }
  // returns the game to launch, or null (a click on a pill, the search box or a star is handled here)
  click(x, y) {
    for (const p of this.pills || []) if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) { this.setGroup(p.k); return null; }
    const i = this.at(x, y); if (i < 0) return null;
    if (this.onStar(i, x, y)) { this.toggleFav(this.list[i]); return null; }
    return this.list[i];
  }
  wheel(dy) { this.goal -= dy * this.rh / 2; this.clamp(); }

  // the games whose cards the list shows where it is scrolled to
  // the first drawing's slow parts one at a time (the background, the header, each shown card), yielding the fraction done so a loading
  // bar can move between them; draw then reuses them
  *warm() {
    const gs = this.shownGames(), n = gs.length + 2;
    if (!this.bg) { this.bg = new U.Screen(this.W, this.H); K.background(this.bg); } yield 1 / n;
    if (!this.head) this.head = this.header(); yield 2 / n;
    for (let i = 0; i < gs.length; i++) { const g = gs[i]; if (!g.card || g.cardArt !== g.art) { g.card = this.card(g); g.cardArt = g.art; g.cardN = ++cardSeq; } yield (i + 3) / n; }
  }
  shownGames() { const r0 = Math.max(0, Math.floor(this.goal / this.rh)), r1 = Math.min(this.rows(), Math.ceil((this.goal + this.H - TOP) / this.rh) + 1); return this.list.slice(r0 * COLS, r1 * COLS); }

  // ---- drawing ----
  card(g) {   // the card's picture (cached until its art, star or playing mark changes)
    const cw = this.cw, ah = this.ah, s = new U.Screen(cw, this.ch); s.u32.fill(0);
    const box = Mask.round(cw, this.ch, R);
    s.paint(box, 0, 0, C.card);
    if (g.art) { const im = U.cover(g.art, cw, ah, 0.3); if (!g.ok) U.adjust(im, 0.4, 0.4); s.draw(im, 0, 0); }
    else { const h = hue(g.name), a = hsl(h, 55, 32), b = hsl((h + 40) % 360, 60, 12);
      K.radial(s, 0, 0, cw, ah, cw * 0.3, ah * 0.2, cw * 0.9, ah * 1.6, [[0, a, 1], [1, b, 1]]);
      const t = U.fitText('uib', g.name, cw - 40); s.print('uib', t, cw / 2, ah / 2 + 10, { color: C.text, align: 'center', shadow: [0, 3, [0, 0, 0], 0.7] }); }
    s.rect(0, ah, cw, 2, C.line);
    // the scan's verdict, bottom left of the art; none for a game that pays (a "Pays ..." label)
    const t = g.info.label, bw = U.textW('uisb', t) + 54;
    if (!/^Pays /.test(t)) { s.round(14, ah - 54, bw, 40, 20, [12, 8, 4], 0.78); s.round(14 + 16, ah - 54 + 12, 16, 16, 8, DOT[g.info.group]); s.print('uisb', t, 14 + 42, ah - 54 + 28, { color: C.text }); }
    if (this.current === g.id) { const w = U.textW('uisb', 'PLAYING') + 28; s.round(14, 14, w, 36, 18, C.gold); s.print('uisb', 'PLAYING', 28, 40, { color: hex('#2a1803') }); }
    // favourite star, top right
    const fav = this.favs().has(g.id); s.round(cw - 70, 10, 60, 60, 30, [0, 0, 0], 0.55); s.print('uib', fav ? '★' : '☆', cw - 40, 52, { color: fav ? C.gold : C.text, align: 'center' });
    s.print('uib', U.fitText('uib', g.name, cw - 36), 18, ah + 44, { color: g.ok ? C.text : C.muted });
    s.print('uis', U.fitText('uis', g.info.meta || ' ', cw - 36), 18, ah + 80, { color: C.muted });
    s.round(0, 0, cw, this.ch, R, C.line, 1, 2);
    for (let i = 0; i < box.a.length; i++) s.rgba[i * 4 + 3] = 255 * box.a[i];   // round the corners
    return s.seal();
  }
  prefetch(r0, r1) {
    for (const r of [r1, r1 + 1, r0 - 1]) for (let c = 0; c < COLS; c++) {
      const g = r >= 0 && this.list[r * COLS + c]; if (!g) continue;
      if (g.art === undefined && !g.loading) { if (this.art.file(g)) { this.art.want(g); return; } continue; }   // not one the worker must make: those wait for the view
      if (g.art !== undefined && (!g.card || g.cardArt !== g.art)) { g.card = this.card(g); g.cardArt = g.art; g.cardN = ++cardSeq; return; }
      if (this.halved && g.card && g.cardHN !== g.cardN) { g.cardH = halfPic(g.card); g.cardHN = g.cardN; return; }   // and at half size, when the list is drawn so
    }
  }
  // the focused card's glow (a gold shadow, blurred 32 pixels) less what the card, lifted 4 pixels, covers with opaque pixels
  glowMask(card) {
    if (this.glow && this.glow.cw === this.cw && this.glow.ch === this.ch) return this.glow.m;
    const o = Mask.round(this.cw, this.ch, R).blur(32), m = new Mask(o.w, o.h, o.ox, o.oy); m.a.set(o.a);
    for (let y = 0; y < card.h; y++) for (let x = 0; x < card.w; x++) if (card.rgba[(y * card.w + x) * 4 + 3] === 255) m.a[(y - 4 - o.oy) * m.w + x - o.ox] = 0;
    this.glow = { cw: this.cw, ch: this.ch, m }; return m;
  }
  header() {   // what does not change in the header: background, LCD glass, brand
    const s = new U.Screen(this.W, TOP); K.background(s); this.lcdTheme = this.ctx.theme ? this.ctx.theme() : 'green';
    const sx = (this.W - 1000) / 2; K.surround(s, sx, -20, 1000, 158, 12, 6);
    const st = [[0, hex('#221208')], [1, hex('#120803')]], o = [0, 0, 0]; s.paint(Mask.round(1000, 158, 12), sx, -20, (x, y) => U.stops(st, (y + 20) / 158, o));
    this.lcd = { x: (this.W - 900) / 2, y: 12, w: 900, h: 96 }; K.lcdBox(s, this.lcd.x, this.lcd.y, 900, 96, this.lcdTheme);
    s.shadow(M, 172, 92, 92, 24, 36, 0.5, 12, [255, 190, 60]); s.round(M - 2, 170, 96, 96, 26, C.line2);
    if (this.icon) { const im = U.rounded(U.resize(this.icon, 92, 92), 24); s.draw(im, M, 172); }
    s.print('brand', 'RETRO POKIES', M + 128, 226, { color: hex('#5a1d00'), spacing: 1.6 });
    s.print('brand', 'RETRO POKIES', M + 128, 222, { grad: K.GOLD, spacing: 1.6 });
    s.print('ui', 'Classic pokie games. Play money only.', M + 128, 260, { color: C.muted });
    return s;
  }
  // the list into screen s, in two parts each redrawn only when what it shows has changed: the header (rows 0 .. TOP: brand, LCD,
  // search box, pills, and what extra(s) draws there, its look given by key) and the cards below it. full: s holds something else, draw
  // all. Returns the rows drawn as [[y0, y1], ...], or null when all were. s at half size (a handheld's screen): drawn at half size, from
  // the background, cards and glow halved once and kept, the header drawn full size and halved when it changes
  draw(s, key = '', extra = null, full = false) {
    const z = s.w < this.W ? 0.5 : 1;
    this.scroll += (this.goal - this.scroll) * 0.3; if (Math.abs(this.goal - this.scroll) < 0.5) this.scroll = this.goal;
    if (!this.bg) { this.bg = new U.Screen(this.W, this.H); K.background(this.bg); }
    if (!this.head || this.lcdTheme !== (this.ctx.theme ? this.ctx.theme() : 'green')) { this.head = this.header(); full = true; }
    const r0 = Math.max(0, Math.floor(this.scroll / this.rh)), r1 = Math.min(this.rows(), Math.ceil((this.scroll + this.H - TOP) / this.rh) + 1), shown = [];
    for (let r = r0; r < r1; r++) for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c, g = this.list[i]; if (!g) break;
      this.art.want(g);
      if (!g.card || g.cardArt !== g.art) { g.card = this.card(g); g.cardArt = g.art; g.cardN = ++cardSeq; }
      shown.push(i, g.cardN);
    }
    const sy = 290, sw = 560, n = this.list.length, hp = (this.pills || []).findIndex(p => this.px >= p.x && this.px < p.x + p.w && this.py >= p.y && this.py < p.y + p.h);
    const sig = { sel: this.sel, l: [Math.round(this.scroll), this.listV, this.games.length, shown].join(),
      h: JSON.stringify([this.ctx.lcd ? this.ctx.lcd() : 0, this.filter, this.filter && Date.now() % 1000 < 550, n, this.group, hp, this.favs().size, key]) };
    const was = full ? {} : this.sigs || {}, rows = []; this.sigs = sig;
    let head = was.h !== sig.h;
    // the rows to redraw: all of the cards' part, or (only the focus moved) the rows of the old and the new focused card with its glow
    // and frame (bands that overlap joined: each glow lies inside one band, and is drawn over the picture once). What is drawn stays in
    // its band (the glow and frame too), so cards scrolling under the header leave its rows as they were
    let bands = was.l !== sig.l ? [[TOP, this.H]] : was.sel !== sig.sel ? [was.sel, sig.sel].map(i => { const y = this.cardXY(i)[1]; return [y - 32, y + this.ch + 32]; }).sort((a, b) => a[0] - b[0]) : [];
    if (bands.length === 2 && bands[1][0] <= bands[0][1]) bands = [[bands[0][0], Math.max(bands[0][1], bands[1][1])]];
    for (const [b0, b1] of bands) {
      const y0 = Math.max(TOP, b0), y1 = Math.min(this.H, b1); if (y0 >= y1) continue;
      if (z < 1) { this.bandHalf(s, shown, y0, y1); rows.push([y0 >> 1, Math.min(s.h, (y1 + 1) >> 1)]); continue; }
      s.u32.set(this.bg.u32.subarray(y0 * this.W, y1 * this.W), y0 * this.W); rows.push([y0, y1]);
      for (let k = 0; k < shown.length; k += 2) {
        const i = shown[k], g = this.list[i], [x, y] = this.cardXY(i), cy = y - (i === this.sel ? 4 : 0);
        if (cy + this.ch <= y0 || cy >= y1) continue;
        if (i === this.sel) s.paint(this.glowMask(g.card), x, y, C.gold, 0.45, undefined, y0, y1);
        s.draw(g.card, x, cy, 1, Math.max(0, y0 - cy), y1 - Math.max(y0, cy));
        if (i === this.sel) s.paint(Mask.ring(this.cw + 10, this.ch + 10, R + 5, 4), x - 5, y - 9, C.gold, 1, undefined, y0, y1);
      }
      this.empty(s);
    }
    // nothing changed: the card of a game a row beyond the view (below first, then above) made now, one a frame, its art read first, so
    // scrolling there does not wait for them
    if (!rows.length && !head && this.scroll === this.goal) this.prefetch(r0, r1);
    if (head) {
      // the header (opaque) over cards scrolled under it; at half size drawn full size and halved
      if (z === 1) this.drawHead(s, n, sy, sw, extra);
      else { if (!this.headS || this.headS.w !== this.W) this.headS = new U.Screen(this.W, TOP); this.drawHead(this.headS, n, sy, sw, extra); s.halfFrom(this.headS, 0, 0, this.W & ~1, TOP); }
      rows.push([0, TOP * z]);
    }
    return full ? null : rows;
  }
  // the header's changing part (LCD text, search box, pills, extra) over its picture, into t (rows 0 .. TOP)
  drawHead(t, n, sy, sw, extra) {
    t.put(this.head, 0, 0);
    if (this.ctx.lcd) K.lcdText(t, this.lcd.x, this.lcd.y, this.lcd.w, this.lcd.h, this.ctx.lcd(), this.lcdTheme);
    // search box and pills
    t.round(M, sy, sw, 64, 32, C.card); t.round(M, sy, sw, 64, 32, this.filter ? C.gold : C.line2, 1, 2);
    t.round(M + 26, sy + 20, 20, 20, 10, C.muted, 1, 3); t.rect(M + 43, sy + 37, 4, 10, C.muted);
    if (this.filter) { const w = t.print('ui', this.filter, M + 64, sy + 42, { color: C.text }); if (Date.now() % 1000 < 550) t.rect(M + 66 + w, sy + 16, 3, 34, C.gold); }
    else t.print('ui', 'Search games (type)', M + 64, sy + 42, { color: C.faint });
    t.print('uis', n + (n === 1 ? ' game' : ' games') + (this.group !== 'all' || this.filter ? ' of ' + this.games.length : ''), this.W - M, sy + 42, { color: C.muted, align: 'right' });
    let px = M; this.pills = [];
    for (const [k, label] of GROUPS) {
      const cnt = this.games.filter(g => this.inGroup(g, k)).length, w = U.textW('uis', label) + U.textW('uis', String(cnt)) + 52, on = this.group === k;
      const hov = this.px >= px && this.px < px + w && this.py >= 380 && this.py < 436;
      t.round(px, 380, w, 56, 28, on ? hex('#3a2810') : hov ? hex('#33220f') : C.card); t.round(px, 380, w, 56, 28, on ? C.gold2 : C.line2, 1, 2);
      const tw = t.print('uis', label, px + 22, 416, { color: C.text }); t.print('uis', String(cnt), px + 30 + tw, 416, { color: C.faint });
      this.pills.push({ k, x: px, y: 380, w, h: 56 }); px += w + 14;
    }
    if (extra) extra(t);
  }
  // no card to show: why, below the header of s (full size)
  empty(s) {
    if (!this.list.length) {
      const msg = !this.games.length ? 'No games yet' : this.group === 'fav' && !this.filter ? 'No favourites yet' : 'No game matches';
      const sub = !this.games.length ? 'Put ROM zips in the roms folder here, or in roms or mk6roms in your home folder' : this.group === 'fav' ? 'Ctrl+D or the star on a card marks one' : 'Esc clears the search';
      s.print('big', msg, this.W / 2, TOP + 120, { color: C.text, align: 'center' }); s.print('ui', sub, this.W / 2, TOP + 170, { color: C.muted, align: 'center' });
    }
  }
  // rows [y0, y1) of the cards' part (full-size rows) into s at half size
  bandHalf(s, shown, y0, y1) {
    const hy0 = y0 >> 1, hy1 = Math.min(s.h, (y1 + 1) >> 1), hw = s.w; this.halved = true;
    if (!this.bgH || this.bgH.w !== hw) { this.bgH = new U.Screen(hw, s.h); this.bgH.halfFrom(this.bg, 0, 0, hw * 2, s.h * 2); }
    s.u32.set(this.bgH.u32.subarray(hy0 * hw, hy1 * hw), hy0 * hw);
    if (!this.list.length) {   // the message drawn full size and halved
      const f = this.emptyS && this.emptyS.w === this.W ? this.emptyS : (this.emptyS = new U.Screen(this.W, this.H)), e0 = y0 & ~1, e1 = Math.min(this.H, hy1 * 2);
      f.u32.set(this.bg.u32.subarray(e0 * this.W, e1 * this.W), e0 * this.W); this.empty(f); s.halfFrom(f, 0, e0, hw * 2, e1 - e0); return;
    }
    for (let k = 0; k < shown.length; k += 2) {
      const i = shown[k], g = this.list[i], [x, y] = this.cardXY(i), hx = x >> 1, hy = Math.floor(y / 2), hcy = hy - (i === this.sel ? 2 : 0);
      if (g.cardHN !== g.cardN) { g.cardH = halfPic(g.card); g.cardHN = g.cardN; }
      const c = g.cardH; if (hcy + c.h <= hy0 || hcy >= hy1) continue;
      if (i === this.sel) s.paint(this.glowHalf(g.card), hx, hy, C.gold, 0.45, undefined, hy0, hy1);
      s.draw(c, hx, hcy, 1, Math.max(0, hy0 - hcy), hy1 - Math.max(hy0, hcy));
      if (i === this.sel) s.paint(Mask.ring(c.w + 6, c.h + 6, (R + 5) / 2, 2), hx - 3, hcy - 3, C.gold, 1, undefined, hy0, hy1);
    }
  }
  // the glow (see glowMask) at half size
  glowHalf(card) {
    const m = this.glowMask(card); if (this.glowH && this.glowH.src === m) return this.glowH.m;
    const h = new Mask((m.w + 1) >> 1, (m.h + 1) >> 1, m.ox / 2, m.oy / 2), at = (x, y) => x < m.w && y < m.h ? m.a[y * m.w + x] : 0;
    for (let y = 0; y < h.h; y++) for (let x = 0; x < h.w; x++) h.a[y * h.w + x] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
    this.glowH = { src: m, m: h }; return h;
  }
}

module.exports = { Selector };
