// Run every ROM for a fixed number of spins, then classify by RTP. Generic engine only, no per-ROM fixes.
// usage: node tools/classify.js [romsDir] [name-filter]   env: SPINS=500 JOBS=4 DRY=100 MINS=5 OUT=file (default <app>/data/rom-status.json; set for test runs) ONLY_NEW=1 (keep OUT's results, run only ROMs missing from it)
//        STALE=1 (also rerun results from other code, see below) FORCE=1 MIN_AGE_H=24 ONLY=<id>[,<id>] or * (just those ROMs, or all, merged into OUT)
// bails: no win in DRY (100) spins = Never pays; over MINS (5) minutes of spinning with no spin completed = Hangs (timed out); with spins completed the scan
// is truncated (i113: Cashman Tonight's ROM animates its own reels, about 8x the instructions per frame of QOTN, so 2500 spins overrun 5 min) and the
// label comes from the spins seen. Labels: web/js/rtp-bands.js.
// result: data/rom-status.json (one entry per ROM, stamped with engine: tools/engine.js hash and at: unix seconds) and a summary table on stdout.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const R = require('./app.js').dir;   // the app (web/, tools/data/); this file's own cache/ is beside it
const RB = require(R + '/web/js/rtp-bands.js'), SC = require(R + '/web/js/scan-core.js'), DN = require(R + '/web/js/denoms.js');
const dir = path.resolve(process.argv[2] || require('./app.js').roms);
const SPINS = +process.env.SPINS || 500, DRY = +process.env.DRY || 100, TIME = (+process.env.MINS || 5) * 60e3, FRAMES = 40000;
const OUT = process.env.OUT || R + '/data/rom-status.json', CACHE = __dirname + '/cache/maps';
const ENGINE = require(R + '/tools/engine.js').engine();

// a hit rate under 1% over 500+ spins means the engine is not really playing; RTP over 1.3 or a near-100% hit rate means a scaling or stuck-meter problem, so neither counts as working
function label(r) { return RB.label(r); }
const noteOf = r => r.stall ? 'stalled at ' + r.stall : r.truncated ? 'time budget: ' + r.spins + ' of ' + r.truncated.of + ' spins in ' + r.truncated.mins + ' min' : r.hasFree && r.features === 0 && r.spins >= 2500 ? 'no features seen (map has free-game counter)' : '';

