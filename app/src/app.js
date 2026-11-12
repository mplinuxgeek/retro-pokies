// The desktop app without the window: the games list, the running game in its cabinet (cabinet.js: marquee and LCD, the game's picture
// doubled, the control panel) and the menu, drawn into one RGBA screen at twice the web build's CSS pixels. main.js feeds it SDL events
// and shows the screen; tests drive it the same way without a window.
// Money: the player's balance is kept in cents (settings "wallet") and goes into each game as credits at its denomination, so changing game
// or denomination keeps it (any cents that do not make a whole credit stay in the wallet). Settings "played" keeps the totals bet and won
// across games, shown on the games list's LCD as games.html does. A new wallet holds $1000 (START), as play.html gives a game; the menu's
// Reset stats & credits puts it back to that. Settings "stats" keeps each game's statistics in credits (play.html stats-<id>).
const fs = require('fs'), path = require('path'), os = require('os');
const { openGame, D, FRAME_MS, MK6, RP } = require('./core.js'), U = require('./ui.js'), { Screen, png } = U, L = require('./library.js');
const { Selector } = require('./selector.js'), { Menu } = require('./menu.js'), PN = require('./panel.js'), { Cabinet } = require('./cabinet.js'), K = require('./look.js');

// note multiplier, as play.html's (not on a real machine): a note buys sqrt(denomination in cents) times its face value, rounded to 0.1, so a $100
// note is $100 at 1c and $1000 at $1; the credit limit (the ROM's 'Credits Not Accepted if Over', $9890 at 1c) scales with it
const noteMult = d => Math.round(Math.sqrt(d) * 10) / 10, limitFor = d => Math.round(989000 * noteMult(d) / d);
const NOTE = 10000, START = 100000, SPEEDS = [1, 2, 4, 8], SCALES = [0.75, 1, 1.25, 1.5, 2, 2.5, 3], VOLUMES = [1, 0.75, 0.5, 0.25, 0];
// mk6c's panel shortcuts: 1-5 bet keys, Q W E R T Y play-line keys, A auto (E is the FEATURE key at a feature prompt, R red on the gamble screen, as play.html)
const SHORTCUT = { 1: 14, 2: 13, 3: 12, 4: 11, 5: 10, q: 1, w: 2, e: 3, r: 4, t: 5, y: 7, a: 9 };
const THEMES = Object.keys(K.LCD);

function settingsStore(file) {
  file = file || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'retro-pokies-desktop', 'settings.json');
  let s = {}; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  return { s, save() { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 1)); } catch (e) {} } };
}

class App {
  // opts: { romDir, settings (settingsStore()), platform: { fullscreen(on), scale(x), resize(W, H), quit(), display() ([w, h] of the screen) }, shotDir }
  constructor(opts = {}) {
    this.st = opts.settings || settingsStore(); this.S = this.st.s; this.pf = opts.platform || {}; this.shotDir = opts.shotDir || path.join(os.homedir(), 'Pictures');
    const S = this.S; if (S.wallet === undefined) S.wallet = START; S.played = S.played || { bet: 0, won: 0 };
    if (S.held) { S.wallet += S.held; S.held = 0; this.st.save(); }   // the last run ended without banking a game's credits (killed or crashed)
    // settings from before the LCD had its own switch had it with the banner: lcdOn starts as the banner was
    this.cab = new Cabinet({ banner: S.banner !== false, style: S.bannerStyle || 'art', lcd: S.lcdOn ?? S.banner !== false, panel: S.panel !== false, theme: S.lcd || 'green' }); this.cab.set({ side: this.sideFits() });
    this.screen = new Screen(this.W, this.H); this.game = null; this.loading = null; this.msg = null; this.px = -1e4; this.py = -1e4; this.acc = 0;
    this.games = []; this.sel = null; this.selecting = true; this.icon = null; this.fonts = false;
    this.menu = new Menu(this.W, () => this.menuItems());
    // the boot screen (drawBoot) shows each step of start() with a progress bar until the games list is ready
    this.boot = { msg: 'Starting', f: 0 }; this.waiters = []; this.paintAt = 0;
    this.ready = this.start(opts.romDir || S.romDir);
  }
  async start(romDir) {
    const S = this.S;
    await this.step('Loading fonts', 0.02, true);
    await Promise.all([PN.load(), U.loadFonts(MK6.decodePngRGBA).then(() => { this.fonts = true; }),
      MK6.decodePngRGBA(new Uint8Array(fs.readFileSync(path.join(RP, 'web', 'favicon.png')))).then(im => { this.icon = im; }, () => {})]);
    await this.step('Scanning ROMs', 0.1, true);
    this.games = L.scan(L.romDirs(romDir));
    await this.step('Found ' + this.games.length + ' ROMs, ' + this.games.filter(g => g.ok).length + ' playable', 0.25, true);
    this.art = new L.Art(() => {});
    this.sel = new Selector(this.games, this.art, this.W, this.H, {
      favs: new Set(S.favs || []), saveFavs: () => { S.favs = [...this.sel.favs()]; this.st.save(); },
      lcd: () => [['CREDIT', K.money(this.walletNow())], ['BET', K.money(S.played.bet)], ['WIN', K.money(S.played.won)]], theme: () => this.cab.o.theme });
    this.sel.icon = this.icon;
    if (S.last) this.sel.focus(S.last);
    await this.step('Loading the pictures', 0.4, true);
    const pics = this.sel.shownGames(); let got = 0;
    await Promise.all(pics.map(g => this.art.ready(g).then(() => this.step('Loading the pictures', 0.4 + 0.2 * ++got / pics.length))));
    await this.step('Drawing the games list', 0.6, true);
    for (const f of this.sel.warm()) await this.step('Drawing the games list', 0.6 + 0.38 * f);
    this.sel.draw(new Screen(this.W, this.H), 'false', () => {}, true);   // the first drawing makes the background and the cards (seconds on a handheld); the list's own frame then reuses them
    await this.step('Ready', 1, true);
    this.boot = null;
  }
  // a step of a loading screen (the boot screen, a game's): its text and the bar's fraction; shown (awaited) when the last was shown 100 ms or more
  // ago, or with force. The main loop draws it; with no loop (tests) the wait ends after 250 ms
  async step(msg, f, force) {
    const p = this.boot || this.loadStep; if (p) { p.msg = msg; p.f = f; }
    const now = performance.now(); if (!force && now - this.paintAt < 100) return; this.paintAt = now;
    await new Promise(r => { this.waiters.push(r); setTimeout(r, 250); });
  }
  get W() { return this.cab.W; }
  get H() { return this.cab.H; }
  toast(t) { this.msg = { t, until: Date.now() + 2500 }; }
  walletNow() { const g = this.game; return this.S.wallet + (g ? g.host.credits * g.denom : 0); }

