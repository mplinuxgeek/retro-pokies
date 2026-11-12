// Music channel of web/js/emusound.js: one tune at a time, whatever its name (100000 samples or more counts as a tune).
const test = require('node:test'), assert = require('node:assert');
function setup() {
  const started = [], stopped = [];
  globalThis.QotnAudio = { configure() {}, playBank(bk, SB, o) { const h = { name: bk.name, duration: bk.samples / 21480, stop() { stopped.push(bk.name); } }; started.push(bk.name); return h; } };
  globalThis.SNDBANK = { decode: (db, rec) => ({ name: rec.name, samples: rec.samples }) };
  const mk = (name, samples) => ({ name, tag: 1, body: new Uint8Array(4), samples });
  const recs = { wintune14: mk('wintune14', 50000), collect: mk('collect', 1138000), SND_FG1: mk('SND_FG1', 539000), reel1: mk('reel1', 12000), reel2: mk('reel2', 12000) };
  const vm = { db: { sections: { 9: { recs: Object.values(recs) } } } };
  delete require.cache[require.resolve('../web/js/emusound.js')];
  require('../web/js/emusound.js').install(vm, null);
  return { vm, recs, started, stopped };
}
const tick = () => new Promise(r => setTimeout(r, 5));
test('a long tune with a non-tune name replaces the win tune', async () => {
  const { vm, recs, started, stopped } = setup();
  vm.sound.play(recs.wintune14, 1); await tick(); vm.sound.play(recs.collect, 2); await tick();
  assert.deepEqual(started, ['wintune14', 'collect']); assert.deepEqual(stopped, ['wintune14']);
  vm.sound.play(recs.SND_FG1, 3); await tick(); assert.deepEqual(stopped, ['wintune14', 'collect']);
});
test('effects play over the music', async () => {
  const { vm, recs, stopped } = setup();
  vm.sound.play(recs.wintune14, 1); await tick(); vm.sound.play(recs.reel1, 2); vm.sound.play(recs.reel2, 3); await tick();
  assert.deepEqual(stopped, []);
});
test('stopMusic cuts the playing tune (a spin starts)', async () => {
  const { vm, recs, stopped } = setup();
  vm.sound.play(recs.collect, 1); await tick(); vm.sound.stopMusic(); await tick();
  assert.deepEqual(stopped, ['collect']);
});
