// Used by js/scan-worker.js: run one spin to its end and tell a long feature chain from a real stall.
// A spin is stalled when neither the game state nor the game number has changed for `idle` frames (a parked prompt waiting for a key the host did not send)
// or when it runs past `max` frames in total; a free-game chain keeps changing state, so it may run long. New reel stops count as progress too: some
// ROMs play all their free games in one state (Wild Goose: state 17, 15 games retriggering to 45, about 10,000 frames)
(function (root) {
  function runSpin(h, o) {
    const idle = o.idle || h.idleFrames || 6000, max = o.max || 200000, st = () => h.vm.mem.r32(h.map.state), seen = o.states || new Set();
    const t0 = Date.now(), idleMs = o.idleMs || 25000; let sinceMs = t0, k = 0, last = st(), lastNo = h.gameNo, since = 0, tail = [last]; seen.add(last);
    const sb = h.map.stopBuf, stops = () => { if (!sb) return ''; let x = ''; for (let i = 0; i < 5; i++) x += (h.vm.mem.r32(sb + 4 * i) | 0) + ','; return x; }; let lastStops = stops(); let nTasks = h.vm.tasks.length;
    while (h.frame()) {
      k++;
      const s = st();
      if (h.gameNo !== lastNo) { lastNo = h.gameNo; since = k; sinceMs = Date.now(); }
      if ((k & 255) === 0 && h.freeCountUp && h.freeCountUp()) { since = k; sinceMs = Date.now(); }   // a free series counting up a big win (Wild Waratah: 2000x the bet, over 2 minutes): not parked; the host caps it
      if ((k & 15) === 0 && h.vm.tasks.length !== nTasks) { nTasks = h.vm.tasks.length; since = k; sinceMs = Date.now(); }   // the ROM started a new task: still presenting (Eye Of The Tiger state 12: the tiger-eyes win restarts win_inc every ~620 frames, 6377 frames for a 792 win; Outback Jack the same). A parked game starts none; `max` still bounds a loop
      if ((k & 15) === 0) { const x = stops(); if (x !== lastStops) { lastStops = x; since = k; sinceMs = Date.now(); } }   // a free game finished: its win presentation keeps the state at 6 for up to 12 s per game
      if (s !== last) { last = s; since = k; sinceMs = Date.now(); seen.add(s); tail.push(s); if (tail.length > 12) tail.shift(); }
      const slow = k - since > 600 && (k & 63) === 0 && Date.now() - sinceMs > idleMs;   // a game busy-looping with very slow frames (Touch Of Paradice: touch-hotspot polling, 70 ms a frame) would take minutes to reach the frame limit
      if (k - since > idle || k >= max || slow) return { k, stalled: true, why: describe(h, last, tail, k - since > idle ? 'parked ' + (k - since) + ' frames' : slow ? 'parked ' + (k - since) + ' frames over ' + ((Date.now() - sinceMs) / 1000 | 0) + ' s' : 'over ' + max + ' frames') };
      if ((k & 255) === 0 && o.expired && o.expired()) return { k, expired: true };
    }
    return { k, stalled: false };
  }
  function describe(h, state, tail, how) {
    const kw = h.vm.keyWait, keys = kw && kw.keys ? kw.keys.join(',') : '';
    return 'state ' + state + ' ' + how + (kw ? ', waiting for key ' + keys : ', no key wait') + '; states ' + tail.join('>');
  }
  const api = { runSpin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SCAN_CORE = api;
})(typeof self !== 'undefined' ? self : this);