  // ---- games ----
  credits() { const g = this.game; return g ? g.host.credits : 0; }
  bank() { const g = this.game; if (!g) return; this.S.wallet += g.host.credits * g.denom; g.host.credits = 0; this.S.held = 0; this.st.save(); }
  // the game's credits as money, written down when they change between games (a game in progress keeps its stake, as the ROM would)
  hold() { const g = this.game, h = g && g.host; if (!h || h.phase) return;
    const bl = this.S.betLines || (this.S.betLines = {}), was = bl[g.id];   // the game's bet and lines, set again when it next opens (as play.html keeps bet-<id>, lines-<id>)
    if (!was || was[0] !== h.bet || was[1] !== h.lines) { bl[g.id] = [h.bet, h.lines]; this.st.save(); } const v = h.credits * g.denom; if (v !== this.S.held) { this.S.held = v; this.st.save(); } }   // the game's credits back into the wallet
  async launch(g, denom) {
    if (!g || !g.ok) { if (g) this.toast(g.name + ': ' + (g.info ? g.info.label : g.why)); return; }
    await this.ready;
    const prev = this.game, kept = prev ? prev.host.credits : 0;
    this.bank(); this.loading = g; this.loadStep = { msg: 'Starting ' + g.name, f: 0 }; this.menu.hide(); this.art.pause(true);
    // the art for the loading screen and the cabinet, decoded alongside
    const art = g.art !== undefined ? null : new Promise(r => { const f = this.art.file(g); if (!f) return r(); L.decode(f).then(im => { g.art = im; r(); }, r); });
    try {
      await this.step('Starting ' + g.name, 0, true);
      const d = denom || (this.S.denom || {})[g.id] || 0, map = require('./core.js').mapFor(g.id), dd = d || D.forMap(map).def;
      const credits = Math.floor(this.S.wallet / dd);
      // a player's game (not fast): the take-win prompt and the gamble, the feature prompts and picks wait for the player, as in play.html
      const game = await openGame(g.zip, { denom: dd, credits, limit: limitFor(dd), rtp: (this.S.rtp || {})[g.id], progress: (f, msg, force) => this.step(msg, 0.4 * f, force) });
      game.romPages = game.host.romHelp(); this.speed = 1; this.pics = null; this.playOn = false; this.playOnLines = this.betAfter = this.autoTake = 0; this.spun = null;   // the help the ROM draws (page count), as play.html finds it at start
      const bl = (this.S.betLines || {})[g.id]; if (bl) { if (!denom) game.host.setBet(bl[0]); game.host.setLines(bl[1]); }   // a new denomination starts at the top bet, as in play.html
      { const st = this.stats(g.id); if (!st.creditsIn) st.creditsIn = credits; }
      this.S.wallet -= credits * game.denom; this.S.held = credits * game.denom; this.game = game; this.gameInfo = g; this.seen = game.host.last;
      if (this.pf.sound) { await this.step('Loading the sounds', 0.42, true); this.pf.sound.attach(game.vm, game.host); }   // the last game's sounds stop
      if (art) { await this.step('Loading the artwork', 0.45, true); await art; }
      await this.step('Building the cabinet', 0.5, true);
      this.panel = this.newPanel(game);
      for (const f of this.cab.parts(g.art || null, g.name, this.panel)) await this.step('Building the cabinet', 0.5 + 0.5 * f);   // as buildCab, a part a frame
      this.selecting = false; this.sel.current = g.id; g.card = null; if (prev && prev.id !== g.id) { const pg = this.games.find(x => x.id === prev.id); if (pg) pg.card = null; }
      this.S.last = g.id; this.st.save(); this.acc = 0;
    } catch (e) { this.toast(g.name + ': ' + e.message); if (prev) { prev.host.credits = kept; this.S.wallet -= kept * prev.denom; this.st.save(); } }
    this.loading = null; this.loadStep = null; this.art.pause(!this.selecting);   // card art made again only while the games list shows
  }
  newPanel(game) { const p = this.cab.panel || { x: this.cab.game.x, y: 0 }; return new PN.Panel(game, p.x, p.y, this.noteText(), p.side); }
  // the panel either side of the game (S.layout 'sides'), under it ('below', the default: a tall window), or ('auto') whichever shows the game larger on this screen
  sideFits(o = {}) {
    const L = this.S.layout || 'below'; if (L !== 'auto') return L === 'sides';
    const d = this.pf.display && this.pf.display(); if (!d) return false;
    const k = side => { const c = new Cabinet({ ...this.cab.o, ...o, side }); return Math.min(d[0] / c.W, d[1] / c.H); }; return k(true) > k(false);
  }
  buildCab() { if (this.game) this.cab.build(this.gameInfo.art || null, this.gameInfo.name, this.panel); }
  setDenom(cents) { const g = this.gameInfo; if (!g || this.game.host.phase) return; (this.S.denom = this.S.denom || {})[g.id] = cents; return this.launch(g, cents); }
  setRtp(set) { const g = this.gameInfo; if (!g || this.game.host.phase) return; (this.S.rtp = this.S.rtp || {})[g.id] = set; return this.launch(g); }   // the ROM's RTP set: the game starts again with it, money kept
  // a game's statistics (play.html stats), in credits
  stats(id) { const all = this.S.stats || (this.S.stats = {}); return all[id] || (all[id] = { creditsIn: 0, spins: 0, freeSpins: 0, wagered: 0, won: 0, freeWon: 0, wins: 0, biggest: 0, biggestMult: 0, biggestFeature: 0, features: 0, gambles: 0, gambleNet: 0 }); }
  // a finished game booked into them (play.html settle): spun holds the meters as SPIN was pressed
  book(g, h) {
    const was = this.spun; this.spun = null; if (!was) return; const S = this.stats(g.id), w = h.last.win || 0, fs = (h.gameNo | 0) - was.games, fw = h.last.featureWin || 0;
    S.spins++; S.wagered += was.cost; S.won += w; if (w) S.wins++; S.biggest = Math.max(S.biggest, w); S.biggestMult = Math.max(S.biggestMult, w / was.cost);
    if (fs > 0) { S.features++; S.freeSpins += fs; S.freeWon += fw; S.biggestFeature = Math.max(S.biggestFeature, fw); }
    S.gambles += (h.gambles | 0) - was.gambles; S.gambleNet += (h.gambleNet | 0) - was.gnet;
  }
  statRows() {
    const g = this.game, S = this.stats(g.id), fmt = n => Math.round(n).toLocaleString('en-US'), net = S.won - S.wagered, d = g.denom;
    return [['Credits in', fmt(S.creditsIn)], ['Total bet', fmt(S.wagered)], ['Total won', fmt(S.won)], ['Won in free games', fmt(S.freeWon)], [net < 0 ? 'Net lost' : 'Net won', fmt(Math.abs(net))],
      ['Observed RTP', S.wagered ? (100 * S.won / S.wagered).toFixed(2) + '%' : '–'], ['Spins (paid / free)', fmt(S.spins) + ' / ' + fmt(S.freeSpins)], ['Features triggered', fmt(S.features)],
      ['Winning spins', fmt(S.wins) + (S.spins ? ' (' + (100 * S.wins / S.spins).toFixed(1) + '%)' : '')], ['Biggest win', fmt(S.biggest)], ['Biggest win (× total bet)', S.biggestMult ? S.biggestMult.toFixed(1) + '×' : '–'],
      ['Biggest feature win', fmt(S.biggestFeature)], ['Denomination', (d >= 100 ? '$' + d / 100 : d + 'c') + ' / credit'], ['Gambles played', fmt(S.gambles)], ['Gamble net', fmt(S.gambleNet)], ['Balance', fmt(g.host.credits)]]
      .map(([a, b]) => ({ info: a + ': ' + b }));
  }
  // Reset stats & credits (play.html sreset): the wallet back to $1000, every game's statistics and the games list's totals cleared
  resetMoney() {
    const g = this.game, S = this.S; if (g && g.host.phase) return this.toast('Finish the game first');
    S.stats = {}; S.played = { bet: 0, won: 0 }; S.wallet = START;
    if (g) { const c = Math.floor(START / g.denom); g.host.credits = c; g.vm.meters.set(0, c); g.host.panel(c, g.host.cost, 0); /* the game's own meters too, as play.html */ S.wallet -= c * g.denom; S.held = c * g.denom; this.stats(g.id).creditsIn = c; }
    this.st.save(); this.toast('Statistics cleared, credit $' + START / 100);
  }
  // a note: its value times the denomination's multiplier, as credits; the cents a credit cannot buy go to the wallet, so no money is lost or made
  note() { const g = this.game; if (!g) return; const c = Math.round(NOTE * noteMult(g.denom)), n = Math.floor(c / g.denom);
    if (g.host.addCredits(n) !== false) { this.S.wallet += c - n * g.denom; this.stats(g.id).creditsIn += n; this.st.save(); if (this.panel) this.panel.feed(); } }
  noteText() { const g = this.game, m = g ? noteMult(g.denom) : 1; return '$' + NOTE / 100 + (m !== 1 ? ' ×' + m : ''); }
  // an any-key prompt's key (play.html anyKey), and a free game's win counting up with no prompt (freeCountUp)
  anyKey() { const g = this.game, hw = g.vm.hotspotWait; return g.host.phase === 'result' && hw && hw.mode === 4 && hw.keys && hw.keys.length >= 16 ? hw.keys[0] : undefined; }
  freeCountUp() { const g = this.game, h = g.host, vm = g.vm, hw = vm.hotspotWait; return h.phase === 'result' && h.inFree && !(this.panel && this.panel.auto) && !h.help && !vm.keyWait && !(hw && hw.mode !== 'log') && h.winValue() > 0 && (vm.live || []).some(t => t.name === 'win_inc' && t.state === 'sleeping'); }
  // SPIN, as play.html's: a new game, or at a prompt the key that answers it
  spin() {
    const g = this.game, h = g && g.host; if (!h) return;
    const vm = g.vm, hw = vm.hotspotWait, prompt = !!vm.keyWait || !!(hw && hw.mode !== 'log'), auto = !!(this.panel && this.panel.auto);
    if (h.help || this.pics) return this.helpOff();
    // the gamble: SPIN while the win still counts up (no prompt yet) is the ROM's own take win (key 0); at the take-win prompt it is PLAY ON (take the win and play the next game); on the gamble screen COLLECT
    const G = h.gamble; if (G) { if (G.early && !G.busy) { h.gamble = null; h.pressKey(0); } else { const off = !G.screen; if (h.collect() && off) this.playOn = true; } return; }
    // SPIN during a win's count-up (no prompt or choice up) sends key 0, which the ROM takes as take win and so cuts a long celebration short
    if (h.phase === 'result' && !auto && !prompt && h.winValue() > 0 && (!h.inFree || this.freeCountUp())) return h.pressKey(0);
    if (h.phase) {   // a prompt: its SPIN key, an any-key prompt's key, the key chosen with the arrows, or a prompt's only key (FEATURE: a pad has no key for it)
      const ck = h.choiceKeys(), any = this.anyKey(), p = this.panel;
      if (ck.includes(0)) h.pressKey(0); else if (any !== undefined) h.pressKey(any); else if (p && ck.includes(p.pick)) { h.pressKey(p.pick); p.pick = -1; } else if (ck.length === 1) h.pressKey(ck[0]);
      else if (hw && hw.mode !== 'log' && hw.ids && hw.ids.length) this.touchNext();   // a touch prompt (Corrida De Toros' pick) with no pointer: the next box, as the scanner answers one
      return;
    }
    const cost = h.cost, was = { cost, games: h.gameNo | 0, gambles: h.gambles | 0, gnet: h.gambleNet | 0 };
    if (!h.spin()) return this.toast(h.credits ? 'Cannot spin now' : 'Insert a note (Enter)');
    this.S.played.bet += cost * g.denom; this.spun = was;
  }
  touchNext() {
    const g = this.game, vm = g.vm, hw = vm.hotspotWait, u = this.hsUsed && this.hsUsed.cur === g.host.cur ? this.hsUsed : (this.hsUsed = { cur: g.host.cur, s: new Set() });
    const id = hw.ids.find(i => !u.s.has(i)) ?? hw.ids[0]; u.s.add(id); vm.sendMessage(2, [7, id, 1]); vm.runTasks(); vm.sendMessage(2, [7, id, 0]); vm.runTasks();
  }
  // the gamble's keys (play.html): GAMBLE opens the gamble screen (there it toggles Full / Half); at the take-win prompt a play key takes the win
  // and plays that many lines, a bet key takes it and sets that bet; on the gamble screen RED, BLACK and the suit keys pick
  gambleKey(k = 15) {
    const g = this.game, h = g && g.host, G = h && h.gamble, p = this.panel; if (!G || G.busy) return;
    if (k === 15) h.gambleStart();
    else if (k === 0) this.spin();
    else if (p && p.lineOf[k] !== undefined) { if (!G.screen) { if (h.collect()) { this.playOn = true; this.playOnLines = p.lineOf[k]; } } else if (k === p.red) h.gambleChoose('red'); else if (k === p.black) h.gambleChoose('black'); }
    else if (p && p.betOf[k] !== undefined) { if (G.screen) { const c = p.suitOf(k); if (c) h.gambleChoose(c); } else if (h.collect()) this.betAfter = p.betOf[k]; }
  }
  // after the frames: the next game a PLAY ON started, the bet a key at the take-win prompt chose, and AUTO's answer to a take-win or any-key
  // prompt after its pause (play.html AUTO_PROMPT, 2.5 s)
  prompts(h) {
    if (this.betAfter && !h.phase) { h.setBet(this.betAfter); this.betAfter = 0; }
    if (this.playOn && !h.phase) { this.playOn = false; if (this.playOnLines) h.setLines(this.playOnLines); this.playOnLines = 0; this.spin(); }
    const auto = this.panel && this.panel.auto, any = auto ? this.anyKey() : undefined;
    if (auto && (any !== undefined || (h.gamble && !h.gamble.screen && !h.gamble.busy))) {
      const now = Date.now(); if (!this.autoTake) this.autoTake = now + 2500; else if (now > this.autoTake) { this.autoTake = 0; if (!h.gamble) h.pressKey(any); else if (h.collect()) this.playOn = true; }
    } else this.autoTake = 0;
  }
  // the paytable (play.html helpKey): the help the ROM draws on the game screen (H again: its next page; any other key leaves), or the game's
  // help pictures (IMG_HELP_SCREEN_<n>) over the game, paged with the arrow keys
  helpKey() {
    const g = this.game, h = g && g.host; if (!h || this.selecting) return; if (this.pics) return this.picPage(1);
    if (g.romPages) { if (h.help) h.helpNext(); else if (!h.helpEnter()) this.toast(h.helpOld === 0 ? 'This game has no paytable' : 'Paytable: finish the game first'); return; }
    const pages = []; for (let n = 1; g.vm.db.get(1, 'IMG_HELP_SCREEN_' + n); n++) pages.push(g.vm.db.get(1, 'IMG_HELP_SCREEN_' + n).index);
    if (!pages.length) return this.toast('This game has no paytable');
    this.pics = { pages, i: 0, im: null }; this.picPage(0);
  }
  picPage(d) {
    const p = this.pics, g = this.game; if (!p) return; p.i = (p.i + d + p.pages.length) % p.pages.length; const want = p.i;
    Promise.resolve(g.vm.loadImage(p.pages[want])).then(im => { if (this.pics === p && p.i === want) p.im = im; }, () => {});
  }
  helpOff() { const h = this.game && this.game.host; this.pics = null; if (h && h.help) h.helpExit(); }
  bet(dir) { const h = this.game.host, k = Object.keys(h.map.betKeys).map(Number).sort((a, b) => a - b), i = k.indexOf(h.bet); if (i + dir >= 0 && i + dir < k.length) h.setBet(k[i + dir]); }
  lines(dir) { const h = this.game.host, k = Object.keys(h.map.lineKeys).map(Number).sort((a, b) => a - b), i = k.indexOf(h.lines); if (i + dir >= 0 && i + dir < k.length) h.setLines(k[i + dir]); }
  async screenshot() {
    const f = path.join(this.shotDir, 'retro-pokies-' + (this.game && !this.selecting ? this.game.id : 'games') + '-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png');
    try { fs.mkdirSync(this.shotDir, { recursive: true }); const was = this.half; this.half = false; this.acc = 0; await this.frame(0); this.half = was; fs.writeFileSync(f, png(this.screen.rgba, this.W, this.H)); this.toast('Saved ' + f); } catch (e) { this.toast('Screenshot failed: ' + e.message); }
  }
  // the cabinet's parts on or off (banner, panel) and the LCD colour: the screen and the window change size with them
  setCab(o) {
    Object.assign(this.S, 'banner' in o ? { banner: o.banner } : {}, 'panel' in o ? { panel: o.panel } : {}, 'theme' in o ? { lcd: o.theme } : {}, 'lcd' in o ? { lcdOn: o.lcd } : {}, 'style' in o ? { bannerStyle: o.style } : {}); this.st.save();
    this.cab.set({ ...o, side: this.sideFits(o) }); this.screen = new Screen(this.W, this.H); this.sGame = null; this.sel.resize(this.W, this.H); this.menu.W = this.W;
    if (this.panel && this.cab.panel) { const auto = this.panel.auto; this.panel = this.newPanel(this.game); this.panel.auto = auto; }
    this.buildCab(); if (this.pf.resize) this.pf.resize(this.W, this.H);
  }
  panelKey(k) { const p = this.panel; if (!p || this.selecting || !this.cab.panel) return; const h = this.game.host;
    if (k !== 99 && (h.help || this.pics)) { p.hold(k); return this.helpOff(); }   // any cabinet key only leaves the paytable, as in play.html
    if (h.gamble && k !== 9 && k !== 99) { p.hold(k); p.auto = false; return this.gambleKey(k); }
    const r = p.press(k); if (r === 'note') this.note(); else if (r === 'spin') this.spin(); }
  showGames() { this.selecting = true; this.menu.hide(); this.art.pause(false); if (this.game) this.sel.focus(this.game.id); }
  quit() { this.bank(); this.st.save(); if (this.art) this.art.close(); if (this.pf.sound) this.pf.sound.close(); if (this.pf.quit) this.pf.quit(); this.done = true; }

