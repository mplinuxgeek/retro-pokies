// Host for the touch-screen multi-game ROMs (Players Choice By Demand / Favourites, Cashman Tonight): what the machine OS does for them.
// Unlike the reel games driven by mk6host.js, these ROMs run the whole game themselves: the OS only forwards touches and answers messages.
// Behaviour of the touch machines:
//   boot     power-up init (on_powerup_game_log / on_powerup_game_init instead of gam_init), game port [8,1,1] + [9,0,0], on_machine_event(0x40, 0),
//            the engine init again, [8,1,1]; each [10] (game over) from the ROM is answered [8,1,1] once and then on_machine_event(0xc, credit)
//   touch    the touch device hit-tests the display (vm.touchAt) and the OS posts [0x1d, code, 0] to the game port; panel Play is code 0x1e
//   menu     game tiles 0x64, 0xc8, 0x12c, 0x190; denominations tile + 1.. ; confirm 0x384 (Cashman Tonight)
//   in game  lines 0x21..0x25, bet per line 0x26..0x29 (the OS draws these buttons itself, the ROM only lists them with enable_button_map)
//   spin     ROM [8,0,0] -> OS [8,0,0]; ROM [10,0,0] -> OS [9,0,0], then on_machine_event(0xc, credit)
//   meters   acc meters are OS system variables: 0 = credit (cents, the ROM takes the bet and adds the win itself), 0x14 = turnover
(function (root) {
  'use strict';
  const PLAY = 0x1e, LINES = [0x21, 0x22, 0x23, 0x24, 0x25], BETS = [0x26, 0x27, 0x28, 0x29], CONFIRM = 0x384, TURNOVER = 0x14;
  // OS panel buttons by driver slot (get_driver_id): Collect 0x3f1, Reserve 0x3f0, Game Rules 0xc, Game Menu 0x20, Gamble 0x3fb, Take Win 0x3e9, Play 0x1e
  const TAKE_WIN = 0x3e9, NEVER = new Set([0x3f1, 0x3f0, 0xc, 0x20, 0x3fb, 0x2a, ...LINES, ...BETS]);

  class TouchHost {
    constructor(vm, opts = {}) {
      this.vm = vm; this.opts = opts; this.credits = opts.credits === undefined ? 100000 : opts.credits;   // cents
      this.phase = null; this.last = null; this.gameNo = 0; this.frames = 0;
      this.idleFrames = 12000;   // scan-core's parked rule: the whole game sits in phase 2 here, and a Mr Cashman feature runs about 7200 frames
      this.stateAddr = vm.alloc(4); this.map = Object.assign({}, opts.map || {}, { state: this.stateAddr });   // runSpin watches map.state: the host writes its phase there
    }
    call(n, ...a) { try { return this.vm.call(n, ...a); } catch (e) { this.vm.note('touch host: ' + n + ' ' + e.message); return 0; } }
    setPhase(p) { this.phaseNo = p; this.vm.mem.w32(this.stateAddr, p); }
    // ROM -> OS messages (vm.outbox: msg_send to the mmc port) answered as the OS does
    pump() {
      const vm = this.vm, ob = vm.outbox || []; vm.outbox = [];
      for (const { port, words } of ob) {
        (this.osLog = this.osLog || []).push(port + ':' + words.map(w => (w >>> 0).toString(16)).join(',')); if (this.osLog.length > 24) this.osLog.shift();   // recent ROM -> OS traffic, for diagnosis
        if (port !== 1) continue;
        if (words[0] === 8) { vm.sendMessage(2, [8, words[1], words[2]]); if (this.phase === 'starting') { this.phase = 'spinning'; this.setPhase(2); } }
        else if (words[0] === 10) {
          if (this.booting && !this.bootAck) { this.bootAck = true; vm.sendMessage(2, [8, 1, 1]); continue; }
          vm.sendMessage(2, [9, 0, 0]); this.gameOver = true;
        }
      }
    }
    step(n = 1) { for (let i = 0; i < n; i++) { this.vm.frame(); this.pump(); if (this.gameOver) { this.gameOver = false; this.vm.runTasks(); this.pump(); this.machineEvent(); if (this.onGameOver) this.onGameOver(); if (this.phase === 'spinning') this.finish(); } } }
    machineEvent() { this.call('on_machine_event', 0xc, this.vm.meters.get(0) | 0); }
    // a progressive level starts at the ROM's own start value (level table, Get_Data_From_Game_sys2game 5: start, rate, reserve rate per level): Cashman Tonight's Major and
    // Minor would show $0.00 on a fresh machine (the cabinet Host does the same in seedJackpots). Meters 0x95 + 2 * level; a level that already has a value is left alone
    seedJackpots() {
      const vm = this.vm; let n = 0, recs = 0;
      try { n = vm.call('get_progressive_levels') | 0; recs = vm.call('Get_Data_From_Game_sys2game', 5, 0, 0, 0) >>> 0; } catch (e) { return; }
      if (n < 1 || n > 4 || recs < 0x8000000 || recs >= 0xc000000) return;
      for (let i = 0; i < n; i++) { const id = 0x95 + 2 * i, start = vm.mem.r32(recs + 12 * i) | 0; if (start > 0 && !(vm.meters.get(id) | 0)) vm.meters.set(id, start); }
    }
    send(code) { this.vm.sendMessage(2, [0x1d, code, 0]); this.step(1); this.seedJackpots(); }
    key(code) { this.vm.sendMessage(2, [7, code, 1]); this.step(2); this.vm.sendMessage(2, [7, code, 0]); this.step(1); }   // during a game the OS forwards a button as key down / up, not as a touch
    tap(x, y) { const vm = this.vm, code = vm.touchAt(x, y); if (code > 0 && vm.touchEnabled(code)) { this.send(code); return code; } return -1; }
    enabledCodes() {   // the ROM's current enable_button_map list ({code, flags} pairs, flags & 1)
      const vm = this.vm, out = []; let a = vm.buttonMap >>> 0; if (!a) return out;
      for (let k = 0; k < 512; k++, a += 8) { const c = vm.mem.r32(a) | 0; if (c === -1) break; if (vm.mem.r32(a + 4) & 1) out.push(c); }
      return out;
    }
    init() {
      this.vm.windowPrio = true;   // windows are display items with the priority _createwin was given: the menu overlay hides the game's paytable text
      this.vm.labelsOnTop = !!this.map.labelsOnTop;   // map.labelsOnTop: a scene's labels are drawn over its own button art (Cashman Tonight's denomination text; see mk6render)
      this.vm.options.touchButtons = true;   // the ROM's own physical-button record (see acc_get_physical_button_ptr)
      if (!this.vm.options.centsPerToken) this.vm.options.centsPerToken = 100;   // the touch machine's token is $1 (Cashman Tonight's 1c game says "$1 = 100 Credits"; the cabinet default 10000 would give "$100 = 10000 Credits")
      // map.meterSeed {id: value}: NV meters a fresh machine must not leave at 0. Cashman Tonight keeps a game log in meters 0x1815..0x8d43 with its
      // write pointer in 0x180a..0x180c (by page, 0x1809); at 0 the log runs from meter 0 up over the credits and the jackpot levels 0x95 / 0x97, and the
      // Grand / Major hit (about $200 of turnover) then waits on a level of a few cents for ever
      for (const [id, v] of Object.entries(this.map.meterSeed || {})) if (!(this.vm.meters.get(+id) | 0)) this.vm.meters.set(+id, v);
      this.seedJackpots();
      const vm = this.vm; vm.meters.set(0, this.credits);   // (vm.hostLoop stays on: the ROM's own messages to the game port, scene events [15,x], must reach it)
      for (const q of [0x19, 0x17, 0x1c]) this.call('Get_Data_From_Game_sys2game', q, 0, 0, 0);
      const engine = () => { this.call('get_token_credit'); this.call('get_token_credit'); this.call('set_default_line_bet'); this.call('set_game_key_butttons', 1); this.call('rsa_playline_init'); this.call('playline_offsets_init'); this.call('prvrn_init', 0, 0); this.call('combination_init', 1); };
      engine(); this.call('Get_Data_From_Game_sys2game', 1, 0, 0, 0); this.call('video_game_setup'); this.call('on_powerup_game_log');
      this.call('get_gam_specific_str', 0); this.call('get_gam_specific_str', 1); this.call('on_powerup_game_init'); vm.runTasks();
      this.booting = true; vm.sendMessage(2, [8, 1, 1]); vm.sendMessage(2, [9, 0, 0]); this.step(1); this.call('on_machine_event', 0x40, 0); this.step(120);
      this.call('get_first_valid_line'); this.call('get_first_valid_bet'); engine(); this.call('clear_hopper_payout_mes'); this.call('api_init_increment_rate'); this.call('display_clear_screen');
      vm.sendMessage(2, [8, 1, 1]); this.step(30); this.booting = false; this.machineEvent(); this.step(200);
      // Players Choice: the first game after a fresh start runs the ROM's memory reset, which clears the credit (and meters) it holds: play it here, out of sight, on game 0
      // and go back to the menu, then give the player's credit back (otherwise the first game the player starts loses the credit and shows as a loss)
      if (this.opts.menu && this.map.memReset) {
        const keep = this.credits; this.select(0, 0); this.setLines(-1); this.setBet(0);
        if (this.spin()) { for (let i = 0; i < 20000 && this.frame(); i++); }
        this.gameNo = 0; this.last = null;
        for (let k = 0; k < 4 && this.enabledCodes().includes(PLAY); k++) { this.send(0x20); this.step(120); }
        vm.meters.set(0, keep); this.credits = keep; this.machineEvent(); this.step(60);
      }
      if (this.opts.menu) { if (vm.msgFooter) vm.msgFooter('Memory Reset'); this.setPhase(0); return; }   // play.html: stay on the game menu, the player picks by touch
      this.select(this.opts.game | 0, this.opts.denom | 0);
      this.setLines(this.opts.lines === undefined ? -1 : this.opts.lines); this.setBet(this.opts.bet === undefined ? 0 : this.opts.bet);
      this.setPhase(0);
      // the first game after a fresh start runs the ROM's memory reset (meters cleared, the turnover one included): play it here so spins count from the next one
      if (this.spin()) { for (let i = 0; i < 20000 && this.frame(); i++); this.gameNo = 0; this.last = null; }
    }
    // pick game n (0..3) on the menu with its denomination d (Cashman Tonight then asks to confirm). The denomination buttons are the codes just
    // above the tile's (tile + 1.. on By Demand / Cashman, tile + 2.. on Favourites); a code that is listed but has no button does nothing, so
    // the candidates are tried until the game screen (Play enabled) is up: those with a touch box on screen first.
    select(n, d) {
      const tile = 100 * (n + 1), codes = this.enabledCodes(), boxes = new Set(this.vm.touchBoxes().map(b => b.code));
      let denoms = codes.filter(c => c > tile && c < tile + 10).sort((a, b) => a - b); const shown = denoms.filter(c => boxes.has(c)); if (shown.length) denoms = shown.concat(denoms.filter(c => !boxes.has(c)));
      if (this.opts.debug) console.log('menu codes', codes.map(c => c.toString(16)).join(','), 'boxes', [...boxes].map(c => c.toString(16)).join(','));
      const inGame = () => this.enabledCodes().includes(PLAY);
      for (const code of [denoms[Math.min(d, denoms.length - 1)], ...denoms, tile].filter(c => c)) {
        this.send(code); this.step(60);
        if (!inGame() && this.enabledCodes().includes(CONFIRM)) { this.send(CONFIRM); this.step(60); }
        if (inGame()) break;
      }
      this.step(240); this.game = n;
    }
    pick(list, i) { const on = this.enabledCodes().filter(c => list.includes(c)), all = on.length ? on : list; return all[i < 0 ? all.length - 1 : Math.min(i, all.length - 1)]; }
    setLines(i) { this.send(this.pick(LINES, i)); this.step(30); }      // index into the line buttons, -1 = most lines
    setBet(i) { this.send(this.pick(BETS, i)); this.step(30); }         // index into the bet-per-line buttons
    spin() {
      const vm = this.vm; if (this.phase) return null;
      vm.meters.set(0, this.credits); this.machineEvent(); this.step(1);
      this.c0 = vm.meters.get(0) | 0; this.t0 = vm.meters.get(TURNOVER) | 0;
      this.phase = 'starting'; this.frames = 0; this.hold = this.quiet = 0; this.setPhase(1); this.send(PLAY);
      this.cur = { cost: 0, win: 0 }; return this.cur;
    }
    finish() {
      const vm = this.vm, cost = (vm.meters.get(TURNOVER) | 0) - this.t0, win = (vm.meters.get(0) | 0) - this.c0 + cost;
      this.credits = vm.meters.get(0) | 0; this.last = { cost, win }; this.cur = null; this.phase = null; this.gameNo++; this.setPhase(0);
    }
    // one display frame; false when the spin is over. A game that never starts (Play refused: no credit, a menu or prompt up) is retried with
    // Play every 2 s, which also starts features that wait for a touch.
    frame() {
      if (!this.phase) { this.step(1); return false; }
      this.step(1); this.frames++;
      if (this.phase === 'starting' && this.frames % 120 === 0) this.send(PLAY);
      if (this.phase === 'spinning' && this.frames > 300 && this.frames % 90 === 0 && !(this.frames < this.hold)) this.prompt();
      return !!this.phase;
    }
    // a game that has started but does not end is waiting for the player: a feature pick (any code outside the panel set, e.g. Cashman
    // Tonight's 0xfa1..0xfa4), else Take Win, else Play. Collect, Game Menu, Gamble and the bet buttons are never pressed.
    prompt() {
      const on = this.enabledCodes(), pick = on.filter(c => !NEVER.has(c) && c !== PLAY && c !== TAKE_WIN && c !== 0x3f9), n = this.prompts = (this.prompts | 0) + 1;
      // picks listed with Play on and none of them on screen (Cashman Tonight's Mr Cashman bonus, 0x1389..0x1391): the ROM takes 6 picks (a key press then a touch; it counts
      // them down at 0xcf2b030) and then waits for Play, pressed as a key, while the list stays the same. Without Play it parks every third prompt
      if (pick.length && n % 3 === 0 && on.includes(PLAY)) { const boxes = new Set(this.vm.touchBoxes().map(b => b.code)); if (!pick.some(c => boxes.has(c))) { this.key(PLAY); return; } }
      // picks listed with Play off and none on screen (Cashman Tonight's 0xfa1..0xfa4, 0x1005, 0x1006 after a bonus): each key press is one pick, queued and
      // shown for about 420 frames (picks left count down at 0xcf2b144); touches are ignored and 0x1006 does nothing. Press keys only, 300 frames apart
      if (pick.length && !on.includes(PLAY) && !this.vm.touchBoxes().some(b => pick.includes(b.code))) { this.key(pick[this.quiet++ % pick.length]); this.hold = this.frames + 300; return; }
      if (pick.length) { const c = pick[(n >> 1) % pick.length]; if (n & 1) this.key(c); else this.send(c); return; }   // a pick is a touch on screen: try it as a touch and as a key
      this.key(on.includes(TAKE_WIN) && n % 2 ? TAKE_WIN : on.includes(0x3f9) && n % 3 === 0 ? 0x3f9 : PLAY);
    }
    idle() { return !this.phase; }
  }
  const api = { TouchHost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6TOUCHHOST = api;
})(typeof window !== 'undefined' ? window : globalThis);
