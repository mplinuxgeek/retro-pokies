// Discover the per-game addresses and key codes the Host needs; writes web/maps/<id>.json.
//   node emu/discover.js "Where Is The Gold" where-is-the-gold [lines] [maxbet]
const fs = require('fs');
const path = require('path');
const MK6 = require('../web/js/mk6.js');
const { discover } = require('../web/js/mk6discover.js');

function findRom(name) {
  const dirs = [
    process.env.ROMS || path.join(__dirname, '../roms'),
    '/app/roms',
    'roms'
  ];
  const targetZip = (name.endsWith('.zip') ? name : name + '.zip').toLowerCase();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const direct = path.join(d, name.endsWith('.zip') ? name : name + '.zip');
    if (fs.existsSync(direct)) return direct;
    try {
      const files = fs.readdirSync(d);
      const match = files.find(f => f.toLowerCase() === targetZip);
      if (match) return path.join(d, match);
    } catch (e) {}
  }
  return null;
}

(async () => {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node emu/discover.js "<RomName>" [id] [lines] [maxbet]');
    process.exit(1);
  }
  const id = process.argv[3] || name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const romPath = findRom(name);
  if (!romPath) {
    console.error(`ROM not found for "${name}"`);
    process.exit(1);
  }

  const rom = await MK6.openZip(fs.readFileSync(romPath));
  const map = await discover(rom, (...a) => (!process.env.CFG && /^config \d/.test(a.join(' '))) ? 0 : console.log(' ', ...a), { lines: +process.argv[4] || 0, bet: +process.argv[5] || 0 });
  const outDir = path.join(__dirname, '../web/maps');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, id + '.json');
  fs.writeFileSync(outFile, JSON.stringify(map, null, 1));
  console.log('wrote ' + outFile);
})();