  menuItems() {
    const g = this.game, S = this.S, on = v => v ? 'on' : 'off', it = [{ head: 'Game' }, { label: 'Games list', act: () => this.showGames() }];
    if (g && !this.selecting) {
      it.push({ label: 'Insert note: ' + this.noteText(), act: () => this.note() });
      it.push({ label: 'Denomination: ' + D.label(g.denom) + '...', list: () => {
        const busy = !!g.host.phase, l = D.ALL.map(c => ({ label: (c === g.denom ? '* ' : '  ') + D.label(c) + ' per credit', act: () => { this.setDenom(c); } }));
        l.push({ info: busy ? 'Finish the game first' : 'Restarts the game, money is kept' }); if (busy) l.forEach(x => { if (x.act) { x.info = x.label; delete x.label; delete x.act; } }); return l; } });
      it.push({ label: 'Statistics...', list: () => this.statRows() });
      it.push({ label: 'Paytable', act: () => this.helpKey() });
      it.push({ label: 'Screenshot', act: () => this.screenshot() });
    }
    it.push({ head: 'Sound' });   // Sound before Display, as play.html's menu
    if (!this.pf.sound) it.push({ info: 'No sound device' });
    else it.push({ label: 'Volume: ' + (S.volume === 0 ? 'off' : Math.round((S.volume ?? 1) * 100) + '%') + '...', list: () => VOLUMES.map(v => ({ label: ((S.volume ?? 1) === v ? '* ' : '  ') + (v ? Math.round(v * 100) + '%' : 'Off'), act: () => { S.volume = v; this.st.save(); } })) });
    it.push({ head: 'Display' });
    it.push({ label: 'Full screen: ' + on(S.fullscreen), act: () => { S.fullscreen = !S.fullscreen; this.st.save(); if (this.pf.fullscreen) this.pf.fullscreen(S.fullscreen); return 'stay'; } });
    it.push({ label: 'Window size: ' + (S.scale ? S.scale + 'x' : 'fit') + '...', list: () => [{ label: (!S.scale ? '* ' : '  ') + 'Fit the screen', act: () => this.scaleTo(0) }]
      .concat(SCALES.map(x => ({ label: (S.scale === x ? '* ' : '  ') + x + 'x', act: () => this.scaleTo(x) }))) });
    if (g && !this.selecting) it.push({ label: 'Speed: ' + (this.speed || 1) + 'x...', list: () => SPEEDS.map(x => ({ label: ((this.speed || 1) === x ? '* ' : '  ') + x + 'x', act: () => { this.speed = x; } })) });   // not kept: each game starts at 1x (play.html)
    const BST = [['art', 'Name over the art'], ['name', 'Name only'], ['artonly', 'Art only']], bst = this.cab.o.style;
    it.push({ label: 'Banner: ' + on(this.cab.o.banner), act: () => { this.setCab({ banner: !this.cab.o.banner }); return 'stay'; } });
    if (this.cab.o.banner) it.push({ label: 'Banner shows: ' + BST.find(b => b[0] === bst)[1] + '...', list: () => BST.map(([v, t]) => ({ label: (bst === v ? '* ' : '  ') + t, act: () => this.setCab({ style: v }) })) });
    it.push({ label: 'LCD panel: ' + on(this.cab.o.lcd), act: () => { this.setCab({ lcd: !this.cab.o.lcd }); return 'stay'; } });
    it.push({ label: 'Control panel: ' + on(this.cab.o.panel), act: () => { this.setCab({ panel: !this.cab.o.panel }); return 'stay'; } });
    const LAY = [['below', 'Below the game'], ['sides', 'Either side of the game'], ['auto', 'Auto (fits the screen)']], lay = S.layout || 'below';
    it.push({ label: 'Panel position: ' + LAY.find(l => l[0] === lay)[1] + '...', list: () => LAY.map(([v, t]) => ({ label: (lay === v ? '* ' : '  ') + t, act: () => { S.layout = v; this.st.save(); this.setCab({}); } })) });
    if (this.cab.o.lcd) it.push({ label: 'LCD colour: ' + this.cab.o.theme + '...', list: () => THEMES.map(t => ({ label: (this.cab.o.theme === t ? '* ' : '  ') + t[0].toUpperCase() + t.slice(1), act: () => this.setCab({ theme: t }) })) });
    it.push({ label: 'Reset banner & LCD', act: () => { this.setCab({ banner: true, style: 'art', lcd: true, theme: 'green' }); return 'stay'; } });   // play.html's defaults
    it.push({ label: 'Smoothing: ' + on(S.linear !== false), act: () => { S.linear = S.linear === false; this.st.save(); return 'stay'; } });
    it.push({ label: 'Show FPS: ' + on(S.fps), act: () => { S.fps = !S.fps; this.st.save(); return 'stay'; } });
    it.push({ head: 'Machine' });
    if (g && !this.selecting) {
      const sets = g.rtpSets || [], best = sets.length ? g.host.bestRtpSet(sets) : 0, cur = sets.find(r => r.set === g.rtp);
      if (sets.length > 1) it.push({ label: 'RTP set: ' + (cur ? cur.pct.toFixed(2) + '%' : g.rtp) + '...', list: () => {
        const busy = !!g.host.phase, l = sets.map(r => ({ label: (r.set === g.rtp ? '* ' : '  ') + r.pct.toFixed(2) + '%' + (r.set === best ? ' (best)' : ''), act: () => { this.setRtp(r.set); } }));
        l.push({ info: busy ? 'Finish the game first' : 'Restarts the game, money is kept' }); if (busy) l.forEach(x => { if (x.act) { x.info = x.label; delete x.label; delete x.act; } }); return l; } });
    }
    it.push({ label: 'Reset stats & credits...', list: () => [{ info: 'Credit back to $' + START / 100 + ', all statistics and totals cleared' }, { label: 'Reset', act: () => this.resetMoney() }, { label: 'Cancel', act: () => {} }] });
    it.push({ head: '' }, { label: 'Quit', act: () => this.quit() });
    return it;
  }
  scaleTo(x) { this.S.scale = x || undefined; this.S.fullscreen = false; this.st.save(); if (this.pf.fullscreen) this.pf.fullscreen(false); if (this.pf.scale) this.pf.scale(x); }
  menuButton() { return this.selecting || !this.game ? { x: this.W - 40 - 140, y: 188, w: 140, h: 50 } : this.cab.menuBtn; }
  onMenuButton(x, y) { const b = this.menuButton(); return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }

