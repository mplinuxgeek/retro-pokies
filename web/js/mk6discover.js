// Per-game address discovery (state variable, stop buffer, reel table, spin starter, win total, config indices, cabinet keys) by static + dynamic analysis of a ROM.
// Runs in node (emu/discover.js) and in the browser (the launcher's ROM scan, inside a worker): discover(rom, log, want) -> the map web/maps/<id>.json holds.
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const MK6 = isNode ? require('./mk6.js') : root.MK6, { VM } = isNode ? require('./mk6vm.js') : root.MK6VM, { Host } = isNode ? require('./mk6host.js') : root.MK6HOST;
  const T = isNode ? require('./mk6tables.js') : root.MK6TABLES, EXPORTS = T.exports, SYSCALLS = T.syscalls, hx = v => (v >>> 0).toString(16);
// constants loaded pc-relative in the first instructions of an export (export wrappers are 12-byte jumps through a literal)
function exportAddr(A, i) { const V = new DataView(A.buffer, A.byteOffset, A.byteLength), w = 0x100 + 12 * i, op = V.getUint16(w, true); return (op & 0xff00) === 0xd000 ? V.getUint32((w + 4 + ((op & 255) << 2)) & ~3, true) : 0x08000000 + w; }
function poolConsts(A, i, n = 120) {
  const V = new DataView(A.buffer, A.byteOffset, A.byteLength), fn = exportAddr(A, i);
  const o = fn - 0x08000000, out = [];
  for (let k = 0; k < n; k++) { const q = V.getUint16(o + 2 * k, true); if ((q & 0xf000) === 0xd000) out.push(V.getUint32((o + 2 * k + 4 + ((q & 255) << 2)) & ~3, true)); }
  return out;
}
const inShared = c => (c >>> 20) === 0xcf;
const mkvm = (rom, li = 1, bi = 0) => new VM(rom, { syscalls: SYSCALLS, exports: EXPORTS, options: { lineIdx: li, betIdx: bi } });

