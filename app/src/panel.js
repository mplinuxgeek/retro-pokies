// The cabinet control panel under the game, drawn as the web build's play.html draws it: its brushed-steel fascia, key lenses, lamps,
// shadows, glows and banknote acceptor come from play.html's own CSS, rendered by Chromium at this panel's scale into assets/webpanel.*
// (tools/import-webpanel.py); the labels are drawn here with the font Chromium draws play.html's "Arial Narrow" with (Liberation Sans) and laid
// out as the browser lays out a key: label, big number, small print, centred in the key. Layout as play.html's #cab: the BET row over the
// PLAY row, then a 3 x 2 block counted from the right (AUTO over SPIN, a labelled play key over GAMBLE, a prompt key over FEATURE) and the
// note acceptor. On a wide screen (side) the panel is two columns either side of the game instead: the BET and PLAY rows turned into
// columns on the left; on the right the 3 x 2 block over the note acceptor, SPIN at its bottom right with GAMBLE beside it and AUTO above. Lamps come from the ROM's lamp table (vm.lamps); the chosen bet and play keys glow green, a labelled play key blue.
// Keys: 0 SPIN, 1-5 and 7 play lines, 10-14 bet, 9 AUTO (a host feature), 7 FEATURE, 15 GAMBLE.
// Gamble, as play.html: at the take-win prompt SPIN reads PLAY ON; on the gamble screen it reads COLLECT, the first and last plain play keys
// become RED and BLACK and the bet keys with a suit pick that suit (app.js gambleKey). pick: a prompt's key chosen with the arrow keys (a pad), shown as pointed at.
const path = require('path'), fs = require('fs');
const { MK6 } = require('./core.js'), U = require('./ui.js'), { Mask, hex } = U;
const WP = require('../assets/webpanel.json'), PC = WP.pieces, Z = WP.scale;   // Z: screen pixels per CSS pixel
const KEY = 64, PITCH = 74, W = Math.round(800 * Z), H = Math.round(156 * Z), NOTE = { x: 694, y: 9, w: 96, h: 138 };
const at = v => v * Z, col = c => 620 - PITCH * c, row = r => 9 + PITCH * r;   // CSS pixels from the panel's top left; stack columns from the right
// side columns: each as wide as the strip is tall (CW screen pixels); in the panel's picture the right one starts RX in, so a lit key's glow
// in the left column does not reach it
const CW = Math.round(156 * Z) & ~1, RX = CW + 64;
// play.html's suits on the five bet keys (SUIT_OF_BET: heart, diamond, none, club, spade)
const SUIT_OF_BET = [0, 1, -1, 2, 3];
// label colours (play.html .cb rules): ink per style and state, and the text shadow lit keys get
const INK = {
  bet: hex('#2c2c30'), 'bet.lamp': hex('#3a2a06'), 'bet.sel': hex('#0d4a14'), play: hex('#2c2c30'), 'play.lamp': hex('#3a2a06'), 'play.sel': hex('#0d4a14'),
  special: hex('#06284a'), 'special.lit': hex('#06284a'), spin: hex('#444444'), 'spin.lamp': hex('#3a2a06'), auto: hex('#4a2300'), 'auto.lit': hex('#4a2300'),
  gamble: hex('#2b0a40'), 'gamble.lamp': hex('#25003b'), fkey: hex('#2c2c30'), 'fkey.lamp': hex('#3a2a06'), 'fkey.ring': hex('#2c2c30'),
};
const LIFT = new Set(['bet.lamp', 'play.lamp', 'play.sel', 'fkey.lamp']), GLOW = new Set(['special.lit', 'auto.lit']);   // 0 1px 0 #fff8; 0 0 3px #fff8
// MK6Emu's two flash rates (mk6c panel.c): state 2 fast, on 430 ms of 760; state 3 slow, on 760 of 1520
const flashOn = (st, ms) => st === 2 ? ms % 760 < 430 : ms % 1520 < 760;

let atlas = null, bill = null, column = null;
async function load() {
  if (!atlas) atlas = await MK6.decodePngRGBA(new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'assets', 'webpanel.png'))));
  return atlas;
}
const piece = (s, name, x, y, mul, alpha) => { const p = PC[name]; if (p) s.sprite(atlas, p, x + p.ox, y + p.oy, mul, alpha); };

