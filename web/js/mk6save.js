// the game's battery-backed state, kept in this browser (IndexedDB) so a reload resumes an unfinished game:
// the meters (non-volatile meters), the game log (mk6sys: gmc_read_write_log records, keys and the host's free-game stops) and the host's own part
// (Host.saved). Not the ROM's working RAM (0x0cf00000, SH-4 area 3 SDRAM, lost at power-off): the ROM rebuilds its game from the log, and a restored
// copy would keep its one-time flags set (QOTN 0xcf01764, the reels' build-once flag) so the power-up would draw no reels. restore() puts them back before the
// ROM's start-up; the ROM then takes its own power-up path (Host.resume). Only play.html saves; the scanners never do.
(function (root) {
  'use strict';
  const V = 1;
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('mk6-saves', 1); r.onupgradeneeded = () => r.result.createObjectStore('saves'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('saves', mode), s = t.objectStore('saves'), q = fn(s); t.oncomplete = () => { db.close(); res(q && q.result); }; t.onerror = () => { db.close(); rej(t.error); }; }));
  function snapshot(vm, extra) {
    return Object.assign({ v: V, t: Date.now(), meters: [...vm.meters], log: JSON.parse(JSON.stringify(vm.gameLog || [])) }, extra);
  }
  // before Host.init: the meters and the log the ROM's power-up reads (gmc_initialise_game_log). A save's `ram` from an older save format is ignored
  function restore(vm, s) {
    vm.meters = new Map(s.meters); vm.powerUpLog = s.log;
  }
  // a denomination change or carry keeps the game log, not the game: the live game (ROM state, host part, meters) belongs to the old denomination and is
  // dropped, the logged games stay recallable (each entry holds its own meters, host part and denom e.d). carryLog: the entries that ended, with their denom
  const carryLog = s => { const L = ((s && s.log) || []).slice(); while (L.length && !L[L.length - 1].done) L.pop(); L.forEach(e => { if (!e.d) e.d = s.denom || 1; }); return L; };
  const demote = s => ({ v: V, t: Date.now(), meters: [], log: carryLog(s), denom: s.denom, variant: s.variant, logOnly: true });
  root.MK6SAVE = { V, snapshot, restore, carryLog, demote, get: id => tx('readonly', s => s.get(id)), put: (id, v) => tx('readwrite', s => s.put(v, id)), del: id => tx('readwrite', s => s.delete(id)) };
})(typeof window !== 'undefined' ? window : globalThis);
