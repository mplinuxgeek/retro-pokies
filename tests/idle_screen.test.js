// the idle screen: message line 2 alternates "GAME OVER PLAY NOW" with the bet text every 2 s,
// the bet text is the ROM's own ("1 credit X reel bet" on the reel-power games Dragon Lord and Wild Ways), and Wild Ways' river keeps moving.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), { VM } = require('../web/js/mk6vm.js'), { Host } = require('../web/js/mk6host.js'), RD = require('../web/js/mk6render.js');
const roms = process.env.ROMS || path.join(__dirname, '..', 'roms'), zip = g => path.join(roms, g + '.zip');
const boot = async (g, preload) => {
  const id = g.toLowerCase().replace(/[^a-z0-9]+/g, '-'), map = require('../web/maps/' + id + '.json'), rom = await MK6.openZip(fs.readFileSync(zip(g)));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: map.lineIdx ?? 1, betIdx: map.betIdx ?? 0 } });
  if (preload) await vm.preload(); const h = new Host(vm, { map }); h.init(map.lineIdx ?? 1, map.betIdx ?? 0, 1); return { vm, h };
};
const line2 = vm => (vm.msgLines[2].cur && vm.msgLines[2].cur.text) || (vm.display.windows[2] && vm.display.windows[2].text) || '';
const idleTexts = (vm, h, secs) => { const seen = [], t0 = vm.now; while (vm.now - t0 < secs * 1000) { h.frame(); const t = line2(vm); if (t !== seen[seen.length - 1]) seen.push(t); } return seen; };
for (const [g, bet] of [['Dragon Lord', '1 credit X reel bet'], ['Wild Ways', '1 credit X reel bet'], ['Indian Dreaming Second Chance', '1 credit X reel bet'], ['Queen Of The Nile', '1 credit per line'], ['Bucaneer', '1 credit X line bet'], ['Pompei', '1 credit per WAY BET']])
  test(g + ' idle line 2 alternates GAME OVER PLAY NOW / ' + bet + ' every 2 s', { skip: !fs.existsSync(zip(g)) }, async () => {
    const { vm, h } = await boot(g); h.setBet(1);
    const seen = idleTexts(vm, h, 13).filter(t => t.trim());
    assert.ok(seen.length >= 5, 'the line changed through 13 s: ' + JSON.stringify(seen));
    for (let i = 1; i < seen.length; i++) assert.ok(/GAME\s+OVER\s+PLAY\s+NOW/.test(seen[i]) !== /GAME\s+OVER\s+PLAY\s+NOW/.test(seen[i - 1]), 'alternates: ' + JSON.stringify(seen));
    assert.ok(seen.some(t => t === bet), 'bet text ' + JSON.stringify(bet) + ' in ' + JSON.stringify(seen));
    assert.ok(!seen.some(t => /credit/.test(t) && t !== bet), 'no other bet text: ' + JSON.stringify(seen));
  });
test('Wild Ways river moves at idle', { skip: !fs.existsSync(zip('Wild Ways')) }, async () => {
  const { vm, h } = await boot('Wild Ways', true);
  const crop = px => { const out = []; for (let y = 89; y < 102; y++) for (let x = 450; x < 565; x++) out.push(px[(y * 640 + x) * 4]); return out; };   // red channel of the river, clear of the message text
  const shots = []; for (let n = 0; n < 5; n++) { const t0 = vm.now; while (vm.now - t0 < 2000) h.frame(); shots.push(crop(await RD.compose(vm))); }
  const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  const moves = shots.slice(1).map((s, i) => diff(shots[i], s));
  assert.ok(moves.every(m => m > 0.5), 'the river changed between every pair of 2 s shots: ' + moves.map(m => m.toFixed(2)).join(' '));
});
// "Memory Reset" (a boot without a save) and "Watchdog Reset" (a load from one) sit in the footer, message window 4 under the reels,
// and go with the next game
test('Memory Reset is in the footer and goes with the next game', { skip: !fs.existsSync(zip('Queen Of The Nile')) }, async () => {
  const { vm, h } = await boot('Queen Of The Nile'); h.resetMessage('Memory Reset'); for (let i = 0; i < 30; i++) h.frame();
  const w = vm.display.windows.find(w => w && /Memory Reset/.test(w.text || ''));
  assert.ok(w, 'a window holds the text'); assert.ok(w.y > 400 && w.y + w.h <= 480, 'in the footer: y ' + w.y + ' h ' + w.h);
  assert.ok(!vm.display.windows.some(x => x && x !== w && /Memory Reset/.test(x.text || '')), 'not anywhere else');
  h.credits = 1000; assert.ok(h.spin(), 'a game starts'); let k = 0; while (h.frame() && k++ < 40000) if (h.gamble && !h.gamble.screen) h.collect();
  assert.ok(!vm.display.windows.some(x => x && /Memory Reset/.test(x.text || '')), 'gone once a game has started');
});
