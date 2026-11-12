// Per-game denominations, shared by play.html and the scanner (scan-worker.js) so they agree.
// The ROMs take any denomination (on MK6 the operator sets it), but a game's jackpots are fixed dollar amounts and its odds can scale with the
// money bet, so a game is offered the denominations at which its biggest spin costs between $1 and $120, and starts at the one closest to $10.
(function (root) {
  'use strict';
  // the menu offers every value of the ROM's get_token_credit(0,0,i) list (13 values, 1c..$100 on every ROM seen); list = ALL, def = the ROM's first enabled value
  const ALL = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];   // cents
  const SUITABLE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];   // guess of a sensible default (biggest spin $1-$120, nearest $10), used only when the ROM cannot be asked (scanners boot the VM at it)
  const MIN_SPIN = 100, MAX_SPIN = 12000, TARGET_SPIN = 1000;   // cents
  const FALLBACK = { list: [1, 2, 5, 10, 20], def: 10, maxCost: 0 };   // maps without line and bet keys (touch games)

  // credits of the game's biggest spin: the dearest line key (labelled keys such as Outback Jack's "30" count) times the largest bet key
  function maxCost(map) {
    const l = Object.keys((map && map.lineKeys) || {}).map(Number).filter(Number.isFinite), b = Object.keys((map && map.betKeys) || {}).map(Number).filter(Number.isFinite);
    const lc = (map && map.lineCost) || {}, credits = n => lc[n] || n;   // map.lineCost: what the ROM charges per bet unit for a line key (Lions: 50 lines cost 25)
    return l.length && b.length ? Math.max(...l.map(credits)) * Math.max(...b) : 0;
  }
  // the default: the first value i whose get_token_credit(0,1,i) (enabled flag) is 1; needs the ROM initialised. null if none/unavailable
  function romDefault(vm) {
    try { for (let i = 0; i < 40; i++) { const v = vm.call('get_token_credit', 0, 0, i) | 0; if (v <= 0) break; if ((vm.call('get_token_credit', 0, 1, i) | 0) === 1) return ALL.includes(v) ? v : null; } } catch (e) {}
    return null;
  }
  // { list: offered denominations (cents), def: the default, maxCost }; with an initialised vm the default is the ROM's, else the guess
  function forMap(map, vm) {
    const rd = vm ? romDefault(vm) : null, mc = maxCost(map);
    if (!mc) return Object.assign({}, FALLBACK, { list: ALL.slice(), def: rd || FALLBACK.def });
    let list = SUITABLE.filter(d => mc * d >= MIN_SPIN && mc * d <= MAX_SPIN);
    if (!list.length) list = [SUITABLE.reduce((a, d) => Math.abs(Math.log(mc * d / TARGET_SPIN)) < Math.abs(Math.log(mc * a / TARGET_SPIN)) ? d : a)];
    const def = list.reduce((a, d) => Math.abs(Math.log(mc * d / TARGET_SPIN)) < Math.abs(Math.log(mc * a / TARGET_SPIN)) ? d : a);
    return { list: ALL.slice(), def: rd || def, maxCost: mc };
  }
  const label = d => d >= 100 ? '$' + d / 100 : d + 'c';

  const api = { ALL, maxCost, forMap, romDefault, label };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6DENOM = api;
})(typeof self !== 'undefined' ? self : this);
