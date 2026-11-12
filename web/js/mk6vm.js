// MK6 virtual machine: runs a game ROM's SH-4 code and provides the system services it calls (the 289 stubs at 0x10000+12*i).
// The base-game state machine of the original (credits, keys, meters) is not in the ROMs, so this file re-implements that side in JS.
(function (root) {
  'use strict';
  const MK6 = typeof require !== 'undefined' ? require('./mk6.js') : root.MK6;
  const SH = typeof require !== 'undefined' ? require('./sh4.js') : root.SH4, AVL = typeof require !== 'undefined' ? require('./avl.js') : root.AVL;
  const CALLSTACK = 0x0bff0000, RET = 0x0bfffff0, SHARED = 0x0cf00000, HEAP = 0x0a000000, STACKS = 0x0b000000;
  const hex = v => (v >>> 0).toString(16);

  class VM {
    constructor(rom, opts = {}) {
      this.opts = opts; this.rom = rom; this.syscalls = opts.syscalls; this.exports = opts.exports;
      this.mem = new SH.Memory(); this.mem.map(0x08000000, rom.A); this.mem.map(SHARED, 0x100000);
      this.cpu = new SH.SH4(this.mem); this.db = AVL.open(rom.A, rom.B);
      this.log = []; this.unimpl = new Map(); this.heap = HEAP; this.stackTop = STACKS;
      this.tasks = []; this.cur = null; this.now = 0; this.sems = [null]; this.ports = [null]; this.msgq = {}; this.handles = [null]; this.handleOf = new Map();
      this.meters = new Map(); this.strCache = new Map();
      const cpu = this.cpu;
      this.mem.onUnmapped = (k, a, s, v) => { if (this.opts.trace) this.note(`unmapped ${k}${s} @${hex(a)}`); return 0; };
      cpu.hook(RET, c => c.stop('return')); cpu.hook(RET + 4, c => c.stop('return'));
      this.syscalls.forEach((name, i) => cpu.hook(0x10000 + 12 * i, c => {
        const f = this.impl[name]; this.cur_name = name; (this.recent = this.recent || []).push(name + '@' + hex(c.pr)); if (this.recent.length > 12) this.recent.shift();
        if (this.opts.trace) this.note(name + '(' + [4, 5, 6, 7].map(k => hex(c.r[k])).join(',') + ')');
        if (!f) { this.unimpl.set(name, (this.unimpl.get(name) || 0) + 1); (this.samples = this.samples || {})[name] = (this.samples[name] || []); if (this.samples[name].length < 4) this.samples[name].push([4, 5, 6, 7].map(k => c.r[k]).concat([0, 1, 2, 3].map(k => this.mem.r32(c.r[15] + 4 * k))).map(hex).join(',') + ' fr:' + [4, 5, 6, 7].map(k => c.fp[c.fb + k].toFixed(2)).join(',')); c.r[0] = 0; if (this.opts.trace) this.note(name + '(' + [4, 5, 6, 7].map(k => hex(c.r[k])).join(',') + ') UNIMPL'); return; }
        const r = f.call(this, c, ...[4, 5, 6, 7].map(k => c.r[k])); if (r !== undefined && !this.yielded) c.r[0] = r | 0;
      }));
      this.impl = (typeof require !== 'undefined' ? require('./mk6sys.js') : root.MK6SYS)(this);
    }
    note(s) { if (this.log.length < 5000) this.log.push(s); }
    // ---- guest helpers
    cstr(a) { let s = ''; for (let i = 0; i < 4096; i++) { const c = this.mem.r8(a + i); if (!c) break; s += String.fromCharCode(c); } return s; }
    writeStr(a, s) { for (let i = 0; i < s.length; i++) this.mem.w8(a + i, s.charCodeAt(i) & 255); this.mem.w8(a + s.length, 0); }
    alloc(n) { const a = this.heap; this.heap = (this.heap + n + 15) & ~15; return a; }
    handle(obj) { let h = this.handleOf.get(obj); if (!h) { h = this.handles.length; this.handles.push(obj); this.handleOf.set(obj, h); } return h; }
    // ---- calling exported game functions to completion (tasks it blocks on are ignored: the caller is a plain call)
    call(name, ...args) {
      const i = this.exports.indexOf(name); if (i < 0) throw new Error('no export ' + name);
      return this.callAddr(0x08000100 + 12 * i, args);
    }
    callAddr(addr, args = [], limit = 5e6) {
      const c = this.cpu, saved = this.save(), flags = [c.halted, c.reason, c.jumped], top = CALLSTACK - (this.callDepth = (this.callDepth || 0) + 1) * 0x8000;   // flags: a call made from inside a syscall must not stop the run it interrupted
      args.forEach((a, k) => { c.r[4 + k] = a; }); c.r[15] = top - 16; c.pr = RET; c.pc = addr; c.halted = false; c.reason = '';
      const owner = this.cur; this.cur = null;
      c.run(limit); const r0 = c.r[0], why = c.reason;
      this.cur = owner; this.restore(saved); [c.halted, c.reason, c.jumped] = flags; this.callDepth--;
      if (why !== 'return') throw new Error(`call 0x${hex(addr)} stopped: ${why} pc=${hex(c.pc)} pr=${hex(c.pr)}`);
      return r0;
    }
    // ---- images (section 1) decoded to RGBA; palettes come from section 10 (PICT.pal indexes it)
    palettes() {
      if (this._pals) return this._pals;
      const sec = this.db.sections[10], out = [];
      for (let i = 0; sec && i < sec.recs.length; i++) {
        const r = sec.recs[i]; if (!r || r.body[0] !== 0x50 || r.body[1] !== 0x41 || r.body[2] !== 0x4c || r.body[3] !== 0x54) { out.push(null); continue; }
        const p = []; for (let k = 0; k < 256; k++) p.push([r.body[8 + 4 * k + 2], r.body[8 + 4 * k + 1], r.body[8 + 4 * k]]); out.push([r.name, p]);
      }
      return (this._pals = out);
    }
    image(id) { return this._img && this._img.get(id) || null; }          // decoded RGBA {w,h,rgba} or null while pending
    // an all-zero alpha plane means opaque (50 Lions' animals), except in a one-colour image: every ROM has 'nothing', 16x16 white with alpha 0, a
    // placeholder sprites show while waiting (Double Dolphin's ripple shows it for 825 ms); drawn opaque it would be a white square in the tile.
    // Nor in a numbered animation frame (name ending in a 4-digit frame number): those are the blank start or end frames of a sprite sequence
    // (Paris Lights' Cropped_BUST0000 firework, High Noon's Cropped_bhit*0016, Scatter Magic 2's Cropped_j0*0000) and drawn opaque they are solid boxes
    async loadImage(id) {
      const flat = im => { const r = im.rgba; for (let k = 4; k < r.length; k += 4) if (r[k] !== r[0] || r[k + 1] !== r[1] || r[k + 2] !== r[2]) return false; return true; };                                                  // PICT decodes synchronously; PNG/JPEG go through this.decodeBlob (browser) or the built-in RGBA PNG reader
      this._img = this._img || new Map(); if (this._img.has(id)) return this._img.get(id);
      const rec = this.db.byIndex(1, id); let im = null;
      if (rec) {
        const b = rec.body;
        try {
          if (b[0] === 0x50 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x54) im = MK6.decodePict(b, rec.pack ? this.palettes().slice(rec.pack.base[10] | 0, (rec.pack.base[10] | 0) + (rec.pack.count[10] | 0)) : this.palettes());   // a pack's PICTs index its own palettes
          // PNG and JPEG through our own decoders in the browser as in Node: they ignore gAMA, iCCP and ICC profiles, as the real machine does. A browser applies them
          // (most PNGs carry gAMA 0.22727, which squares every value; Pompei's IMG_MS_OLAY JPEG has an ICC profile) and every background would come out darker.
          // An all-zero alpha plane means "opaque" to the engine (50 Lions animals, Fire Dancer's IMG_MS_BEV_TOP). The browser decoder is only a fallback.
          else if (b[0] === 0x89 && b[1] === 0x50) {
            im = await (this.decodePng || MK6.decodePngRGBA)(b);   // decodePng / decodeJpeg: a host's own decoders (the desktop app's worker threads)
            if (im && b[25] === 6 && !im.opaqueAlpha && !flat(im) && !/\d{4}$/.test(rec.name)) for (let k = 3; k < im.rgba.length; k += 4) im.rgba[k] = 255;
            if (!im && this.decodeBlob) im = await this.decodeBlob(b);
          }
          else if (b[0] === 0xff && b[1] === 0xd8) {   // baseline JPEGs (Peacock Magic and Venetian Nights draw their backgrounds from IMG_ATTRACT_TOP/BOT JPEGs)
            const J = typeof JPEG !== 'undefined' ? JPEG : typeof require !== 'undefined' ? require('./jpeg.js') : null;
            im = this.decodeJpeg ? await this.decodeJpeg(b) : J ? J.decodeJpeg(b) : null;
            if (!im && this.decodeBlob) im = await this.decodeBlob(b);
          }
          else if (this.decodeBlob) im = await this.decodeBlob(b);
        } catch (e) { this.note('image ' + id + ' ' + rec.name + ': ' + e.message); }
      }
      this._img.set(id, im); return im;
    }
    // decode every image up front so nothing pops in mid-animation; onProgress(done, total) is awaited every 16 images. Record 0 is a real image in
    // every ROM (Pompei's IMG_DNM_BG_ALL): skipped: _getobjectarea would give it 0x0 and the denomination text would be centred on the small box only
    async preload(onProgress) {
      const sec = this.db.sections[1], n = sec ? sec.recs.length : 0;
      for (let i = 0; i < n; i++) { if (sec.recs[i]) await this.loadImage(i); if (onProgress && ((i + 1) % 16 === 0 || i === n - 1)) await onProgress(i + 1, n); }
    }
    // ---- FLIC animations (section 7): decoded to RGBA frames on first use; the palette comes from the stream or, failing that, from the palette named like the animation's art
    flic(id) {
      this._flics = this._flics || new Map(); let f = this._flics.get(id); if (f !== undefined) return f;
      const rec = this.db.byIndex(7, id), FL = typeof require !== 'undefined' ? require('./flic.js') : root.FLIC; f = null;
      try {   // a damaged record (Phoenix Fantasy) shows nothing instead of stopping the game
        const pf = rec && FL.parse(rec.body);
        if (pf) {
          // header word 6 is the palette's index in section 10 (-1: the FLIC has its own): Double Dolphin's FLC_a_dolphins uses PLT_Dol, which no name rule finds,
          // so without the index it would be drawn without its colours (grey on white); the names are the fallback
          const suf = rec.name.replace(/^FLC_/, ''), want = ['IMG_SYM_' + suf, 'PLT_' + suf, 'PAL_' + suf, suf].map(n => n.toLowerCase()), pals = this.palettes(),
            pi = rec.body.length >= 28 ? new DataView(rec.body.buffer, rec.body.byteOffset, 28).getInt32(24, true) : -1,
            pal = (pi >= 0 && pals[pi]) || pals.find(p => p && want.includes(p[0].toLowerCase()));
          // header word 2 is the frame rate in frames per second, not a delay: QOTN's FLC_BOB (15) plays at 15 fps (14.8 changes a second), Grizzly's (30) at 30 fps; delay is the frame period in ms (out-of-range rates play at 15 fps)
          f = { name: rec.name, w: pf.w, h: pf.h, count: pf.count, delay: 1000 / (pf.delay >= 1 && pf.delay <= 60 ? pf.delay : 15), frames: pf.frames(pal ? Uint8Array.from(pal[1].flat()) : null) };
        }
      } catch (e) { f = null; this.note('flic ' + id + ' ' + (rec && rec.name) + ': ' + e.message); }
      this._flics.set(id, f); return f;
    }
    // ---- bitmap fonts (section 4): header words [3] image id, [4] first char, [5] glyph count, [8] offset of the x table (int32 per glyph)
    font(rec) {
      this._fonts = this._fonts || new Map(); let f = this._fonts.get(rec); if (f) return f;
      const b = rec.body, v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getInt32(20, true), at = v.getInt32(32, true), x = new Int32Array(n + 1);
      for (let i = 0; i < n && at + 4 * i + 4 <= b.length; i++) x[i] = v.getInt32(at + 4 * i, true);
      const ko = v.getInt32(36, true);   // header +36: per-glyph kerning records ([count, (adjust << 16 | next char) ...] at the offset, -1 = none)
      f = { name: rec.name, type: v.getInt32(4, true), sp: v.getInt32(28, true), img: v.getInt32(12, true) + (rec.pack ? rec.pack.base[1] | 0 : 0), first: v.getInt32(16, true), n, x, h: 0, w: 0, v, ko: ko > 0 && ko + 4 * n <= b.length ? ko : 0 };
      const im = this.image(f.img); if (im) { f.w = im.w; f.h = im.h; }
      this._fonts.set(rec, f); return f;
    }
    glyph(f, ch) { const i = ch - f.first; if (i < 0 || i >= f.n) return null; const x0 = f.x[i], x1 = i + 1 < f.n ? f.x[i + 1] : (f.w || x0 + 8); return x1 > x0 ? { x: x0, w: x1 - x0 } : null; }   // equal x: no glyph for that character
    kern(f, a, b) {
      if (!f.ko) return 0; const v = f.v, i = a - f.first; if (i < 0 || i >= f.n) return 0; const o = v.getInt32(f.ko + 4 * i, true); if (o <= 0 || o + 4 > v.byteLength) return 0;
      for (let k = 0, n = v.getInt32(o, true); k < n && o + 8 + 4 * k <= v.byteLength; k++) { const e = v.getInt32(o + 4 + 4 * k, true); if ((e & 0xffff) === b) return e >> 16; }
      return 0;
    }
    // Text metrics (string rectangles give: "$100 Buys" 82, "2000 Credits" 102, "5c" 31): between two glyphs the machine adds the font's
    // letter spacing (header word 7: -1 in the denomination fonts, -2 in the a_* message fonts, -14 in Dragon Magic's 27 px wide Meter
    // cells whose digits are 13 px of ink) and the kerning pair of (char, next). So a glyph advances by width + spacing + kern(char, next), the last one by
    // its width; the text width is the sum (a spacing of -1 for every font would spread the Meter digits 13 px too far apart).
    // Only fonts with flag 4 in the header's type word (+4) do that: the per-glyph adjust is 0 for the others, which advance by
    // their full width with no kerning (Queen Of The Nile's message font, type 11, has a +2 pair for every glyph that is never applied)
    glyphAdvance(f, s, k) { const g = this.glyph(f, s.charCodeAt(k)); if (!g) return 0; if (!(f.type & 4)) return g.w; return g.w + (k + 1 < s.length ? f.sp + this.kern(f, s.charCodeAt(k), s.charCodeAt(k + 1)) : 0); }
    textWidth(f, s) { const im = this.image(f.img); if (im) { f.w = im.w; f.h = im.h; } let w = 0; for (let k = 0; k < s.length; k++) w += this.glyphAdvance(f, s, k); return w; }
    // ---- scenes: flatten a SCNE into positioned items (kind 1 image, 2 nested scene, 5 text, 7 FLIC, 9 sound, 11 sprite); priorities add up
    instantiate(inst, rec, ox, oy, prio = 0, depth = 0) {
      if (depth > 8) return;
      const sc = AVL.parseScene(rec);
      for (const e of sc.entries) {
        const x = ox + e.x, y = oy + e.y, p = prio + e.prio;
        if (e.kind === 2) { const sub = this.db.byIndex(2, e.id); if (sub) this.instantiate(inst, sub, x, y, p, depth + 1); }
        else if (e.kind === 0) inst.items.push({ kind: 0, x, y, prio: p, flags: e.flags, w: e.w4 & 0xffff, h: e.w4 >>> 16, code: e.w6 >>> 16, visible: true, scene: rec.name });   // touch box
        else if (e.kind === 5) {   // a string (STRG: font index at +8, text from +32), drawn with its top left at x, y (Big Ben Jackpot's "$" at 525, 14 beside the jackpot amount).
          // Only entries flagged 0x100: the others are test strings and help-page text, not checked
          const s = this.db.byIndex(5, e.id); if (!s || !(e.flags & 0x100) || s.body.length < 33) continue;
          const fr = this.db.byIndex(4, (s.body[8] | s.body[9] << 8) + (s.pack ? s.pack.base[4] | 0 : 0)); if (!fr) continue;
          let n = 32; while (n < s.body.length && s.body[n]) n++;
          inst.items.push({ kind: 'str', text: String.fromCharCode(...s.body.subarray(32, n)), font: this.font(fr), x, y, prio: p, flags: e.flags, visible: true, scene: rec.name });
        }
        else inst.items.push({ kind: e.kind, id: e.id, x, y, prio: p, flags: e.flags, scale: e.scale, plays: e.plays, motion: e.w2, visible: true, scene: rec.name,
          code: (e.kind === 1 || e.kind === 11) && (e.flags & 0x80000000) ? e.w6 >>> 16 : undefined });   // a touch-flagged sprite too (Mr Cashman's MONEY / BOX pick: SP_CAM3_moneyb, code 110 / 111)   // an image with the touch flag is a touch target too (Outback Jack's cards: flag 0x80000000, code 3001.. in word 6)   // motion: section-8 MSEQ index (-1 none)
      }
    }
    // ---- touch screen: the hit test takes the topmost visible object under the point; a touch box (scene entry kind 0, or
    // _createbox) answers with its code, anything else with -1. The touch device handler then accepts only codes the ROM listed
    // with enable_button_map ({code, flags} pairs, flags & 1, ended by -1).
    touchBoxes() {
      const out = []; for (const it of ((this.display || {}).items || [])) { if (!it || !it.visible || !it.code) continue;
        if (it.box) out.push(it); else if (it.img !== undefined) { const im = this.image(it.img); if (im) out.push({ x: it.x, y: it.y, w: im.w, h: im.h, code: it.code, prio: it.prio }); } }
      return out;
    }
    touchAt(x, y) {
      let best = null; for (const it of this.touchBoxes()) if (x >= it.x && x < it.x + it.w && y >= it.y && y < it.y + it.h && (!best || (it.prio | 0) >= (best.prio | 0))) best = it;
      return best ? best.code : -1;
    }
    touchEnabled(code) {
      let a = this.buttonMap >>> 0; if (!a) return true;
      for (let k = 0; k < 512; k++, a += 8) { const c = this.mem.r32(a) | 0; if (c === -1) return false; if (c === (code | 0)) return !!(this.mem.r32(a + 4) & 1); }
      return false;
    }
    // ---- tasks: each owns a full register context; blocking system calls yield back to the scheduler
    save() { const c = this.cpu; return { r: Int32Array.from(c.r), pc: c.pc, pr: c.pr, gbr: c.gbr, mach: c.mach, macl: c.macl, t: c.t, s: c.s, q: c.q, m: c.m, fpscr: c.fpscr, fp: Float32Array.from(c.fp), fpul: c.fpul }; }
    restore(x) { const c = this.cpu; c.r.set(x.r); c.pc = x.pc; c.pr = x.pr; c.gbr = x.gbr; c.mach = x.mach; c.macl = x.macl; c.t = x.t; c.s = x.s; c.q = x.q; c.m = x.m; c.fpscr = x.fpscr; c.fp.set(x.fp); c.fpul = x.fpul; }
    createTask(entry, name, prio, arg) {
      const stackBase = (this.freeStacks = this.freeStacks || []).pop() || (this.stackTop -= 0x10000, this.stackTop + 0x10000); const t = { stackBase, id: this.tasks.length + 1, name, prio, state: 'suspended', ctx: null, wake: 0, waitSem: null, result: 0 };
      const c = this.cpu, saved = this.save();
      c.r.fill(0); c.r[4] = arg | 0; c.r[15] = stackBase - 16; c.pr = RET + 4; c.pc = entry; t.ctx = this.save(); this.restore(saved);
      this.tasks.push(t); (this.live = this.live || []).push(t); return t;
    }
    block(state, extra = {}) {                      // called from inside a hook: park the current task right after the stub returns
      const c = this.cpu, t = this.cur; if (!t) return false;
      c.pc = c.pr; this.yielded = true; c.jumped = true; Object.assign(t, extra, { state }); t.ctx = this.save(); c.halted = false; this.switchOut = true; return true;
    }
    resume(t, result) { t.ctx.r[0] = result | 0; t.state = 'ready'; }
    // run ready tasks until all are blocked (virtual time does not advance); returns instructions executed
    runTasks(budget = 2e6) {
      let used = 0, progressed = true;
      const c = this.cpu;
      while (progressed && used < budget) {
        progressed = false;
        this.live = (this.live || []).filter(t => { if ((t.state === 'done' || t.state === 'crashed') && t.stackBase && !t.freed) { t.freed = true; if (t.state === 'done') this.freeStacks.push(t.stackBase); } return t.state !== 'done' && t.state !== 'crashed'; });   // finished tasks keep their id slot in this.tasks but leave the scheduler
        const ready = this.live.filter(t => t.state === 'ready' && !this.polling(t)).sort((a, b) => a.prio - b.prio);   // (finished tasks keep their id slot; their stacks are recycled)
        for (const t of ready) {
          if (t.state !== 'ready') continue;
          progressed = true; used += this.runTask(t);
        }
      }
      return used;
    }
    // one time slice of one ready task: until it returns, blocks or uses 400k instructions; returns instructions executed
    runTask(t) {
      const c = this.cpu;
      this.cur = t; this.restore(t.ctx); this.yielded = false; this.switchOut = false; c.halted = false; c.reason = '';
      const n0 = c.cycles; let guard = 0;
      while (!c.halted && !this.switchOut && c.cycles - n0 < 400000) { c.step(); if (++guard > 400000) break; }
      if (this.switchOut) { /* already saved by block() */ }
      else if (c.halted && c.reason === 'return') { t.state = 'done'; t.ctx = null; }   // a finished task's register context is not needed again (periodic SP_TIMER scene_cb tasks pile up in this.tasks, which keeps the slot for the id)
      else if (c.halted) { t.state = 'crashed'; this.note(`task ${t.name} stopped: ${c.reason} pc=${hex(c.pc)} pr=${hex(c.pr)} recent: ${(this.recent || []).join(' ')}`); }
      else { t.ctx = this.save(); const p = this.pollLoop(t.ctx.pc); if (p && this.pollExit(p, t.ctx) === false) { t.ctx.pc = p.head; t.poll = p; } }   // time slice used up; stays ready
      this.cur = null; this.yielded = false;
      return c.cycles - n0;
    }
    // A task that used its whole slice inside a poll loop (only loads and compares, closed by one bf / bt back to its head) waits for a word another task or
    // the OS writes: Cashman Tonight's game_main spins on a word the cashman animation task sets to -1 when the animation ends, about 370 frames later.
    // The task stays 'ready' (the hosts read tasks[0].state) but runTasks skips it until the loop, evaluated on its saved registers, would exit. The
    // check runs every round, so the task goes on in the same round as it would have by spinning.
    polling(t) { if (t.poll && (t.state !== 'ready' || this.pollExit(t.poll, t.ctx) !== false)) t.poll = null; return !!t.poll; }
    pollLoop(pc) {
      const mem = this.mem; pc >>>= 0;
      for (let b = pc; b < pc + 16; b += 2) {
        const op = mem.r16(b), hi = op >> 8; if (hi !== 0x89 && hi !== 0x8b) continue;
        const head = (b + 4 + (((op & 255) << 24) >> 23)) >>> 0; if (head > pc || b - head > 14 || b === head) return null;
        return { head, br: b, bt: hi === 0x89 };
      }
      return null;
    }
    // true when the loop would exit now, false when it would go round again, undefined when the code is not a pure poll loop (it is then not parked)
    pollExit(p, x) {
      const mem = this.mem, R = Int32Array.from(x.r); let T = x.t, ok = true;
      const rd = (a, n) => { a >>>= 0; if (!mem.page(a)) { ok = false; return 0; } return n === 4 ? mem.r32(a) : n === 2 ? (mem.r16(a) << 16) >> 16 : (mem.r8(a) << 24) >> 24; };
      for (let pc = p.head; pc < p.br && ok; pc += 2) {
        const op = mem.r16(pc), n = (op >> 8) & 15, m = (op >> 4) & 15, lo = op & 15, d = op & 255;
        switch (op >> 12) {
          case 0xd: R[n] = rd(((pc & ~3) + 4 + d * 4), 4); break;                                   // mov.l @(disp,PC),Rn
          case 0x9: R[n] = rd(pc + 4 + d * 2, 2); break;                                            // mov.w @(disp,PC),Rn
          case 0x5: R[n] = rd(R[m] + lo * 4, 4); break;                                             // mov.l @(disp,Rm),Rn
          case 0x6: if (lo > 2) return undefined; R[n] = rd(R[m], [1, 2, 4][lo]); break;           // mov.b / mov.w / mov.l @Rm,Rn
          case 0x8: if (n === 4) R[0] = rd(R[m] + lo, 1); else if (n === 5) R[0] = rd(R[m] + lo * 2, 2); else if (n === 8) T = R[0] === (d << 24) >> 24 ? 1 : 0; else return undefined; break;
          case 0x3: if (lo !== 0) return undefined; T = R[n] === R[m] ? 1 : 0; break;               // cmp/eq Rm,Rn
          case 0x2: if (lo !== 8) return undefined; T = (R[n] & R[m]) === 0 ? 1 : 0; break;         // tst Rm,Rn
          case 0xc: if (n !== 8) return undefined; T = (R[0] & d) === 0 ? 1 : 0; break;             // tst #imm,R0
          default: return undefined;
        }
      }
      return ok ? (p.bt ? T === 0 : T === 1) : undefined;
    }
    advance(ms) {                                   // move virtual time forward and wake sleepers
      this.now += ms;
      for (const t of this.live || []) if (t.state === 'sleeping' && t.wake <= this.now) this.resume(t, 0);
      for (const t of this.live || []) if (t.state === 'waiting' && t.deadline && t.deadline <= this.now) { t.waitSem.waiters = t.waitSem.waiters.filter(w => w !== t); this.resume(t, -1); }
    }
  }
  const api = { VM, RET, SHARED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6VM = api;
})(typeof window !== 'undefined' ? window : globalThis);