  // ---- input; coordinates are screen pixels ----
  key(k, e = {}) { if (this.boot) return;
    if (this.loading) return;
    if (k === 'f10' || (k === 'menu')) return this.menu.toggle();
    if (k === 'f11' || (e.alt && (k === 'return' || k === 'enter'))) { this.S.fullscreen = !this.S.fullscreen; this.st.save(); if (this.pf.fullscreen) this.pf.fullscreen(this.S.fullscreen); return; }
    if (k === 'f12') return this.screenshot();
    if (k === 'f4') { this.S.fps = !this.S.fps; this.st.save(); this.listOwn = this.listHalfOwn = false; return; }   // all redrawn: the counter's box goes
    if (this.menu.open) return this.menu.key(k);
    if (this.selecting) {
      const r = this.sel.key(k, e);
      if (r === 'close') { if (this.game) this.selecting = false; else this.menu.show(); }
      else if (r) this.launch(r);
      return;
    }
    const h = this.game && this.game.host; if (!h) { if (k === 'escape') this.menu.show(); return; }
    // the paytable: H (a pad's R1) goes on, the arrow keys page the help pictures, any other key only leaves it (play.html)
    if (h.help || this.pics) { if (this.pics && (k === 'left' || k === 'right')) return this.picPage(k === 'right' ? 1 : -1); if (k === 'h' || k === 'pageDown') return this.helpKey(); return this.helpOff(); }
    if (this.panel && ['space', 'up', 'down', 'left', 'right'].includes(k)) this.panel.auto = false;   // a game key stops AUTO, as in play.html
    // the gamble screen (play.html): R red, B black, 1-4 heart, diamond, club, spade; a pad's D-pad left red, right black
    if (h.gamble && h.gamble.screen) { const c = { r: 'red', b: 'black', left: 'red', right: 'black', 1: 'H', 2: 'D', 3: 'C', 4: 'S' }[k]; if (c) return void h.gambleChoose(c); }
    // a prompt with several keys to choose from and no SPIN (a feature pick): the arrow keys move a choice over them and SPIN presses it, as a pad has no other way to them
    const ck = h.phase ? h.choiceKeys() : [];
    if (this.panel && ck.length > 1 && !ck.includes(0) && ['left', 'right', 'up', 'down'].includes(k)) {
      const p = this.panel, i = ck.indexOf(p.pick), d = k === 'right' || k === 'down' ? 1 : -1; p.pick = ck[i < 0 ? (d > 0 ? 0 : ck.length - 1) : (i + d + ck.length) % ck.length]; return;
    }
    // play.html's keys: left / right the play lines, up / down the bet. The console launcher sets RP_PAD: its D-pad keeps left / right for the
    // bet and up / down for the lines, as RetroPokies.txt has them (its key map is one for the games list, the menu and the game)
    const pad = !!process.env.RP_PAD;
    switch (k) {
      case 'space': this.spin(); break;
      case 'return': case 'enter': case 'n': this.note(); break;   // Enter inserts a note, as in play.html; N too (a pad's SELECT)
      case 'g': case 'pageUp': this.gambleKey(); break;   // pageup: a pad's L1
      case 'h': case 'pageDown': this.helpKey(); break;   // the paytable; pagedown: a pad's R1
      case 'e': if (ck.includes(7)) h.pressKey(7); else this.panelKey(SHORTCUT.e); break;   // the FEATURE key at a feature prompt, as in play.html
      case 'f2': this.setCab({ panel: !this.cab.o.panel }); break;
      case 'f3': this.setCab({ banner: !this.cab.o.banner }); break;
      case 'left': if (pad) this.bet(-1); else this.lines(-1); break; case 'right': if (pad) this.bet(1); else this.lines(1); break;
      case 'up': if (pad) this.lines(1); else this.bet(1); break; case 'down': if (pad) this.lines(-1); else this.bet(-1); break;
      case 'tab': this.showGames(); break;
      case 'escape': this.menu.show(); break;
      default: if (SHORTCUT[k] !== undefined) this.panelKey(SHORTCUT[k]);
    }
  }
  text(t) { if (this.boot) return; if (!this.loading && this.selecting && !this.menu.open) this.sel.text(t); }
  move(x, y) { if (this.boot) return; this.px = x; this.py = y; if (this.menu.open) this.menu.hover(x, y); else if (this.selecting) this.sel.hover(x, y); }
  click(x, y) { if (this.boot) return;
    if (this.loading) return;
    if (this.menu.open) return this.menu.click(x, y);
    if (this.onMenuButton(x, y)) { const b = this.menuButton(); this.menu.at = { right: b.x + b.w, top: b.y + b.h + 10 }; return this.menu.show(); }
    if (this.selecting) { const g = this.sel.click(x, y); if (g) this.launch(g); return; }
    const c = this.cab;
    if (c.panel && y >= c.panel.y) { if (this.panel) { const k = this.panel.keyAt(x, y); if (k >= 0) this.panelKey(k); } return; }
    if (y >= c.game.y && y < c.game.y + c.game.h && x >= c.game.x && x < c.game.x + c.game.w) {
      const h = this.game.host; if (h.help || this.pics) return this.helpOff();
      // a touch prompt takes a click on the boxes the game drew, as the cabinet's touch screen (play.html); elsewhere a click is SPIN
      if (h.touch(Math.floor((x - c.game.x) * 640 / c.game.w), Math.floor((y - c.game.y) * 480 / c.game.h)) < 0) this.spin();
    }
  }
  wheel(dy) { if (this.boot) return; if (this.menu.open) this.menu.key(dy > 0 ? 'up' : 'down'); else if (this.selecting) this.sel.wheel(dy); }

