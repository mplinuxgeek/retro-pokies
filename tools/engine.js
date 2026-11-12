#!/usr/bin/env node
// engine.js - a short hash of the code and data that decide a scan result, screenshot or marquee: the emulator (web/js/mk6*.js),
// the scan rules (scan-core, denoms), the shipped maps, the syscall tables and the two scanners. Results stamped with another hash are stale.
// Pages, docs and the RTP labels (rtp-bands.js) are left out: changing them does not change what a ROM does.
// The ROM scanner (tools/classify.js) and a panel data file in tools/data/ count when they are present beside this file. A checkout without them gets a different hash, which only matters within one install.
// usage: node tools/engine.js (prints the hash)   require: const { engine } = require('./engine.js')
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const R = path.resolve(__dirname, '..');
const SOURCES = [
  ['web/js', f => /^mk6.*\.js$/.test(f) || f === 'scan-core.js' || f === 'denoms.js'],
  ['web/maps', f => f.endsWith('.json')],
  ['tools/data', f => f.endsWith('.json')],
  ['tools', f => f === 'classify.js' || f === 'shots.js'],
];
function engine() {
  const h = crypto.createHash('sha1');
  for (const [dir, keep] of SOURCES) {
    let names = [];
    try { names = fs.readdirSync(path.join(R, dir)).filter(keep).sort(); } catch (e) {}
    for (const f of names) { h.update(dir + '/' + f + '\0'); h.update(fs.readFileSync(path.join(R, dir, f))); }
  }
  return h.digest('hex').slice(0, 12);
}
module.exports = { engine };
if (require.main === module) console.log(engine());