async function discover(rom, log = () => {}, want = {}) {
  const A = rom.A, map = {};
  const gs = poolConsts(A, EXPORTS.indexOf('get_game_state')), sr = poolConsts(A, EXPORTS.indexOf('gam_Set_reel_pos'));
  map.state = gs.find(inShared); map.stopBuf = sr.find(inShared); map.lineBets = sr.filter(inShared)[1];
  log('state', hx(map.state), 'stopBuf', hx(map.stopBuf), 'lineBets', hx(map.lineBets));

  // only configurations the ROM really has (prvrn_init copies the variant rows into RAM) are valid: they populate the most shared RAM
  const populated = (li, bi) => { try { const vm = new VM(rom, { syscalls: SYSCALLS, exports: EXPORTS, options: { lineIdx: li, betIdx: bi } }); vm.meters.set(0, 1e5);
      try { vm.call('set_game_key_butttons', 1); } catch (e) { vm.call('set_default_line_bet'); }
      for (const [f, ...a] of [['set_game_key_butttons', 1], ['rsa_playline_init'], ['playline_offsets_init'], ['prvrn_init', li, bi], ['combination_init', 1]]) vm.call(f, ...a);
      let n = 0; for (let a = 0xcf00000; a < 0xcf10000; a += 4) if (vm.mem.r32(a)) n++; return n; } catch (e) { return -1; } };
  const pop = {}; let maxPop = 0; for (let li = 0; li < 8; li++) for (let bi = 0; bi < 8; bi++) { pop[li + ',' + bi] = populated(li, bi); maxPop = Math.max(maxPop, pop[li + ',' + bi]); }
  let cfg0 = [1, 0]; for (let li = 0; li < 8; li++) for (let bi = 0; bi < 8; bi++) if (pop[li + ',' + bi] === maxPop && cfg0[2] === undefined) cfg0 = [li, bi, 1];   // first valid configuration, for the steps that run before the config search
  // spin starter: the function that creates the reel task (entry = its prologue: register pushes, then sts.l pr)
  { const vm = mkvm(rom, cfg0[0], cfg0[1]), h = new Host(vm, { map: Object.assign({}, map, { starter: 0, window: 0 }) }); h.init(cfg0[0], cfg0[1], 1);
    let pr = 0; const o = vm.impl.gos_create; vm.impl.gos_create = function (c, e, n, p, a) { if (!pr && /spin/i.test(vm.cstr(n))) pr = c.pr >>> 0; return o.call(this, c, e, n, p, a); };
    const V = new DataView(A.buffer, A.byteOffset, A.byteLength); h.credits = 100000; h.lines = 1; h.bet = 1;
    for (const [b, l] of [[14, 1]]) { /* start a game; keys are irrelevant here */ }
    vm.sendMessage(2, [8, 1, 1]); vm.runTasks(); map.assigned = vm.assigned ? [...vm.assigned] : []; log('assigned keys', map.assigned.join(','));
    if (pr) { let a = pr - 0x08000000; while (a > 0 && V.getUint16(a, true) !== 0x4f22) a -= 2;   // prologue: sts.l pr,@-r15 (the creator calls, so it saves pr); a literal pool can sit right before the entry, so an rts walk-back lands inside it
      while (a > 0 && (V.getUint16(a - 2, true) & 0xff0f) === 0x2f06) a -= 2;   // preceding mov.l rN,@-r15 register pushes belong to the prologue
      map.starter = a + 0x08000000; log('starter', hx(map.starter), 'created from', hx(pr)); } else log('no spin task created');
  }
  // configuration + cabinet keys: the ROM picks its line/bet option sets by two configuration indices (acc_get_num_lines/bets); try each pair, press keys 1..20
  // after a game start and watch the line-bet array (leading equal non-zero entries = lines, first entry = bet per line): a key that changes the line count is a line key, one that changes the bet a bet key
  const scan = (li, bi) => {
    const vm = new VM(rom, { syscalls: SYSCALLS, exports: EXPORTS, options: { lineIdx: li, betIdx: bi } }), h = new Host(vm, { map: Object.assign({}, map, { window: 0 }) }); h.init(li, bi, 1); vm.meters.set(0, 1e6); h.credits = 1e6;
    for (let g = 0; g < 2; g++) { if (!h.spin()) break; for (let k = 0; h.phase && k < 40000; k++) h.frame(); }   // some games only assign their cabinet keys at the end of a game
    vm.sendMessage(2, [8, 1, 1]); vm.runTasks(); const lineKeys = {}, betKeys = {};
    const read = () => { const arr = [...Array(60)].map((_, i) => vm.mem.r32(map.lineBets + 4 * i)); let n = 0; while (n < 60 && arr[n] === arr[0] && arr[0] > 0) n++; return { n, bet: n ? arr[0] : 0 }; };
    const press = k => { vm.call('gam_process_player_command', k, 1, 0); return read(); };
    // MK6 cabinet layout: line keys 1..5, bet keys 10..14. A bet key first, then a line key (some games ignore a key pressed alone); the line-bet array then shows lines and bet
    // some panels put bet keys in the line positions (Koala Mint at its default config: five bet keys, no line keys, each starts a 1-line game at its own
    // bet). Press keys 1..5 alone, up and down: one that changes the bet while the line count stays is a bet key, not a line key
    const betAt = {}; let prev = read(); for (const l of [1, 2, 3, 4, 5, 5, 4, 3, 2, 1]) { const r = press(l); if (prev.n && r.n === prev.n && r.bet !== prev.bet) betAt[l] = r.bet; prev = r; }
    for (let b = 10; b <= 14; b++) for (let l = 1; l <= 5; l++) { press(b); const r = press(l); if (!r.n) continue; if (betAt[l]) { betKeys[betAt[l]] = betKeys[betAt[l]] || l; continue; } betKeys[r.bet] = betKeys[r.bet] || b; lineKeys[r.n] = lineKeys[r.n] || l; }
    // with the bet keys in the line positions the game has no line key; the host still presses one per game, so give it a key the ROM ignores (one of the unused bet positions)
    if (!Object.keys(lineKeys).length && Object.keys(betKeys).length) { const r0 = read(); for (let b = 10; b <= 14 && r0.n; b++) { const r = press(b); if (r.n === r0.n && r.bet === r0.bet) { lineKeys[r0.n] = b; break; } } }
    for (const [n, k] of Object.entries(lineKeys)) for (const [n2, k2] of Object.entries(lineKeys)) if (k === k2 && +n2 > +n) delete lineKeys[n2];   // the array can spill past the last line: one count per key (the smallest)
    return { lineKeys, betKeys };
  };
  // a variant whose evaluation tables were never copied into RAM plays but never pays: require at least one win in a short random run
  const winProbe = (li, bi, r) => { try { const vm = new VM(rom, { syscalls: SYSCALLS, exports: EXPORTS, options: { lineIdx: li, betIdx: bi } }), ks = Object.keys(r.lineKeys).map(Number), bs = Object.keys(r.betKeys).map(Number);
      const h = new Host(vm, { map: Object.assign({}, map, { window: 0, lineIdx: li, betIdx: bi, lineKeys: r.lineKeys, betKeys: r.betKeys }), lines: Math.max(...ks), bet: bs.length ? Math.min(...bs) : 1 }); h.init(li, bi, 1);
      for (let g = 0; g < 40; g++) { h.credits = 1e5; if (!h.spin()) return 0; for (let k = 0; h.phase && k < 40000; k++) { h.frame(); const s = vm.mem.r32(map.state); if (s === 9 || s === 10 || s === 8) return 1; } } return 0; } catch (e) { return 0; } };
  { let best = null, all = null;
    // the line-bet array is the 2nd shared constant of gam_Set_reel_pos in most ROMs; when no key moves it, try the other shared constants
    const cands = [map.lineBets, ...sr.filter(inShared).filter(c => c !== map.lineBets && c !== map.stopBuf), ...gs.filter(inShared).filter(c => c !== map.state)];
    for (const cand of cands) { map.lineBets = cand; best = null;   // a real array reacts to several keys; one fixed value (a reel length) is a false hit
    // want.config [li, bi]: only that configuration (the default)
    for (let li = 0; li < 8; li++) for (let bi = 0; bi < 8; bi++) { if (want.config && (li !== want.config[0] || bi !== want.config[1])) continue; if (!want.config && pop[li + ',' + bi] < maxPop * 0.9) continue; let r; try { r = scan(li, bi); } catch (e) { log('config', li, bi, 'error', e.message.slice(0, 80)); continue; } log('config', li, bi, JSON.stringify(r.lineKeys), JSON.stringify(r.betKeys)); const mx = Math.max(0, ...Object.keys(r.lineKeys).map(Number)); const mb = Math.max(0, ...Object.keys(r.betKeys).map(Number)); const won = Object.keys(r.lineKeys).length ? winProbe(li, bi, r) : 0; const score = (won ? 2e4 : 0) + (want.lines && mx === want.lines ? 1e4 : 0) + (want.bet && mb === want.bet ? 5e3 : 0) + Object.keys(r.lineKeys).length * 100 + Object.keys(r.betKeys).length * 10 + Math.max(0, ...Object.keys(r.lineKeys).map(Number)) / 100; if (!best || score > best.score) best = Object.assign(r, { score, li, bi }); }
    if (best && Object.keys(best.lineKeys).length && (!all || best.score > all.score)) all = Object.assign(best, { cand });
    if (best && Object.keys(best.lineKeys).length > 1) break; }
    if (all && !(best && Object.keys(best.lineKeys).length > 1)) { best = all; map.lineBets = all.cand; }
    if (!best) best = { li: cfg0[0], bi: cfg0[1], lineKeys: {}, betKeys: {} };
    if (!Object.keys(best.betKeys).length) best.betKeys = { 1: 14 };
    Object.assign(map, { lineIdx: best.li, betIdx: best.bi, lineKeys: best.lineKeys, betKeys: best.betKeys });
    log('config lineIdx', best.li, 'betIdx', best.bi, 'lineKeys', JSON.stringify(map.lineKeys), 'betKeys', JSON.stringify(map.betKeys));
  }
  // reel table: five {length, strip pointer, ...} records of 12 bytes in shared RAM, discovered with the game's valid config
  { const vm = mkvm(rom, map.lineIdx, map.betIdx), h = new Host(vm, { map: Object.assign({}, map, { starter: 0, reels: 0, window: 0 }) }); try { h.init(map.lineIdx, map.betIdx, 1); } catch (e) { log('init with unknown reels:', e.message); }
    const m = vm.mem; let found = [];
    for (let a = 0xcf00000; a < 0xcf0ff00; a += 4) { let ok = true; for (let i = 0; i < 5 && ok; i++) { const len = m.r32(a + 12 * i), p = m.r32(a + 12 * i + 4); ok = len >= 8 && len <= 400 && (p >>> 24) === 0x08; } if (ok) found.push(a); }
    if (!found.length) {                                  // games that keep the strips in ROM: a RAM word points at five {length, strip pointer, ...} records
      const ok = a => { for (let i = 0; i < 5; i++) { const len = m.r32(a + 12 * i), p = m.r32(a + 12 * i + 4); if (!(len >= 8 && len <= 400 && (p >>> 24) === 0x08)) return false; } return true; };
      for (let a = 0xcf00000; a < 0xcf0ff00 && !found.length; a += 4) { const p = m.r32(a); if ((p >>> 24) === 0x08 && (p >>> 0) < 0x08800000 - 80 && ok(p)) found.push(p); }
    }
    if (!found.length) { const V = new DataView(A.buffer, A.byteOffset, A.byteLength), { names } = MK6.findNames(A, V), sets = MK6.findStrips(A, V, names.length); if (sets.length) found.push(0x08000000 + sets[0][0]); }   // strips only in ROM: the static table found by the profile tools
    map.reels = found[0]; log('reels', found.map(hx).join(','));
  }
  // win total & window: the ROM writes the win it shows through write_panel_meter_mes(2, value), counting up and back to 0 once the win is collected, so the largest value is the game's win; the word that holds that value after each winning game (and 0 after losing ones) is the win total
  { const vm = mkvm(rom, map.lineIdx, map.betIdx), h = new Host(vm, { map: Object.assign({}, map, { window: 0 }), lines: +Object.keys(map.lineKeys).pop(), bet: +Object.keys(map.betKeys)[0], fast: true }); h.init(map.lineIdx, map.betIdx, 1);   // fast: a win is collected, not held for a player's take-win
    const wpm = exportAddr(A, EXPORTS.indexOf('write_panel_meter_mes')); let shown = 0; const sfw = exportAddr(A, EXPORTS.indexOf('sfw_Search_for_wins')); let rec = 0, winWin = 0;
    const tracer = (c, pc) => { pc >>>= 0; if (pc === wpm && c.r[4] === 2) shown = Math.max(shown, c.r[5] >>> 0); if (pc === sfw) { if (!rec) rec = c.r[7] >>> 0; if (!winWin && (c.r[5] >>> 20) === 0xcf) winWin = c.r[5] >>> 0; } };   // sfw_Search_for_wins(lineBets, window, comb, records, ...)
    let cand = null, wins = 0, losses = 0; const seen = new Set(); const tEnd = Date.now() + 30000; for (let g = 0; g < 200 && (wins < 14 || losses < 5) && !(wins === 0 && g >= 40) && Date.now() < tEnd; g++) {   // no win shown after 40 games (or 30 s): the win total cannot be found, give up instead of spinning 200 slow games
      try { h.credits = 1e6; shown = 0; if (!h.spin()) break; vm.cpu.trace = tracer; let k = 0; while (h.phase && k++ < 40000) h.frame(); }
      catch (e) { log('win search stopped:', e.message); break; }   // the win total is optional (the host falls back to the win meter): a ROM that fails here keeps the rest of its map
      const w = shown; if (w > 0) seen.add(w); const hits = new Set(); if (w > 0) { for (let a = 0xcf00000; a < 0xcf10000; a += 4) if (vm.mem.r32(a) === w) hits.add(a); cand = cand ? new Set([...cand].filter(a => hits.has(a))) : hits; wins++; }
      else { losses++; if (cand) for (const a of [...cand]) if (vm.mem.r32(a) !== 0) cand.delete(a); } }
    map.winRecords = rec || undefined; log('winRecords', rec && hx(rec)); if (winWin) { map.window = winWin; log('window', hx(winWin)); } map.win = (cand && losses && seen.size > 1 && [...cand].sort((a, b) => a - b)[0]) || null; log('win', map.win && hx(map.win), 'candidates', cand ? [...cand].map(hx).join(',') : 'none', 'after', wins, 'winning games'); }

  // feature stops & freeCount: test candidate scatter symbols (low frequency on reels) to trigger state 16 or 7, find the RAM word that holds free game count
  if (map.reels && map.state) {
    try {
      const vm = mkvm(rom, map.lineIdx, map.betIdx), h = new Host(vm, { map: Object.assign({}, map, { window: 0 }) });
      h.init(map.lineIdx, map.betIdx, 1);
      const m = vm.mem;
      const strips = [0, 1, 2, 3, 4].map(i => {
        const len = m.r32(map.reels + 12 * i), ptr = m.r32(map.reels + 12 * i + 4);
        return Array.from({ length: len }, (_, j) => m.r32(ptr + 4 * j));
      });
      const symCounts = {};
      strips.forEach(s => s.forEach(sym => symCounts[sym] = (symCounts[sym] || 0) + 1));
      const candSyms = Object.keys(symCounts).map(Number).sort((a, b) => symCounts[a] - symCounts[b]);

      for (const sym of candSyms) {
        if (symCounts[sym] > 30) continue;
        if (!strips.slice(0, 3).every(s => s.includes(sym))) continue;
        const testStops = [0, 1, 2, 3, 4].map(r => strips[r].includes(sym) ? strips[r].indexOf(sym) : 0);

        const v = mkvm(rom, map.lineIdx, map.betIdx), host = new Host(v, { map: Object.assign({}, map, { window: 0 }) });
        host.init(map.lineIdx, map.betIdx, 1);
        const mem = v.mem;
        const pre = new Map();
        for (let a = 0xcf00000; a < 0xcf10000; a += 4) pre.set(a, mem.r32(a));

        let triggeredState = 0;
        const origWatch = v.mem.onWatch;
        v.mem.watchAddr = map.state;
        v.mem.onWatch = val => {
          if (val === 16 || val === 7) triggeredState = val;
          if (origWatch) origWatch(val);
        };

        if (!host.spin(testStops)) continue;
        let k = 0;
        while (host.phase && k++ < 400) {
          if (triggeredState) break;
          host.frame();
          if (host.gamble) host.collect();
        }

        if (triggeredState) {
          map.featureStops = testStops;
          const cand = [];
          for (let [a, val] of pre.entries()) {
            const cur = mem.r32(a);
            if (val === 0 && (cur === 10 || cur === 15 || cur === 20 || cur === 25)) cand.push(a);
          }
          for (let i = 0; i < 600; i++) {
            host.frame();
            const decr = cand.filter(a => mem.r32(a) === pre.get(a) - 1 || mem.r32(a) === 14 || mem.r32(a) === 9);
            if (decr.length) {
              map.freeCount = decr[0];
              map.freeFlag = decr[0];
              break;
            }
          }
          log('featureStops', JSON.stringify(map.featureStops), 'freeCount', map.freeCount && hx(map.freeCount));
          break;
        }
      }
    } catch (e) {
      log('feature discovery error:', e.message);
    }
  }

  return map;
}
  const api = { discover, poolConsts };
  if (isNode) module.exports = api; else root.MK6DISCOVER = api;
})(typeof window !== 'undefined' ? window : globalThis);