// the steel fascia as a column of h pixels (and its shadow) for the side layout, made from the strip: its two ends (rounded corners and
// edges) side by side, its top and bottom edges kept, and the brushed middle rows between them repeated, mirrored so no seam shows
function makeColumn(h) {
  if (column && column.ch === h) return column;
  const P = PC.steel, L = -P.ox, T = -P.oy, Rt = P.w - L - W, B = P.h - T - H, E = 60, w = CW + L + Rt, oh = h + T + B, im = { w, h: oh, ch: h, x: 0, y: 0, rgba: new Uint8ClampedArray(w * oh * 4) };
  const a = atlas.rgba, m0 = T + E, band = P.h - B - E - m0;
  for (let y = 0; y < oh; y++) {
    let sy; if (y < m0) sy = y; else if (y >= oh - B - E) sy = y - oh + P.h; else { const k = (y - m0) % (2 * band); sy = m0 + (k < band ? k : 2 * band - 1 - k); }
    // the two ends fade into each other over the middle 60 pixels
    for (let x = 0; x < w; x++) { const t = Math.min(1, Math.max(0, (x - (w >> 1) + 30) / 60)), r = ((P.y + sy) * atlas.w + P.x) * 4, i = r + x * 4, j = r + (x - w + P.w) * 4, di = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) im.rgba[di + c] = t <= 0 ? a[i + c] : t >= 1 ? a[j + c] : a[i + c] + (a[j + c] - a[i + c]) * t; }
  }
  return (column = im);
}

// words wrapped to max pixels in font f with letter spacing sp, as the browser wraps a key's text
function wrap(f, text, max, sp) {
  const out = []; let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) { const t = line ? line + ' ' + w : w; if (line && U.textW(f, t, sp) + sp > max) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line); return out;
}

// a $100 note (an Australian polymer hundred: green, a clear window, the value at the corners), drawn once, upright: it goes in short edge first
function makeBill() {
  const w = Math.round(62 * Z), h = Math.round(150 * Z), s = new U.Screen(w, h); s.u32.fill(0);
  const m = Mask.round(w, h, 5);
  const st = [[0, hex('#146430')], [0.45, hex('#329e50')], [1, hex('#146430')]], o = [0, 0, 0]; s.paint(m, 0, 0, (x, y) => U.stops(st, x / w, o));
  s.paint(Mask.round(w - 20, 60, 26), 10, 100, hex('#bfe3c4'), 0.35);
  s.round(12, 14, 34, 48, 5, hex('#e8f4ff'), 0.55); s.round(12, 14, 34, 48, 5, hex('#ffffff'), 0.6, 2);
  s.print('uib', '100', w - 8, h - 12, { color: hex('#e9f7e2'), align: 'right' }); s.print('uisb', '100', w - 8, 34, { color: hex('#e9f7e2'), align: 'right' });
  s.round(0, 0, w, h, 5, hex('#0d4220'), 1, 2);
  for (let i = 0; i < w * h; i++) s.rgba[i * 4 + 3] = 255 * m.a[i];   // the screen is opaque where painted: cut the corners
  return s;
}