async function one(file) {
  const MK6 = require(R + '/web/js/mk6.js'), { VM } = require(R + '/web/js/mk6vm.js'),
    { Host } = require(R + '/web/js/mk6host.js'), { discover } = require(R + '/web/js/mk6discover.js');
  const name = path.basename(file, '.zip'), id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const res = { name, id }, t0 = Date.now();
  try {
    const rom = await MK6.openZip(fs.readFileSync(file));
    const shipped = R + '/web/maps/' + id + '.json', cached = CACHE + '/' + id + '.json';
    let map; const td = Date.now();
    if (fs.existsSync(shipped)) map = JSON.parse(fs.readFileSync(shipped));
    else if (fs.existsSync(cached)) map = JSON.parse(fs.readFileSync(cached));
    else { map = await discover(rom, () => 0, {}); fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cached, JSON.stringify(map, null, 1)); }
    const touch = !!(map && map.touch);   // touch-screen multi-game ROMs (Players Choice, Cashman Tonight): the ROM runs the game, TouchHost plays MK6Emu's OS
    if (!touch && !(map && map.state && map.stopBuf && map.starter && Object.keys(map.lineKeys || {}).length && Object.keys(map.betKeys || {}).length))
      throw new Error('no valid map (discovery failed)');
    res.discoverSecs = +((Date.now() - td) / 1000).toFixed(1);
    const vm = new VM(rom, { syscalls: require(R + '/tools/data/syscalls.json'), exports: require(R + '/tools/data/exports.json'),
      options: { lineIdx: map.lineIdx ?? 1, betIdx: map.betIdx ?? 0, ...(DN.maxCost(map) ? { denom: DN.forMap(map).def } : {}) } });   // each game at its default denomination, as play.html (fixed-dollar jackpots)
    const ks = touch ? [] : Object.keys(map.lineKeys).map(Number), lines = touch ? 'touch' : Math.max(...ks), bets = touch ? [] : Object.keys(map.betKeys).map(Number);
    let h;
    if (touch) { const { TouchHost } = require(R + '/web/js/mk6touchhost.js'); h = new TouchHost(vm, { map, game: +(process.env.GAME ?? map.game ?? 0) }); h.init(); }
    else { h = new Host(vm, { map, lines, bet: bets[0] || 1, fast: true }); h.init(map.lineIdx ?? 1, map.betIdx ?? 0, h.bestRtpSet()); }   // the game's highest RTP set, as play.html
    let spins = 0, wins = 0, won = 0, bet = 0, stuck = 0, refused = 0, maxWin = 0, maxMult = 0, frames = 0, feats = 0, freeGames = 0, featWon = 0, gp = h.gameNo | 0;
    const ts = Date.now(); let timeout = false, truncated = false, stall = ''; const states = new Set();
    // the time budget: a ROM that completed spins is slow, not hung (its spins end, runSpin would have called a parked one), unless the budget ran out
    // inside one spin that had already taken longer than runSpin's wall-clock idle rule allows
    const over = (t1, rs) => { if (spins && !(rs && rs.expired && Date.now() - t1 > 25000)) truncated = { of: SPINS, mins: TIME / 60e3 }; else timeout = true; };
    while (spins < SPINS && !(wins === 0 && spins >= DRY)) {
      if (Date.now() - ts > TIME) { over(); break; }
      h.credits = 100000;
      if (!h.spin()) { refused++; break; }
      const t1 = Date.now(), rs = SC.runSpin(h, { max: FRAMES * 5, states, expired: () => Date.now() - ts > TIME }); const k = rs.k; frames += k;
      if (rs.expired || Date.now() - ts > TIME) { over(t1, rs); break; }
      if (rs.stalled) { stuck++; stall = 'spin ' + (spins + 1) + ': ' + rs.why; break; }
      spins++;
      const dg = (h.gameNo | 0) - gp; gp = h.gameNo | 0;   // gameNo moves once per feature trigger plus once per free game
      if (dg > 1) { feats++; freeGames += dg - 1; featWon += h.last ? h.last.win : 0; }
      const w = h.last ? h.last.win : 0;
      bet += h.last ? h.last.cost : 0; won += w; if (w > 0) wins++;
      if (w > maxWin) maxWin = w; if (h.last && h.last.cost && w / h.last.cost > maxMult) maxMult = w / h.last.cost;
    }
    const ss = (Date.now() - ts) / 1000;
    Object.assign(res, { lines, bets: bets.join('/'), denom: DN.forMap(map).def, hasWin: !!map.win, hasFree: !!map.freeCount, spins, wins, stuck, stall, states: [...states].sort((a, b) => a - b).join(','), refused, timeout, truncated,
      rtp: bet ? +(won / bet).toFixed(3) : 0, hit: spins ? +(wins / spins).toFixed(3) : 0, bet, won, maxWin, maxMult: +maxMult.toFixed(1),
      features: feats, freeGames, featRtp: bet ? +(featWon / bet).toFixed(3) : 0, spinSecs: +ss.toFixed(1), spinsPerSec: ss ? +(spins / ss).toFixed(1) : 0, framesPerSpin: spins ? (frames / spins) | 0 : 0 });
  } catch (e) { res.error = String(e.message || e).slice(0, 200); }
  res.status = label(res); res.note = noteOf(res); res.secs = ((Date.now() - t0) / 1000) | 0;
  return res;
}

