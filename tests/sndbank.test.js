// The ROM's compiled sound bank (AVLSoundControl): every sound record decodes, the voice lengths equal the authored durations, and the mix level matches the expected reference peaks.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), AVL = require('../web/js/avl.js'), SB = require('../web/js/sndbank.js');
const zip = path.join(process.env.ROMS || path.join(__dirname, '..', 'roms'), 'Queen Of The Nile.zip');
function render(bank) {       // plain mixdown at 21480 Hz (linear resampling), no master gain
  const out = new Float32Array(bank.samples);
  for (const ev of bank.voices) { let t = 0; for (const e of ev) { if (e.off && e.step) { const p = SB.pcm(bank, e.off), n = Math.min(Math.floor(p.length / e.step), e.len - 32); for (let i = 0; i < n && t + i < out.length; i++) { const x = i * e.step, k = x | 0, f = x - k; out[t + i] += ((p[k] || 0) * (1 - f) + (p[k + 1] || 0) * f) * e.vel / 128; } } t += e.len; } }
  return out;
}
test('QOTN sound bank decodes and matches the authored durations', { skip: !fs.existsSync(zip) }, async () => {
  const rom = await MK6.openZip(fs.readFileSync(zip)), db = AVL.open(rom.A, rom.B), sec = db.sections[9]; let n = 0;
  for (const r of sec.recs) {
    if (!r || r.tag === 3) continue; const b = SB.decode(db, r); assert.ok(b, 'bank block of ' + r.name); n++;
    if (r.tag === 2 && r.a >>> 16) assert.ok(Math.abs(b.ms - (r.a >>> 16) * 10) < 60, r.name + ' ' + b.ms + ' vs ' + (r.a >>> 16) * 10);
  }
  assert.ok(n > 100);
  const peak = name => { const o = render(SB.decode(db, sec.byName.get(name))); let m = 0; for (const x of o) m = Math.max(m, Math.abs(x)); return m * 32768 * 0.7; };
  assert.ok(Math.abs(peak('reel_clink') - 7850) < 300, 'reel_clink mix peak (expected 7746..7851): ' + peak('reel_clink'));
  assert.ok(Math.abs(peak('betbeep2') - 6803) < 300, 'betbeep mix peak (expected 6803): ' + peak('betbeep2'));
});
