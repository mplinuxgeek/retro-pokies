// Host side of an MK6 game: what the host OS does around the ROM (credits, bet/line keys, reel stops, spin timing); the ROM itself does
// win evaluation, symbol drawing and the game state machine. Message/call protocol: see mk6vm.js.
(function (root) {
  'use strict';
  const MK6VM = typeof require !== 'undefined' ? require('./mk6vm.js') : root.MK6VM;
  // RAM / code addresses differ per game (the ROM's linker places them): discovered by emu/discover.js into web/maps/<id>.json; these are Queen Of The Nile's
  const QOTN_MAP = { lineIdx: 1, betIdx: 0, state: 0xcf001e0, stopBuf: 0xcf00274, starter: 0x08009934, win: 0xcf00178, reels: 0xcf05000, window: 0xcf00f44, winRecords: 0xcf002c4, freeCount: 0xcf05688, freeFlag: 0xcf05684, freeOwnStops: true, lineKeys: { 1: 1, 5: 2, 10: 3, 15: 4, 20: 5 }, betKeys: { 1: 14, 2: 13, 3: 12, 5: 11, 10: 10 } };
  const METER_CREDIT = 0, METER_BET = 1, METER_WIN = 2;
  const isCopy = c => c.prio === -1 || c.ePlays === -1;   // the ROM's win-flash copy of a reel symbol: scene entry play count -1 (its priority is the 10th argument)
  const GAMBLE_KEYS = { red: 1, black: 5, S: 10, C: 11, D: 13, H: 14 };   // the ROM's gamble screen keys (QOTN, Pirates, Alchemy: the lit gbl_*_on)
  // cabinet keys as the ROM numbers them (as gam_process_player_command takes them): PLAY lines 1/5/10/15/20 = keys 1..5, BET per line 1/2/3/5/10 = keys 14/13/12/11/10
  const CREDIT_LIMIT = 100000;

  class Host {
    constructor(vm, opts = {}) {
      this.vm = vm; this.map = Object.assign({}, QOTN_MAP, opts.map || {}); if (opts.map && opts.map.state && opts.map.state !== QOTN_MAP.state) for (const k of ['freeCount', 'freeFlag', 'featureStops', 'freeOwnStops']) if (!(k in opts.map)) delete this.map[k]; /* QOTN free-game words are RAM addresses of that ROM only */ const lk = Object.keys(this.map.lineKeys || {}).map(Number), bk = Object.keys(this.map.betKeys || {}).map(Number);   /* lines / bet must be keys of the map (gam_process_player_command(undefined) busy-loops the ROM: Dragon Magic has line keys 1,3,5,7,9 only); default: most lines, lowest bet */
      this.lines = opts.lines in (this.map.lineKeys || {}) ? opts.lines : (lk.length ? Math.max(...lk) : 20); this.bet = opts.bet in (this.map.betKeys || {}) ? opts.bet : (bk.length ? Math.min(...bk) : 1); this.limit = opts.limit || CREDIT_LIMIT; this.rng = opts.rng || Math.random; this.fast = !!opts.fast;   // fast: headless runs skip the win-line animation wait
      vm.stateAddr = this.map.state;   // lets system stubs see the game state (log replay in gmc_read_write_log)
      vm.meterBlock = this.map.meterBlock;   // the ROM's running-meters block whose bet word the host seeds (gmc_read_write_log mode 2; Golden Archer Jackpot only)
      this.credits = opts.credits === undefined ? 10000 : opts.credits; this.phase = null; this.last = null; this.buf = 0;
    }
    // game task spinning at state 0 without ever waiting (Grizzly: rare, random): 120 consecutive such frames count as idle
    busyIdle() {
      const vm = this.vm, b = !this.inFree && !this.held && !vm.keyWait && vm.mem.r32(this.map.state) === 0 && vm.tasks[0].state === 'ready';
      this.busy0 = b ? (this.busy0 | 0) + 1 : 0; return this.busy0 > 120;
    }
    // RTP sets: combination_init(n) selects one and get_percentage99 names it ("92.26"); numbers past the last set fall back to set 1's
    // table (Big Red has 5 sets, best 4 = 94.95; most games 3; Wild Tepee 2). Needs only the key table and prvrn_init, so it runs before init.
    // Returns [{ set, pct }], or [] when the ROM gives no usable labels.
    rtpSets(lineIdx = this.map.lineIdx, betIdx = this.map.betIdx) {
      const vm = this.vm, out = [];
      try {
        try { vm.call('set_game_key_butttons', 1); } catch (e) { vm.call('set_default_line_bet'); }   // combination_init jumps to 0 until the key table is set (Lets Go Fishin, Heart Of Vegas, Miss Kitty, ...: without it their sets cannot be read and set 3 would be played past the end of a 2-set table)
        vm.call('prvrn_init', lineIdx ?? 1, betIdx ?? 0);
        for (let n = 1; n <= 9; n++) {
          vm.call('combination_init', n);
          const p = vm.call('get_percentage99') >>> 0, pct = p >= 0x8000000 ? parseFloat(vm.cstr(p)) : NaN;
          if (!(pct > 0) || (n > 1 && pct === out[0].pct)) break;
          out.push({ set: n, pct });
        }
      } catch (e) { return []; }
      return out;
    }
    // the set with the highest RTP (3 when the ROM does not say)
    bestRtpSet(sets = this.rtpSets()) { return sets.length ? sets.reduce((a, b) => (b.pct > a.pct ? b : a)).set : 3; }
    // set: the RTP set (percentage variation), 1-based as combination_init counts them. Most ROMs keep the table combination_init(set) installs;
    // 15 (Heart Of Vegas, 100 Lions, 50 Lions, Brazil, ...) ask acc_get_percentage_variation_index every spin instead and re-select from its
    // answer, which the system layer takes from vm.options.variation: so both get the set, else those games play set 1 whatever was chosen
    init(lineIdx = this.map.lineIdx, betIdx = this.map.betIdx, set = 1) {
      const vm = this.vm; vm.meters.set(METER_CREDIT, this.credits * (vm.options.denom || 1)); vm.options.variation = set;
      this.seedJackpots();
      try { vm.call('set_game_key_butttons', 1); } catch (e) { vm.call('set_default_line_bet'); }   // some ROMs scan a key table that only set_default_line_bet fills (the scan never ends on a zero table)
      for (const [n, ...a] of [['set_game_key_butttons', 1], ['rsa_playline_init'], ['playline_offsets_init'], ['prvrn_init', lineIdx, betIdx], ['combination_init', set], ['set_base_credit', lineIdx, betIdx], ['video_game_setup'], ['api_init_increment_rate'], ['gam_init']]) {
        try { vm.call(n, ...a); } catch (e) { if (n !== 'gam_init' || !/opcode 0x0 at 0x0/.test(e.message)) throw e; vm.call('Get_Data_From_Game_sys2game', 25, 0, 0, 0); vm.call(n, ...a); }   // gam_init calls through an interface pointer that only query 25 sets up (Cashman, Players Choice)
      }
      vm.runTasks(); vm.call('display_main_background'); vm.runTasks();
      // a free game (state 7) starts by writing raw random numbers into the stop buffer; the host replaces them with real stop positions (plain writes only: this runs inside a guest store)
      this.rawSend = vm.sendMessage; vm.sendMessage = (p, w) => { if (p === 2 && this.inFree && w[0] === 15 && w[1] === 1 && vm.cur && vm.cur.name === 'API_spin') { this.held = w.slice(); this.heldTask = vm.cur; this.heldAt = vm.now; return; } return this.rawSend(p, w); };   // a free game's reels stopping: hold the ROM's go-on message so the win can be shown
      vm.mem.watchAddr = this.map.state; vm.mem.onWatch = v => {
        if (v !== this.stLast) { this.stLast = v; this.st16 = 0; this.st18 = 0; this.stF = 0; this.st8 = 0; this.stuckSpin = 0; this.st16b = 0; }   // (a rewrite of the same value is not a new state) the parked-game watchdogs count frames in one state only: otherwise st8, stuckSpin and st16b would accumulate over the whole session and fire early
        // (continued) free games change state every game; Golden Archer Jackpot walks 55>67>60>61>62 while busy)
        const prime = () => { const st = this.randomStops(); this.reapSpinTasks(); this.pendingPos = st; if (this.map.starter) vm.cpu.trace = (c, pc) => { if ((pc >>> 0) === this.map.starter) { this.reapSpinTasks(); for (let k = 0; k < st.length; k++) vm.mem.w32(c.r[4] + 4 * k, st[k]); vm.cpu.trace = null; } }; return st; };
        const rp = !!vm.replay;   // a power-up replaying the logged game: its free games were counted before the save
        if (v === this.map.freeState && !rp) this.gameNo = (this.gameNo | 0) + 1;   // a free game in its own state (Mr Cashman: 19, then 20; other ROMs use 19/20 for other things, so per map)
        if (v === 7) { if (!this.inFree) this.featSeen = true; if (!this.map.freeOwnStops) { const st = vm.replayHost('stops') || this.randomStops(); vm.logHost('stops', st); st.forEach((p, i) => vm.mem.w32(this.map.stopBuf + 4 * i, p)); }   /* logged: a power-up replays the free games already played on the same stops */ if (!rp) this.gameNo = (this.gameNo | 0) + 1; this.primed = false; }
        else if (v === 5 && this.phase === 'result' && this.map.freeCount && !this.primed) {       // the game starts a free game by itself: give its reels their stops as for a paid spin
          // the ROM picks its free-game stops itself, as on the real machine; a map can still opt in to host stops with freeOwnStops: false. Host stops leave the ROM's
          // grid out of step with the reels shown: its win flash then blinks copies of other symbols over them (Double Dolphin: 9 / J, turtle / fish)
          this.primed = true; if (this.map.freeOwnStops === false) { const st = prime(); st.forEach((p, i) => vm.mem.w32(this.map.stopBuf + 4 * i, p)); }   // map.freeOwnStops: the ROM picks its free-game stops itself (50 Lions: from reel set n); overriding them with set-0 stops halves the free-game return
          if (!this.inFree) { this.inFree = true; this.fgTot = this.fgBase = this.winValue(); this.gameNo = (this.gameNo | 0) + 1; } }
        else if (v === 6) this.primed = false;
        else if (v === 0) { this.fgRestored = false; this.primed = false; } };
      /* no reserve_animation_init here: the OS calls it (sys2game export 6) only from its Reserve button, and on Indian Dreaming Lady Luck it removes the TOUCH Game Rules button the ROM put up at init */  this.buf = vm.alloc(64); this.stops = this.randomStops(); this.show(this.stops); this.panel(this.credits, 0, 0); vm.runTasks();
      this.baseScenes = vm.display.scenes.length; this.baseItems = vm.display.items.length;
      // The OS calls gam_key_indicator_and_message_update once the game is idle after power-up too, so the panel lamps are up before the first game
      if (!vm.meters.has(1508)) vm.meters.set(1508, 1);   // the OS's boot has the ROM write meter 1508 = 1 before this call; unset, Pharohs Fortune lights the line keys steady and no bet key instead of slow flash + chosen bet
      this.helpLamp();
      try { vm.call('gam_key_indicator_and_message_update'); vm.runTasks(); } catch (e) {}
    }
    // The lamp setter forces the lamp of the Game Rules key to steady (1) whatever state the ROM asks for, while the game has help pages and no help
    // screen is up: the key is gTok(help_func(4)) (5 Dragons: 6; the ROM sets 2, then 3 and the lamp shows 1). The ROM's writes into vm.lamps go through a trap that applies this
    helpLamp() {
      const vm = this.vm; if (this.helpKey !== undefined) return;
      let key = -1; try { if (this.romHelp()) { const t = this.helpFunc(4), k = vm.call('gTok', t); vm.runTasks(); if (k >= 0 && k < 16) key = k | 0; } } catch (e) {}
      this.helpKey = key;
      if (key < 0 || !vm.lamps || vm.lamps.__helpTrap) return;
      const host = this, L = vm.lamps; L[key] = { ...(L[key] || { t: vm.now, seq: 0 }), state: 1 };   /* an unset lamp is steady in the lamp table */
      vm.lamps = new Proxy(L, { get: (t, k) => k === '__helpTrap' ? true : t[k], set: (t, k, v) => { t[k] = v && +k === host.helpKey && !host.help ? { ...v, state: 1 } : v; return true; } });
    }
    // a new spin supersedes any spin task still parked from before (only the newest one is resumed by the retrace handler): free its stack
    reapSpinTasks() { const vm = this.vm; for (const t of vm.live || []) if (t.name === 'API_spin' && t.state !== 'done' && t.state !== 'crashed' && t !== vm.cur) { t.state = 'done'; } }
    // Progressive jackpots: the OS seeds each level's meter (0x95 + 2*level, see S.Get_Data_From_System_game2sys request 0) with the start value
    // the game reports through Get_Data_From_Game_sys2game(5) (12-byte records, start value first). Without it Golden Archer Jackpot reads its
    // levels as 0 and its jackpot state 62 waits for a non-zero amount for ever (real machine: levels 20000 / 5000).
    seedJackpots() {
      const vm = this.vm; let n = 0, recs = 0;
      try { n = vm.call('get_progressive_levels') | 0; recs = vm.call('Get_Data_From_Game_sys2game', 5, 0, 0, 0) >>> 0; } catch (e) { return; }
      if (n < 1 || n > 4 || recs < 0x8000000 || recs >= 0xc000000) return;
      for (let i = 0; i < n; i++) { const id = 0x95 + 2 * i, start = vm.mem.r32(recs + 12 * i) | 0; if (start > 0 && !(vm.meters.get(id) | 0)) vm.meters.set(id, start); }
    }
    sceneEndPending() { return ((this.vm.display || {}).scenes || []).some(sc => sc.playing && sc.endAt && sc.event && !sc.fixedMs); }   // the ROM is waiting for a scene-end callback that the clock will fire (periodic SP_TIMER ticks do not count)
    // other ROM tasks sleeping towards their next step: the game waits for their messages (Where Is The Gold and Lets Go Fishin: five 'Display Collected
    // Items' tasks step every ~2 s through 5-9 items, then each sends [15, 101..105]; otherwise the watchdog ends the feature after 400 frames). Capped at
    // 6000 frames of the same parked state, for tasks that loop for ever
    othersWorking() {
      const vm = this.vm, st = vm.mem.r32(this.map.state); if (this.owState !== st || vm.frameNo - (this.owSeen | 0) > 5) { this.owState = st; this.owFrames = 0; } this.owSeen = vm.frameNo;
      if (++this.owFrames > 6000) return false;
      return (vm.live || []).some(t => t !== vm.tasks[0] && t.state === 'sleeping' && !/^(win_inc|API_spin|scene_cb)$/.test(t.name));
    }
    waitingOnScene() {   // hold the parked-game watchdog while a scene end is due, but not for ever: some ROMs loop an animation (Golden Inca SCN_METERS re-adds itself from its own end callback), so after ~24 s of continuous pending the watchdog counts again
      if (!this.sceneEndPending()) { this.pendRun = 0; this.pendNames = null; return false; }
      // a new scene waiting is progress (a feature chaining its animations, Outback Jack's map bonus runs well past 24 s); the same names again are a loop
      const names = new Set(((this.vm.display || {}).scenes || []).filter(sc => sc.playing && sc.endAt && sc.event && !sc.fixedMs).map(sc => sc.rec && sc.rec.name || ''));
      if (this.pendNames && [...names].some(n => !this.pendNames.has(n))) this.pendRun = 0;
      this.pendNames = names;
      return (this.pendRun = (this.pendRun | 0) + 1) < 1500;
    }
    idle() { const vm = this.vm, g = vm.tasks[0]; return vm.mem.r32(this.map.state) === 0 && g.state === 'waiting' && !(vm.live || []).some(t => t.name === 'meter_rot' || t.name === 'win_inc'); }
    // cabinet controls: lines {1,5,10,15,20}, bet per line {1,2,3,5,10}; both take effect on the next spin
    get LINES() { return Object.keys(this.map.lineKeys).map(Number); } get BETS() { return Object.keys(this.map.betKeys).map(Number); }
    snd(kind, name, o) { if (this.onSound) this.onSound(kind, name, o); }
    // credits a game costs: lines x bet, unless the map says what the ROM charges per bet unit for a line key (map.lineCost: 50-line Lions and
    // Waratah games charge 25 for 50 lines, the 60 key 40: the ROM's own total bet, meter 1). Charging lines x bet would make them pay back half
    get cost() { const lc = this.map.lineCost && this.map.lineCost[this.lines]; return (lc || this.lines) * this.bet; }
    canChange() { return !this.phase; }
    setLines(n) { if (!this.canChange() || !(n in this.map.lineKeys)) return false; this.lines = n; this.snd('sfx', 'betbeep' + (this.LINES.indexOf(n) + 1)); this.panel(this.credits, this.last ? this.last.cost : 0, this.last ? this.last.win : 0); return true; }
    setBet(b) { if (!this.canChange() || !(b in this.map.betKeys)) return false; this.bet = b; this.snd('sfx', 'betbeep' + (this.BETS.indexOf(b) + 1)); this.panel(this.credits, this.last ? this.last.cost : 0, this.last ? this.last.win : 0); return true; }
    // note / coin acceptor: refused above the credit limit (ROM message 'Credits Not Accepted if Over')
    addCredits(n) {
      // the note acceptor works in every phase: in a game the credit counted before the bet (`before`) moves with the credits, so the end-of-game accounting keeps the note
      if (this.credits + n > this.limit) { this.snd('sfx', 'Alarm', { gain: 0.4 }); this.say('Credits Not Accepted if Over ' + this.money(this.limit) + '.'); return false; }
      const d = this.vm.options.denom || 1, m = this.vm.meters; this.credits += n; this.snd('sfx', 'Coinin');
      if (this.phase) { if (this.before !== undefined) this.before += n; m.set(METER_CREDIT, (m.get(METER_CREDIT) | 0) + n * d); const c = this.cur ? this.cur.cost : 0; this.panel(this.credits - c, c, this.phase === 'result' ? this.winValue() : 0); }
      else { m.set(METER_CREDIT, this.credits * d); this.panel(this.credits, this.last ? this.last.cost : 0, this.last ? this.last.win : 0); }
      return true;
    }
    // the credit / bet / win panel is host business in the original (the game only formats it): Update_credit_panel_display(credit, bet, win, 0)
    panel(credit, bet, win) { const d = this.vm.options.denom || 1; this.vm.call('Update_credit_panel_display', credit * d, bet * d, win * d, 0); }   // the ROM takes cents and divides by the base credit value for the credit counts
    warnOnce(key, msg) { this.warned = this.warned || {}; if (!this.warned[key]) { this.warned[key] = 1; console.warn('[mk6host] ' + msg); } }
    // reels on the grid: 5, or the map's reelCount (Enchantress 6 Reel: 6; without it the 6th reel sits on stop 0 every spin, the same symbols in every
    // window, paying 2.0 and never lining up its EYES scatters)
    reelIdx() { const n = this.map.reelCount | 0; return Array.from({ length: n >= 3 && n <= 10 ? n : 5 }, (_, i) => i); }
    reelLengths() {
      if (!this.map.reels) { this.warnOnce('reels', 'map has no reels address: assuming 30 stops per reel'); return [30, 30, 30, 30, 30]; }
      const lens = this.reelIdx().map(i => this.vm.mem.r32((this.map.reelsRam || this.map.reels) + 12 * i));   // reelsRam: the strip table the ROM copies into RAM for the set and line count in play (combination_init, the line-count routine); map.reels is the ROM's static table of one set
      if (lens.some(n => n < 8 || n > 400)) this.warnOnce('reelsBad', 'reel lengths out of range (' + lens.join('/') + '): map.reels is probably wrong, using 30 for those reels');
      return lens.map(n => (n >= 8 && n <= 400 ? n : 30));   // Bush Ranger: 280/60/70/80/360
    }
    // test-menu feature trigger: the map's known stops, each moved by up to map.featureJitter positions when the map says the trigger survives that (scatters stay in the window)
    featureStops() {
      const j = this.map.featureJitter | 0, f = this.map.featureStops; if (!j || !f) return f;
      const L = this.reelLengths(); return f.map((s, i) => (((s + Math.floor(this.rng() * (2 * j + 1)) - j) % L[i]) + L[i]) % L[i]);
    }
    // the line-count routine zeroes the stop buffer and the reel positions (and may switch the reel strip set): call it, then put back every shared-RAM word it cleared and the stop buffer
    callRecount() {
      const vm = this.vm, m = vm.mem, P = [], S = [];
      for (let a = 0x0cf00000; a < 0x0d000000; a += 4096) { const p = m.page(a); if (p) { P.push(p); S.push(p.slice()); } }
      const sb = this.map.stopBuf, st = sb ? Array.from({ length: 10 }, (_, i) => m.r32(sb + 4 * i)) : [];
      vm.callAddr(this.recount, [this.map.lineBets, 1]);
      P.forEach((p, k) => { for (let o = 0; o < 4096; o += 4) if (!(p[o] | p[o + 1] | p[o + 2] | p[o + 3]) && (S[k][o] | S[k][o + 1] | S[k][o + 2] | S[k][o + 3])) { p[o] = S[k][o]; p[o + 1] = S[k][o + 1]; p[o + 2] = S[k][o + 2]; p[o + 3] = S[k][o + 3]; } });
      st.forEach((v, i) => m.w32(sb + 4 * i, v));
    }
    randomStops() { return this.reelLengths().map(n => Math.floor(this.rng() * n)); }
    setStops(stops) { const m = this.vm.mem; for (let i = 0; i < 10; i++) m.w32(this.buf + 4 * i, i < stops.length ? stops[i] : 0); }
    show(stops) { this.setStops(stops); this.vm.call('ve_display_reels', this.buf, 0); }
    // message line: the ROM draws whatever text the OS hands to write_message_handler_mes(text, colour, window); the texts here are ours
    // ROM -> OS messages (msg_send to the mmc port, vm.outbox). In normal play (mode 0) the OS answers the game-over [10, 0, 0] with [9, 0, 0],
    // after which the game goes idle and takes the next start; without it the next [8, 1, 0] leaves the game in state 1. Before the [9, 0, 0] it calls
    // gam_key_indicator_and_message_update (sys2game export 19, once per game), which puts up the idle key lamps (Pompei's Spin lamp flashes)
    osMessages() { const vm = this.vm, ob = vm.outbox; if (!ob || !ob.length) return; vm.outbox = []; for (const { port, words } of ob) if (port === 1 && words[0] === 10) { vm.call('gam_key_indicator_and_message_update'); vm.runTasks(); vm.sendMessage(2, [9, 0, 0]); vm.runTasks(); } }
    // The OS's message line 2 (under the top of the reel frame) while the game is idle: every 2 s it alternates the ROM strings "GAM Play Now"
    // (or "GAM Insert Credits" without enough credit) and the bet text (betLineString), through write_message_handler_mes(text, colour -1, line 2)
    romString(name) { const r = this.vm.db.get(5, name); if (!r) return null; const b = r.body, at = b.length > 32 && b[0] === 0x53 ? 32 : 0; let e = at; while (e < b.length && b[e]) e++; return String.fromCharCode(...b.subarray(at, e)); }
    messageLine(line, text) { const vm = this.vm; this.lineBuf = this.lineBuf || {}; const buf = this.lineBuf[line] = this.lineBuf[line] || vm.alloc(96); vm.writeStr(buf, text || ' '); try { vm.call('write_message_handler_mes', buf, -1, line); vm.runTasks(); } catch (e) {} }
    // ROM-drawn help: the game draws its own help pages on the game screen. help_func(1) shows page 1, (2) the next, (3) leaves.
    // A game whose help_func(8) version is 100 or more also gives its page count (7), timeout in seconds (6) and a table of two message-line strings
    // per page (9; the OS alternates them on line 2). Older games get their page count from the OS's config; here help ends where the ROM says there is
    // no next page (help_func(2) returns 0: Alchemy after 7), wraps back to page 1's pictures (Queen of the Nile after 4)
    // or shows the game screen again (Indian Dreaming Maximillions after its jackpot page). They get the OS's default strings and a 60 s timeout. 0: no help_func (Pompei)
    helpFunc(a) { const vm = this.vm, r = vm.call('help_func', a); vm.runTasks(); return r | 0; }
    romHelp() { try { return this.helpFunc(8) >= 100 ? this.helpFunc(7) : Infinity; } catch (e) { return 0; } }
    helpAllowed() { try { return !this.phase && !this.gamble && this.idle() && !!this.vm.call('help_scr_is_allowed'); } catch (e) { return false; } }
    helpEnter() {
      const vm = this.vm; let pages = this.romHelp(); if (!pages || !this.helpAllowed()) return false; const game = this.helpPictures();
      const more = 'Press GAME RULES button for more information', other = 'Press ANY other button to return to game', last = 'Press ANY button to return to game';
      let msgs, ms = 60000;
      if (pages !== Infinity) { const t = this.helpFunc(9) >>> 0, txt = i => { const a = t ? vm.mem.r32(t + 4 * i) >>> 0 : 0; return a ? this.romString(vm.cstr(a)) : null; };
        const m = Array.from({ length: pages }, (_, p) => [txt(2 * p), txt(2 * p + 1)].filter(Boolean)); msgs = p => m[p - 1] || []; ms = 1000 * (this.helpFunc(6) || 60); }
      else { if (this.helpOld === undefined) this.helpOld = this.helpCount(game); pages = this.helpOld; if (!pages) return false; msgs = p => p < pages ? [more, other] : [last]; }
      this.help = { page: 1, pages, ms, until: vm.now + ms, msgs };
      try { this.helpFunc(8); this.helpFunc(1); } catch (e) { this.help = null; return false; }
      this.idleMsgAt = 0; return true;
    }
    // an older game's page count, found once by paging through its help and leaving it: the OS knows the last page (its message line drops the
    // "more" string there: Alchemy page 7 and Queen of the Nile page 4). 0: help draws nothing (the Mr Cashman games, Touch Of Paradice)
    helpCount(game) {
      let n = 0;
      try { this.helpFunc(8); this.helpFunc(1); const first = this.helpPictures();
        if (first !== game) for (n = 1; n < 30; n++) { this.helpFunc(8); if (!this.helpFunc(2) || [first, game].includes(this.helpPictures())) break; } } catch (e) { n = 0; }
      try { this.helpFunc(3); this.helpFunc(8); } catch (e) {} return n;
    }
    helpNext() { const h = this.help; if (!h) return false; if (++h.page > h.pages) { this.helpExit(); return false; } h.until = this.vm.now + h.ms;
      try { this.helpFunc(8); this.helpFunc(2); } catch (e) { this.helpExit(); return false; } this.idleMsgAt = 0; return true; }
    helpPictures() { return this.vm.display.items.filter(it => it && it.visible && (it.img !== undefined || it.flic !== undefined)).map(it => (it.img ?? 'f' + it.flic) + '@' + it.x + ',' + it.y).join(' '); }   // images and FLICs (Pharaohs Fortune's pages)
    helpExit() { if (!this.help) return; this.help = null; try { this.helpFunc(3); this.helpFunc(8); } catch (e) {} this.idleMsgAt = 0; }
    idleMessages() {
      const vm = this.vm;
      if (this.help) { const h = this.help; if (vm.now >= h.until) { this.helpExit(); return; }
        if (this.idleMsgAt && vm.now < this.idleMsgAt) return; this.idleMsgAt = vm.now + 2000; this.idleMsgN = (this.idleMsgN | 0) + 1;
        const m = h.msgs(h.page); if (m.length) this.messageLine(2, m[this.idleMsgN % m.length]); return; }
      if (this.phase) { this.idleMsgAt = 0; return; }
      if (this.idleMsgAt && vm.now < this.idleMsgAt) return;
      this.idleMsgAt = vm.now + 2000; this.idleMsgN = (this.idleMsgN | 0) + 1;
      let t = null;
      if (this.idleMsgN & 1) t = this.romString(this.credits >= this.cost ? 'GAM Play Now' : 'GAM Insert Credits');
      else { const f = this.betLineString(); if (f) t = f.replace('%d', String(this.bet)).replace('%s', this.bet === 1 ? '' : 's'); }
      if (t) this.messageLine(2, t);
    }
    // the bet text's string resource: "% Credits Per Line" ("%d credit%s per line", Bucaneer "X line bet", Pompei "per WAY BET"), except on a reel-power
    // game, which the OS shows as "1 credit X reel bet" (Dragon Lord, whose record says "per line"; Indian Dreaming Second Chance, "per WAY
    // BET"; Wild Ways, whose record already says it): the record that says "X reel bet", "% credit reel bet" when "% Credits Per Line" does not.
    // Wild Ways' "% credit reel bet" reads "%d credit reel bet" (no X) and the OS does not show that, so the X text wins, from either record
    betLineString() {
      if (this.betStr !== undefined) return this.betStr;
      let f = this.romString('% Credits Per Line');
      if (this.reelPower() && !(f && /X reel bet/i.test(f))) { const r = this.romString('% credit reel bet'); if (r && /X reel bet/i.test(r)) f = r; else if (!f) f = r; }
      return this.betStr = f;
    }
    reelPower() { try { const r = this.vm.call('get_gam_specific_str', 1); return (r >>> 0) > 0x8000000 && /REEL/i.test(this.vm.cstr(r)); } catch (e) { return false; } }   // the ROM's own name for its bet selector: "REEL BET" or "NUMBER OF LINES"
    // the ROM's own label for panel key k ("Play 243 Ways", "Play REELS 1-3", "Bet 5 Credits"): the OS asks the game for each key's text the same way
    // (sys2game request 0x1a), so Ways and Lines come from the ROM, not from the map. '' when the ROM has none or calls it "Not Used"
    keyText(k) { const vm = this.vm; if (!this.keyBuf) this.keyBuf = vm.alloc(256); vm.mem.w8(this.keyBuf, 0); try { vm.call('get_key_text', k, this.keyBuf); } catch (e) { return ''; } const t = vm.cstr(this.keyBuf).trim(); return t === 'Not Used' ? '' : t; }
    // the host's own win and free-game texts, only for a ROM that shows none itself: one that runs the OS's message lines (message_line_handler)
    // has its own ("Now that's a reel win!!", "3 free games remaining") and a blank at the spin would wipe its GOOD LUCK
    sayGame(text) { const ml = this.vm.msgLines; if (!(ml && ml.some(L => L.msgs.length))) this.say(text); }
    say(text) { const vm = this.vm; if (!this.msgBuf) this.msgBuf = vm.alloc(96); vm.writeStr(this.msgBuf, text || ' '); try { vm.call('write_message_handler_mes', this.msgBuf, 3, 0); vm.runTasks(); } catch (e) {} }
    // the footer, the OS's message window 4 (line 3, under the reels at the left of the denomination badge): "Memory Reset" at a boot without a
    // save and "Watchdog Reset" after a load from one.
    // Both stay until the next game starts (a power-up shows "Watchdog Reset, then GAME OVER PLAY NOW"; no "Memory Reset" after games in a recall)
    footer(text) { const vm = this.vm; if (!this.footBuf) this.footBuf = vm.alloc(96); vm.writeStr(this.footBuf, text || ' '); try { vm.call('write_message_handler_mes', this.footBuf, 3, 3); vm.runTasks(); } catch (e) {} }
    resetMessage(text) { this.footer(text); this.wdReset = true; }
    money(credits) { const c = Math.round(credits * (this.vm.options.denom || 1)); return '$' + Math.floor(c / 100) + '.' + String(c % 100).padStart(2, '0'); }
    // ---- gamble: the ROM plays it all (QOTN 0x8012624..): the card is acc_rand_0(4) (0 spade, 1 club, 2 diamond, 3 heart) turned by FLC_GBL_*, the history,
    // Full / Half, acc_get_max_doubleups rounds (5 with the gamble option on) and its own cap (a large win drops the suits, a larger one
    // ends the game at Gamble). Key 0 of the take-win prompt opens the gamble screen and on it toggles Full / Half; the screen's key wait starts with 5
    // and takes red 1, black 5, spade 10, club 11, diamond 13, heart 14, Take Win its key 1 (7; Pirates 0). The result is the ROM's win at game end
    canGamble() { return !this.noGamble; }
    gambleWin() { const r = this.vm.gameRec; return r ? Math.round(this.vm.mem.r32(r + 12) / (this.vm.options.denom || 1)) : this.winValue(); }   // the game record's win word follows the gamble on every map (meter 2 waits for the game's end)
    gambleStart() {
      const g = this.gamble, vm = this.vm; if (g && g.early && !g.busy && this.canGamble()) { g.want = true; return true; }   // state 10, no key wait yet: held until the take-win prompt
      if (!g || g.busy || !vm.keyWait || !this.canGamble()) return false;
      if (!g.screen) { g.key = vm.keyWait.keys[0]; g.screen = true; } g.busy = true; vm.keyWait = null; vm.sendMessage(2, [7, g.key, 1]); vm.runTasks(); return true;
    }
    gambleChoose(color) {
      const g = this.gamble, vm = this.vm, k = GAMBLE_KEYS[color]; if (!g || !g.screen || g.busy || !vm.keyWait || !vm.keyWait.keys.includes(k)) return false;
      g.busy = true; g.n++; this.gambles = (this.gambles | 0) + 1; vm.keyWait = null; vm.sendMessage(2, [7, k, 1]); vm.runTasks(); return true;
    }
    collect() {
      const g = this.gamble, vm = this.vm; if (g && g.early && !g.busy) { g.take = true; return true; }   // state 10, no key wait yet (a bet / Play / SPIN click as the win shows): taken when the prompt arrives
      if (!g || g.busy || !vm.keyWait) return false;
      // Take Win: the second key offered (QOTN 7; Pirates 0, as the OS's Take Win button; key 15 first in the list is a cash-out)
      const k = vm.keyWait.keys[1] ?? vm.keyWait.keys[0]; vm.keyWait = null; if (g.screen) g.busy = true; else this.gamble = null; vm.sendMessage(2, [7, k, 1]); vm.runTasks(); return true;
    }
    // the win total changed in the last 1500 frames: a roll-up still counting (Luigis Ball retrigger: win_inc sleeps 500-1000 frames between steps in state 7)
    // a free series with games left (or just won: the trigger spin counts up in state 9 first) whose win is still counting up (win_inc sleeping between ticks): not parked. A big free-game win counts up for up to a minute
    // (Arabian Nights, 54 s in state 5); maps with no win word read meter 2, which only moves at the end, so winMoving() cannot see it and the abort would end the series early
    freeCountUp() { const vm = this.vm; return !!this.map.freeCount && vm.mem.r32(this.map.freeCount) > 0 && this.frames < 20000 && (vm.live || []).some(t => t.name === 'win_inc' && t.state === 'sleeping'); }
    // a player is deciding: a ROM key wait (feature start, pick, take-win, gamble screen), a touch prompt, or a choice the ROM flashes keys for. The OS waits for ever, so no frame
    // counter or parked-game watchdog may run meanwhile (the 30000-frame abort and the 400-frame parked-state abort would end games a player is still looking at). Fast mode
    // and AUTO answer prompts themselves and are timed by those counters
    featureWait() { const st = this.vm.mem.r32(this.map.state); return st === 16 || st === 7 || (st > 11 && st !== 15); }   /* the game waits at a feature trigger / free-game start (play.html AUTO stops there when autoHuman is set) */
    humanWaiting() { const vm = this.vm; if (this.fast || this.autoKeys) return false; return !!vm.keyWait || !!(vm.hotspotWait && vm.hotspotWait.mode !== 'log') || (this.phase === 'result' && this.choiceKeys().length > 0); }
    // the ROM's win meter count-up task is sleeping between ticks: a big win counts for up to a minute (Arabian Nights 54 s, Outback Jack's free-game win: 100 s and more at 1 credit a tick, win_inc waking every ~1 s), on games with no win word or free-game counter
    // winMoving() and freeCountUp() cannot see that. Per state, capped at 20000 frames (5 min) for a count-up that never ends
    winIncCounting() { return this.stF < 20000 && (this.vm.live || []).some(t => t.name === 'win_inc' && t.state === 'sleeping'); }
    winMoving() { const v = this.winValue(), f = this.vm.frameNo; if (v !== this.wmVal) { this.wmVal = v; this.wmFrame = f; } return f - (this.wmFrame | 0) < 1500; }
    winValue() { const raw = this.map.win ? this.vm.mem.r32(this.map.win) : this.vm.meters.get(METER_WIN) | 0; return Math.round(raw / (this.vm.options.denom || 1)); }   // games whose win total word is unknown: the ROM writes it to meter 2 when the game ends
    window() {
      if (!this.map.window) { this.warnOnce('window', 'map has no window address: win windows read as all zero'); return [[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]]; }
      const m = this.vm.mem; return [0, 1, 2].map(r => this.reelIdx().map(c => m.r32(this.map.window + 40 * r + 4 * c)));
    }   // symbol ids, row-major
    // Hide the shown step of the win cycle and put its flashed tiles back
    endWinCycle() {
      const c = this.winCycle; this.winCycle = null; if (!c) return;
      const cur = c.steps[c.idx];
      if (cur) {
        for (const i of cur.scene.dm || []) if (this.vm.display.items[i]) this.vm.display.items[i].visible = false;
        for (const f of cur.flash || []) { if (f[1].img === f[3] || (f[6] !== undefined && f[1].img === f[6])) f[1].img = f[2]; if (f[5]) f[1].x = f[4]; }
      }
    }
    // Per-line win cycle from the scenes the ROM created after scene id baseId (rsa_do_win_animations): sets this.winCycle and this.animUntil
    buildWinCycle(baseId) {
      const vm = this.vm;
      const nm = it => it && it.img !== undefined ? vm.db.byIndex(1, it.img)?.name || '' : '';
      const isSide = it => it.x < 30 || it.x > 580;
      let newScenes = vm.display.scenes.filter(s => s.id > baseId && s.dm && s.dm.length > 0);
      // ROM re-creates the idle line indicators as scenes of side items only: leave them showing, they are not win steps
      newScenes = newScenes.filter(s => !s.dm.every(i => vm.display.items[i] && isSide(vm.display.items[i])));
      for (const s of newScenes) for (const idx of s.dm) if (vm.display.items[idx]) vm.display.items[idx].visible = false;
      // the host's cycle owns the flash: take back the reel tiles the ROM scene's own blink put the game's light-blue blank on (Arabian Nights' free games blanked them to IMG_a_BLANK, not the cell's cloud tile)
      for (const s of newScenes) { for (const h of s.hid || []) if (h[2] !== undefined && h[0].img === h[2]) { h[0].img = h[1]; h[2] = undefined; } s.hid = null; }
      // Arabian Nights style: one scene with the blinking symbols + lit indicator, then symbol-less scenes (the drawn line pieces) belong to it
      const groups = [];
      for (const s of newScenes) {
        const hasSym = s.dm.some(i => { const c = vm.display.items[i]; return c && isCopy(c) && c.img; });
        const hasWll = s.dm.some(i => nm(vm.display.items[i]).includes('WLL'));
        if (!hasSym && !hasWll && groups.length) { const g = groups[groups.length - 1]; g.dm = g.dm.concat(s.dm); }
        else groups.push({ id: s.id, dm: s.dm.slice() });
    }
    const lineScenes = []; let combinedScene = null;
    groups.forEach((s, idx) => {
      let lineNum = null;
      for (const i of s.dm) { const m = nm(vm.display.items[i]).match(/IMG_WLL(\d+)|IMG_BRI_[LR](\d+)|IMG_WIN_(\d+)_P/); if (m) { lineNum = parseInt(m[1] || m[2] || m[3], 10); break; } }
      if (idx === groups.length - 1 && groups.length > 1) combinedScene = s;
      else lineScenes.push({ id: s.id, line: lineNum, scene: s });
    });
    let blank = vm.db.get(1, 'IMG_BG_BLANK_11');
    if (!blank) for (const s of newScenes) for (const i of s.dm) { const c = vm.display.items[i]; if (!blank && c && c.img && /BLANK/i.test(nm(c))) blank = vm.db.get(1, nm(c)); }   // no stock blank tile: use the one the ROM's own flash overlay carries
    if (!blank) blank = vm.db.get(1, 'GS_BLANK');                                            // 50 Lions: the symbol-set blank cell
    const reelItems = vm.display.items.filter(o => o.visible && o.prio >= 0 && o.img);
    let steps = lineScenes.concat(combinedScene ? [{ id: combinedScene.id, scene: combinedScene, line: null }] : []);
    for (const st of steps) {
      const animSyms = st.scene.dm.map(i => vm.display.items[i]).filter(c => c && isCopy(c) && c.img);
      st.lamp = st.scene.dm.map(i => vm.display.items[i]).filter(c => c && isSide(c) && nm(c).startsWith('IMG_BRI_'));
      // the cell's own blank: a free game's flash scene carries a per-cell background tile (IMG_a_feat_blank_<reel><row>, Arabian Nights' cloud sky) under each symbol;
      // one tile for every cell would show the wrong part of the sky. The line marker (st.lamp) blinks by itself: swapping the side box under it for a blank would cover the line number
      const cellBlank = c => { if (/feat_blank/i.test(nm(c))) return c.img; for (const i of st.scene.dm) { const b = vm.display.items[i]; if (b && b !== c && b.x === c.x && b.y === c.y && b.img !== undefined && b.img !== c.img && /feat_blank/i.test(nm(b))) return b.img; } const rr = Math.round((c.x - 50) / 110) + 1, rw = Math.round((c.y - 121) / 100) + 1, own = vm.db.get(1, 'IMG_a_feat_blank_' + rr + rw); if (own) return own.index; return blank ? blank.index : undefined; };   // a scene without that cell's own tile (a line win of two copies): the cell's tile by position
      st.flash = animSyms.filter(c => !st.lamp.includes(c)).map(c => [c, (reelItems.find(o => o.scene === undefined && o.y === c.y && o.x === c.x) || reelItems.find(o => o.y === c.y && o.x === c.x))]).filter(q => q[1]).map(([c, o]) => { const bi = cellBlank(c); return [c, o, o.img, bi !== undefined ? bi : o.img, o.x, c.x - o.x, blank ? blank.index : undefined]; });   // [6]: the game's blank, for a cloud tile once the free games' backdrop has gone
    }
    if (this.map.freeCount && !this.inFree && vm.mem.r32(this.map.freeCount) > 0) {            // feature trigger: flash the scatter (the scene with no win-line pieces), not the line wins that happen to be on the grid
      const sc = steps.filter(st => st.flash && st.scene.dm.length && !st.scene.dm.some(i => /^IMG_WL\d+_[LRS]|WLL|^IMG_WIN_/.test(nm(vm.display.items[i]))) && st.scene.dm.some(i => vm.display.items[i] && isCopy(vm.display.items[i])));
      if (sc.length) steps = sc;
    }
    // A line is four phases (blank, shown, blank, shown) of the ROM's own win-flash phase (mk6sys WIN_PHASE_MS, exported as vm.winPhaseMs): 4 x 319 = 1275 ms, a design choice as the base game's scene cycle
    const ph = vm.winPhaseMs || 319, ms = 4 * ph;   // the OS's rhythm: per line two blinks, then the next line; the ROM does not pace the cycle. The total is capped below (the OS flashes until a key is pressed)
    this.winCycle = { steps, idx: -1, stepT0: 0, ms, ph };
    this.animUntil = vm.now + Math.min(12000, Math.max(3000, steps.length * ms));
    }
    sideCount() { return this.vm.display.items.filter(x => x.visible && x.scene !== undefined && (x.x < 30 || x.x > 580)).length; }
    // Start one game: keys + stops go to the ROM, which spins its own reel engine (task API_spin) and later evaluates the wins.
    spin(stops) {
      const vm = this.vm, m = vm.meters; if (this.phase) return null;
      if (this.map.lineKeys[this.lines] === undefined || this.map.betKeys[this.bet] === undefined) return null;   // not a key of this game (never send undefined to the ROM)
      if (this.credits < this.cost) return null;
      vm.drawStops = null; vm.drawLog = [];                                                   // the game's draws up to its spin, for a recovery; a recovery's unused ones never reach a new game
      this.sideBase = this.sideCount();                                                      // line-number boxes shown at idle (the ROM destroys them when a game starts)                                              // refused before the game starts: not enough credit
      this.osMessages(); for (let i = 0; i < 4000 && !this.idle(); i++) { vm.frame(); this.osMessages(); }   // let the previous game's roll-up finish
      // the start can switch reel strip sets (Ruby Magic idles on one, plays on another): stops drawn for the idle set can lie past the end of a shorter strip, so ours are drawn again
      let lens0 = !stops && this.reelLengths().join(); const redraw = () => { if (lens0 && this.reelLengths().join() !== lens0) { stops = this.randomStops(); lens0 = this.reelLengths().join(); } };
      stops = stops || this.randomStops(); m.set(METER_CREDIT, this.credits * (vm.options.denom || 1)); this.reapSpinTasks();
      // the game's start-up state draws its own targets and hands them to the spin starter; give it ours (stops stay in step with the reels).
      // Forced stops past the end of the strip set the game starts on are wrapped: Pompei idles on one set (reel 5: 60 stops) and plays on another (53), and a stop
      // of 53-59 there parks the game in state 3 for good (12% of forced spins drawn for the idle set). Random stops are redrawn instead (redraw above)
      // map.ownStops: keep the ROM's (Enchantress 6 Reel draws uniform stops, then moves 80% of those that show a wild on reels 3-5, table at
      // 0xcf03410; uniform host stops would skip that and pay 1.3-1.6)
      if (this.map.starter) vm.cpu.trace = (c, pc) => { if ((pc >>> 0) === this.map.starter) { this.reapSpinTasks(); redraw(); if (!lens0) { const L = this.reelLengths(); stops = stops.map((p, k) => L[k] > 0 && p >= L[k] ? p % L[k] : p); } this.logDraws(Array.from(stops, (_, k) => vm.mem.r32(c.r[4] + 4 * k) >>> 0), stops); for (let k = 0; k < stops.length; k++) { if (this.map.ownStops) stops[k] = vm.mem.r32(c.r[4] + 4 * k) >>> 0; else vm.mem.w32(c.r[4] + 4 * k, stops[k]); } vm.cpu.trace = null; } };
      const find = this.recount === undefined && !this.map.noRecount && this.map.lineBets;   // find is the line-bets address the finder compares r4 with if (find) this.recount = null;
      const cpu = vm.cpu, step = cpu.step; let prev = 0;
      if (find) cpu.step = function () {                                                                     // find the call that counts the active lines (r4 = line bets, r5 = 1), made once during start-up
        const pc = cpu.pc >>> 0;
        if (!this.recount && (cpu.pr >>> 0) === prev + 4 && pc >= 0x08000000 && pc !== cpu.pr >>> 0 && (cpu.r[4] >>> 0) === find && cpu.r[5] === 1) {
          this.recount = pc; this.recountOwn = false;   // the ROM makes this call itself while it starts ([8, 1, 0]); with the keys already in (lineBets set) the host's second call is not needed, and on Wizard Ways / Indian Dreaming Lady Luck it switches the reel strips to a set the ROM does not play
          for (let i = 0; i < 64; i++) if (this.vm.mem.r32(find + 4 * i)) { this.recountOwn = true; break; }
        }
        prev = pc; return step.call(cpu);
      }.bind(this);
      // game start [8, state, mode]: the ROM sets state and game mode from it. The OS sends [8, 1, 0] (normal play) after the
      // player set lines and bet at idle; the game then plays its own win tune, rolls the win up and cycles the winning lines (QOTN: 1.05 s, then 1.31 s
      // per line) until the next Play. ([8, 1, 1], game mode 1, looks like replay mode: the ROM skips the roll-up and the win tune, and features that
      // wait for the player cannot run.)
      // mode 0: bet and line keys at idle, then the start (the OS sends the Play key as [7, key, 1] around [8, 1, 0], but the idle game here does not
      // act on key messages, so the keys go in as player commands). The start state checks credit against the bet these set (total bet 0 loops for ever)
      vm.muteSound = true;   // the key presses below are the host's, not the player's: the OS plays no bet beep at the start
      vm.call('gam_process_player_command', this.map.betKeys[this.bet], 1, 0); vm.call('gam_process_player_command', this.map.lineKeys[this.lines], 1, 0); vm.runTasks();
      // a real cabinet cuts the last game's win tune when the next game starts; the ROM only released it (it plays out), so the host stops it
      for (const id of vm.releasedSounds || []) vm.sound.stop(id); if (vm.releasedSounds) vm.releasedSounds.clear(); if (vm.sound.stopMusic) vm.sound.stopMusic();   // and any other tune (collect, the previous feature's march) still playing
      vm.sendMessage(2, [8, 1, 0]); vm.runTasks();
      if (vm.mem.r32(this.map.state) === 0) { vm.sendMessage(2, [9, 0, 0]); for (let i = 0; i < 120; i++) vm.frame(); vm.sendMessage(2, [8, 1, 0]); vm.runTasks(); }   // the game ignores the start message after some feature endings (Amazon Queen, free-game chain ending 7>0): [9,0,0] resets it
      vm.cpu.trace = null; if (find) cpu.step = step;
      // state 1 clears the line bets, so the keys come after the start too (the OS sends the Play key as messages around [8, 1, 0] instead). The start already took this game's bet from the credit meter and checked it; the keys are checked against what is left, so they
      // see the credit from before the start (at $1 a credit a 100-credit balance is all bet, and the line key was refused while the reels spun).
      const credit0 = m.get(METER_CREDIT) | 0, started = vm.mem.r32(this.map.state) !== 0;
      if (started) m.set(METER_CREDIT, credit0 + this.cost * (vm.options.denom || 1));
      if (this.map.betAfterStart) vm.call('gam_process_player_command', this.map.betKeys[this.bet], 1, 0);   // the bet key again re-runs the bet handler, which sets the SPIN lamp (key 0) to fast flash for the whole spin; the OS only sends the Play key and key 0 stays steady
      const ok = vm.call('gam_process_player_command', this.map.lineKeys[this.lines], 1, 0); vm.runTasks(); vm.muteSound = false;
      if (started) m.set(METER_CREDIT, credit0);
      redraw();
      if (!ok && !started) return null;   // refused: not enough credit (the game stayed idle)
      if (this.recount && !this.map.noRecount && !this.recountOwn) {
        this.callRecount(); const s0 = stops; redraw();   // it may switch the strip set (Indian Dreaming Lady Luck: reel 5 28 > 55 stops): draw again from the strips the reels now use
        if (stops !== s0 && this.map.stopBuf) for (let k = 0; k < stops.length; k++) vm.mem.w32(this.map.stopBuf + 4 * k, stops[k]);
      }                                    // the start-up counted zero lines (selects how many reel rows pay); count again now the keys set them
      const cost = this.cost;
      m.set(1, cost * (vm.options.denom || 1));   // meter 1 = this game's total bet in cents, which the OS sets once the bet is accepted (the ROM zeroes it at game start); Golden Archer Jackpot pays its jackpot as a multiple of it (0 left state 62 waiting for ever)
      if (this.wdReset) { this.wdReset = false; const L3 = vm.msgLines && vm.msgLines[3]; if (L3 && L3.cur) { vm.writeStr(this.msgBuf, L3.cur.text.slice(0, 95)); vm.call('write_message_handler_mes', this.msgBuf, L3.cur.colour, 3); vm.runTasks(); } else this.footer(''); }   // "Watchdog Reset" / "Memory Reset" go with the next game: the ROM's own line-3 message, if it has one, comes back
      this.sayGame(''); this.cur = { stops, cost, win: 0, window: null, t0: vm.now }; this.flashSince = 0; this.triedKeys = null; this.retries = 0; this.before = this.credits; this.setStops(stops); for (let i = stops.length; i < 10; i++) { const v = vm.mem.r32(this.map.stopBuf + 4 * i) >>> 0; if (v) vm.mem.w32(this.buf + 4 * i, v); }   /* words past the reels (King Neptune's 6th draw, bound 1013) were drawn by the ROM already: gam_Set_reel_pos copies all 10 and zeroes them */
      vm.call('gam_Set_reel_pos', this.buf); this.seenSpin = this.spinTask(); this.winBefore = m.get(METER_WIN) | 0;
      this.panel(this.credits - cost, cost, 0); this.lastCost = cost; vm.betCents = cost * (vm.options.denom || 1);
      this.phase = 'spinning'; this.frames = 0;
      { const L = vm.gameLog, e = L && L[L.length - 1]; if (e && !e.done && !e.h) { e.h = this.saved(); e.m = [...m]; e.d = vm.options.denom || 1; e.t = Date.now(); } }   // the game's start, for a recall
      return this.cur;
    }
    // a recall shows each logged key's take-win or gamble prompt (state 8) for a second before the key goes in; with pausing on (vm.recallPause,
    // the OS's SET PAUSING) it holds at the first one, the win-pending point (a losing game never gets there), until play.html clears vm.recallPaused.
    // A feature also holds after its trigger and after each free game but the last (see frame(): 16 holds for QOTN's 15 free games, as on the real machine)
    // Other key waits are not held: the ROM moves on from some by itself (QOTN's feature start), and the log would no longer match
    recallHold() {
      const vm = this.vm, R = vm.replay, r = R.recs[R.i]; if (!r || r[0] !== 'key' || vm.mem.r32(this.map.state) !== 8) return false;
      if (vm.recallPause && !this.keyPaused) { this.keyPaused = true; vm.recallPaused = true; }
      if (vm.recallPaused) return true;
      if (this.holdKw !== vm.keyWait) { this.holdKw = vm.keyWait; this.holdF = 0; } return ++this.holdF < 60;
    }
    // the draws the game made up to its spin go with its log entry: the run of them that drew the ROM's own stops (rom) takes the host's (ours)
    logDraws(rom, ours) {
      const vm = this.vm, D = vm.drawLog, L = vm.gameLog, e = L && L[L.length - 1]; vm.drawLog = null; if (!D || !e || e.done) return;
      for (let i = D.length - rom.length; i >= 0; i--) if (rom.every((v, k) => D[i + k][1] === v)) { if (!this.map.ownStops) rom.forEach((_, k) => { D[i + k][1] = ours[k] % D[i + k][0]; }); e.draws = D; return; }
    }
    // ---- power-up from a save (play.html keeps the save, the scanners never make one). saved(): the host's own part of a save, next to the
    // game's battery RAM (SHARED), meters and game log. resume(s), on a fresh VM whose meters and vm.powerUpLog were restored before init: the OS's
    // power-up start [8, 1, 1] (game mode 1); gmc_initialise_game_log then hands the ROM its logged game, which it runs again in recovery from its
    // start-up state: an interrupted spin is completed with the same stops, a pending win or an open gamble comes back. The message line says
    // "Watchdog Reset", as the OS's after a load from a save
    saved() { const o = {}; { const vm = this.vm; if (!this.phase && !this.idleLamps && vm.lamps && vm.mem.r32(this.map.state) === 0 && Object.keys(vm.lamps).length) this.lampsIdle = JSON.parse(JSON.stringify(vm.lamps)); else if (this.phase) this.lampsIdle = undefined; }   /* the idle lamps (flashing) go in the save: the recovery replay at a reload leaves every lamp steady and a resumed VM cannot rebuild them */ for (const k of SAVED) if (this[k] !== undefined) o[k] = JSON.parse(JSON.stringify(this[k])); return o; }
    resume(s) {
      const vm = this.vm; Object.assign(this, s); if (this.gamble) { this.gamble.busy = false; this.resumeGamble = this.gamble; this.gamble = null; }   // the gamble waits until the ROM is back at its prompt (the replay passes through state 3)
      const stops = this.phase && this.cur && this.cur.stops;   // the paid spin of the game in progress lands where it did (the stop buffer may hold a later free game's)
      if (stops && this.map.starter) vm.cpu.trace = (c, pc) => { if ((pc >>> 0) === this.map.starter) { this.reapSpinTasks(); if (!this.map.ownStops) for (let k = 0; k < stops.length; k++) vm.mem.w32(c.r[4] + 4 * k, stops[k]); vm.cpu.trace = null; } };
      { const st = stops || (this.last && this.last.stops); if (st) { this.setStops(st); vm.call('gam_Set_reel_pos', this.buf); } }   // a finished game's recovery shows its result again: the reels go back to its stops
      { const L = vm.powerUpLog, e = L && L[L.length - 1]; vm.drawStops = !stops && e && e.done && !e.hostEnd && e.draws ? e.draws.map(d => [...d]) : null; }   // and the ROM's redraw of the game's start lands there (see acc_rand_0). Not for a game the host ended itself: its log lacks the
      // records the game's end reads, and the replay ran out of them part way (King Of The Nile parked at state 8)
      // the recovery replay leaves every key lamp steady (1) even when no game was in progress, and nothing after it puts up the idle lamps (no game over
      // [10, 0, 0] follows; gam_key_indicator_and_message_update then keeps them steady too). The OS flashes the play keys and SPIN at this idle, as
      // init's update does, so an idle machine keeps init's lamps; a game in progress keeps the replay's
      const idleLamps = !this.phase && vm.lamps ? (this.lampsIdle ? { ...this.lampsIdle } : { ...vm.lamps }) : null;
      vm.sendMessage(2, [8, 1, 1]); vm.runTasks(); this.frames = 0; this.sawSpin = false;
      this.resumeT = vm.now; this.idleLamps = idleLamps;   // put back by frame() once the replay is back at state 0
      this.resetMessage('Watchdog Reset'); this.panel(this.phase && this.cur ? this.credits - this.cur.cost : this.credits, this.cost, this.phase ? 0 : (this.last ? this.last.win : 0));
    }
    // the button the game flashed most recently during this game (vm.lamps from gos_control 13), key 0 aside (it flashes at idle); once pressed, only a newer flash counts
    soloLamp() { const L = this.vm.lamps || {}, t0 = this.cur ? this.cur.t0 : 0, ks = Object.keys(L).filter(k => +k && (L[k].state === 2 || L[k].state === 3) && L[k].t >= t0); return ks.length === 1 ? +ks[0] : undefined; }
    // the newest key that started flashing since the last press; with retry, also a key that was already flashing then and has not been pressed in this game,
    // at most 3 times a game (Pharohs Fortune's feature prompt flashes keys 6 and 7 and takes only 7: pressing the newer 6 changes nothing)
    // a finished game's recovery that stops reading its log part way, in a game state: give it up after 10 s as the host gives up a
    // parked game (abort message, then force idle), so the machine is not left frozen (Outback Jack's card pick slept at state 12 with no
    // lamp flashing, its logged key ignored)
    replayStall() {
      const vm = this.vm, R = vm.replay, st = vm.mem.r32(this.map.state);
      if (this.rStallM && st === 0) { vm.meters = this.rStallM; this.rStallM = null; }   // the game was metered when it was played: what the given-up end counts is undone
      if (!R || !R.done || R.recall || st === 0 || this.phase) { this.rStall = null; return; }
      const k = R.i + ':' + st, busy = vm.tasks[0].state === 'ready'; if (!this.rStall || this.rStall.k !== k) { this.rStall = { k, n: 0, tries: 0 }; return; }
      if (++this.rStall.n < (busy ? 1800 : 600)) return;   // a busy game task gets longer (Golden Archer Jackpot's jackpot states 55-70 run long, and its recovery spins at state 62)
      this.rStall.n = 0; this.rStallM = new Map(vm.meters); vm.replay = null; vm.keyWait = null; if (this.rStall.tries++) vm.mem.w32(this.map.state, 0); else { vm.sendMessage(2, [9, 0, 0]); vm.runTasks(); }
    }
    replayFlashPick() { const vm = this.vm, R = vm.replay, r = R.recs[R.i], st = vm.mem.r32(this.map.state); return !!r && r[0] === 'key' && st > 11 && st !== 15 && !this.spinTask() && Object.values(vm.lamps || {}).some(l => l.state === 2); }
    flashKey(retry) { const L = this.vm.lamps || {}, t0 = this.cur ? this.cur.t0 : 0, done = this.pressedSeq | 0, tried = this.triedKeys || new Set(); let best, fresh = false;
      for (const k in L) { if (!+k || L[k].state !== 2 || L[k].t < t0) continue; const f = L[k].seq > done; if (!f && !(retry && done && (this.retries | 0) < 3 && !tried.has(+k))) continue; if (best === undefined || f > fresh || (f === fresh && L[k].seq > L[best].seq)) { best = k; fresh = f; } }
      return best === undefined ? undefined : +best; }
    // the keys a feature choice is flashing right now (mode 0, the same states as the press branch in frame); [] when there is no choice
    choiceKeys() {
      const vm = this.vm, st = vm.mem.r32(this.map.state), hw = vm.hotspotWait;
      if (this.phase === 'result' && hw && hw.mode !== 'log' && hw.keys && hw.keys.length) return hw.keys.slice();
      // a ROM key wait (state 16 feature trigger: Feature key 7, 5 Dragons' 1-5 pick; Mr Cashman [6,7]) waits for the player, as on the real machine: its keys, or the flashing ones when
      // it lists the whole idle set (Double Dolphin flashes 7). The take-win prompt is the gamble's (host.gamble) unless no gamble is offered: then the collect key (keys[1]).
      // Key 15 (gamble) is not offered here (the host plays the gamble itself). [] in fast mode (the host answers)
      if (this.phase === 'result' && vm.keyWait) {
        if (this.fast) return [];
        const ks = vm.keyWait.keys || [], L = vm.lamps || {};
        if (st === 8 && ks.length > 3) return this.gamble || (this.winValue() > 0 && !this.noGamble) ? [] : [ks[1] ?? ks[0]];
        const fl = Object.keys(L).filter(k => (L[k].state & 3) >= 2).map(Number);
        return (ks.length > 3 ? fl : ks).filter(k => k !== 15);
      }
      // Big Hearted's START FEATURE (state 9, no key wait, key 7 alone flashing in lamp state 3): the player's key to press, so the parked-game
      // watchdog waits for it instead of pressing it after 400 frames (autoplay and fast mode still get the watchdog's press: humanWaiting is false there)
      if (this.phase === 'result' && !vm.keyWait && st === 9 && !this.fast && !this.spinTask()) { const solo = this.soloLamp(); if (solo) return [solo]; }
      if (this.phase !== 'result' || vm.keyWait || st <= 11 || st === 15 || this.spinTask()) return [];
      const L = vm.lamps || {}, t0 = this.cur ? this.cur.t0 : 0, done = this.pressedSeq | 0;
      return Object.keys(L).filter(k => +k && L[k].state === 2 && L[k].t >= t0 && L[k].seq > done).map(Number);
    }
    // a touch on the game screen (640x480): during a touch prompt a touch box with an id the prompt accepts is sent as [7, id, 1] (Corrida De Toros
    // pick: boxes 5001/5002); returns the id, or -1 when the touch does nothing
    touchable(x, y) { const hw = this.vm.hotspotWait; if (!hw || hw.mode === 'log' || !hw.ids) return -1; const id = this.vm.touchAt(x, y); return hw.ids.includes(id) ? id : -1; }
    touch(x, y) { const id = this.touchable(x, y); if (id < 0) return -1; const vm = this.vm; vm.sendMessage(2, [7, id, 1]); vm.runTasks(); vm.sendMessage(2, [7, id, 0]); vm.runTasks(); return id; }
    // a panel button pressed and released, as the OS forwards it during a game ([7, key, 1] then [7, key, 0])
    pressKey(k) { const vm = this.vm; vm.keyWait = null; this.flashSince = vm.now; (this.triedKeys = this.triedKeys || new Set()).add(k); this.pressedSeq = vm.lampSeq; vm.sendMessage(2, [7, k, 1]); vm.runTasks(); vm.sendMessage(2, [7, k, 0]); vm.runTasks(); }
    spinTask() { return (this.vm.live || []).find(t => t.name === 'API_spin' && t.state !== 'done' && t.state !== 'crashed'); }
    // one display frame; drives the host side of the cycle: reels done -> tell the game ([15,1,0]) -> read the outcome -> wait for the game to finish
    frame() {
      const vm = this.vm;
      if (this.idleLamps && !this.phase && vm.mem.r32(this.map.state) === 0 && !vm.replay && vm.now - (this.resumeT || 0) >= 600) {   /* not before the recovery replay and the ROM's own lamp writes after it are over */ const L = this.idleLamps; this.idleLamps = null; for (const k of Object.keys(vm.lamps)) delete vm.lamps[k]; for (const k of Object.keys(L)) vm.lamps[k] = { ...L[k], seq: ++vm.lampSeq }; }
      else if (this.phase) this.idleLamps = null;
      // a recall with pausing on stops before each logged free game (the replay's next record is its stops): the ROM has shown the trigger or the last free
      // game's win and does nothing until play.html clears vm.recallPaused. The whole VM waits, so the log cannot get ahead of the ROM
      if (vm.recall && vm.replay) { const R = vm.replay, r = R.recs[R.i];
        if (vm.recallPause && r && r[0] === 'stops' && this.pausedAt !== R.i) { this.pausedAt = R.i; vm.recallPaused = true; this.freeze = true; }
        if (vm.recallPaused && this.freeze) return true; this.freeze = false; }
      vm.frame(); if (!this.humanWaiting()) this.frames++; if (this.phase === 'result') { const w = this.winValue(); if (w !== this.fw) { this.fw = w; this.frames = 0; } }   /* the game total grew: a long free-game series with no free-game counter (Outback Jack, 16000 frames and more) is progressing, not wedged */ this.stF = (this.stF | 0) + 1; /* a player thinking at a key prompt is not a stalled game (the 30000-frame abort would leave the ROM at the feature prompt for good); stF = frames in this game state */ if (!this.fast) this.idleMessages();   // (the scanner runs fast: no messages)
      this.osMessages();
      if (this.pendingPos) { const st = this.pendingPos; this.pendingPos = null; this.setStops(st); vm.call('gam_Set_reel_pos', this.buf); vm.runTasks(); }   // free game: the OS tells the reels where they will stop, as for a paid spin
      if (vm.replay && vm.keyWait && !(vm.recall && this.recallHold()) && vm.replayKey()) { vm.keyWait = null; vm.runTasks(); }   // power-up recovery: the logged game's next key
      else if (vm.replay && vm.replay.done && !vm.replay.recall && !vm.keyWait && this.replayFlashPick() && vm.replayKey()) vm.runTasks();   // a finished game's pick the game asked for by flashing keys, with no key wait (the host's mode 0 below): its logged key
      this.replayStall();
      if (this.resumeGamble && vm.keyWait && vm.mem.r32(this.map.state) === 8) { this.gamble = this.resumeGamble; this.resumeGamble = null; }
      if (this.gamble && this.gamble.screen) { const g = this.gamble;
        if (vm.mem.r32(this.map.state) !== 8) { this.gambleFrom = g.amount; this.gamble = null; }   // the ROM ended the gamble (won to the limit, lost, Take Win)
        else if (g.busy && vm.keyWait) { g.busy = false; if (vm.keyWait.keys[0] !== 5 && !g.n) { this.gamble = null; this.noGamble = true; } } }   // back at the take-win prompt: no gamble screen came up, offer none again
      if (this.held) {       // free game: its reels have stopped and the ROM wants to go on; show this game's win first, then let it
        if (!this.heldShown && this.heldTask && this.heldTask.state !== 'done' && this.heldTask.state !== 'crashed' && vm.now - this.heldAt < 2500) { /* the reels are still settling */ }
        else if (!this.heldShown) { this.heldShown = true; this.snd('stop', '', { slot: 'whirr' });
          const w = this.winValue(), d = w - (this.fgTot || 0); this.fgTot = w; this.holdUntil = vm.now + (this.map.freeOwnStops ? 0 : 700);
          if (this.map.winRecords && !this.map.freeOwnStops) {   /* freeOwnStops: the ROM evaluates and flashes this game's wins itself once released (state 5): rsa_do_win_animations now would replay the PREVIOUS game's records (window and records are one game behind until then) on this game's tiles */ const I = vm.display.items, n0 = I.length, sc0 = vm.display.scenes.reduce((m, s) => Math.max(m, s.id), 0); vm.call('rsa_do_win_animations', ...(this.map.winAnim || [this.map.winRecords])); vm.runTasks(); this.animItems = I.slice(n0);
            if (this.animItems.some(c => c.visible && isCopy(c) && c.img)) {
              const reel = I.slice(0, n0).filter(o => o.visible && o.prio >= 0 && o.img);   // the ROM's own symbol copies come from its internal grid, which does not match the stops the host displayed in a free game: copy the displayed tile
              for (const c of this.animItems) { if (!isCopy(c) || !c.img) continue; const nmc = vm.db.byIndex(1, c.img)?.name || ''; if (/blank|BRI|WIN/i.test(nmc)) continue; const o = reel.find(q => q.scene === undefined && q.x === c.x && q.y === c.y) || reel.find(q => q.x === c.x && q.y === c.y); if (o) c.img = o.img; }   // the reel strip tile, not the scene backdrop under it (Arabian Nights' top-row IMG_REEL, a flat light-blue tile that would then flash on the win copies)
              this.animT0 = vm.now; this.buildWinCycle(sc0); this.holdUntil = this.animUntil; if (d > 0 && !this.winCycle.steps.some(s => s.line)) this.sayGame('Free game win ' + this.money(d) + '!');
            } else { for (const c of this.animItems) c.visible = false; this.animItems = null; } }
        }
        else if (vm.now < this.holdUntil) { /* the per-frame win cycle below blinks the tiles */ }
        else if (vm.now >= this.holdUntil) {
          if (this.animUntil) { this.animUntil = 0; this.endWinCycle(); vm.call('rsa_restore_screen'); vm.runTasks(); for (const it of this.animItems || []) it.visible = false; this.animItems = null; }
          const n = vm.mem.r32(this.map.freeCount); if (n > 0) this.sayGame(n + ' Free Game' + (n === 1 ? '' : 's') + ' Remaining');
          const w = this.held; this.held = null; this.heldShown = false; this.frames = 0; /* the 6000-frame cap counts per free game, not per feature */ this.rawSend(2, w); vm.runTasks(); }
      }
      if (this.map.freeCount) {       // free-game banner: the ROM keeps the games left in a word; the OS puts the text on the message line
        const n = vm.mem.r32(this.map.freeCount), f = this.map.freeFlag ? vm.mem.r32(this.map.freeFlag) : 1;
        if (n !== this.fgN) { const was = this.fgN | 0; this.fgN = n;
          if (n > 0) this.sayGame(was === 0 ? n + ' Free Game' + (n === 1 ? '' : 's') + ' Awarded!' : n + ' Free Game' + (n === 1 ? '' : 's') + ' Remaining');
          else if (was > 0 && f) this.sayGame('Free Games Complete'); }
      }
      if (this.winCycle) {
        const cycle = this.winCycle;
        if (cycle.steps.length > 0) {
          if (vm.now - cycle.stepT0 >= cycle.ms) {
            if (cycle.idx >= 0 && cycle.steps[cycle.idx]) {
              const prev = cycle.steps[cycle.idx];
              for (const i of prev.scene.dm || []) if (vm.display.items[i]) vm.display.items[i].visible = false;
              for (const f of prev.flash || []) { if (f[1].img === f[3] || (f[6] !== undefined && f[1].img === f[6])) f[1].img = f[2]; if (f[5]) f[1].x = f[4]; }
            }
            cycle.idx = (cycle.idx + 1) % cycle.steps.length;
            const cur = cycle.steps[cycle.idx];
            for (const i of cur.scene.dm || []) if (vm.display.items[i]) vm.display.items[i].visible = true;
            cycle.stepT0 = vm.now;
            if (cur.line) this.sayGame('Line ' + cur.line + ' Wins!');
            else this.sayGame('Win ' + this.money(this.winValue()) + '!');
          }
          const cur = cycle.steps[cycle.idx];
          if (cur && (cur.flash || cur.lamp)) {
            const t = vm.now - cycle.stepT0, P = cycle.ph || 319, on = (t >= P && t < 2 * P) || t >= 3 * P;   // blank, shown, blank, shown of one phase P each (see ms above); the line marker toggles with the symbols
            for (const l of cur.lamp || []) l.visible = on;
            // only tiles that still show the saved symbol or the blank: the ROM may redraw a tile during the feature (Double Dolphin's dives change the tiles
            // beside them), and writing the saved image back would make it alternate between the old and the new symbol
            const sky = vm.skyShowing && vm.skyShowing(); for (const f of cur.flash || []) { const b = f[6] !== undefined && !sky && /feat_blank/i.test((vm.db.byIndex(1, f[3]) || {}).name || '') ? f[6] : f[3]; if (f[1].img !== f[2] && f[1].img !== f[3] && f[1].img !== b) continue; f[1].img = on ? f[2] : b; if (f[5]) f[1].x = on ? f[4] : f[4] + f[5]; if (f[0] !== f[1]) f[0].visible = on; }   // the overlay copy of the symbol must blink too or it stays drawn over the blank tile
          }
        }
      }
      // The ROM flashes the GAMBLE lamp (key 15) from state 10, before its take-win prompt (state 8) starts the key wait; the OS takes a GAMBLE press from then on
      // (QOTN: key 15 pressed 40 ms after the win appeared opens the gamble screen). Offer the gamble at state 10 (a player only): a press is held until the prompt
      if (this.phase === 'result' && !this.fast && !this.noGamble) {
        const stt = vm.mem.r32(this.map.state), g0 = this.gamble;
        if (!g0 && stt === 10 && !vm.keyWait && this.winValue() > 0 && vm.lamps && vm.lamps[15] && (vm.lamps[15].state & 3) >= 2) this.gamble = { amount: this.winValue(), n: 0, since: vm.now, busy: false, screen: false, early: true, want: false };
        else if (g0 && g0.early && stt !== 10 && stt !== 8) this.gamble = null;   // the ROM went on without a prompt
      }
      if (this.phase === 'spinning' && this.spinTask()) this.sawSpin = true;
      if (this.phase === 'spinning' && ((!this.spinTask() && this.sawSpin) || this.frames > 600)) {
        // the ROM's spin task sends [15, 1] itself when the reels stop (the OS sends none); its task appears a frame or two after the start
        this.sawSpin = false;
        this.cur.window = this.window(); this.last = this.cur; this.phase = 'result'; this.frames = 0;
      } else if (this.phase === 'result' && vm.keyWait && vm.keyWait.keys.length > 3 && vm.mem.r32(this.map.state) === 8 && this.winValue() > 0 && !this.noGamble) {   // take-win prompt: collect or gamble (the OS plays the gamble itself, so it is played here). winValue falls back to the win meter, which the ROM has set by now: requiring map.win (3 maps of 120) would skip the prompt everywhere else
        let g = this.gamble;
        // The OS puts the ROM's "GAM Press GAMBLE()" string ("PLAY ON, GAMBLE or TAKE WIN") on message line 2 when it offers the gamble
        if (!g) { g = this.gamble = { amount: this.winValue(), n: 0, since: vm.now, busy: false, screen: false }; if (!this.fast) { const t = this.romString('GAM Press GAMBLE()'); if (t) this.messageLine(2, t); } }
        else if (g.early) { g.early = false; if (!this.fast) { const t = this.romString('GAM Press GAMBLE()'); if (t) this.messageLine(2, t); } if (g.take) { g.take = false; g.want = false; this.collect(); } else if (g.want) { g.want = false; this.gambleStart(); } }   // the prompt is up: the GAMBLE pressed at state 10 goes in now
        if (this.fast) this.collect();   // the scanner takes the win at once; a player decides (the OS keeps cycling the win until a button is pressed)
      } else if (this.phase === 'result' && vm.hotspotWait && vm.hotspotWait.mode !== 'log' && !this.fast) {
        /* a touch prompt waits for the player (touch(x, y), or a panel key it accepts: choiceKeys), as on the real machine */
      } else if (this.phase === 'result' && vm.hotspotWait && vm.hotspotWait.polls > 60) {   // fast mode, and the game-log replay polls: answer with an input the wait accepts   // touch/hotspot prompt (Corrida De Toros pick-the-winner, Touch Of Paradice dice): answer with a valid input the wait reports
        const hw = vm.hotspotWait; if (this.hsSpin !== this.cur) { this.hsSpin = this.cur; this.hsUsed = new Set(); } this.st16 = 0;
        const id = (hw.mode === 4 || hw.mode === 5 || hw.mode === 8) && hw.keys.length ? hw.keys[0] : (hw.ids.find(i => !this.hsUsed.has(i)) ?? hw.ids[0] ?? hw.keys[0]);   // hotspot modes pick distinct ids ("touch any 5 dice")
        if (id === undefined) vm.sendMessage(2, [9, 0, 0]); else { this.hsUsed.add(id); vm.sendMessage(2, [7, id, 1]); }
        hw.polls = 0; vm.runTasks();
      } else if (this.phase === 'result' && vm.keyWait && (vm.mem.r32(this.map.state) === 16 || vm.now - vm.keyWait.since > 1500) && (this.fast || (this.autoKeys && !(this.autoHuman && this.featureWait())) || !this.choiceKeys().length)) {   // only fast mode (scanner, tests), play.html's AUTO (autoKeys) or a prompt the panel has no key for answers by itself: a player presses the key (the OS waits for ever)   // the game wants a key: state 16 (feature trigger) needs immediate key 7 since vm.now is frozen while ROM blocks; other states wait 1500ms
        const st16 = vm.mem.r32(this.map.state) === 16; if (st16) this.featSeen = true; const kw = vm.keyWait.keys || [], fl = Object.keys(vm.lamps || {}).filter(n => vm.lamps[n].state === 2).map(Number),
          // the feature prompt flashes the button that starts it, whether or not the key list has it: Double Dolphin flashes Feature (key 7) and lists the idle keys;
          // the OS sends [7, 7, 1] / [7, 7, 0] when it is pressed
          // Super Bucks 5's pick assigns [16,1,2,3,4,5] and takes only 1-5 (its table at 0x80168ec): prefer a panel key (0-15) over the first listed
          k = st16 ? (fl.length === 1 ? fl[0] : kw.length && !kw.includes(7) ? (kw.includes(6) ? 6 : kw.find(x => x >= 0 && x < 16) ?? kw[0]) : 7) : (kw.length > 3 ? (kw[1] ?? 7) : kw.includes(7) && fl.includes(7) ? 7 : (kw.length > 0 ? kw[0] : 7));   /* Mr Cashman START FEATURE waits on [6,7] with both flashing: the ROM takes either, the OS starts the free games only on 7 */   /* take-win prompt without a host gamble: key 0 would start the ROM's gamble, so collect */ vm.keyWait = null;
        if (st16 && kw.length > 3 && (this.st16k = (this.st16k | 0) + 1) > 60) { this.st16k = 0; vm.sendMessage(2, [9, 0, 0]); vm.runTasks(); }   // feature prompt that only offers the idle key list (Spring Carnival): no key moves it, [9,0,0] ends the game
        else { vm.sendMessage(2, [7, k, 1]); vm.runTasks(); }
      } else if (this.phase === 'result' && !vm.keyWait && vm.mem.r32(this.map.state) > 11 && vm.mem.r32(this.map.state) !== 15 && !this.spinTask() && (this.flashKey() !== undefined || (this.fast && this.flashKey(true) !== undefined))) {   // mode 0: a choice the game asks for by flashing buttons in a feature state (Grizzly 18; not 0-11 or 15, where games flash keys during normal play, Wild Tepee); press the newest after a player's pause
        if (!this.flashSince) this.flashSince = vm.now;
        if (this.triedGame !== (this.gameNo | 0)) { this.triedGame = this.gameNo | 0; this.triedKeys = null; this.retries = 0; }   // keys tried at an earlier prompt of this spin may be the answer to this one (Pharoh's Fortune: a retrigger in the free games flashes 6 and 7 again; with both already tried the series would park and be aborted)
        // the player picks with the flashing panel buttons (play.html: pressKey); only the scanner (fast) picks for itself
        // a key that did nothing: after 3 s with no lamp change try another flashing key once (flashKey(true))
        if (this.fast && vm.now - this.flashSince >= 80) { const k = this.flashKey(); if (k !== undefined) this.pressKey(k); else if (vm.now - this.flashSince >= 3000) { this.retries = (this.retries | 0) + 1; this.pressKey(this.flashKey(true)); } }
      } else if (this.phase === 'result' && vm.mem.r32(this.map.state) === 6 && vm.tasks[0].state === 'waiting' && !vm.keyWait && this.frames > 5 && !(vm.live || []).some(t => t.name === 'win_inc' && t.state !== 'done')) {   // collect animation over: let the game carry on
        if (this.inFree && this.stF < 6000 && (this.held || (this.map.freeCount && vm.mem.r32(this.map.freeCount) > 0) || (vm.live || []).some(t => t.name === 'API_spin' && t.state !== 'done' && t.state !== 'crashed' && t.ctx))) return true;
        // a spin task still running means the reels are still turning, free series or not: its own [15, 1] ends the game. Wild Ways and Ruby Magic (no free-game counter found,
        // so inFree stays false) spin free games in state 6; sending [15, 1] at once would end each one before its reels turn, the spin tasks would pile up and the series would stall in state 5
        if (this.stF < 6000 && (vm.live || []).some(t => t.name === 'API_spin' && t.state !== 'done' && t.state !== 'crashed' && t.ctx)) return true;       // a free game continues by itself once its reels stop (see the held message in frame()); the frame cap releases a mis-discovered freeCount
        if (!this.inFree && !this.fgRestored && ((this.map.freeCount && vm.mem.r32(this.map.freeCount) > 0) || this.featSeen)) { this.featSeen = false; this.fgRestored = true; vm.call('rsa_restore_screen'); vm.runTasks(); this.show(this.last.stops); vm.runTasks(); }   // the feature intro cleared the reels: put them back before the first free game
        vm.sendMessage(2, [15, 1, 0]); vm.runTasks();
      } else if (this.phase === 'result' && !vm.keyWait && [7, 8].includes(vm.mem.r32(this.map.state)) && vm.tasks[0].state === 'waiting' && !this.held && (vm.live || []).some(t => t.name === 'API_spin' && t.state === 'suspended') && (this.stuckSpin = (this.stuckSpin | 0) + 1) > 300) {   // free game parked while its spin task sleeps on a stop signal nobody sends (Amazon Queen, Indian Princess): wake the spin task
        this.stuckSpin = 0; const ps = vm.mem.r32(this.map.state) + ':' + (this.gameNo | 0); this.parkWakes = ps === this.parkAt ? this.parkWakes + 1 : 1; this.parkAt = ps;
        if (this.parkWakes > 3) { this.parkWakes = 0; vm.sendMessage(2, [9, 0, 0]); vm.runTasks(); for (let i = 0; i < 200; i++) vm.frame(); this.reapSpinTasks(); }   // waking the spin task did not help (it suspends again, Amazon Queen): end the game as the OS's abort path would
        else { for (const t of vm.live) if (t.name === 'API_spin' && t.state === 'suspended') t.state = 'ready'; vm.runTasks(); }
      } else if (this.phase === 'result' && !vm.keyWait && vm.mem.r32(this.map.state) === 16 && vm.tasks[0].state === 'ready' && !this.held && !this.spinTask() && (this.st16b = (this.st16b | 0) + 1) > 300) {   // feature prompt the game polls for a touch hotspot in a busy loop (Touch Of Paradice: gmc_key_hotspot_wrapper/gos_open/gos_close, no key wait; very slow frames): end the game
        this.st16b = 0; vm.sendMessage(2, [9, 0, 0]); vm.runTasks();
      } else if (this.phase === 'result' && !vm.keyWait && ![0, 5, 6, 7, 8, 9, 10, 16].includes(vm.mem.r32(this.map.state)) && vm.tasks[0].state === 'ready' && !this.held && (this.st18 = (this.st18 | 0) + 1) > 600) {   // game task busy-looping ~10 s in one state the host does not know (Grizzly state 18, rare, random): same abort message as below. A limit of 10 frames would cut Golden Archer Jackpot's busy jackpot states (55-70) short and the forced state 0 would leave its dispatch loop spinning for ever
        this.st18 = 0; if ((this.st18n = (this.st18n | 0) + 1) > 1) { this.st18n = 0; vm.mem.w32(this.map.state, 0); } else { vm.sendMessage(2, [9, 0, 0]); vm.runTasks(); }   // abort did not recover it: force idle
      } else if (this.phase === 'result' && !vm.keyWait && vm.mem.r32(this.map.state) !== 0 && (vm.mem.r32(this.map.state) !== 8 || (this.st8 = (this.st8 | 0) + 1) > 1200) && ['waiting', 'sleeping'].includes(vm.tasks[0].state) && (!this.spinTask() || vm.mem.r32(this.map.state) === 8) && !this.held && (this.waitingOnScene() || this.othersWorking() || this.winMoving() || this.freeCountUp() || this.winIncCounting() || this.humanWaiting() ? (this.st16 = 0, false) : true) && (this.st16 = (this.st16 | 0) + 1) > 400) {   // not while a playing scene still has its end callback due (Touch Of Paradice dice reveals: the Game task waits for the callback's [15,3])   // game parked in a state that waits for a message the host cannot supply (Alchemy feature trigger, King Of The Nile free game): message type 9 makes the ROM abandon it and return to idle, so the next game starts clean
        // before giving up: one key alone flashing (lamp state 2, or 3 as Big Hearted's START FEATURE key 7 in state 9) since this game began is the
        // prompt the game waits on without a key wait; press it once
        this.st16 = 0; const solo = this.soloLamp(), tag = (this.gameNo | 0) + ':' + solo;
        if (solo !== undefined && this.soloPressed !== tag) { this.soloPressed = tag; vm.sendMessage(2, [7, solo, 1]); vm.runTasks(); }
        else { vm.sendMessage(2, [9, 0, 0]); vm.runTasks(); }
      } else if (this.phase === 'result' && !this.gamble && (this.idle() || this.frames > 30000 || this.busyIdle()) && !(this.animUntil && !this.fast && vm.now < this.animUntil)) {
        const fgEnd = (this.gameNo | 0) > (this.cleanGame | 0);
        if (this.winCycle) {
          const cur = this.winCycle.steps[this.winCycle.idx];
          if (cur) {
            for (const i of cur.scene.dm || []) if (vm.display.items[i]) vm.display.items[i].visible = false;
            for (const f of cur.flash || []) { if (f[1].img === f[3] || (f[6] !== undefined && f[1].img === f[6])) f[1].img = f[2]; if (f[5]) f[1].x = f[4]; }
          }
          this.winCycle = null;
        }
        if (this.animUntil || fgEnd) { this.animUntil = 0; vm.call('rsa_restore_screen'); vm.runTasks(); }
        // (no api_indicators_off / rsa_playline_init here: the OS never calls them at game end. rsa_playline_init destroys the 20 line boxes (op 3) and api_indicators_off
        // rebuilds them dimmed (op 5), and a win that hid one box (sideCount below sideBase) would fire it: the numbers would go dim after the game, the real machine keeps them bright)
        if (fgEnd) { this.cleanGame = this.gameNo; this.sayGame('Free Games Won ' + this.money(this.winValue()) + '!'); }
        if (this.inFree) this.last.featureWin = this.winValue() - (this.fgBase | 0);
        this.inFree = false; this.phase = null; this.stops = this.last.stops; this.last.win = this.winValue();
        // a game the host ended itself ([9, 0, 0] from a watchdog, or a feature that went idle) never reached gmc_at_end_of_game: its log entry stays open
        // and a reload at idle would resume it as a game in progress, reels spinning (Pompei, 5 Dragons, Mystic Mermaid after free games). Back at idle it is over
        { const L = vm.gameLog, e = L && L[L.length - 1]; if (e && !e.done && !vm.replay && vm.mem.r32(this.map.state) === 0) { e.done = true; e.hostEnd = true; e.end = [...vm.meters]; } }
        // progressive jackpots the ROM won (game2sys request 5): it pays them straight onto its credit meter, which the host does not read, so they are
        // added here, part of this game's win (Outback Jack's card game: Major / Minor). Cents not worth a whole credit carry over to the next one
        const jp = (vm.jackpotsHit || []).splice(0); if (jp.length) { const d = vm.options.denom || 1, c = jp.reduce((t, j) => t + j.cents, 0) + (this.jpDust | 0);
          this.last.jackpot = Math.floor(c / d); this.jpDust = c - this.last.jackpot * d; this.last.jackpots = jp; this.last.win += this.last.jackpot; }
        if (this.gambleFrom !== undefined) { this.gambleNet = (this.gambleNet | 0) + this.last.win - this.gambleFrom; this.gambleFrom = undefined; }
        this.credits = this.before - this.last.cost + this.last.win; this.panel(this.credits, this.last.cost, this.last.win);
      }
      return !!this.phase;
    }
  }
  // host fields a save keeps (Host.saved / resume)
  const SAVED = ['credits', 'lines', 'bet', 'phase', 'cur', 'last', 'before', 'stops', 'lastCost', 'winBefore', 'gameNo', 'cleanGame', 'inFree', 'fgTot', 'fgBase', 'featSeen', 'gamble', 'noGamble', 'gambleFrom', 'gambleNet', 'gambles', 'jpDust', 'lampsIdle'];
  const api = { Host };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6HOST = api;
})(typeof window !== 'undefined' ? window : globalThis);
