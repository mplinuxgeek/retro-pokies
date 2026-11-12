// Arabian Nights free games: during free games the ROM's own win scenes play (the host runs no win cycle of its own there, because the
// ROM's win records are one game behind at the moment the reels stop). Their blink must use the cell's cloud tile (IMG_a_feat_blank_<reel><row>),
// never the base game's light-blue blank (IMG_a_BLANK / IMG_REEL), while the cloud backdrop is up; the base game never shows the cloud tile.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const MK6 = require('../web/js/mk6.js'), { VM } = require('../web/js/mk6vm.js'), { Host } = require('../web/js/mk6host.js');
const map = require('../web/maps/arabian-nights.json');
const zip = path.join(process.env.ROMS || path.join(__dirname, '..', 'roms'), 'Arabian Nights.zip');
test('Arabian Nights free-game win flash uses the cell cloud tile', { skip: !fs.existsSync(zip) }, async () => {
  const rom = await MK6.openZip(fs.readFileSync(zip));
  const vm = new VM(rom, { syscalls: require('../tools/data/syscalls.json'), exports: require('../tools/data/exports.json'), options: { lineIdx: map.lineIdx, betIdx: map.betIdx } });
  const h = new Host(vm, { map, lines: 25, bet: 1, fast: true }); h.autoKeys = true; h.init(map.lineIdx, map.betIdx, h.bestRtpSet());
  const nm = i => (vm.db.byIndex(1, i) || {}).name || '';
  let frames = 0, cloud = 0, wins = 0, last = 0; const bad = [];
  const top = o => { let t = null, ti = -1; vm.display.items.forEach((d, i) => { if (d && !d.dead && d.visible && d.img !== undefined && d.x === o.x && d.y === o.y && (!t || d.prio > t.prio || (d.prio === t.prio && i > ti))) { t = d; ti = i; } }); return t; };
  for (let g = 0; g < 3000000 && wins < 30 && frames < 40000; g++) {
    h.credits = 1e6; if (!h.phase && !h.inFree) h.spin(h.featureStops()); if (!h.frame() && h.phase) break;
    const sky = vm.skyShowing(); if (h.inFree) frames++;
    if (h.inFree && h.map.freeOwnStops) { assert.equal(h.winCycle, null, 'the host runs no win cycle in free games'); }
    for (let r = 0; r < 5; r++) for (let w = 0; w < 3; w++) { const t = top({ x: 50 + 110 * r, y: 121 + 100 * w }); if (!t) continue; const n = nm(t.img);
      if (h.inFree && sky && /^IMG_(a_BLANK|REEL)/.test(n)) bad.push('free-game cell ' + r + w + ' shows ' + n);
      else if (h.inFree && /feat_blank/i.test(n)) cloud++;
      else if (!h.inFree && h.phase && /feat_blank/i.test(n)) bad.push('base-game cell ' + r + w + ' shows ' + n + ' (the cloud tile belongs to free games only)'); }
    if (h.inFree && h.credits !== last) { if (h.credits > last) wins++; last = h.credits; } else if (!h.inFree) last = h.credits;
  }
  assert.ok(frames > 1000 && cloud > 0, 'ran free games: ' + frames + ' frames, ' + cloud + ' cloud-tile cells seen');
  assert.deepEqual([...new Set(bad)], [], 'no light-blue tile in free games, no cloud tile in the base game');
});
