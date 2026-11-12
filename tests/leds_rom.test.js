// Button lamps and the light show against real ROMs (headless): the lamp output follows vm.lamps (the ROM's gos_control(13) calls) with the panel's flash timing, and the light-show events
// come in game order. Queen Of The Nile (classic 9-line, free games, gamble), Wild Ways (reel power) and Choy Sun Returns.
// Every loop is bounded by a frame count; stops come from a seeded generator (or the map's feature stops), so a run is the same every time.
// Time is vm.now (virtual ms, 1 frame ~17 ms), never the wall clock: the LampOutput and LightShow take it as their clock.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), { VM } = require('../web/js/mk6vm.js'), { Host } = require('../web/js/mk6host.js');
const L = require('../web/js/leds.js'), S = require('../web/js/lightshow.js');
const dir = process.env.ROMS || path.join(__dirname, '..', 'roms');
const GAMES = { qotn: ['Queen Of The Nile', 'queen-of-the-nile'], ww: ['Wild Ways', 'wild-ways'], csr: ['Choy Sun Returns', 'choy-sun-returns'] };

async function boot(key, seed = 12345) {
  const [zip, slug] = GAMES[key], map = require('../web/maps/' + slug + '.json');
  const rom = await MK6.openZip(fs.readFileSync(path.join(dir, zip + '.zip')));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: map.lineIdx, betIdx: map.betIdx } });
  let sd = seed; const rng = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  const lines = map.lineKeys ? Math.max(...Object.keys(map.lineKeys).map(Number)) : 25;
  const h = new Host(vm, { map, lines, bet: 1, rng }); h.autoKeys = true; h.init(map.lineIdx, map.betIdx, h.bestRtpSet());
  return { vm, h, map };
}
// lamp output on a host-flashed mock driver, ticked every 10 ms of virtual time like the panel's paint; calls = [{ t, on }] per driver write
function lampRig(vm) {
  const model = new L.LampModel(vm), cab = new L.Cabinet(L.DEFAULT_CABINET), drv = new L.MockDriver(); let clock = 0, timer = null; const calls = [];
  drv.onSet = m => calls.push({ t: clock, on: m.on });
  const out = new L.LampOutput(model, cab, drv, { now: () => clock, setInterval: f => (timer = f), clearInterval: () => {} });
  let next = 10, bad = [];
  // the lit-now mask worked out straight from vm.lamps and the clock, without the model or the output
  const expect = t => { let on = 0; for (const k of Object.keys(vm.lamps)) { const s = vm.lamps[k].state, c = L.DEFAULT_CABINET.channels[k]; if (c === undefined || s === 1 || s > 3) continue; const p = L.flashPhase(t);   /* state 1 is dark */
    if (s === 0 || (s === 2 && p.fast) || (s === 3 && p.slow)) on |= 1 << c; } return on >>> 0; };
  return { model, drv, out, calls, start: () => out.start(), expect,
    // after a frame: poll the ROM's lamps, then tick the 10 ms clock up to vm.now and compare the driver's last write with the expectation
    pump() { for (; next <= vm.now; next += 10) { clock = next; model.poll(); timer(); const want = expect(next); if (drv.last && drv.last.on !== want) bad.push(next + ': ' + drv.last.on.toString(2) + ' want ' + want.toString(2)); } },
    bad };
}
const frames = (h, n, fn) => { for (let i = 0; i < n; i++) { h.frame(); if (fn) fn(); } };

