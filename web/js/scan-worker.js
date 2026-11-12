// Worker for debug.html: runs one ROM headless for N spins and classifies it.
// in: { id, name, buf, map?, cfg: { spins, dry, mins, frames } }  out: { id, progress } | { id, map } | { id, result }
importScripts('mk6.js', 'sh4.js', 'avl.js', 'flic.js', 'mk6tables.js', 'mk6sys.js', 'jpeg.js', 'mk6vm.js', 'mk6host.js', 'mk6touchhost.js', 'mk6discover.js', 'rtp-bands.js', 'scan-core.js', 'denoms.js');
const RB = self.RTP_BANDS, SC = self.SCAN_CORE;
console.warn = () => {};   // discovery spawns hundreds of VMs; each warn line is retained by DevTools
// a hit rate under 1% over 500+ spins means the engine is not really playing; RTP over 1.3 or a near-100% hit rate means a scaling or stuck-meter problem, so neither counts as working
const label = r => RB.label(r);
const noteOf = r => r.stall ? 'stalled at ' + r.stall : r.truncated ? 'time budget: ' + r.spins + ' of ' + r.truncated.of + ' spins in ' + r.truncated.mins + ' min' : r.hasFree && r.features === 0 && r.spins >= 2500 ? 'no features seen (map has free-game counter)' : '';
const validMap = m => m && (m.touch || (m.state && m.stopBuf && m.starter && Object.keys(m.lineKeys || {}).length && Object.keys(m.betKeys || {}).length));   // touch: Players Choice / Cashman Tonight (mk6touchhost.js)
onmessage = async e => {
  const { id, name, buf, cfg } = e.data, res = { name, id }, t0 = Date.now(), say = o => postMessage(Object.assign({ id }, o));
  try {
    const rom = await MK6.openZip(new Uint8Array(buf)); let map = e.data.map; const td = Date.now();
    { let shipped = null; try { shipped = await (await fetch('../maps/' + id + '.json', { cache: 'no-cache' })).json(); } catch (x) {} if (validMap(shipped)) map = shipped; }   // a shipped map wins over a stale browser-discovered one (as in play.html)
    if (!validMap(map)) { say({ progress: 'discovering map' }); map = await MK6DISCOVER.discover(rom, () => 0, {}); if (validMap(map)) say({ map }); }
    if (!validMap(map)) throw new Error('no valid map (discovery failed)');
    res.discoverSecs = +((Date.now() - td) / 1000).toFixed(1);
    const vm = new MK6VM.VM(rom, Object.assign({ options: { lineIdx: map.lineIdx ?? 1, betIdx: map.betIdx ?? 0, ...(MK6DENOM.maxCost(map) ? { denom: MK6DENOM.forMap(map).def } : {}) } }, MK6TABLES));   // each game at its default denomination, as play.html
    const touch = !!map.touch, ks = touch ? [] : Object.keys(map.lineKeys).map(Number), lines = touch ? 'touch' : Math.max(...ks), bets = touch ? [] : Object.keys(map.betKeys).map(Number);
    let h; if (touch) { h = new MK6TOUCHHOST.TouchHost(vm, { map, game: map.game | 0 }); h.init(); } else { h = new MK6HOST.Host(vm, { map, lines, bet: bets[0] || 1, fast: true }); h.init(map.lineIdx ?? 1, map.betIdx ?? 0, h.bestRtpSet()); }
    let spins = 0, wins = 0, won = 0, bet = 0, stuck = 0, refused = 0, maxWin = 0, maxMult = 0, frames = 0, last = 0, feats = 0, freeGames = 0, featWon = 0; const g0 = h.gameNo | 0, ts = Date.now(); let timeout = false, truncated = false, gp = null, stall = ''; const states = new Set();
    const over = (t1, rs) => { if (spins && !(rs && rs.expired && Date.now() - t1 > 25000)) truncated = { of: cfg.spins, mins: cfg.mins }; else timeout = true; };   // spins completed = slow, not hung
    while (spins < cfg.spins && !(wins === 0 && spins >= cfg.dry)) {
      if (Date.now() - ts > cfg.mins * 60e3) { over(); break; }
      h.credits = 100000; if (gp == null) gp = h.gameNo | 0;
      if (!h.spin()) { refused++; break; }
      const t1 = Date.now(), rs = SC.runSpin(h, { max: cfg.frames * 5, states, expired: () => Date.now() - ts > cfg.mins * 60e3 }); const k = rs.k; frames += k;
      if (rs.expired || Date.now() - ts > cfg.mins * 60e3) { over(t1, rs); break; }
      if (rs.stalled) { stuck++; stall = 'spin ' + (spins + 1) + ': ' + rs.why; break; }
      spins++;
      const dg = (h.gameNo | 0) - gp; gp = h.gameNo | 0;   // gameNo moves once per feature trigger plus once per free game; dg 1 alone is an ordinary game
      if (dg > 1) { feats++; freeGames += dg - 1; featWon += h.last ? h.last.win : 0; }
      const w = h.last ? h.last.win : 0;
      bet += h.last ? h.last.cost : 0; won += w; if (w > 0) wins++;
      if (w > maxWin) maxWin = w; if (h.last && h.last.cost && w / h.last.cost > maxMult) maxMult = w / h.last.cost;
      if (Date.now() - last > 250) { last = Date.now(); say({ progress: 'spinning', spins, wins, rtp: bet ? won / bet : 0, feats }); await new Promise(r => setTimeout(r, 0)); }
    }
    const ss = (Date.now() - ts) / 1000;
    Object.assign(res, { lines, bets: bets.join('/'), denom: MK6DENOM.forMap(map).def, hasWin: !!map.win, hasFree: !!map.freeCount, spins, wins, stuck, stall, states: [...states].sort((a, b) => a - b).join(','), refused, timeout, truncated,
      rtp: bet ? +(won / bet).toFixed(3) : 0, hit: spins ? +(wins / spins).toFixed(3) : 0, bet, won, maxWin, maxMult: +maxMult.toFixed(1),
      features: feats, freeGames, featRtp: bet ? +(featWon / bet).toFixed(3) : 0, spinSecs: +ss.toFixed(1), spinsPerSec: ss ? +(spins / ss).toFixed(1) : 0, framesPerSpin: spins ? (frames / spins) | 0 : 0 });
  } catch (err) { res.error = String(err && err.message || err).slice(0, 200); }
  res.status = label(res); res.note = noteOf(res); res.secs = ((Date.now() - t0) / 1000) | 0;
  say({ result: res });
};
