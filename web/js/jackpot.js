// Progressive jackpot levels for play.html.
// The OS meters belong to the emulator (mk6sys.js game2sys requests 5 and 6): per level i the level value is meter 0x95 + 2*i (cents), its fraction
// 0x96 + 2*i, the reserve 0x9d + 2*i and the reserve fraction 0x9e + 2*i. The ROM's bets grow them and a jackpot hit resets them. This file only
// follows the meters: it keeps the level values for the marquee, saves the four meters per level through a provider so the levels survive a reload,
// and seeds the saved meters into the VM before the first spin. It adds nothing of its own.
// A provider has
//   load()         the saved meters {id: value}, or null
//   save(meters)   store {id: value} for the levels
//   close()
// LocalProvider keeps them in this browser (localStorage). A network provider would post the meters to a server-owned pool for a game id and push
// other machines' changes back; contribute() on the pool is the hook for that and does nothing for now.
(function (root) {
  'use strict';
  const NAMES = { 1: ['JACKPOT'], 2: ['MAJOR', 'MINOR'], 3: ['GRAND', 'MAJOR', 'MINOR'], 4: ['GRAND', 'MAJOR', 'MINOR', 'MINI'] };

  const FAMILY = [0x95, 0x96, 0x9d, 0x9e];   // level value, its fraction, reserve, reserve fraction; level i uses id + 2*i

  class LocalProvider {
    constructor(key, store) { this.key = key; this.store = store || (typeof localStorage !== 'undefined' ? localStorage : null); }
    load() { try { const o = JSON.parse(this.store.getItem(this.key)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } }
    save(meters) { try { this.store.setItem(this.key, JSON.stringify(meters)); } catch (e) {} }
    close() {}
  }

  class JackpotPool {
    // opts: { provider, key (localStorage key for the default provider) }
    constructor(vm, opts) {
      opts = opts || {}; this.vm = vm; this.levels = []; this.vals = []; this.listeners = []; this.saved = {};
      let n = 0, recs = 0;
      try { n = vm.call('get_progressive_levels') | 0; recs = vm.call('Get_Data_From_Game_sys2game', 5, 0, 0, 0) >>> 0; } catch (e) { return; }
      if (n < 1 || n > 4 || recs < 0x8000000 || recs >= 0xc000000) return;
      for (let i = 0; i < n; i++) this.levels.push({ index: i, start: vm.mem.r32(recs + 12 * i) | 0 });
      if (this.levels.some(l => l.start <= 0)) { this.levels = []; return; }
      // names by rank, biggest first (the ROM's own level order is not always by size)
      const order = this.levels.map(l => l.index).sort((a, b) => this.levels[b].start - this.levels[a].start), names = NAMES[n];
      order.forEach((li, rank) => { this.levels[li].name = names[rank]; });
      this.provider = opts.provider || new LocalProvider(opts.key || 'mk6-jackpot');
      this.read = []; this.shown = []; this.rom = null; this.pend = null;
      this.hook();
      this.hookRom();
      this.seed();
    }
    get active() { return this.levels.length > 0; }
    ids() { const out = []; this.levels.forEach((l, i) => FAMILY.forEach(f => out.push(f + 2 * i))); return out; }
    // saved meters go into the VM before the first spin; a saved level below its start value is not trusted
    seed() {
      const m = this.vm.meters, saved = this.provider.load() || {};
      this.levels.forEach((l, i) => { const v = saved[FAMILY[0] + 2 * i];
        if (Number.isFinite(v) && v >= l.start) FAMILY.forEach(f => { const x = saved[f + 2 * i]; if (Number.isFinite(x)) m.set(f + 2 * i, x); }); });
      this.sync();
    }
    sync() { this.vals = this.levels.map((l, i) => this.vm.meters.get(0x95 + 2 * i) | 0); }
    // the ROM's growth (higher) and payouts (lower) both arrive as meter writes: take them, save, tell the marquee
    hook() {
      const m = this.vm.meters, set = m.set.bind(m), mine = new Set(this.ids());
      m.set = (id, v) => { const r = set(id, v); if (mine.has(id)) { this.persist(); if (FAMILY[0] <= id && (id - FAMILY[0]) % 2 === 0) { this.sync(); for (const f of this.listeners) f(this.view()); } } return r; };
    }
    // What the ROM's own jackpot box shows. The ROM reads the level meter (0x95 + 2*level) once a game, right after the bet fed the levels, and draws it
    // a little later, rounded down to whole credits (Dragon Magic at a $1 credit: 40222 cents shows "$ 402.00"). So the marquee does not follow the live
    // meter: it takes the value read at that moment and, when the ROM draws a money text within one credit below it, that text's amount, so both change
    // together. A ROM that prints "Jackpot: Major $900.00, Minor $10.00" as one line is followed from that text.
    hookRom() {
      const vm = this.vm, impl = vm.impl, n = this.levels.length, mem = vm.mem;
      for (const name of ['gmc_read_meter', 'acc_read_meter', 'acc_read_meter_3w']) { const f = impl[name]; if (!f) continue;
        impl[name] = (c, id, out) => { const r = f.call(vm, c, id, out), l = ((id & 0xffff) - FAMILY[0]) / 2;
          if (out && Number.isInteger(l) && l >= 0 && l < n) { const v = mem.r32(out) | 0; this.read[l] = v; this.shown[l] = undefined; this.pend = { l, v, t: vm.now }; Promise.resolve().then(() => this.emit()); } return r; }; }   // emit after the ROM's draw, if any, in the same run
      const dt = impl._drawtextDC; if (!dt) return;
      impl._drawtextDC = (c, dc, str, len, rc) => { const r = dt.call(vm, c, dc, str, len, rc);
        try { const t = vm.cstr(str), text = len >= 0 ? t.slice(0, len) : t; this.seen(text); } catch (e) {} return r; };
    }
    seen(text) {
      if (/jackpot\s*:/i.test(text)) {
        const m = [...text.matchAll(/([A-Za-z]+)\s*\$\s*([\d,]+(?:\.\d+)?)/g)];
        if (m.length) { this.rom = m.map(x => ({ name: x[1].toUpperCase(), cents: Math.round(parseFloat(x[2].replace(/,/g, '')) * 100) })).sort((x, y) => y.cents - x.cents).slice(0, 2); this.emit(); }
        return;
      }
      const p = this.pend; if (!p || this.vm.now - p.t > 1000) return;
      const m = /^\s*\$?\s*([\d,]+)\.(\d\d)\s*$/.exec(text); if (!m) return;
      const c = parseInt(m[1].replace(/,/g, ''), 10) * 100 + parseInt(m[2], 10), d = this.vm.options.denom || 1;
      if (c <= p.v && c > p.v - d) { this.shown[p.l] = c; this.pend = null; this.emit(); }
    }
    emit() { this.sync(); for (const f of this.listeners) f(this.view()); }
    persist() { const o = {}; for (const id of this.ids()) o[id] = this.vm.meters.get(id) | 0; this.provider.save(o); }
    // the pool adds no share of its own: the ROM grows its levels from the bet (game2sys request 6)
    contribute() {}
    // levels to show, biggest first, at most `max` (the marquee has room for two)
    view(max) { if (this.rom) return this.rom.slice(0, max || 2);
      return this.levels.map((l, i) => ({ index: i, name: l.name, cents: (this.shown[i] ?? this.read[i] ?? this.vals[i]) || l.start })).sort((a, b) => b.cents - a.cents).slice(0, max || 2); }
    onChange(f) { this.listeners.push(f); }
    close() { if (this.provider) this.provider.close(); }
  }

  const api = { JackpotPool, LocalProvider };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6JACKPOT = api;
})(typeof self !== 'undefined' ? self : this);