for (const key of Object.keys(GAMES)) {
  const skip = !fs.existsSync(path.join(dir, GAMES[key][0] + '.zip'));
  test(GAMES[key][0] + ': lamp output follows vm.lamps, panel flash timing, through spins', { skip }, async () => {
    const { vm, h } = await boot(key), r = lampRig(vm); await r.start();
    frames(h, 360, () => r.pump());   // 6 s idle: fast key 0, slow keys 1-5 (the idle set), steady bet keys
    assert.equal(vm.lamps[0].state, 2, 'idle: Collect / Take Win flashes fast'); for (let k = 1; k <= 5; k++) assert.equal(vm.lamps[k].state, 3, 'idle: Play ' + k + ' flashes slow');
    const idleEnd = r.calls.length;
    // edges of channel 0 (key 0 fast) and 1 (key 1 slow) from the driver writes
    const edges = ch => { const e = []; let prev = null; for (const c of r.calls) { const b = (c.on >>> ch) & 1; if (b !== prev) e.push({ t: c.t, on: b }); prev = b; } return e; };
    const e0 = edges(0), e1 = edges(1), runs = e => e.slice(1, -1).map((x, i) => [x.on, e[i + 2].t - x.t]);
    assert.ok(e0.length >= 12 && e1.length >= 6, 'enough edges: ' + e0.length + ' fast, ' + e1.length + ' slow');
    for (const [on, len] of runs(e0)) assert.ok(Math.abs(len - (on ? 430 : 330)) <= 10, 'fast ' + (on ? 'on' : 'off') + ' ' + len);
    for (const [on, len] of runs(e1)) assert.ok(Math.abs(len - 760) <= 10, 'slow ' + (on ? 'on' : 'off') + ' ' + len);
    for (const x of e0.filter(x => x.on)) assert.ok(x.t % 760 <= 10, 'fast on-edge at ' + x.t); for (const x of e1.filter(x => x.on)) assert.ok(x.t % 1520 <= 10, 'slow on-edge at ' + x.t);   // slow edges fall on fast on-edges
    for (const c of r.calls) { const m = (c.on >>> 1) & 31; assert.ok(m === 0 || m === 31, 'keys 1-5 flash in step: ' + c.on.toString(2)); }   // one shared clock
    // play: a spin, its win, the collect; the output matches the ROM's lamps on every tick (r.bad)
    h.credits = 2000; frames(h, 10, () => r.pump()); const lamps0 = JSON.stringify(vm.lamps);
    for (let g = 0, spins = 0, seen = new Set(); g < 30000 && spins < 3; g++) { if (!h.phase && !h.inFree && !h.gamble) { h.spin(); spins++; }
      if (h.gamble && !h.gamble.screen && !h.gamble.busy) h.collect(); h.frame(); r.pump(); seen.add(JSON.stringify(vm.lamps)); if (!h.phase && spins === 3 && g > 100) { assert.ok(seen.size > 4, 'the ROM changed its lamps through the game'); break; } }
    assert.deepEqual(r.bad.slice(0, 5), [], 'driver output equals the lamps worked out from vm.lamps and the clock on every 10 ms tick');
    assert.ok(r.calls.length > idleEnd, 'the lamp changes of play reached the driver'); assert.notEqual(JSON.stringify(vm.lamps), '{}');
  });
}

// ---- light show events
function eventRig(h, vm, cfg) {
  const drv = new L.MockDriver(), show = new S.LightShow(drv, cfg, { now: () => vm.now }), log = []; const fire = show.fire.bind(show);
  show.fire = (n, x) => { log.push({ n, t: vm.now, win: h.last && h.last.win }); return fire(n, x); };
  const ev = new S.HostEvents(h, show); ev.hookSounds(vm);
  return { show, ev, log, names: () => log.map(e => e.n), step() { const r = h.frame(); ev.watch(); return r; }, run(n) { for (let i = 0; i < n; i++) this.step(); } };
}
// play one game to its end with a seeded or given stop set; the gamble prompt is declined (Take Win). Bounded; returns frames used
function playGame(h, rig, stops, max = 60000) {
  if (h.phase || h.inFree) throw new Error('not idle'); assert.ok(h.spin(stops), 'bet accepted'); let g = 0;
  for (; g < max; g++) { if (h.gamble && !h.gamble.screen && !h.gamble.busy) h.collect(); rig.step(); if (!h.phase && g > 5) break; } assert.ok(g < max, 'game ended within ' + max + ' frames'); return g;
}
const slice = (log, from, to) => { const a = log.findIndex(e => e.n === from); const b = log.findIndex((e, i) => i > a && e.n === to); return log.slice(a, b < 0 ? undefined : b); };

test('reel stop heuristic: the ROM sound that plays', () => {
  for (const n of ['reel_clink', 'SND_whirring_clink', 'HL_CASHBOX_REEL_STOP', 'reel_stop']) assert.ok(S.HostEvents.isReelStop(n), n);
  for (const n of ['wintune12', 'reel1', 'betbeep1', 'Reelding', '', undefined]) assert.ok(!S.HostEvents.isReelStop(n), String(n));
});

test('win size by win / cost', () => { const th = S.DEFAULT_SHOW.win;
  assert.equal(S.winEvent(4, 1, th), 'winSmall'); assert.equal(S.winEvent(5, 1, th), 'winMedium'); assert.equal(S.winEvent(19, 1, th), 'winMedium'); assert.equal(S.winEvent(20, 1, th), 'winBig'); assert.equal(S.winEvent(5, 0, th), 'winSmall'); });

