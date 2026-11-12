// The core boots a ROM, plays spins and draws frames, with no browser and no window.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const { openGame, W, H } = require('../src/core.js');
const ROMS = process.env.ROMS || path.join(__dirname, '..', 'roms'), zip = path.join(ROMS, 'Queen Of The Nile.zip');

test('Queen Of The Nile boots, spins and draws', { skip: !fs.existsSync(zip) && 'set ROMS to a folder with Queen Of The Nile.zip' }, async () => {
  const g = await openGame(zip, { fast: true }), h = g.host;
  const blank = (await g.frame()).slice(); assert.strictEqual(blank.length, W * H * 4);   // a copy: each frame is drawn into the same picture
  let lit = 0; for (let i = 0; i < blank.length; i += 4) if (blank[i] | blank[i + 1] | blank[i + 2]) lit++;
  assert.ok(lit > W * H / 4, 'the attract / idle screen is drawn: ' + lit + ' lit pixels');
  h.credits = 1000;
  const c0 = h.credits; let games = 0;
  for (let s = 0; s < 3; s++) {
    assert.ok(h.spin(), 'spin ' + (s + 1) + ' accepted');
    for (let k = 0; h.phase && k < 20000; k++) h.frame();
    assert.ok(!h.phase, 'spin ' + (s + 1) + ' finished'); games++;
  }
  assert.strictEqual(games, 3);
  assert.notStrictEqual(h.credits, c0, 'credits moved: ' + c0 + ' -> ' + h.credits);
  const after = await g.frame(); let diff = 0; for (let i = 0; i < after.length; i += 4) if (after[i] !== blank[i]) diff++;
  assert.ok(diff > 1000, 'the screen changed after the spins: ' + diff + ' pixels');
});
