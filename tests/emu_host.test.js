// Runs real QotN ROM code in the SH-4 VM: the host drives a few games and the ROM spins, evaluates and pays.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), { VM } = require('../web/js/mk6vm.js'), { Host } = require('../web/js/mk6host.js');
const map = require('../web/maps/queen-of-the-nile.json');   // the host reads the game's state, stop buffer and keys from its map
const zip = path.join(process.env.ROMS || path.join(__dirname, '..', 'roms'), 'Queen Of The Nile.zip');
test('ROM runs spin cycles through the host', { skip: !fs.existsSync(zip) }, async () => {
  const rom = await MK6.openZip(fs.readFileSync(zip));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: 1, betIdx: 0 } });
  const h = new Host(vm, { map }); h.autoKeys = true; h.init(1, 0, 20); let wins = 0;   // AUTO answers the feature key prompt: a player's host waits at it for ever
  for (let i = 0; i < 40; i++) {
    assert.ok(h.spin(), 'bet accepted'); let k = 0; while (h.frame() && k++ < 40000) if (h.gamble && !h.gamble.screen) h.collect();   // a win offers a gamble: take the win, as a player would
    assert.ok(k > 100, 'spin takes a plausible number of frames: ' + k);
    assert.equal(h.last.cost, 20); assert.ok(h.last.window.every(r => r.length === 5 && r.every(Number.isInteger)));
    wins += h.last.win > 0;
  }
  assert.ok(wins > 3 && wins < 35, 'some, not all, games win: ' + wins);
});

test('ROM cabinet controls: lines, bet per line, credit limit, refused bet', { skip: !fs.existsSync(zip) }, async () => {
  const rom = await MK6.openZip(fs.readFileSync(zip));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: 1, betIdx: 0 } });
  const h = new Host(vm, { map, credits: 1000, limit: 1200 }); h.autoKeys = true; h.init(1, 0, 1);
  for (const [lines, bet] of [[1, 1], [5, 2], [10, 3], [15, 5], [20, 10]]) {
    assert.ok(h.setLines(lines) && h.setBet(bet)); const before = h.credits, r = h.spin(); assert.ok(r, 'spin accepted');
    assert.equal(r.cost, lines * bet); let k = 0; while (h.frame() && k++ < 40000) if (h.gamble && !h.gamble.screen) h.collect();   // a win offers a gamble: take the win, as a player would
    assert.equal(h.credits, before - lines * bet + h.last.win);
  }
  assert.equal(h.setLines(7), false); assert.equal(h.setBet(4), false);
  h.credits = 15; h.setLines(20); h.setBet(1); assert.equal(h.spin(), null, 'not enough credit');
  assert.equal(h.addCredits(2000), false, 'over the limit'); assert.equal(h.addCredits(100), true); assert.equal(h.credits, 115);
});

// during QOTN's free games the ROM puts "N free games remaining" (priority 12) on message line 2 beside "1 credit per line" (10); only the count
// shows. The 2 s rotation runs through the top priority only, so a lower message never surfaces.
test('ROM message line shows the free-game count, not the bet line, through the feature', { skip: !fs.existsSync(zip) }, async () => {
  const rom = await MK6.openZip(fs.readFileSync(zip));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: 1, betIdx: 0 } });
  const h = new Host(vm, { map, fast: true }); h.init(1, 0, 1); h.credits = 10000;
  assert.ok(h.spin(map.featureStops), 'the feature stops start a game');
  // the counter word rises when the trigger is evaluated (frame ~170); the ROM posts its first count about 150 frames later, after the scatter
  // presentation, and the standing bet line is all there is until then. The window starts at that first count.
  const shown = new Set(); let k = 0, counts = 0, started = false;
  while (h.frame() && k++ < 40000) { const L = vm.msgLines[2]; if (vm.mem.r32(map.freeCount || 0xcf05688) > 0 && L.cur) { if (/free games? remaining/.test(L.cur.text)) { started = true; counts++; } if (started) shown.add(L.cur.text); } }
  assert.ok(counts > 1000, 'the count is on the line through the free games: ' + counts + ' frames');
  assert.ok(![...shown].some(t => /credit per line/i.test(t)), 'the bet line never surfaces once the count is listed: ' + [...shown].join(' | '));
  assert.ok(h.last.win > 0, 'the feature paid');
});