test('Queen Of The Nile: credit, spin, 5 reel stops, win by size, feature, free games, gamble, attract', { skip: !fs.existsSync(path.join(dir, 'Queen Of The Nile.zip')) }, async () => {
  const { vm, h } = await boot('qotn'), rig = eventRig(h, vm, {}); rig.run(200);
  h.credits += 500; rig.run(5); assert.deepEqual(rig.names(), ['credit'], 'credit in');
  // base games with seeded stops until a small win and a no-win have been seen (bounded)
  const wins = new Map(); let noWin = 0;
  for (let n = 0; n < 40 && !(wins.size && noWin); n++) { rig.log.length = 0; playGame(h, rig, undefined);
    const nm = rig.names(), sp = nm.indexOf('spin'), stops = nm.filter(x => x === 'reelstop').length;
    assert.ok(sp === 0, 'game starts with spin: ' + nm); assert.equal(stops, 5, 'one reel stop a reel: ' + nm);
    const t = rig.log.filter(e => e.n === 'reelstop').map(e => e.t); for (let i = 1; i < 5; i++) assert.ok(t[i] - t[i - 1] >= 400 && t[i] - t[i - 1] <= 520, 'reels stop one after another: ' + t);
    assert.ok(t[0] > rig.log[0].t, 'first stop after the spin');
    const last = h.last; if (last.win > 0) { const want = S.winEvent(last.win, last.cost, S.DEFAULT_SHOW.win); assert.equal(nm[nm.length - 1 - (nm.at(-1) === 'idle' ? 1 : 0)] === want || nm.includes(want), true, 'win ' + last.win + '/' + last.cost + ' => ' + want + ': ' + nm);
      assert.ok(nm.lastIndexOf(want) > nm.lastIndexOf('reelstop'), 'the win effect comes after the last reel stop'); wins.set(want, last.win); }
    else { noWin++; assert.ok(!nm.some(x => /^win/.test(x)), 'no win effect without a win: ' + nm); }
  }
  assert.ok(wins.has('winSmall') && noWin, 'saw a win and a no-win: ' + [...wins.keys()]);
  // feature: the trigger stops, free games, back to the base game; the whole series' win is sized by win / cost
  rig.log.length = 0; const g0 = h.gameNo | 0; playGame(h, rig, h.featureStops(), 400000);
  const nm = rig.names(), fi = nm.indexOf('feature'), ei = nm.indexOf('featureEnd');
  assert.ok(nm.indexOf('spin') === 0 && fi > nm.indexOf('spin') && ei > fi, 'spin, feature, featureEnd in order: ' + nm.join());
  assert.equal(nm.filter(x => x === 'feature').length, 1); assert.ok(nm.filter(x => x === 'free').length >= 5, 'a free event for each free game after the first: ' + nm.filter(x => x === 'free').length);
  assert.ok(nm.slice(fi, ei).filter(x => x === 'reelstop').length >= 5 * 5, 'free games stop their reels too');
  assert.ok(nm.slice(0, fi).filter(x => x === 'reelstop').length === 5, 'trigger spin: 5 reel stops before the feature starts');
  assert.ok(h.last.win > 0 && nm.slice(ei).some(x => /^win/.test(x)), 'series win shown after featureEnd: ' + h.last.win + ' ' + nm.slice(ei).join());
  assert.equal(nm.slice(ei).find(x => /^win/.test(x)), S.winEvent(h.last.win, h.last.cost, S.DEFAULT_SHOW.win));
  // gamble: win, open the gamble screen, one pick, take
  let opened = false;
  for (let n = 0; n < 60 && !opened; n++) { rig.log.length = 0; assert.ok(h.spin(), 'bet'); let wasWin = false;
    for (let g = 0; g < 60000; g++) { if (h.gamble && !h.gamble.screen && !h.gamble.busy && h.gambleStart()) { opened = true; } else if (h.gamble && h.gamble.screen && !h.gamble.busy) { if (h.gamble.n < 1) h.gambleChoose('red'); else h.collect(); } rig.step(); if (!h.phase && g > 5) break; }
    if (opened) { const nm2 = rig.names(); assert.ok(nm2.includes('gamble'), 'gamble screen event: ' + nm2); assert.ok(nm2.indexOf('gamble') > nm2.lastIndexOf('reelstop'), 'after the reels'); assert.ok(nm2.indexOf('idle', nm2.indexOf('gamble')) > 0, 'back to idle when the gamble ends: ' + nm2); } }
  assert.ok(opened, 'a gamble was opened');
  if (process.env.DBG) console.log("QOTN", wins, noWin, nm.join(" ").replace(/(reelstop )+/g, "R "), vm.now);
  // attract: idle for idleSecs (60 s) with no game
  rig.log.length = 0; const t0 = vm.now; let k = 0; for (; k < 6000 && !rig.names().includes('attract'); k++) rig.step();
  assert.ok(rig.names().includes('attract'), 'attract after idle'); const dt = rig.log.find(e => e.n === 'attract').t - t0; assert.ok(dt >= 55000 && dt <= 66000, 'attract after ~60 s idle: ' + dt);
  h.credits += 10; rig.step(); assert.equal(rig.names().pop(), 'credit', 'credit ends the attract');
});