if (process.argv[2] === '--one') {
  one(process.argv[3]).then(r => { process.stdout.write('\n@@' + JSON.stringify(r) + '\n'); process.exit(0); });
} else {
  const filt = (process.argv[3] || '').toLowerCase();
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.zip') && f.toLowerCase().includes(filt)).sort().map(f => path.join(dir, f));
  // ONLY_NEW=1: keep the results already in OUT and test only the ROMs that have none; new results are merged in.
  // STALE=1 (the LAN scanner): the same, plus the ROMs whose result came from other code (its engine stamp differs) and is at least
  // MIN_AGE_H hours old (default 24; FORCE=1 drops the age rule), oldest result first. ONLY=<id>[,<id>]: just those ROMs, merged in.
  let kept = [];
  const nameOf = f => path.basename(f, '.zip'), idOf = f => nameOf(f).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const STALE = process.env.STALE === '1';
  if (process.env.ONLY_NEW === '1' || STALE || process.env.ONLY) { try { kept = JSON.parse(fs.readFileSync(OUT)); } catch (e) { kept = []; } }
  if (process.env.ONLY) {
    const ids = new Set(process.env.ONLY.split(','));
    files = files.filter(f => ids.has('*') || ids.has(idOf(f)));
  } else if (process.env.ONLY_NEW === '1' || STALE) {
    const byName = new Map(kept.map(r => [r.name, r])), now = Date.now() / 1000, minAge = +(process.env.MIN_AGE_H ?? 24) * 3600;
    const due = r => !r || (STALE && r.engine !== ENGINE && (process.env.FORCE === '1' || now - (r.at || 0) >= minAge));
    files = files.filter(f => due(byName.get(nameOf(f)))).sort((a, b) => ((byName.get(nameOf(a)) || {}).at || 0) - ((byName.get(nameOf(b)) || {}).at || 0));
    console.log(`${kept.length} ROMs already classified (engine ${ENGINE}), ${files.length} to run`);
  }
  const JOBS = +process.env.JOBS || 4, results = []; let next = 0, live = 0;
  // atomic: write a temp file in the same dir, then rename over the db, so readers never see a partial file
  const save = () => {
    const names = new Set(results.map(r => r.name)), rows = kept.filter(r => !names.has(r.name)).concat(results);
    const t = OUT + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows.sort((a, b) => a.name.localeCompare(b.name)), null, 1)); fs.renameSync(t, OUT);
  };
  if (!files.length) console.log('nothing to run');
  const launch = () => {
    while (live < JOBS && next < files.length) {
      const f = files[next++]; live++;
      cp.execFile('node', [__filename, '--one', f], { maxBuffer: 1 << 26, timeout: (TIME / 60e3 + 3) * 60e3, killSignal: 'SIGKILL' }, (err, out) => {
        const m = /@@(.*)\n/.exec(out || '');
        // a child stuck inside one synchronous VM call (init, discovery, spin) cannot check its own clock, so the parent kills it
        const killed = !m && err && err.killed, r = m ? JSON.parse(m[1]) : killed ? { name: path.basename(f, '.zip'), id: path.basename(f, '.zip').toLowerCase().replace(/[^a-z0-9]+/g, '-'), timeout: true, error: 'hung in a single VM call, killed after ' + (TIME / 60e3 + 3) + ' min', status: RB.L.timeout }
          : { name: path.basename(f, '.zip'), error: 'crashed: ' + String(err && err.message).slice(0, 120), status: RB.L.error };
        r.engine = ENGINE; r.at = Math.floor(Date.now() / 1000);
        results.push(r); save(); live--;
        console.log(r.status.padEnd(26), String(r.rtp ?? '').padEnd(6), `${r.wins ?? '-'}w/${r.spins ?? '-'}s`.padEnd(10), r.name, r.error || '');
        if (next >= files.length && !live) {
          const c = {}; results.forEach(x => c[x.status] = (c[x.status] || 0) + 1); console.log(c);
        } else launch();
      });
    }
  };
  launch();
}
