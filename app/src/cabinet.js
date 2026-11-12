// The playing screen laid out like play.html's cabinet: the title marquee (attract art, name, CREDIT / BET / WIN LCD, key hints and the
// Menu button) over the game's picture over the control panel, each in its dark surround on the warm background. With side (a wide screen)
// the control panel is two columns either side of the game, under a banner as wide as the whole cabinet. Everything that does not
// move is drawn once per game into one picture (base); a frame copies it, then draws the game, the panel's keys and the overlays on top.
// The LCD's figures are redrawn into base only when they change. As play.html's display settings (ui/marquee.css): the banner shows the name
// over the art, the name alone or the art alone (style), and the LCD can be off (lcd); the banner off with the LCD on leaves a slim strip with the LCD.
const U = require('./ui.js'), K = require('./look.js'), PN = require('./panel.js');

const PAD = 24, GAP = 22, GW = 1280, GH = 960, MQH = 300, MQH_NOLCD = 190, STRIP = 132, LCDW = 900, LCDH = 96;
const HINTS = [['Space', 'spin'], ['← →', 'lines'], ['↑ ↓', 'bet'], ['Enter', 'add credits'], ['G', 'gamble'], ['H', 'paytable'], ['Tab', 'games']];   // play.html's keys

let plain = null;   // the picture under the game when there is no banner: { key, s }
class Cabinet {
  // o: { banner, style ('art' the name over the art, 'name', 'artonly'), lcd, panel, theme (LCD colour), side (the panel either side of the game) }
  constructor(o = {}) { this.o = { banner: true, style: 'art', lcd: true, panel: true, theme: 'green', side: false, ...o }; this.layout(); }
  set(o) { Object.assign(this.o, o); this.layout(); if (this.args) this.build(...this.args); }
  layout() {
    const o = this.o, side = o.panel && o.side, SW = side ? PN.CW + GAP : 0; let y = PAD;
    this.W = GW + 2 * PAD + 2 * SW;
    const mh = o.banner ? (o.lcd ? MQH : MQH_NOLCD) : o.lcd ? STRIP : 0;
    this.mq = mh ? { x: PAD, y, w: this.W - 2 * PAD, h: mh } : null; if (mh) y += mh + GAP;
    this.game = { x: PAD + SW, y, w: GW, h: GH }; y += GH;
    this.panel = side ? { x: PAD, y: this.game.y, w: this.W - 2 * PAD, h: GH, side: { gap: GW + 2 * GAP, h: GH } } : o.panel ? { x: PAD, y: y + GAP, w: GW, h: PN.H } : null;
    if (o.panel && !side) y += GAP + PN.H;
    this.H = y + PAD;
    this.lcd = this.mq && o.lcd ? { x: this.mq.x + (this.mq.w - LCDW) / 2, y: this.mq.y + (o.banner ? 150 : (mh - LCDH) / 2), w: LCDW, h: LCDH } : null;
    this.menuBtn = this.mq ? { x: this.mq.x + this.mq.w - 156, y: this.mq.y + 16, w: 140, h: 50 } : { x: this.game.x + GW - 76, y: this.game.y + 12, w: 64, h: 56 };
  }
  // the picture that does not change while this game runs; art: the game's attract picture or null; panel: the Panel (draws its fascia)
  build(art, name, panel) { const it = this.parts(art, name, panel); let r; while (!(r = it.next()).done); return r.value; }
  // build in parts: it yields the fraction done between the slow ones (the marquee, the game's surround) so a loading bar can move
  *parts(art, name, panel) {
    this.args = [art, name, panel]; const s = this.base = new U.Screen(this.W, this.H);
    // with no banner the background and the game's surround are the same for every game: made once, then copied
    const key = this.mq ? null : [this.W, this.H, this.game.x, this.game.y, this.game.w, this.game.h].join();
    if (key && plain && plain.key === key) { s.copy(plain.s); if (this.panel && panel) panel.drawBg(s); return s; }
    K.background(s);
    const q = this.mq, st = this.o.style;
    if (q && this.o.banner) {
      for (const f of K.marqueeParts(s, q.x, q.y, q.w, q.h, st === 'name' ? null : art, st === 'artonly' ? null : name, { titleBase: 112 })) yield 0.65 * f;
      K.hints(s, HINTS, q.x + q.w / 2, q.y + q.h - 18);
    } else if (q) {   // the slim strip: play.html #marquee.nobanner (linear-gradient(180deg, #221208, #120803)), no shortcut hints
      K.surround(s, q.x, q.y, q.w, q.h, 12); const st2 = [[0, U.hex('#221208')], [1, U.hex('#120803')]], o = [0, 0, 0];
      s.paint(U.Mask.round(q.w, q.h, 12), q.x, q.y, (px, py) => U.stops(st2, (py - q.y) / q.h, o));
    }
    if (this.lcd) { const l = this.lcd; K.lcdBox(s, l.x, l.y, l.w, l.h, this.o.theme); this.lcdUnder = K.grab(s, l.x, l.y, l.w, l.h); this.lcdKey = null; }
    yield 0.7; K.surround(s, this.game.x, this.game.y, this.game.w, this.game.h, 0);   // the game's frame is square; the marquee and panel keep round corners yield 0.95;
    if (key) { plain = { key, s: new U.Screen(this.W, this.H) }; plain.s.copy(s); }
    if (this.panel && panel) panel.drawBg(s);   // the steel fascia sits on the background, as in play.html
    return s;
  }
  // the LCD's figures: [[label, text], ...]
  setLcd(cells) {
    if (!this.lcd || !this.base) return; const key = JSON.stringify(cells); if (key === this.lcdKey) return; this.lcdKey = key;
    const l = this.lcd; K.put(this.base, this.lcdUnder, l.x, l.y); K.lcdText(this.base, l.x, l.y, l.w, l.h, cells, this.o.theme);
  }
  onMenu(x, y) { const b = this.menuBtn; return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }
  // the Menu button: a labelled button in the marquee, or (no marquee) a small one over the game's corner that shows near the pointer
  drawMenuButton(s, px, py) {
    const b = this.menuBtn, hover = this.onMenu(px, py);
    if (this.mq) return K.button(s, b.x, b.y, b.w, b.h, '☰ Menu', { r: 10, hover, alpha: 0.92 });
    // over the game it fades in as the pointer comes near; with no pointer yet (a handheld's pad, the keyboard) it stays shown
    const d = px <= -1e4 ? 0 : Math.hypot(px - (b.x + b.w / 2), py - (b.y + b.h / 2)); if (d > 280) return;
    s.round(b.x, b.y, b.w, b.h, 10, [20, 12, 6], 0.8 * Math.min(1, (280 - d) / 120));
    s.print('uib', '☰', b.x + b.w / 2, b.y + 38, { color: hover ? K.C.gold : K.C.text, align: 'center', alpha: Math.min(1, (280 - d) / 120) });
  }
}

module.exports = { Cabinet, PAD, GW, GH };