for (const key of ['ww', 'csr']) {
  const skip = !fs.existsSync(path.join(dir, GAMES[key][0] + '.zip'));
  test(GAMES[key][0] + ': credit, spin, reel stops, win/idle in order', { skip }, async () => {
    const { vm, h } = await boot(key), rig = eventRig(h, vm, {}); rig.run(120); h.credits += 300; rig.run(3); assert.deepEqual(rig.names(), ['credit']);
    for (let n = 0; n < 4; n++) { rig.log.length = 0; playGame(h, rig, undefined, 200000); const nm = rig.names();
      assert.equal(nm[0], 'spin'); assert.ok(nm.filter(x => x === 'reelstop').length >= 5, 'reel stops: ' + nm); const lastStop = nm.lastIndexOf('reelstop');
      assert.ok(nm.slice(lastStop + 1).every(x => /^win|idle|feature|free|gamble/.test(x)), 'only game-end events after the last reel stop: ' + nm); }
  });
}

// bet / gamble lamps (keys 10-15) on Queen Of The Nile. The panel draws ROM state 0 lit and 1 dark (idle keys 10-13 = 1, key 14 = 0, key 15 = 1 give only Bet 1 lit;
// a Bet 2 press moves state 0 to key 13; a win flashes key 15 = 3 with the gamble button). The model, cabinet and driver must show the same.
test('Queen Of The Nile: bet and gamble lamps follow the panel (state 0 lit, 1 dark)', { skip: !fs.existsSync(path.join(dir, 'Queen Of The Nile.zip')) }, async () => {
  const { vm, h, map } = await boot('qotn'), r = lampRig(vm); await r.start();
  frames(h, 120, () => r.pump());
  const lit = () => [10, 11, 12, 13, 14, 15].filter(k => r.model.lamps[k] && r.model.lamps[k].on);
  assert.deepEqual([10, 11, 12, 13, 14].map(k => vm.lamps[k] && vm.lamps[k].state), [1, 1, 1, 1, 0], 'the ROM at idle: Bet 1 is state 0, the other bets 1');
  assert.ok(!vm.lamps[15] || vm.lamps[15].state === 1, 'gamble: not set, or 1 (every lamp starts at 1)');
  assert.deepEqual(lit(), [14], 'idle: only Bet 1 (key 14) lit, gamble dark');
  const ch = k => L.DEFAULT_CABINET.channels[k]; assert.equal(r.drv.last.on >>> ch(14) & 1, 1); for (const k of [10, 11, 12, 13, 15]) assert.equal(r.drv.last.on >>> ch(k) & 1, 0, 'key ' + k + ' dark');
  // a win offers the gamble: key 15 flashes slow (3), Bet 1 stays lit; the collect puts it back to 1 (dark)
  h.credits = 2000; let sawGamble = false;
  for (let g = 0, spins = 0; g < 30000 && !sawGamble; g++) { if (!h.phase && !h.inFree && !h.gamble && spins < 40) { h.spin(); spins++; } h.frame(); r.pump();
    if (vm.lamps[15] && vm.lamps[15].state > 1) { sawGamble = true; assert.deepEqual(r.model.lamps[15], { on: true, flash: 'slow' }); assert.ok(r.model.lamps[14].on, 'Bet 1 stays lit while the gamble is offered'); } }
  assert.ok(sawGamble, 'a win offered the gamble within 40 spins');
  assert.deepEqual(r.bad.slice(0, 5), [], 'driver output equals the lamps worked out from vm.lamps on every tick');
});