class Panel {
  // side: { gap, h } for the side layout: the columns are h pixels tall, the right one gap pixels to the right of the left one's edge
  constructor(game, x0, y0, noteText = '$100', side = null) {
    this.g = game; this.noteText = noteText; this.x0 = x0; this.y0 = y0; this.held = -1; this.auto = false; this.autoAt = 0; this.feedT = -1e9;
    this.side = side; this.gap = side ? side.gap : 0; this.W = side ? RX + CW : W; this.H = side ? side.h : H;   // the panel's picture
    const m = game.map, h = game.host, keyText = k => { try { return h.keyText(k) || ''; } catch (e) { return ''; } };
    this.lineOf = {}; for (const [n, k] of Object.entries(m.lineKeys || {})) this.lineOf[k] = +n;
    this.betOf = {}; for (const [n, k] of Object.entries(m.betKeys || {})) this.betOf[k] = +n;
    this.keys = []; const add = (key, kind, x, y, label) => this.keys.push({ key, kind, x, y, label });
    const lines = Object.entries(m.lineKeys || {}).map(([n, k]) => [+n, k]).sort((a, b) => a[0] - b[0]), bets = Object.entries(m.betKeys || {}).map(([n, k]) => [+n, k]).sort((a, b) => a[0] - b[0]);
    // where the keys go (CSS pixels in the picture): the BET and PLAY rows, the block (column c from the right, row r) and the note acceptor.
    // side: the rows are columns centred in the left column; the block sits on the note acceptor: SPIN bottom right, GAMBLE to its left,
    // AUTO over SPIN with FEATURE to its left, then the labelled play key (left) and the prompt key (right) over those
    const ch = this.H / Z, rx = RX / Z, n = Math.max(bets.length, lines.filter(([l]) => !(m.lineLabels || {})[l]).length), top = Math.round((ch - PITCH * (n - 1) - KEY) / 2);
    const betAt = i => side ? [9, top + PITCH * i] : [10 + PITCH * i, row(0)], playAt = i => side ? [83, top + PITCH * i] : [10 + PITCH * i, row(1)];
    const base = ch - 9 - NOTE.h - 14 - KEY;
    const SIDE = [[[83, 1], [83, 0]], [[9, 2], [9, 0]], [[83, 2], [9, 1]]];   // [column][row]: x in the right column, row up from the bottom
    this.blk = (c, r) => { if (!side) return [col(c), row(r)]; const [x, k] = (SIDE[c] || [[9, c]])[r] || [9, c]; return [rx + x, base - PITCH * k]; };
    this.note = side ? { x: rx + (CW / Z - NOTE.w) / 2, y: ch - 9 - NOTE.h } : { x: NOTE.x, y: NOTE.y };
    // PLAY row: plain line counts, fewest first; a key the ROM names (5 Dragons' EXTRA, Reel Power's reels) shows that name, a labelled one goes in the block
    let unitAll = 'LINES', slot = 0, pi = 0;
    for (const [n, k] of lines) {
      const lbl = (m.lineLabels || {})[n], rt = keyText(k);
      if (lbl) { add(k, 'special', ...this.blk(1 + slot, 0), { top: 'PLAY', big: lbl.toUpperCase().split(' '), small: n + ' CREDITS' }); slot++; continue; }
      const mm = /^Play\s*(\d+)\s*(Ways?|Lines?)\b/i.exec(rt), r = /^Play\s*(REELS?\s*1(?:-\d)?)\b/i.exec(rt);
      const [big, unit] = mm ? [mm[1], mm[2].toUpperCase()] : r ? [r[1].toUpperCase().replace(/^REELS?\s*/, ''), /-/.test(r[1]) ? 'REELS' : 'REEL'] : [String(n), n === 1 ? 'LINE' : 'LINES'];
      add(k, 'play', ...playAt(pi++), { top: 'PLAY', big: [big], small: unit }); unitAll = unit;
    }
    // BET row: a ways or Reel Power game's bet is not a bet per line (play.html PER_LINE)
    const perLine = /LINE/.test(unitAll) ? ' PER LINE' : '';
    bets.forEach(([n, k], i) => add(k, 'bet', ...betAt(i), /^BET x\d/i.test(keyText(k)) ? { top: 'BET', big: ['X' + n], small: 'MULTIPLIER', suit: -1 }
      : { top: 'BET', big: [String(n)], small: (n === 1 ? 'CREDIT' : 'CREDITS') + perLine, suit: bets.length === 5 ? SUIT_OF_BET[i] : -1 }));
    add(9, 'auto', ...this.blk(0, 0), { text: 'AUTO' }); add(0, 'spin', ...this.blk(0, 1), { text: 'SPIN' });
    this.canGamble = !!(h.canGamble && h.canGamble()); if (this.canGamble) add(15, 'gamble', ...this.blk(1, 1), { text: 'GAMBLE' });
    this.feature = this.lineOf[7] === undefined; if (this.feature) add(7, 'fkey', ...this.blk(2, 1), { text: 'FEATURE' });
    this.prompt = null;   // a further key the ROM waits for (GAME MENU and so on): over FEATURE while it is wanted
    const plain = this.keys.filter(o => o.kind === 'play'); this.red = plain.length ? plain[0].key : -1; this.black = plain.length > 1 ? plain[plain.length - 1].key : -1;
    this.bets = bets.map(([, k]) => k); this.pick = -1;
  }
  // the gamble screen's suit for a bet key (play.html SUIT_KEY: heart, diamond, none, club, spade), or null
  suitOf(k) { const i = this.bets.indexOf(k); return i < 0 ? null : ['H', 'D', null, 'C', 'S'][i] || null; }
  // Pharaohs Fortune's own gamble screen: SPIN and GAMBLE flash and no play key does; the ROM then lights the red, black and suit keys itself (play.html romG)
  romGamble() { const g = this.g.host.gamble; return !!(g && g.screen) && this.lamp(0) >= 2 && this.lamp(15) >= 2 && !Object.keys(this.lineOf).some(k => this.lamp(+k) >= 2); }
  // a key's text now: the gamble's names over the printed ones
  labelOf(o) {
    const g = this.g.host.gamble; if (!g) return o.label;
    if (o.kind === 'spin') return { text: g.screen ? 'COLLECT' : 'PLAY ON', small: true };   // smaller, as play.html's .cb.spin.collect
    if (g.screen && o.kind === 'play') return { text: o.key === this.red ? 'RED' : o.key === this.black ? 'BLACK' : '', big: true };   // a <big> label in play.html: the 85% rule
    return o.label;
  }
  hold(k) { this.held = k; this.heldUntil = Date.now() + 150; }
  // the prompt key's place: a key the ROM offers that the panel has no key for
  syncPrompt() {
    const h = this.g.host, have = new Set(this.keys.map(k => k.key)), k = h.choiceKeys().find(n => !have.has(n) && n !== 0);
    const want = k === undefined ? null : k, cur = this.prompt ? this.prompt.key : null; if (want === cur) return;
    if (this.prompt) this.keys.splice(this.keys.indexOf(this.prompt), 1);
    this.prompt = want === null ? null : { key: want, kind: 'fkey', x: this.blk(2, 0)[0], y: this.blk(2, 0)[1], label: { text: (h.keyText(want) || 'KEY ' + want).toUpperCase() } };
    if (this.prompt) this.keys.push(this.prompt);
  }
  used(k) { return this.keys.some(o => o.key === k); }
  lamp(k) { const L = this.g.vm.lamps || {}; return L[k] ? [1, 0, 2, 3][L[k].state & 3] : -1; }   // as play.html: ROM state 0 lights the key, 1 leaves it dark
  lit(k, ms) {
    const h = this.g.host, st = this.lamp(k), choice = h.choiceKeys();
    if (k === 9) return this.auto;
    if (k === 15 && st < 0) { const g = h.gamble; return !!(g && !g.screen && !g.busy) && flashOn(3, ms); }   // GAMBLE flashes slowly while it is offered
    if (choice.includes(k)) return flashOn(st >= 2 ? st : 2, ms);
    if (st >= 2) return flashOn(st, ms);
    if (k === 0) return st === 1 || (st < 0 && !h.phase && h.credits >= h.cost);
    return st === 1;
  }
  keyAt(x, y) {   // ROM key under a screen point, 99 for the note acceptor, or -1
    let qx = x - this.x0; if (this.side) { if (qx >= CW + this.gap) qx += RX - CW - this.gap; else if (qx >= CW) return -1; }
    const px = qx / Z, py = (y - this.y0) / Z, N = this.note;
    if (px >= N.x && px < N.x + NOTE.w && py >= N.y && py < N.y + NOTE.h) return 99;
    for (const o of this.keys) if (px >= o.x && px < o.x + KEY && py >= o.y && py < o.y + KEY) return o.key;
    return -1;
  }
  feed() { this.feedT = Date.now(); }   // a note goes in: the acceptor's slot lights and the note is pulled through it
  // a click: returns what the app should do ('note', 'spin') after the panel's own key handling
  press(k) {
    const h = this.g.host; this.held = k; this.heldUntil = Date.now() + 150;
    if (k === 99) return 'note';
    if (k !== 9 && k !== 99) this.auto = false;   // any other panel key stops AUTO (the press still acts), as in play.html
    if (h.choiceKeys().includes(k)) { h.pressKey(k); return null; }
    if (k === 9) { this.auto = !this.auto; this.autoAt = this.autoLast = 0; return null; }   // the first SPIN at once
    if (k === 0) return 'spin';
    if (this.betOf[k] !== undefined) { h.setBet(this.betOf[k]); return null; }
    if (this.lineOf[k] !== undefined) { if (h.setLines(this.lineOf[k])) return 'spin'; }
    return null;
  }
  // AUTO: SPIN again 1.5 s after the machine is idle and 3 s after its last SPIN (play.html's AUTO_IDLE, AUTO_COOLDOWN); stops when the credit runs out, and at a feature trigger or free-game start (the
  // player starts and watches it), as in play.html. While on, the host answers the ROM's other key prompts (take win) itself
  autoTick() {
    const h = this.g.host; h.autoHuman = true;
    if (this.auto && h.phase && (h.inFree || (this.g.vm.keyWait && h.featureWait()))) this.auto = false;
    h.autoKeys = this.auto; if (!this.auto) return null;
    if (h.phase) { this.autoAt = Date.now() + 1500; return null; }
    if (h.credits < h.cost) { this.auto = false; return null; }
    if (Date.now() >= this.autoAt && Date.now() >= this.autoLast + 3000) { this.autoAt = Date.now() + 1500; this.autoLast = Date.now(); return 'spin'; }
    return null;
  }
  // a key's look now: its piece name in the atlas (style.state), as play.html's classes and data-lamp give it
  look(o, ms) {
    const k = o.key, h = this.g.host, lit = this.lit(k, ms), idle = !h.phase;
    const sel = (this.lineOf[k] !== undefined && this.lineOf[k] === h.lines) || (this.betOf[k] !== undefined && this.betOf[k] === h.bet);
    const G = h.gamble; if (G && G.screen && !this.romGamble()) {   // the keys that pick a colour or suit are lit, the rest dark
      const on = !G.busy && (k === this.red || k === this.black || (o.kind === 'bet' && !!this.suitOf(k)));
      if (o.kind === 'play') return on ? 'play.lamp' : 'play'; if (o.kind === 'bet') return on ? 'bet.lamp' : 'bet';
    }
    switch (o.kind) {
      case 'bet': return sel ? 'bet.sel' : lit && (this.lamp(k) !== 1 || h.choiceKeys().includes(k)) ? 'bet.lamp' : 'bet';   // a steady ROM bet lamp is not shown (play.html): the ROM learns the bet only at the start, so its idle lamp marks the old bet
      case 'play': return sel && (lit || !idle || this.lamp(k) < 0) ? 'play.sel' : lit ? 'play.lamp' : 'play';   // the chosen play key stays green while a game runs, and when the ROM has no lamp for it (play.html)
      case 'special': return lit || (sel && !idle) ? 'special.lit' : 'special';
      case 'spin': return lit ? 'spin.lamp' : 'spin';
      case 'auto': return lit ? 'auto.lit' : 'auto';
      case 'gamble': return lit ? 'gamble.lamp' : 'gamble';
      default: return lit ? 'fkey.lamp' : h.choiceKeys().includes(k) && this.lamp(k) < 0 && flashOn(2, ms + 330) ? 'fkey.ring' : 'fkey';
    }
  }
  // the fascia, drawn once into the cabinet picture; its part under the panel is kept to redraw the keys on
  drawBg(s) {
    if (!atlas) return; this.bg = new U.Screen(this.W, this.H);
    for (const p of this.parts()) {
      if (this.side) { const c = makeColumn(this.H); s.sprite(c, c, p.x + PC.steel.ox, p.y + PC.steel.oy); } else piece(s, 'steel', p.x, p.y);
      for (let y = 0; y < p.h && p.y + y < s.h; y++) this.bg.u32.set(s.u32.subarray((p.y + y) * s.w + p.x, (p.y + y) * s.w + p.x + Math.min(p.w, s.w - p.x)), y * this.W + p.px);
    }
    this.pic = null; this.pics = null;
  }
  // the panel's parts on the screen (x, y, w, h) and where each starts in its picture (px): the strip, or the two columns
  parts() {
    const X = Math.round(this.x0), Y = Math.round(this.y0);
    return this.side ? [{ x: X, y: Y, w: CW, h: this.H, px: 0 }, { x: X + CW + this.gap, y: Y, w: CW, h: this.H, px: RX }] : [{ x: X, y: Y, w: W, h: H, px: 0 }];
  }
  sx(px) { return Math.round(this.x0) + (this.side && px >= RX ? px - RX + CW + this.gap : px); }   // a picture x on the screen
  // the rectangle (px, py, w, h) of picture pic onto s where it shows (within one part)
  out(s, pic, px, py, w, h) {
    const X = this.sx(px), Y = Math.round(this.y0) + py, n = Math.min(w, s.w - X);
    for (let y = 0; y < h && Y + y < s.h; y++) s.u32.set(pic.u32.subarray((py + y) * this.W + px, (py + y) * this.W + px + n), (Y + y) * s.w + X);
  }
  // the panel changes only when a lamp flashes or a key is pressed or pointed at: it is drawn into its own picture then, and copied in.
  // part: s already holds the panel as last drawn, so unless the keys changed only the moving part (animRect) is copied
  draw(s, hx, hy, part) {
    if (!atlas || !this.bg) return;
    const ms = Date.now(), hover = this.keyAt(hx, hy); this.syncPrompt();
    if (this.held >= 0 && ms > this.heldUntil) this.held = -1;
    if (this.pick >= 0 && !this.g.host.choiceKeys().includes(this.pick)) this.pick = -1;
    const G = this.g.host.gamble, looks = this.keys.map(o => this.look(o, ms)), feeding = ms - this.feedT < 1100, sig = JSON.stringify([looks, this.keys.length, hover, this.held, feeding, this.noteText, this.pick, G ? (G.screen ? 2 : 1) : 0]);
    const changed = !this.pic || sig !== this.sig;
    // the last few pictures are kept by their look: a flashing lamp only swaps between two (a handheld took 15 ms to redraw the keys)
    if (changed) { this.sig = sig; const c = this.pics || (this.pics = new Map()); let pic = c.get(sig);
      if (!pic) { pic = new U.Screen(this.W, this.H); pic.copy(this.bg); this.drawKeys(pic, looks, hover, feeding); if (c.size >= 8) c.delete(c.keys().next().value); c.set(sig, pic); }
      this.pic = pic; }
    if (part && !changed) { const a = this.animPic(); this.out(s, this.pic, a.x, a.y, a.w, a.h); } else for (const p of this.parts()) this.out(s, this.pic, p.px, 0, p.w, p.h);
    // the acceptor's chevrons bob (play.html chev: 1.3 s, opacity 0.35 to 1, 2 px down to 2 px up)
    const t = (1 - Math.cos(2 * Math.PI * (ms % 1300) / 1300)) / 2; piece(s, 'chev', this.sx(at(this.note.x)), Math.round(this.y0) + at(this.note.y + 2 - 4 * t), [1, 1, 1], 0.35 + 0.65 * t);
    this.drawBill(s, ms);
  }
  // the part of the panel that moves every frame (the note acceptor's chevrons and the note going in): the column from the acceptor to the
  // right edge, or (side) the acceptor and the note's way under it; animPic in the picture, animRect on the screen (even, for halving)
  animPic() {
    const x = Math.round(at(this.note.x - 8)) & ~1; if (!this.side) return { x, y: 0, w: (this.W - x + 1) & ~1, h: this.H };
    const y = Math.round(at(this.note.y - 8)) & ~1; return { x, y, w: Math.round(at(NOTE.w + 16)) & ~1, h: Math.min(this.H - y, Math.round(at(200)) & ~1) };
  }
  animRect() { const a = this.animPic(); return { x: this.sx(a.x), y: Math.round(this.y0) + a.y, w: a.w, h: a.h }; }
  drawKeys(s, looks, hover, feeding) {
    // glows reach over the neighbouring keys: lit keys go last
    const order = this.keys.map((o, i) => i).sort((a, b) => (PC[looks[a]].w > 140) - (PC[looks[b]].w > 140));
    for (const i of order) {
      const o = this.keys[i], st = looks[i], mode = this.held === o.key ? 'active' : hover === o.key || this.pick === o.key ? 'hover' : null;
      const kx = at(o.x), ky = at(o.y); piece(s, mode ? st + '.' + mode : st, kx, ky);
      const dy = mode === 'active' ? at(2) : 0, b = mode === 'active' ? 0.94 : mode === 'hover' ? 1.05 : 1;
      if (o.label.suit >= 0) piece(s, 'suit' + o.label.suit, kx, ky + dy, [b, b, b]);   // the suit stays on the gamble screen too, as play.html's faded shape
      this.label(s, o, st, kx, ky + dy, b);
    }
    const N = this.note; piece(s, feeding ? 'note.feed' : hover === 99 ? 'note.hover' : 'note', at(N.x), at(N.y));
    // the note's value with its multiplier (play.html .note em: 800 15px Arial, #7dff9f with a green glow), at the foot of the acceptor
    const F = U.font('nem'), base = at(N.y + NOTE.h - 3 - 8 - 15) + (at(15) - F.asc - F.desc) / 2 + F.asc, cx = at(N.x + NOTE.w / 2), v = this.noteText;
    s.paint(Mask.text('nem', v).blur(4), cx - U.textW('nem', v) / 2, base, hex('#29d85a'), 0.53);
    s.print('nem', v, cx, base, { color: hex('#7dff9f'), align: 'center' });
  }
  // a key's text as the browser sets it: lines of 1.05 times their font size, the block centred in the 56 x 54 content box
  label(s, o, st, kx, ky, b) {
    // letter spacing is 0.02em of the key's own font (.cb), inherited as a length by the big number and the small print
    const l = this.labelOf(o), lines = [], key = l.text ? (l.small ? 'kfk' : o.kind === 'spin' || o.kind === 'auto' ? 'kspin' : o.kind === 'fkey' ? 'kfk' : 'kb') : 'kb', sp = U.font(key).size * 0.02;
    const add = (f, t, a = 1) => { for (const w of wrap(f, t, at(56), sp)) lines.push([f, w, a, sp]); };
    // a big label takes at most 85% of the key's inner width (play.html fitBig): the largest key face that fits
    if (l.text !== undefined && l.big) { if (l.text) { const f = ['kbig', 'ksp', 'kb', 'kfk'].find(f => U.textW(f, l.text, U.font(f).size * 0.02) <= at(56) * 0.85) || 'kfk'; add(f, l.text); } }
    else if (l.text !== undefined) { if (l.text) add(key, l.text); }   // '' : a key the gamble screen leaves blank
    else { add('kb', l.top); for (const t of l.big) add(o.kind === 'special' ? 'ksp' : 'kbig', t); if (l.small) add('ksm', l.small, 0.8); }
    const lh = f => U.font(f).size * 1.05, total = lines.reduce((a, [f]) => a + lh(f), 0), ink = INK[st].map(v => v * b), cx = kx + at(KEY / 2);
    // one-word small labels (FEATURE, GAMBLE, COLLECT) go .1em lower, as play.html: their line keeps room for descenders capitals never use
    let y = ky + at(5) + (at(54) - total) / 2 + (lines.length === 1 && (o.kind === 'fkey' || o.kind === 'gamble' || l.small) ? U.font(lines[0][0]).size * 0.1 : 0);
    for (const [f, t, a, sp] of lines) {
      const F = U.font(f), base = y + (lh(f) - F.asc - F.desc) / 2 + F.asc, x = cx - (U.textW(f, t, sp) + sp) / 2;
      if (LIFT.has(st)) s.print(f, t, x, base + at(1), { color: [255, 255, 255], alpha: 0.53 * a, spacing: sp });
      if (GLOW.has(st)) s.paint(Mask.text(f, t, sp).blur(2), x, base, [255, 255, 255], 0.53 * a);
      s.print(f, t, x, base, { color: ink, alpha: a, spacing: sp }); y += lh(f);
    }
  }
  // the note being pulled up into the acceptor's slot (play.html billin: 0.95 s, from 134 px below the slot to 156 px above it, cut at the slot)
  drawBill(s, ms) {
    const t = (ms - this.feedT) / 950; if (t < 0 || t >= 1) return;
    if (!bill) bill = makeBill();
    const e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t), slot = this.y0 + at(this.note.y + 44 - 9), top = slot + at(134 - 290 * e), from = Math.max(0, slot - top);
    const n = Math.min(bill.h - from, Math.round(slot + at(146) - top - from));
    if (n > 0) s.draw(bill, this.sx(at(this.note.x + NOTE.w / 2)) - bill.w / 2, top, 1, from, n);
  }
}

module.exports = { Panel, load, H, W, CW };