  // ---- one display frame: dt ms of play, then the picture; with the FPS setting on, frames a second and the ms each took in the top left
  // (and, as SHOW, the ms the window took to put the previous frame on the screen: main.js sets showMs) ----
  async tick(dt) {
    const t0 = performance.now(), s = await this.frame(dt);
    { const w = this.waiters.splice(0); if (w.length) setImmediate(() => w.forEach(r => r())); }   // a loading step waits for its frame: main.js shows it before the next turn of the event loop
    if (this.S.fps) { this.sGame = null;
      const f = this.fps = this.fps || { at: [], ms: 0 }; f.at.push(t0); while (f.at[0] < t0 - 1000) f.at.shift();
      f.ms = f.ms * 0.9 + (performance.now() - t0) * 0.1;
      const px = s.w < this.W ? 2 : 4, t = 'FPS ' + f.at.length + '  ' + f.ms.toFixed(1) + ' MS' + (this.showMs != null ? '  SHOW ' + this.showMs.toFixed(1) : '');
      // as wide as the widest yet: a frame that redraws only some rows keeps the box, and a shorter text must cover a longer one
      if (f.px !== px) { f.px = px; f.w = 0; } const bw = f.w = Math.max(f.w, Screen.textW(t, px) + 4 * px);
      s.rect(0, 0, bw, 11 * px, [0, 0, 0]); s.text(2 * px, 2 * px, t, [255, 255, 0], px, false); if (s.dirty) s.dirty.push([0, 11 * px]);
    }
    return s;
  }
  async frame(dt) {
    const s = this.screen; if (this.boot) { this.drawBoot(s); s.dirty = null; return s; }
    const b = this.menuButton();
    if (this.pf.sound) this.pf.sound.volume = this.game && !this.selecting && !this.loading ? this.S.volume ?? 1 : 0;   // the game stands still under the games list: its sounds wait too
    if (!this.menu.open) { this.menu.at = { right: b.x + b.w, top: b.y + b.h + 10 }; this.menu.H = this.H; }
    // s.dirty: the rows changed since the last frame ([[y0, y1], ...]), or null for all of them (main.js halves only those)
    // the games list redraws only its parts that changed, when the last frame was the list's own too (listOwn)
    const toast = this.msg && Date.now() < this.msg.until, own = this.listOwn, ownH = this.listHalfOwn; this.listOwn = this.listHalfOwn = false; s.dirty = null;
    const shown = this.sGame; this.sGame = null;   // which of the game's pictures s holds (nothing drawn over it since), as pxVer and its place
    if (this.loading) this.drawLoading(s);
    else if ((this.selecting || !this.game) && this.menu.open && !toast) {
      // the menu over the games list: the list and the menu's box (its shadow is slow to draw) are kept from the first frame, and each
      // later one puts back the box's rows from that and draws the menu's rows again
      const M = this.menu, bx = M.box(), key = [this.W, this.H, bx.x, bx.y, bx.w, bx.h].join(), y0 = Math.max(0, bx.y), y1 = Math.min(this.H, bx.y + bx.h);
      if (!this.mBase || this.mBaseKey !== key) {
        this.sel.draw(s, 'false', s => K.button(s, b.x, b.y, b.w, b.h, '☰ Menu', { r: 10, hover: false }), true); M.drawBox(s);
        (this.mBase = this.mBase && this.mBase.w === this.W && this.mBase.h === this.H ? this.mBase : new Screen(this.W, this.H)).copy(s); this.mBaseKey = key;
      } else { s.u32.set(this.mBase.u32.subarray(y0 * this.W, y1 * this.W), y0 * this.W); s.dirty = [[y0, y1]]; }
      M.drawRows(s); this.sGame = null; return s;
    }
    else if (this.selecting || !this.game) {
      this.mBase = null;
      const hover = this.onMenuButton(this.px, this.py), btn = s => K.button(s, b.x, b.y, b.w, b.h, '☰ Menu', { r: 10, hover });
      if (this.half && !toast && !this.menu.open) {   // a handheld's screen: the list drawn at half size (main.js shows it as it is)
        const hs = this.listHalf && this.listHalf.w === this.W >> 1 && this.listHalf.h === this.H >> 1 ? this.listHalf : (this.listHalf = new Screen(this.W >> 1, this.H >> 1));
        hs.dirty = this.sel.draw(hs, String(hover), btn, !ownH); this.listHalfOwn = true; return hs;
      }
      const rows = this.sel.draw(s, String(hover), btn, !own);
      if (!this.menu.open && !toast) { s.dirty = rows; this.listOwn = true; }
    }
    else {
      const g = this.game, h = g.host, c = this.cab;
      // Speed (play.html): sp VM frames for each frame of real time, at most 12 ms of them a frame; a feature start drops it to 1x
      const sp = this.speed || 1, t1 = performance.now(); this.acc = Math.min(this.acc + dt * sp, 4 * sp * FRAME_MS);
      while (this.acc >= FRAME_MS) { this.acc -= FRAME_MS; h.frame(); if (sp > 1 && performance.now() - t1 > 12) { this.acc = 0; break; } }
      if (h.inFree && !this.wasFree) this.speed = 1; this.wasFree = h.inFree;
      this.hold();
      // a game counts towards the totals won once it is over (its win collected)
      if (!h.phase && h.last && h.last !== this.seen) { this.seen = h.last; this.S.played.won += (h.last.win || 0) * g.denom; this.book(g, h); this.st.save(); }
      this.prompts(h);   // after the booking: a PLAY ON starts the next game at once
      // the LCD as the host's own meters (mk6host.js panel()): during a game the stake is off the credit and the win shows as it grows
      const cur = h.phase && h.cur, credit = cur ? h.credits - cur.cost : h.credits, win = h.phase === 'result' ? h.winValue() : h.phase ? 0 : (h.last ? h.last.win : 0);
      c.setLcd([['CREDIT', K.money(credit * g.denom)], ['BET', K.money((cur ? cur.cost : h.cost) * g.denom)], ['WIN', K.money(win * g.denom)]]);
      const px = await g.frame(); this.lastFrame = px; if (!g.vm.outSame) this.pxVer = (this.pxVer || 0) + 1;   // pxVer counts the game's pictures
      if (this.half && !(this.msg && Date.now() < this.msg.until) && !this.pics) return this.halfFrame(px);
      // the cabinet around the game, and the game at 2x unless s holds it already
      const G = c.game, at = this.pxVer + ',' + G.x + ',' + G.y + ',' + G.w + ',' + G.h, x2 = G.w === 1280 && G.h === 960 && G.x >= 0 && G.y >= 0 && G.x + G.w <= s.w && G.y + G.h <= s.h;
      if (x2) { s.copyAround(c.base, G.x, G.y, G.w, G.h); if (shown !== at) s.put2x({ w: 640, h: 480, rgba: px }, G.x, G.y); this.sGame = at; }
      else { s.copy(c.base); s.blit({ w: 640, h: 480, rgba: px }, G.x, G.y, G.w, G.h); }
      if (this.pics) { const p = this.pics; if (p.im) s.blit(p.im, G.x, G.y, G.w, G.h); this.sGame = null;   // the help pictures over the game
        K.toast(s, 'Paytable ' + (p.i + 1) + ' / ' + p.pages.length + ' · ← → pages · any other key closes', G.x + G.w / 2, G.y + G.h - 40, G.w - 80); }
      if (c.panel && this.panel) { if (this.panel.autoTick() === 'spin') this.spin(); this.panel.draw(s, this.px, this.py); }
      if (!this.menu.open) { c.drawMenuButton(s, this.px, this.py); const m = c.menuBtn;   // over the game's corner when there is no banner
        if (m.x < G.x + G.w && m.x + m.w > G.x && m.y < G.y + G.h && m.y + m.h > G.y) this.sGame = null; }
    }
    this.menu.draw(s); if (this.menu.open) this.sGame = null;
    if (this.msg && Date.now() < this.msg.until) { this.sGame = null; const area = this.selecting || !this.game ? { y: 0, h: this.H } : this.cab.game; K.toast(s, this.msg.t, this.W / 2, area.y + area.h - 40, this.W - 160); }
    return s;
  }
  // a game frame for a window at half size or smaller (a handheld's screen), drawn straight at half size: the cabinet picture halved once
  // (and its LCD when the figures change), the game's 640 x 480 picture copied in 1:1 (it is drawn at 2x: halved it is itself), and only
  // the control panel and the Menu button drawn at full size and halved. Menus and messages go through the full-size picture (tick).
  // hs keeps the last frame: while the halved cabinet (hb, hbVer counts its changes) is as then, only the rows laid over last time are put
  // back, and the game only when its picture changed (pxVer). hs.same: the picture is the last one too
  halfFrame(px) {
    const s = this.screen, c = this.cab, W = this.W >> 1, H = this.H >> 1;
    if (!this.hs || this.hs.w !== W || this.hs.h !== H) { this.hs = new Screen(W, H); this.hb = new Screen(W, H); this.hbFor = null; this.hbVer = 0; this.hsVer = -1; }
    if (this.hbFor !== c.base) { this.hb.halfFrom(c.base, 0, 0, this.W, this.H); this.hbFor = c.base; this.hbLcd = c.lcdKey; this.hbPanel = null; this.hbVer++; }
    else if (c.lcd && this.hbLcd !== c.lcdKey) { const l = c.lcd; this.hb.halfFrom(c.base, l.x, l.y, l.w, l.h); this.hbLcd = c.lcdKey; this.hbVer++; }
    // the panel's keys go into the halved cabinet picture when they change; only the note acceptor's column is halved every frame
    const P = c.panel && this.panel; let a = null;
    if (P) { if (P.autoTick() === 'spin') this.spin(); const known = this.hbPanel === P && this.hbSig === P.sig;
      P.draw(s, this.px, this.py, known); if (!known || this.hbSig !== P.sig) { for (const r of P.parts()) this.panelHalf(P.pic, s, r); this.hbPanel = P; this.hbSig = P.sig; this.hbVer++; } a = P.animRect(); }
    // the halved cabinet around the game, then the game (the cabinet under it would only be overwritten)
    const hs = this.hs, gx = c.game.x >> 1, gy = c.game.y >> 1, gx1 = Math.min(W, gx + 640), gy1 = Math.min(H, gy + 480), hb = this.hb.u32, hu = hs.u32;
    const game = { w: 640, h: 480, rgba: px }, gk = gx + ',' + gy, same = this.hsPx === this.pxVer, full = this.hsVer !== this.hbVer || this.hsGame !== gk || gx < 0 || gy < 0;
    // rows y0..y1 of the cabinet around the game
    const around = (y0, y1) => { for (let r = y0; r < y1; r++) { const o = r * W;
      if (r < gy || r >= gy1) hu.set(hb.subarray(o, o + W), o); else { hu.set(hb.subarray(o, o + gx), o); hu.set(hb.subarray(o + gx1, o + W), o + gx1); } } };
    if (full) { if (gx < 0 || gy < 0) hs.copy(this.hb); else around(0, H); hs.put(game, gx, gy); this.hsVer = this.hbVer; this.hsGame = gk; }
    else { for (const [y0, y1] of this.hsCover) { around(y0, y1); if (same) hs.putRows(game, gx, gy, y0 - gy, y1 - gy); }
      if (!same) hs.put(game, gx, gy); }
    if (a) hs.halfFrom(s, a.x, a.y, a.w, a.h);
    // the Menu button, or the open menu, laid over the halved picture (the banner, or the game's corner); and the FPS counter (tick)
    const m = this.menu.open ? this.menuLayer() : this.buttonLayer(); if (m) hs.layer(m.k, m.w, m.y, m.runs);
    hs.same = !full && same && !a && m === this.hsM && !this.S.fps; this.hsM = m; this.hsPx = this.pxVer;
    this.hsCover = (m ? [[m.y, Math.min(H, m.y + m.runs.length)]] : []).concat(this.S.fps ? [[0, 22]] : []);
    return hs;
  }
  // a part of the control panel (rectangle p of s, drawn from the panel's picture pic) halved into the halved cabinet picture; kept for each
  // of the panel's pictures and parts, so a flashing lamp costs a copy
  panelHalf(pic, s, p) {
    const hb = this.hb, hx = p.x >> 1, hy = p.y >> 1, hw = p.w >> 1, hh = p.h >> 1, m = this.hpc || (this.hpc = new WeakMap());
    const all = m.get(pic) || {}; m.set(pic, all); let c = all[p.x];
    if (c && c.hw === hw && c.hh === hh) { for (let r = 0; r < hh; r++) hb.u32.set(c.u.subarray(r * hw, (r + 1) * hw), (hy + r) * hb.w + hx); return; }
    hb.halfFrom(s, p.x, p.y, p.w, p.h); c = all[p.x] = { hw, hh, u: new Uint32Array(hw * hh) };
    for (let r = 0; r < hh; r++) c.u.set(hb.u32.subarray((hy + r) * hb.w + hx, (hy + r) * hb.w + hx + hw), r * hw);
  }
  // the Menu button at half size as a layer (see menuLayer): drawn over black and over white once for each look (pointed at, faded)
  buttonLayer() {
    const c = this.cab, b = c.menuBtn, px = this.px, py = this.py, HW = this.W >> 1, HH = this.H >> 1;
    const d = px <= -1e4 ? 0 : Math.hypot(px - (b.x + b.w / 2), py - (b.y + b.h / 2)), key = JSON.stringify([b, HW, HH, !!c.mq, c.onMenu(px, py), Math.min(281, Math.round(d))]);
    if (this.bl && this.bl.key === key) return this.bl.m;
    const bx = b.x >> 1, by = b.y >> 1, bw = b.w >> 1, bh = b.h >> 1, o = Object.create(c); o.menuBtn = { x: 0, y: 0, w: b.w, h: b.h };
    const k = this.bl && this.bl.k.w === HW && this.bl.k.h === HH ? this.bl.k : new Screen(HW, HH), wt = this.bl && this.bl.k === k ? this.bl.wt : new Screen(HW, HH);
    for (const [col, d2] of [[0xff000000, k], [0xffffffff, wt]]) {
      const f = new Screen(b.w, b.h), h = new Screen(bw, bh); f.u32.fill(col); o.drawMenuButton(f, px - b.x, py - b.y); h.halfFrom(f, 0, 0, b.w, b.h);
      for (let r = 0; r < bh; r++) d2.u32.set(h.u32.subarray(r * bw, (r + 1) * bw), (by + r) * HW + bx);
    }
    // each row as runs, as menuLayer's: 0 nothing, 1 the button's own colour, 2 blended
    const runs = [];
    for (let r = by; r < by + bh; r++) { const o2 = []; let kd = -1;
      for (let x = bx; x < bx + bw; x++) { const i = r * HW + x, p = k.u32[i], q = wt.u32[i], t = p === q ? 1 : p === 0xff000000 && q === 0xffffffff ? 0 : 2;
        if (t !== kd) { if (kd >= 0) o2[o2.length - 2] = x; o2.push(x, 0, t); kd = t; } }
      if (kd >= 0) o2[o2.length - 2] = bx + bw; runs.push(Int32Array.from(o2)); }
    const m = runs.some(r => r.some((v, i) => i % 3 === 2 && v)) ? { k, w: wt, y: by, runs } : null;   // faded out: nothing to lay
    this.bl = { key, k, wt, m }; return m;
  }
  // the open menu at half size, over the game. Its box and shadow are drawn at half size once for the box's size, over black and over white
  // (Screen.layer: colour and see-through part); inside its border the box counts as opaque (it lets 3% through), so the rows are drawn
  // at full size on its colour there, and halved, only when they change
  menuLayer() {
    const M = this.menu, b = M.box(), gk = JSON.stringify([b, this.W, this.H]), key = gk + JSON.stringify([M.sel, M.first, M.items.map(it => [it.label, it.info, it.head])]);
    if (this.ml && this.ml.key === key) return this.ml;
    const HW = this.W >> 1, HH = this.H >> 1, ix = (b.x + 9) >> 1, iy = (b.y + 9) >> 1, ix1 = (b.x + b.w - 8) >> 1, iy1 = (b.y + b.h - 8) >> 1;
    if (!this.mb || this.mb.gk !== gk) {
      const x = Math.max(0, (b.x - 64) >> 1), y = Math.max(0, (b.y - 64) >> 1), x1 = Math.min(HW, (b.x + b.w + 80) >> 1), y1 = Math.min(HH, (b.y + b.h + 80) >> 1);
      const k = new Screen(HW, HH), wt = new Screen(HW, HH);
      for (const [c, d] of [[0xff000000, k], [0xffffffff, wt]]) { for (let r = y; r < y1; r++) d.u32.fill(c, r * HW + x, r * HW + x1); M.drawBox(d, 0.5); }
      // each row as runs: 0 nothing (clear), 1 the menu's colour (opaque), 2 blended
      const opaque = (r, c) => r >= iy && r < iy1 && c >= ix && c < ix1, runs = [];
      for (let r = y; r < y1; r++) { const o = []; let kd = -1;
        for (let c = x; c < x1; c++) { const i = r * HW + c, p = k.u32[i], q = wt.u32[i], t = p === q || opaque(r, c) ? 1 : p === 0xff000000 && q === 0xffffffff ? 0 : 2;
          if (t !== kd) { if (kd >= 0) o[o.length - 2] = c; o.push(c, 0, t); kd = t; } }
        if (kd >= 0) o[o.length - 2] = x1; runs.push(Int32Array.from(o)); }
      this.mb = { gk, k, wt, y, runs, fill: k.u32[((iy + iy1) >> 1) * HW + ix + 4] };
    }
    // the rows go into the box picture over black (inside the border only it is used): each row drawn at full size on the box's colour and
    // halved once, then kept, so moving or scrolling copies rows
    const mb = this.mb, k = mb.k, rc = this.rowCache || (this.rowCache = new Map());
    for (let r = iy; r < iy1; r++) k.u32.fill(mb.fill, r * HW + ix, r * HW + ix1);
    M.arrows(k, 0.5);
    for (const [i, x, y, w, h] of M.rows()) {
      const it = M.items[i], ck = JSON.stringify([it.label, it.info, it.head, i === M.sel, w, h, mb.fill]); let c = rc.get(ck);
      if (!c) { const f = new Screen(w, h); f.u32.fill(mb.fill); M.drawRow(f, i, 0, 0, w, h); c = new Screen(w >> 1, h >> 1); c.halfFrom(f, 0, 0, w, h); if (rc.size >= 200) rc.clear(); rc.set(ck, c); }
      const hx = x >> 1, hy = y >> 1; for (let r = 0; r < c.h && hy + r < HH; r++) k.u32.set(c.u32.subarray(r * c.w, (r + 1) * c.w), (hy + r) * HW + hx);
    }
    return (this.ml = { key, k: mb.k, w: mb.wt, y: mb.y, runs: mb.runs });
  }
  // loading screens: black, a picture (the app's icon, a game's art when decoded) and its name, the step and a bar
  drawProgress(s, im, title, p) {
    const W = this.W, H = this.H, cx = W / 2, bw = Math.min(800, W - 160), bx = (W - bw) / 2, by = H / 2 + 120;
    s.clear([0, 0, 0]);
    if (im) { const k = Math.min(720 / im.w, 300 / im.h, im.w < 300 ? 2 : 1), w = Math.round(im.w * k), h = Math.round(im.h * k); s.blit(im, cx - w / 2, by - 110 - h, w, h); }
    if (this.fonts) { const t = U.fitText('big', title, W - 80); s.print('big', t, cx - U.textW('big', t) / 2, by - 40, { color: K.C.gold }); }
    s.round(bx, by, bw, 16, 8, K.C.line); const fw = Math.round(bw * Math.max(0, Math.min(1, p.f))); if (fw >= 16) s.round(bx, by, fw, 16, 8, K.C.gold);
    if (this.fonts) { const t = U.fitText('ui', p.msg, W - 80); s.print('ui', t, cx - U.textW('ui', t) / 2, by + 60, { color: K.C.muted }); }
  }
  drawBoot(s) { this.drawProgress(s, this.icon, 'Retro Pokies', this.boot); }
  drawLoading(s) { const g = this.loading; this.drawProgress(s, g.art || null, g.name, this.loadStep || { msg: '', f: 0 }); }
}

module.exports = { App, settingsStore };
