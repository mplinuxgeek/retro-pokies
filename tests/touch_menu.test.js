// Touch multi-game menus: the game-select screen of Cashman Tonight and Players Choice By Demand / Favourites picks a game when the player touches
// a tile. The ROM makes each menu button with _createbox and passes its size as stack words (arguments 4 and 5 of sysw__createbox), not in r4 / r5
// (read from r4 / r5, every menu box would be 0 x 0 and no touch would reach the menu). The test taps the way play.html does (pointer -> the smallest enabled box under it -> [0x1d, code, 0]).
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), { VM } = require('../web/js/mk6vm.js'), { TouchHost } = require('../web/js/mk6touchhost.js');
const dir = process.env.ROMS || path.join(__dirname, '..', 'roms'), PLAY = 0x1e;
const hit = (vm, x, y) => { let best = null; for (const b of vm.touchBoxes()) if (b.code > 0 && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && vm.touchEnabled(b.code)) { const a = b.w * b.h; if (!best || a < best.a || (a === best.a && (b.prio | 0) >= (best.p | 0))) best = { a, p: b.prio, c: b.code }; } return best ? best.c : -1; };
for (const [name, id] of [['Cashman Tonight', 'cashman-tonight'], ['Players Choice By Demand', 'players-choice-by-demand'], ['Players Choice Favourites', 'players-choice-favourites']]) {
  const zip = path.join(dir, name + '.zip');
  test(name + ': a touch on a menu button starts a game', { skip: !fs.existsSync(zip) }, async () => {
    const map = require('../web/maps/' + id + '.json'), rom = await MK6.openZip(fs.readFileSync(zip));
    const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: 1, betIdx: 0 } });
    const h = new TouchHost(vm, { map, game: 0, menu: true, credits: 100000 }); vm.meters.set(0, 100000); h.init(); h.credits = vm.meters.get(0) | 0; h.machineEvent();
    assert.ok(!h.enabledCodes().includes(PLAY), 'the menu is up, not a game');
    for (const it of vm.display.items) if (it && it.visible && it.code && it.img !== undefined) await vm.loadImage(it.img);   // play.html's compositor decodes these while drawing
    const boxes = vm.touchBoxes().filter(b => b.code > 0 && b.w > 0 && b.h > 0 && b.code < 0x384 && vm.touchEnabled(b.code));
    assert.ok(boxes.length >= 4, 'menu touch boxes have a size: ' + boxes.length);
    let picked = -1;
    for (const b of boxes) {
      const code = hit(vm, b.x + (b.w >> 1), b.y + (b.h >> 1)); if (code < 0) continue;
      h.send(code); h.step(60); if (!h.enabledCodes().includes(PLAY) && h.enabledCodes().includes(0x384)) { h.send(0x384); h.step(60); }   // Cashman Tonight asks to confirm
      if (h.enabledCodes().includes(PLAY)) { picked = code; break; }
    }
    assert.ok(picked > 0, 'a touch picked a game (Play enabled): ' + h.enabledCodes().map(c => c.toString(16)));
    h.step(240); assert.ok(h.spin(), 'the picked game starts');
  });
}
