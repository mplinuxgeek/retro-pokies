// Pompei's volcano wild: the real machine plays its eruption from the reel stop until the next press, about every 100 ms, with coins and lava thrown into the
// cells beside it. The ROM shows it as SCN_A_Volcano, whose sprite entries
// (SP_SP_vulc, SP_SP_COINSPIN_1..4) carry play count -1; played once, the eruption would freeze on its last frame 1.4 s after the reel stop.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), { VM } = require('../web/js/mk6vm.js'), { Host } = require('../web/js/mk6host.js');
const map = require('../web/maps/pompei.json');
const zip = path.join(process.env.ROMS || path.join(__dirname, '..', 'roms'), 'Pompei.zip');
test('Pompei volcano wild erupts until the next spin', { skip: !fs.existsSync(zip) }, async () => {
  const rom = await MK6.openZip(fs.readFileSync(zip));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: map.lineIdx, betIdx: map.betIdx } });
  const h = new Host(vm, { map, lines: 25, bet: 1 }); h.init(map.lineIdx, map.betIdx, 3); const D = vm.display;
  const vulc = () => D.scenes.find(s => s.sprite && s.rec.name === 'SP_SP_vulc');
  const shown = () => { const s = vulc(), d = s && s.spriteItem; return d && d.visible ? vm.db.byIndex(1, d.img).name : null; };
  assert.ok(h.spin([33, 47, 47, 9, 14]), 'spin accepted');   // play strips: reel 2 stop 47 puts the volcano in its middle row
  let k = 0; while (!vulc() && k++ < 2000) h.frame(); assert.ok(vulc(), 'the ROM shows SCN_A_Volcano when the volcano lands');
  const t0 = vm.now, seen = []; while (vm.now - t0 < 5000) { h.frame(); const n = shown(); if (n && n !== seen[seen.length - 1]) seen.push(n); }
  assert.ok(seen.length > 35, 'the eruption keeps changing about every 100 ms for 5 s: ' + seen.length + ' frames');
  assert.ok(seen.filter(n => n === 'cr_vulc0000').length >= 3, 'it starts over (14 frames of 100 ms a pass)');
  const coin = D.scenes.find(s => s.sprite && s.rec.name === 'SP_SP_COINSPIN_1'); assert.ok(coin && coin.plays === -1, 'the coin sprites repeat too');
  k = 0; while (h.frame() && k++ < 40000) if (h.gamble && !h.gamble.screen) h.collect();   // finish the game: a win offers a gamble, take the win
  const t1 = vm.now, idle = new Set(); while (vm.now - t1 < 1500) { h.frame(); idle.add(shown()); }
  assert.ok(idle.size > 10 && !idle.has(null), 'still erupting with the game over, until the next press: ' + idle.size + ' frames');
  assert.ok(h.spin([0, 0, 0, 0, 0]), 'next spin accepted'); for (let i = 0; i < 300; i++) h.frame();
  assert.equal(shown(), null, 'the next press ends it');
});
