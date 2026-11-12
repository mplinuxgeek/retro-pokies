// The app without a window: the selector lists the ROMs, a game launches from it, the menu opens, the denomination changes and the
// money is kept. Needs ROMS (a folder with Queen Of The Nile.zip); settings go to a temporary file, not the user's.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const { App, settingsStore } = require('../src/app.js');
const ROMS = process.env.ROMS;

test('selector, launch, menu, denomination', { skip: !ROMS && 'set ROMS' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpd-')), st = settingsStore(path.join(tmp, 's.json'));
  const app = new App({ romDir: ROMS, settings: st, shotDir: tmp });
  await app.ready; assert.ok(app.games.length > 0 && app.selecting);
  await app.tick(16);
  'queen of the nile'.split('').forEach(c => app.text(c));
  const g = app.sel.list[app.sel.sel]; assert.strictEqual(g.id, 'queen-of-the-nile', 'filter finds the game');
  app.key('return'); while (app.loading !== null || !app.game) await new Promise(r => setTimeout(r, 20));
  assert.ok(!app.selecting && app.game.id === 'queen-of-the-nile');
  const money = () => app.S.wallet + app.game.host.credits * app.game.denom, m0 = money();
  for (let i = 0; i < 30; i++) await app.tick(17);
  app.key('f10'); assert.ok(app.menu.open);
  await app.tick(17);
  const d = app.menu.items.findIndex(it => /^Denomination/.test(it.label || '')); assert.ok(d > 0); app.menu.sel = d; app.menu.key('return');
  const to = app.game.denom === 1 ? 2 : 1, i = app.menu.items.findIndex(it => (it.label || '').trim().startsWith(to + 'c per')); app.menu.sel = i; app.menu.key('return');
  while (app.loading !== null || app.game.denom !== to) await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(money(), m0, 'money kept across the denomination change');
  // a win waits at the take-win prompt (the gamble offer) for the player: take it
  app.key('space'); for (let i = 0; i < 600 && app.game.host.phase; i++) { const g = app.game.host.gamble; if (g && !g.early && !g.screen && !g.busy) app.game.host.collect(); await app.tick(17); }
  assert.ok(!app.game.host.phase, 'spin finished');
  // control panel: a bet key selects the bet, a play key selects the lines and spins, the note acceptor adds a note
  await app.tick(17); assert.ok(app.panel && app.cab.panel && app.screen.h === app.cab.H && app.cab.H > app.cab.panel.y, 'panel drawn under the game');
  const h = app.game.host, bets = Object.keys(h.map.betKeys).map(Number), lines = Object.keys(h.map.lineKeys).map(Number);
  app.panelKey(h.map.betKeys[bets[1]]); assert.strictEqual(h.bet, bets[1], 'bet key');
  const c0 = h.credits; app.panelKey(h.map.lineKeys[lines[0]]); assert.strictEqual(h.lines, lines[0], 'play key selects lines'); assert.ok(h.phase, 'play key spins');
  for (let i = 0; i < 400 && h.phase; i++) await app.tick(17);
  const c1 = h.credits; app.panelKey(99); assert.strictEqual(h.credits, c1 + 10000 / app.game.denom, 'note acceptor'); assert.ok(c0 !== undefined);
  app.key('tab'); assert.ok(app.selecting); await app.tick(17);
  app.quit(); fs.rmSync(tmp, { recursive: true });
});
