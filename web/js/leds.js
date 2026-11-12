// Button lamp output to real cabinet hardware. The ROM sets each button lamp with gos_control(13, state, 3, key), which mk6sys.js keeps
// in vm.lamps[key] = { state, t, seq }: 0 LIT, 1 off, 2 fast flash, 3 slow flash (a lamp is drawn lit when its output bit is clear;
// on all of keys 0-5 and 7-15: key 14 = 0 is the chosen bet at idle, 1 is dark. Key 6 never lights on the original panel). This file turns that into a lamp model (key -> {on, flash}) that
// emits only on change, a per-cabinet mapping (ROM key -> output channel), and output drivers behind one interface: open(), set(mask, flashMask,
// slowMask), close(). Nothing here runs unless a page builds a LampOutput: play.html does so only with a saved LED config (localStorage mk6-leds).
// Flash timing matches the original panel: fast 430 ms on / 330 off, slow 760 / 760, every lamp on
// one shared clock with each slow edge on a fast on-edge. Masks are 32-bit numbers (channel n = bit n): a WS2811 chain of 10 chips is 30 channels.
(function (root) {
  'use strict';
  const FLASH = { fast: { on: 430, off: 330 }, slow: { on: 760, off: 760 } };
  // shared blink clock: which flashing lamps are lit at wall time t (ms since any origin). The period starts with the on phase, as the original timer does.
  // Periods 760 and 1520: slow is two fast periods, so t = 0 starts both. F is the flash-rate setting (config 'flash'), the default rates when absent
  const ph = (t, r) => { const p = r.on + r.off; return ((t % p) + p) % p < r.on; };
  const flashPhase = (t, F = FLASH) => ({ fast: ph(t, F.fast), slow: ph(t, F.slow) });
  const FLASH_OF = [null, null, 'fast', 'slow'];   // ROM state -> flash rate (0 steady lit, 1 off)
  // ROM key names on the usual panel (get_key_text per game; these are the common ones for the test page and configs)
  const KEY_NAMES = { 0: 'Collect / Take Win', 1: 'Play 1', 2: 'Play 2', 3: 'Play 3', 4: 'Play 4', 5: 'Play 5', 6: 'Game Rules / Feature 6', 7: 'Feature / Extra 7', 8: 'Key 8', 9: 'Key 9', 10: 'Bet 5', 11: 'Bet 4', 12: 'Bet 3', 13: 'Bet 2', 14: 'Bet 1', 15: 'Gamble' };

  // Lamp model: reads vm.lamps and keeps { key: { on, flash } } where flash is null, 'fast' or 'slow'; onChange(lamps) fires only when a lamp changed.
  // Also usable without a VM: set(key, state) feeds it by hand (the test page). A lamp the ROM never set is absent, which drivers treat as off.
  class LampModel {
    constructor(vm) { this.vm = vm; this.lamps = {}; this.seq = -1; this.onChange = null; }
    // true when something changed. Cheap enough per frame: vm.lampSeq moves only on a gos_control(13) call, so most polls return at once
    poll() { const vm = this.vm; if (!vm || (vm.lampSeq | 0) === this.seq) return false; this.seq = vm.lampSeq | 0; let changed = false;
      for (const k of Object.keys(vm.lamps || {})) changed = this.apply(+k, vm.lamps[k].state) || changed;
      if (changed && this.onChange) this.onChange(this.lamps); return changed; }
    set(key, state) { const c = this.apply(key, state); if (c && this.onChange) this.onChange(this.lamps); return c; }
    // ROM state 0 is lit, 1 is off, 2 and 3 flash. Any other value draws nothing: off here
    apply(key, state) { const on = state === 0 || state === 2 || state === 3, flash = FLASH_OF[state & 3] || null, o = this.lamps[key];
      if (o && o.on === on && o.flash === flash) return false; this.lamps[key] = { on, flash }; return true; }
    clear() { this.lamps = {}; this.seq = -1; if (this.onChange) this.onChange(this.lamps); }
  }

  // Cabinet mapping: { name, channels: { romKey: channel }, games: { gameId: { romKey: channel } } }. games overrides per game (feature-bet keys 6/7,
  // labelled play keys). Channel numbers are the driver's outputs: PacDrive LED 0-15, serial bit n, or WS2811 chip floor(n / 3) colour n % 3.
  class Cabinet {
    constructor(cfg, gameId) { cfg = cfg || {}; this.name = cfg.name || 'default'; this.map = Object.assign({}, cfg.channels || {}, (cfg.games || {})[gameId] || {}); }
    channel(key) { const c = this.map[key]; return c === undefined ? -1 : c | 0; }
    // the three masks a driver takes, from a lamp model: lit (steady or flashing), flashing at all, and the slow-rate subset
    masks(lamps) { let on = 0, flash = 0, slow = 0; for (const k of Object.keys(lamps)) { const c = this.channel(k), l = lamps[k]; if (c < 0 || c > 31 || !l.on) continue;
      on |= 1 << c; if (l.flash) flash |= 1 << c; if (l.flash === 'slow') slow |= 1 << c; } return { on: on >>> 0, flash: flash >>> 0, slow: slow >>> 0 }; }
    channels() { return Object.values(this.map).map(Number); }
  }
  // Default cabinet: the 14 outputs of KingHavok's EmulateLEDs.ahk order (PacDrive LEDs 0-13), plus keys 6 and 7 on 12 and 13
  const DEFAULT_CABINET = { name: 'default', channels: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 14: 6, 13: 7, 12: 8, 11: 9, 10: 10, 15: 11, 7: 12, 6: 13 }, games: {} };

  // Output drivers. Each has open(), set(on, flash, slow) with the three masks, close(). flashes = true means the device blinks flashing channels
  // itself (serial firmware, WLED preset), so the host sends masks only on change. Without it the LampOutput ticker toggles the on mask on the shared
  // clock and set() gets the lit-now mask with flash = 0. Masks are 32-bit; a driver with fewer outputs ignores the high bits.
  const hex = n => (n >>> 0).toString(16).padStart(8, '0');
  // WS2811 chips the button channels take: 3 outputs a chip. channels is the cabinet mapping object (highest channel + 1) or a count
  const chipsOf = ch => { const n = typeof ch === 'number' ? ch : ch && Object.keys(ch).length ? Math.max(...Object.values(ch).map(Number)) + 1 : 32; return Math.max(1, Math.ceil(n / 3)); };
  // light-show config with the strip placed after the button chips when the config does not say, so the show never paints over a button
  const showConfig = cfg => Object.assign({ offset: (cfg.buttonOffset | 0) + chipsOf(cfg.channels) }, cfg.lightshow);
  // In-memory driver for tests and the test page: keeps every frame it was given and reports the latest state through onSet
  class MockDriver {
    constructor(opts = {}) { this.opts = opts; this.flashes = !!opts.flashes; this.calls = []; this.last = null; this.onSet = null; this.opened = false; this.pixelsSeen = null; }
    async open() { this.opened = true; }
    async set(on, flash, slow) { this.last = { on: on >>> 0, flash: flash >>> 0, slow: slow >>> 0 }; this.calls.push(this.last); if (this.onSet) this.onSet(this.last); }
    async pixels(rgb, offset = 0) { this.pixelsSeen = { rgb: Array.from(rgb), offset }; if (this.onPixels) this.onPixels(rgb, offset); }
    async preset(id) { this.presetSeen = id; if (this.onPreset) this.onPreset(id); }
    async close() { this.opened = false; }
  }
  // Serial line protocol: 'L <on hex> <flash hex> <slow hex>\n' per change, 8 hex digits each. A firmware that cannot flash ignores the last two
  // (the host then flashes for it: set flashes = false in the config). WebSerial needs a user gesture before requestPort, so open() is called from a button
  class SerialDriver {
    constructor(opts = {}) { this.opts = opts; this.flashes = opts.flashes !== false; this.port = null; this.writer = null; }
    async open() { const ser = (root.navigator || {}).serial; if (!ser) throw new Error('WebSerial not available (Chrome / Edge on https or localhost)');
      this.port = this.opts.port || (await ser.getPorts())[0] || await ser.requestPort();   /* a port granted before opens without a gesture */ await this.port.open({ baudRate: this.opts.baud || 115200 }); this.writer = this.port.writable.getWriter(); }
    frame(on, flash, slow) { return 'L ' + hex(on) + ' ' + hex(flash) + ' ' + hex(slow) + '\n'; }
    async set(on, flash, slow) { if (this.writer) await this.writer.write(new TextEncoder().encode(this.frame(on, flash, slow))); }
    async close() { try { if (this.writer) { await this.writer.write(new TextEncoder().encode(this.frame(0, 0, 0))); this.writer.releaseLock(); } if (this.port) await this.port.close(); } finally { this.writer = this.port = null; } }
  }
  // WLED on an ESP32 driving WS2811 chips: each chip is one WLED "pixel" whose R, G and B outputs are three button LEDs (channel n = pixel floor(n/3),
  // colour n%3), at pixel offset buttonOffset so a strip can share the chain. Two transports: the JSON API over HTTP (browser and Node; a
  // 'seg.i' per-pixel write, http://<host>/json/state) and DDP over UDP (Node only: browsers have no UDP; port 4048, the realtime protocol WLED
  // accepts without configuration). pixels(rgb, offset) writes raw RGB triples for the light show; preset(id) switches a WLED preset.
  class WledDriver {
    constructor(opts = {}) { this.opts = opts; this.host = opts.host || 'wled.local'; this.bri = opts.brightness === undefined ? 255 : opts.brightness | 0; this.off = opts.buttonOffset | 0; this.flashes = false; this.udp = null; this.seq = 0; this.chips = chipsOf(opts.channels); }
    async open() {
      if (this.opts.transport === 'ddp') { const dgram = typeof require !== 'undefined' ? require('dgram') : null; if (!dgram) throw new Error('DDP needs Node (UDP)'); this.udp = dgram.createSocket('udp4'); }
      else if (!this.opts.fetch && typeof fetch === 'undefined') throw new Error('no fetch for the WLED JSON API');
    }
    // DDP packet: 10-byte header (flags 0x41 = version 1 + push, sequence, data type 0x01 RGB 8-bit, destination 1, offset in bytes BE32, length BE16) + RGB
    ddp(rgb, pixelOffset) { const b = new Uint8Array(10 + rgb.length), off = pixelOffset * 3; b[0] = 0x41; b[1] = (this.seq = (this.seq % 15) + 1); b[2] = 0x01; b[3] = 1;
      b[4] = off >>> 24; b[5] = (off >>> 16) & 255; b[6] = (off >>> 8) & 255; b[7] = off & 255; b[8] = rgb.length >>> 8; b[9] = rgb.length & 255; b.set(rgb, 10); return b; }
    json(rgb, pixelOffset) { const i = []; for (let p = 0; p * 3 < rgb.length; p++) i.push(p + pixelOffset, [rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]]);
      return { on: true, bri: 255, seg: { id: this.opts.segment | 0, i } }; }   // bri 255: per-pixel values carry the brightness (lor 1 = live override, so the running effect does not repaint them)
    async send(body) { const f = this.opts.fetch || fetch; const r = await f('http://' + this.host + '/json/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (r && r.ok === false) throw new Error('WLED ' + r.status); }
    async pixels(rgb, offset = 0) { if (this.udp) await new Promise((res, rej) => this.udp.send(this.ddp(rgb, offset), 4048, this.host, e => e ? rej(e) : res())); else await this.send(this.json(rgb, offset)); }
    // the lit mask as chip colours: bit n -> pixel n/3, colour n%3 at the configured brightness. Three channels per chip, so a 4-chip cabinet is 12 bits
    rgbOf(on) { const rgb = new Uint8Array(this.chips * 3); for (let c = 0; c < this.chips * 3; c++) if (c < 32 && (on >>> c) & 1) rgb[c] = this.bri; return rgb; }
    async set(on) { await this.pixels(this.rgbOf(on), this.off); }
    async preset(id) { await this.send({ ps: id | 0 }); }
    async close() { try { await this.set(0); } catch (e) {} if (this.udp) { this.udp.close(); this.udp = null; } }
  }
  // PacDrive (Ultimarac, USB HID vendor 0xD209 products 0x1500-0x1508): one 4-byte output report, bytes 2 and 3 = LEDs 1-8 and 9-16; no flash in
  // hardware. WebHID, so Chrome only and after a user gesture. Untested on hardware; the report layout is the PacDrive SDK's
  class PacDriveDriver {
    constructor(opts = {}) { this.opts = opts; this.flashes = false; this.dev = null; }
    async open() { const hid = (root.navigator || {}).hid; if (!hid) throw new Error('WebHID not available'); const ds = (await hid.getDevices()).filter(d => d.vendorId === 0xd209); if (!ds.length) ds.push(...await hid.requestDevice({ filters: [{ vendorId: 0xd209 }] })); if (!ds.length) throw new Error('no PacDrive chosen'); this.dev = ds[0]; await this.dev.open(); }
    report(on) { return new Uint8Array([0, 0, on & 255, (on >>> 8) & 255]); }
    async set(on) { if (this.dev) await this.dev.sendReport(0, this.report(on)); }
    async close() { if (this.dev) { try { await this.set(0); await this.dev.close(); } catch (e) {} this.dev = null; } }
  }
  // Raspberry Pi GPIO and PacDrive from Node (node-hid) are not here yet: both need a native module the browser cannot load
  const DRIVERS = { mock: MockDriver, serial: SerialDriver, wled: WledDriver, pacdrive: PacDriveDriver };
  const makeDriver = cfg => { const D = DRIVERS[(cfg || {}).driver || 'mock']; if (!D) throw new Error('unknown LED driver ' + cfg.driver); return new D(cfg); };

  // Joins model, cabinet and driver. Sends the driver only what changed: with a flashing driver the three masks when a lamp changes; otherwise the
  // lit-now mask whenever the shared clock turns a flashing lamp, so the driver sees one write per edge (10 ms ticks, like the original 10 ms paint)
  class LampOutput {
    constructor(model, cabinet, driver, opts = {}) { this.model = model; this.cabinet = cabinet; this.driver = driver; this.now = opts.now || (() => (root.performance || Date).now()); this.masks = { on: 0, flash: 0, slow: 0 }; this.sent = null; this.timer = null; this.setInterval = opts.setInterval || ((f, ms) => setInterval(f, ms)); this.clearInterval = opts.clearInterval || (h => clearInterval(h));   /* unbound window.setInterval throws Illegal invocation */ this.t0 = opts.t0 || 0; this.err = null; this.flash = opts.flash || FLASH;
      model.onChange = lamps => this.update(lamps); }
    update(lamps) { this.masks = this.cabinet.masks(lamps); this.push(); }
    // the lit-now mask at wall time t: steady lamps, plus flashing ones in their on phase
    litAt(t) { const m = this.masks, p = flashPhase(t - this.t0, this.flash), fastBits = m.flash & ~m.slow; return ((m.on & ~m.flash) | (p.fast ? fastBits : 0) | (p.slow ? m.slow : 0)) >>> 0; }
    push() { const m = this.masks, d = this.driver, frame = d.flashes ? [m.on, m.flash, m.slow] : [this.litAt(this.now()), 0, 0];
      const sig = frame.join(); if (sig === this.sent) return false; this.sent = sig; Promise.resolve(d.set(...frame)).catch(e => { this.err = e; }); return true; }
    tick() { if (!this.driver.flashes && this.masks.flash) this.push(); }
    async start(period = 10) { await this.driver.open(); this.model.poll(); this.update(this.model.lamps);   /* lamps the ROM set before the output started (play.html opens it after init) */ if (!this.driver.flashes) this.timer = this.setInterval(() => this.tick(), period); }
    async stop() { if (this.timer) this.clearInterval(this.timer); this.timer = null; this.sent = null; await this.driver.close(); }
  }

  const api = { FLASH, KEY_NAMES, DEFAULT_CABINET, DRIVERS, flashPhase, chipsOf, showConfig, LampModel, Cabinet, LampOutput, MockDriver, SerialDriver, WledDriver, PacDriveDriver, makeDriver };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6LEDS = api;
})(typeof window !== 'undefined' ? window : globalThis);
