// Headless check without SDL: boot a game, play N spins, save the last frame as a PNG and print the frame times.
// usage: node src/snap.js "<ROM zip>" [spins] [out.png]
const fs = require('fs'), { png } = require('./ui.js');
const { openGame, W, H } = require('./core.js');
(async () => {
  const [zip, n = 3, out = 'snap.png'] = process.argv.slice(2), g = await openGame(zip, { fast: true }), h = g.host;
  for (let s = 0; s < +n; s++) { h.credits = 1000; h.spin(); for (let k = 0; h.phase && k < 20000; k++) h.frame(); }
  h.credits = 1000; h.spin(); for (let k = 0; k < 40; k++) h.frame();   // mid-spin: reels moving
  const ts = []; let rgba; for (let i = 0; i < 60; i++) { const t = performance.now(); h.frame(); rgba = await g.frame(); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b); console.log(g.id, 'frame + compose ms: median', ts[30].toFixed(2), 'p95', ts[57].toFixed(2), '(60 fps needs < 16.5)');
  fs.writeFileSync(out, png(rgba, W, H)); console.log('wrote', out);
})().catch(e => { console.error(e); process.exit(1); });
