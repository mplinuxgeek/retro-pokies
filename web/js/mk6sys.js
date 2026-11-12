// System-call implementations for MK6VM. Argument meanings are inferred from the arguments the games pass.
// Every function is called as f.call(vm, cpu, r4, r5, r6, r7); a returned number becomes r0.
(function (root) {
  'use strict';
  const AVL = typeof require !== 'undefined' ? require('./avl.js') : root.AVL;
  const TYPE_SECTION = AVL.KIND_OF_TYPE;

  module_exports((vm) => {
    const mem = vm.mem, S = {};
    const stackArg = (c, k) => mem.r32(c.r[15] + 4 * (k - 4));       // k-th integer argument (k>=4) lives on the stack
    const rnd = (() => { let s = 0x2545F491; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; }; })();
    // sound events for the front end: the ROM plays sounds as scenes (a WAV or MIDI object added with _addscene, started with _controlscene); the page overrides these
    vm.sound = vm.sound || { log: [], play(rec, scene) { if (rec && this.log.length < 5000) this.log.push(rec.name); }, stop() {} };
    vm.display = vm.display || { scenes: [], windows: [], items: [], nextScene: 1 };
    const D = vm.display;

    // ---- printf family: formats guest varargs (int-class registers r5.. then stack)
    function format(c, fmt, first, stackFrom) {
      let ai = first; const next = () => stackFrom !== undefined ? mem.r32(c.r[15] + 4 * stackFrom++) : ai < 4 ? c.r[4 + ai++] : mem.r32(c.r[15] + 4 * (ai++ - 4));
      return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?(l|h|ll)?([diuxXcs%])/g, (m, fl, w, p, l, t) => {
        if (t === '%') return '%';
        let v = t === 's' ? vm.cstr(next()) : t === 'c' ? String.fromCharCode(next() & 255) : (t === 'd' || t === 'i') ? String(next() | 0) : t === 'u' ? String(next() >>> 0) : (next() >>> 0).toString(16);
        if (t === 'X') v = v.toUpperCase();
        if (p !== undefined && t === 's') v = v.slice(0, +p);
        if (w) { const pad = fl.includes('0') && t !== 's' ? '0' : ' '; v = fl.includes('-') ? v.padEnd(+w, ' ') : (pad === '0' && v[0] === '-' ? '-' + v.slice(1).padStart(+w - 1, '0') : v.padStart(+w, pad)); }
        return v;
      });
    }
    // the sprintf thunk: destination in r4, format = first STACK word, varargs = the following stack words (r5..r7 are not arguments)
    // create_dollar_string(out, cents, width): currency "$", decimal "." (strings 1 and 3), right-aligned in width with spaces
    S.create_dollar_string = (c, out, cents, width) => { cents >>>= 0; const t = '$' + Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0'); vm.writeStr(out, ' '.repeat(Math.max(0, (width | 0) - t.length)) + t); return 0; };
    // the system supplies the currency itself: a %s right before %d is its currency symbol ("$", string 1) and one right after %d its minor unit
    // ("¢", string 2); the ROM passes only the number (Queen Of The Nile "%s%d Buys", "%d%s")
    // Touch machines only (cabinet ROMs such as 5 Dragons "%d%s" leave a stack pointer that is not the string): a ROM that passes the currency and minor-unit strings itself (Cashman Tonight "%s%d%s  =  %d  Credit%s" gets "$", 100, "", 10000, "s") keeps its %s: the stack word is a pointer
    const ptrLike = w => !!vm.windowPrio && (w >>> 0) > 0x8000000 && (w >>> 0) < 0xd000000;
    const currencyFix = (c, fmt) => { let k = 1; const parts = fmt.split(/(%[-+ 0#]*\d*(?:\.\d+)?(?:l|h|ll)?[diuxXcs%])/); const T = parts.map(x => /^%.*[diuxXcs%]$/.test(x) ? x[x.length - 1] : null);
      for (let i = 0; i < parts.length; i++) { const t = T[i]; if (!t || t === '%') continue;
        if (t === 's' && T[i + 2] === 'd' && parts[i + 1] === '') { if (ptrLike(mem.r32(c.r[15] + 4 * k))) k++; else parts[i] = '$'; }
        else if (t === 's' && i >= 2 && T[i - 2] === 'd' && parts[i - 1] === '') { if (ptrLike(mem.r32(c.r[15] + 4 * k))) k++; else parts[i] = '¢'; }
        else k++; }
      return parts.join(''); };
    S.sprintf = (c, d) => { const f = mem.r32(c.r[15]); if (!f) return 0; const s = format(c, currencyFix(c, vm.cstr(f)), 0, 1); vm.writeStr(d, s); return s.length; };
    // sscanf(str, fmt, ...): like sprintf, everything after r4 is on the stack (Players Choice parses its RTP strings "90.10" with it)
    S.sscanf = (c, str) => {
      const sp = c.r[15], fmt = vm.cstr(mem.r32(sp)), s = vm.cstr(str); let i = 0, n = 0, arg = 1;
      const out = () => mem.r32(sp + 4 * arg++) >>> 0, ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
      for (let k = 0; k < fmt.length; k++) {
        const ch = fmt[k];
        if (/\s/.test(ch)) { ws(); continue; }
        if (ch !== '%') { if (s[i] !== ch) break; i++; continue; }
        let m = /^%(\*?)(\d*)(h|l|ll)?([diuxXfeEgsc%])/.exec(fmt.slice(k)); if (!m) break; k += m[0].length - 1;
        const [, skip, width, len, conv] = m; if (conv === '%') { if (s[i] !== '%') break; i++; continue; }
        if (conv !== 'c') ws(); const rest = width ? s.slice(i, i + +width) : s.slice(i);
        const re = conv === 's' ? /^\S+/ : conv === 'c' ? /^[\s\S]/ : /[fegE]/.test(conv) ? /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/ : /x/i.test(conv) ? /^[-+]?(0x)?[0-9a-f]+/i : /^[-+]?\d+/;
        const t = re.exec(rest); if (!t) break; i += t[0].length; if (skip) continue;
        const a = out(); n++;
        if (conv === 's' || conv === 'c') vm.writeStr(a, t[0]);
        else if (/[fegE]/.test(conv)) { if (len === 'l') mem.wf64 ? mem.wf64(a, +t[0]) : (() => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, +t[0]); mem.w32(a, b.getUint32(0)); mem.w32(a + 4, b.getUint32(4)); })(); else { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, +t[0]); mem.w32(a, b.getUint32(0)); } }
        else { const v = parseInt(t[0], /x/i.test(conv) ? 16 : 10); if (len === 'h') mem.w16(a, v); else mem.w32(a, v); }
      }
      return n;
    };
    S.printf = S.iprintf = S.uprintf = S._auxtext = () => 0;

    // ---- libc
    S.strlen = (c, a) => vm.cstr(a).length;
    S.strcpy = (c, d, s) => { vm.writeStr(d, vm.cstr(s)); return d; };
    S.strncpy = (c, d, s, n) => { const t = vm.cstr(s); for (let i = 0; i < n; i++) mem.w8(d + i, i < t.length ? t.charCodeAt(i) : 0); return d; };
    S.strcat = (c, d, s) => { vm.writeStr(d + vm.cstr(d).length, vm.cstr(s)); return d; };
    S.strcmp = (c, a, b) => { const x = vm.cstr(a), y = vm.cstr(b); return x < y ? -1 : x > y ? 1 : 0; };
    S.strncmp = (c, a, b, n) => { const x = vm.cstr(a).slice(0, n), y = vm.cstr(b).slice(0, n); return x < y ? -1 : x > y ? 1 : 0; };
    S.memcmp = (c, a, b, n) => { for (let i = 0; i < n; i++) { const x = mem.r8(a + i), y = mem.r8(b + i); if (x !== y) return x < y ? -1 : 1; } return 0; };
    S.memcpy = S.memmove = (c, d, s, n) => { const t = []; for (let i = 0; i < n; i++) t.push(mem.r8(s + i)); for (let i = 0; i < n; i++) mem.w8(d + i, t[i]); return d; };
    S.memset = (c, d, v, n) => { for (let i = 0; i < n; i++) mem.w8(d + i, v); return d; };
    S.strrev = (c, a) => { const s = vm.cstr(a); vm.writeStr(a, [...s].reverse().join('')); return a; };
    S.rand = () => rnd() & 0x7fff;
    S.acc_rand_0 = S.acc_rand32_0 = (c, a, n) => {   // (ctx, bound, ?): bounded draw when a plausible bound is passed
      // a finished game's recovery draws its start again (QOTN state 3: one draw per reel, the strip length the bound; Ruby Magic also draws its strip set).
      // the real machine draws from the seeds in the logged game record, so it lands on the game's own result; ours replays the draws the game made (vm.drawLog,
      // kept with its log entry by Host.spin, the reel stops the host's), each answered while its bound matches (a finished feature replays its free games)
      const D = vm.drawStops, b = n > 0 && n < 65536; if (D && D.length && vm.replay && b && D[0][0] === n) return D.shift()[1];
      const v = b ? rnd() % n : rnd() >>> 0; if (vm.drawLog && b && vm.drawLog.length < 256) vm.drawLog.push([n, v]); return v;
    };

    // ---- tasks and synchronisation (gos_*)
    S.gos_create = (c, entry, name, params) => { const t = vm.createTask(entry, vm.cstr(name), mem.r32(params + 4), mem.r32(params + 12)); return t.id; };   // params = {stack size, priority, flags, entry argument}
    S.gos_resume = (c, id) => { const t = vm.tasks[id - 1]; if (t && t.state === 'suspended') { if (t.ctx) t.ctx.r[0] = 0; t.state = 'ready'; } return 0; };
    S.gos_suspend = (c, id) => { const t = id === 0 ? vm.cur : vm.tasks[id - 1]; if (!t) return -1; if (t === vm.cur) { vm.block('suspended'); return undefined; } t.state = 'suspended'; return 0; };
    S.gos_kill = (c, id) => { const t = vm.tasks[id - 1]; if (t) t.state = 'done'; return 0; };
    S.gos_getpid = () => vm.cur ? vm.cur.id : 0;
    S.gos_getprio = (c, id) => (vm.tasks[id - 1] || { prio: 0 }).prio;
    S.gos_chprio = (c, id, p) => { const t = vm.tasks[id - 1]; if (t) t.prio = p; return 0; };
    S.gos_getname = (c, id, buf) => { const t = vm.tasks[id - 1]; if (t && buf) vm.writeStr(buf, t.name); return 0; };
    S.gos_screate = (c, count) => { vm.sems.push({ count, waiters: [] }); return vm.sems.length - 1; };
    S.gos_sdelete = () => 0;
    S.gos_signal = (c, id) => { const s = vm.sems[id]; if (!s) return -1; const w = s.waiters.shift(); if (w) vm.resume(w, 0); else s.count++; return 0; };
    S.gos_wait = (c, id, timeout) => {
      const s = vm.sems[id]; if (!s) return -1;
      if (s.count > 0) { s.count--; return 0; }
      if (!vm.cur) return -1;
      const t = vm.cur; s.waiters.push(t); vm.block('waiting', { waitSem: s, deadline: timeout > 0 ? vm.now + timeout * 10 : 0 }); return undefined;
    };
    // a sleep wakes on the display frame nearest its deadline, not the first one after it: the real machine sleeps about n ms (gos_sleepms(37) 37-40 ms,
    // (10) 11 ms), and the win meter count-up sleeps 37 ms a tick, which waking on the next frame after the deadline would turn into 48 ms against ~33 ms on hardware
    // A task that sleeps again right after waking carries the frame lateness over (the deadline counts from the last deadline, not from the frame it woke on),
    // so a repeating gos_sleepms(37) averages 37 ms as on the real machine (37.3 ms), not one 33 ms frame: the win meter count-up of a 100 credit win takes 4.8 s as on the real machine (3.3 s without the carry-over).
    const sleeper = unit => (c, n) => { if (!vm.cur) return 0; const t = vm.cur, late = t.sleepDl === undefined ? 1e9 : vm.now - t.sleepDl, base = late > -9 && late < 17 ? t.sleepDl : vm.now; t.sleepDl = base + n * unit; vm.block('sleeping', { wake: Math.max(vm.now + 1, t.sleepDl - 8) }); return undefined; };
    // Touch/key hotspot service, as the system implements it. Every argument is a stack word, a<k> = mem.r32(sp + 4k),
    // a0 = mode. Hotspot table: { id, enabled } x (n+1), id -1 = free. Rect table: { w0, w1, w2, id } x (n+1), w0 -1 = free.
    //   0 (table, n, id, enabled): fill the first free slot      1 (table, n): clear n slots to { -1, 0 }
    //   2 (rects, n): clear n slots to { -1, -1, -1, 0 }          3 (rects, rectPtr, n, id): copy 3 words + id into the first free slot
    //   4 (keys, buf)              wait for a key
    //   5 (keys, buf, table, n)    wait for a key or hotspot, also type 12      (Corrida De Toros "Pick the winner")
    //   6 (buf, table, n)          wait for a hotspot                           (Touch Of Paradice dice)
    //   7 (buf, table, n, x)       wait for a hotspot, also type 12
    //   8 (keys, buf, table, n)    as 5 without type 12
    //   9 (buf, rects, n, x)       wait for a rect hotspot (id = word 3)
    // keys = struct whose +4 points at { flag, value } x 0x21; flag 1 = key enabled. The waits read game-port messages {type, a, b} into buf, consume
    // everything, and return on type 9, on type 12 where noted, or on type 7 with b == 1 and a = an enabled key (a < 0x21) or a hotspot id.
    // A waiting task sleeps and re-enters this stub on wake, so it blocks like a msg_recv loop; vm.hotspotWait tells the host which inputs are valid.
    // Modes 2-4, 7 and 9 are mapped from register usage only; 0, 1, 5, 6 and 8 are used by (Corrida De Toros, Touch Of Paradice).
    const HOTSPOT_STUB = 0x10000 + 12 * Math.max(0, (vm.syscalls || []).indexOf('gmc_key_hotspot_wrapper'));   // 0x10054
    const hotspotIds = (table, n, size, idWord) => { const ids = []; if (!table) return ids; for (let i = 0; i <= n; i++) { const e = table + size * i, id = mem.r32(e + 4 * idWord) | 0; if ((mem.r32(e) | 0) !== -1 && (size === 16 || mem.r32(e + 4) === 1)) ids.push(id); } return ids; };
    const enabledKeys = ks => { const keys = [], kt = ks ? mem.r32(ks + 4) : 0; if (kt) for (let i = 0; i < 0x21; i++) if (mem.r32(kt + 8 * i) === 1) keys.push(i); return keys; };
    S.gmc_key_hotspot_wrapper = (c) => {
      const sp = c.r[15], a = k => mem.r32(sp + 4 * k), mode = a(0) | 0;
      if (mode === 0) { for (let i = 0; i <= (a(2) | 0); i++) { const e = a(1) + 8 * i; if ((mem.r32(e) | 0) === -1) { mem.w32(e, a(3)); mem.w32(e + 4, a(4)); break; } } return 0; }
      if (mode === 1) { for (let i = 0; i < (a(2) | 0); i++) { mem.w32(a(1) + 8 * i, -1); mem.w32(a(1) + 8 * i + 4, 0); } return 0; }
      if (mode === 2) { for (let i = 0; i < (a(2) | 0); i++) { const e = a(1) + 16 * i; mem.w32(e, -1); mem.w32(e + 4, -1); mem.w32(e + 8, -1); mem.w32(e + 12, 0); } return 0; }
      if (mode === 3) { for (let i = 0; i <= (a(3) | 0); i++) { const e = a(1) + 16 * i; if ((mem.r32(e) | 0) === -1) { for (let w = 0; w < 3; w++) mem.w32(e + 4 * w, mem.r32(a(2) + 4 * w)); mem.w32(e + 12, a(4)); break; } } return 0; }
      let buf, keys = [], ids = [], t12 = false;
      if (mode === 4) { keys = enabledKeys(a(1)); buf = a(2); t12 = true; }
      else if (mode === 5 || mode === 8) { keys = enabledKeys(a(1)); buf = a(2); ids = hotspotIds(a(3), a(4) | 0, 8, 0); t12 = mode === 5; }
      else if (mode === 6 || mode === 7) { buf = a(1); ids = hotspotIds(a(2), a(3) | 0, 8, 0); t12 = mode === 7; }
      else if (mode === 9) { buf = a(1); ids = hotspotIds(a(2), a(3) | 0, 16, 3); t12 = true; }
      else return 0;
      const P = port(2);
      while (P.q.length) {
        const m = P.q.shift(); for (let i = 0; i < 3; i++) mem.w32(buf + 4 * i, m[i] | 0);
        if (m[0] === 9 || (t12 && m[0] === 12) || (m[0] === 7 && m[2] === 1 && (m[1] < 0x21 ? keys.includes(m[1]) : ids.includes(m[1] | 0)))) { vm.hotspotWait = null; return 0; }
      }
      if (!vm.cur) return 0;
      const hw = vm.hotspotWait && vm.hotspotWait.buf === buf ? vm.hotspotWait : (vm.hotspotWait = { polls: 0, buf });
      Object.assign(hw, { mode, keys, ids }); hw.polls++; if (hw.since === undefined) hw.since = vm.now;
      // mode 7 (buf, hotspots, count, ms): after ms with no touch the system answers type 12 and the ROM picks for the player (Mr Cashman's money-or-box: 30000)
      const ms = mode === 7 ? a(4) | 0 : 0; if (ms > 0 && vm.now - hw.since >= ms) { mem.w32(buf, 12); mem.w32(buf + 4, 0); mem.w32(buf + 8, 0); vm.hotspotWait = null; return 0; }
      const t = vm.cur; vm.block('sleeping', { wake: vm.now + 1 }); t.ctx.pc = HOTSPOT_STUB; return undefined;
    };
    // gmc_1ms_delay(buf, ms): wait up to ms for a game-port message; one that arrives is copied to buf, and when none came the buffer holds type 12, the
    // timeout. The call returns buf: Eye Of The Tiger's feature (0x8018610) reads the type through r0 and moves on only on 9 or 12; with a 0 there it
    // replays its eye round for ever.
    const DELAY_STUB = 0x10000 + 12 * Math.max(0, (vm.syscalls || []).indexOf('gmc_1ms_delay'));
    S.gos_sleep = sleeper(1000); S.gos_sleep10 = sleeper(10); S.gos_sleepms = sleeper(1); S.avl_sleepms = sleeper(1); S.gmc_1ms_delay = (c, a, n) => {                      // plain delay(ms), or (msg buffer, ms): poll the game port for up to ms
      if (a > 0xffff) {
        const P = vm.msgq[2], t = vm.cur;
        if (P && P.q.length) { const m = P.q.shift(); for (let i = 0; i < 3; i++) mem.w32(a + 4 * i, m[i] | 0); if (t) t.delayBuf = 0; return a; }
        if (!t) { mem.w32(a, 12); mem.w32(a + 4, 0); mem.w32(a + 8, 0); return a; }
        if (t.delayBuf !== a) { t.delayBuf = a; t.delayUntil = vm.now + Math.max(1, n | 0); }
        if (vm.now >= t.delayUntil) { t.delayBuf = 0; mem.w32(a, 12); mem.w32(a + 4, 0); mem.w32(a + 8, 0); return a; }
        vm.block('sleeping', { wake: Math.min(t.delayUntil, vm.now + 1) }); t.ctx.pc = DELAY_STUB; return undefined;   // re-enter on wake: a message may have come
      }
      else n = a;
      if (!vm.cur) return 0; vm.block('sleeping', { wake: vm.now + Math.max(1, n) }); return undefined;
    };
    S.gos_getmem = (c, n) => vm.alloc(n); S.gos_freemem = () => 0;
    S.gos_mkpool = () => 1; S.gos_getbuf = (c, pool) => vm.alloc(256); S.gos_freebuf = () => 0;
    S.gos_pcreate = () => { vm.ports.push([]); return vm.ports.length - 1; };
    S.gos_psend = (c, port, msg) => { const q = vm.ports[port]; if (!q) return -1; const w = q.waiters && q.waiters.shift(); if (w) vm.resume(w, msg); else q.push(msg); return 0; };
    S.gos_ppeek = (c, port) => { const q = vm.ports[port]; return q && q.length ? q[0] : 0; };
    S.gos_pcount = (c, port) => { const q = vm.ports[port]; return q ? q.length : 0; };
    S.gos_pdelete = () => 0;
    S.gos_preceive = (c, port, timeout) => {
      const q = vm.ports[port]; if (!q) return 0; if (q.length) return q.shift();
      if (!vm.cur) return 0; (q.waiters = q.waiters || []).push(vm.cur); vm.block('waiting', { waitSem: q, deadline: timeout > 0 ? vm.now + timeout * 10 : 0 }); return undefined;
    };
    S.gos_init = S.gos_setfp = S.gos = S.gos_control = S.gos_open = S.gos_close = S.gos_read = S.gos_write = S.gos_putc = S.gos_getc = () => 0;
    // gos_control(13, state, 3, key): button lamp (state 0 off, 1 lit, 2 and 3 flashing: the system arms its blink timer for both). A game asking the player to choose flashes the keys it takes
    // (Grizzly state 18 in normal play: keys 1 and 5); the host reads vm.lamps to press one
    vm.lamps = vm.lamps || {}; vm.lampSeq = 0;
    // the autoplay record as the real machine keeps it: the ROM stores the key that started the last game (Pompei: set_autoplay_old_key(5)
    // on each start) and after the game flashes the Spin lamp (state 3) while that key is still valid; -1 = none, which gave a steady lamp
    vm.oldKey = -1; vm.autoplayActive = 0;
    S.initialize_autoplay_record = () => { vm.oldKey = -1; vm.autoplayActive = 0; return 0; };
    S.get_autoplay_old_key = () => vm.oldKey; S.set_autoplay_old_key = (c, k) => { vm.oldKey = k | 0; return 0; };
    S.get_autoplay_active = () => vm.autoplayActive; S.set_autoplay_active = (c, v) => { vm.autoplayActive = v | 0; return 0; };
    S.get_pressed_key = () => vm.pressedKey;
    // gos_control(dev, cmd, a, b) dispatches to device dev's control function (table of 76-byte entries, +0x24).
    // Device 31 cmd 1 clears the status byte at a and returns 1; the game refuses a start while that byte & 63 is set (Pirates read stale stack there)
    S.gos_control = (c, op, st, x, key) => {
      if (op === 13) vm.lamps[key | 0] = { state: st | 0, t: vm.now, seq: ++vm.lampSeq };
      else if (op === 31) { if (st === 1 && x) mem.w8(x, 0); return 1; }
      return 0;
    };
    // syscall 90: gos_get_time in MK6 kernel. Virtual time only moves between frames, so a task that polls the clock in a loop without blocking
    // ("wait for input or a timeout", Grizzly 0x08013a60 at state 0) would never see it change and hang inside one runTasks. After 64 reads in
    // one frame the task sleeps until the next tick, as if the clock had moved on under it (a time poll is a wait by definition).
    // NULL3 (stub 32): returns 0 on the real machine. The ROMs use it as random(range) for chance checks: Outback Jack's mystery jackpot is
    // 'bet >= NULL3(rec, 92000) + 1' (so 0 hit it every spin and locked play.html in the card game), Corrida De Toros 75000 every spin, Golden
    // Archer Jackpot 100000. The real machine never reaches the jackpot (its meter read in that check gives 0); a uniform draw below the range gives the
    // cabinet's odds (bet / range) instead
    S.NULL3 = (c, p, range) => (range | 0) > 0 ? Math.floor(Math.random() * (range | 0)) : 0;
    S.NULL31 = () => {
      const t = vm.cur; if (!t) return vm.now | 0;
      if (t.clockFrame !== vm.frameNo) { t.clockFrame = vm.frameNo; t.clockPolls = 0; }
      if (++t.clockPolls <= 64) return vm.now | 0;
      t.clockPolls = 0; vm.block('sleeping', { wake: vm.now + 1 }); t.ctx.pc = CLOCK_STUB; return undefined;   // re-enter on wake, so the read returns the new time (resume would return 0)
    };
    const CLOCK_STUB = 0x10000 + 12 * Math.max(0, (vm.syscalls || []).indexOf('NULL31'));
    // get_sys_time_glb: the system clock in ms. Cashman Tonight rolls its Grand jackpot win for up to 2000 ms of it (0x0800beac, a 50 ms sleep a turn);
    // unimplemented it reads 0, the time-out never comes and the game parks after the Grand pick
    S.get_sys_time_glb = () => vm.now | 0;
    S.mmc_check_credit_increment_limit = () => 0;   // 0 = limit not exceeded; nonzero makes the ROM call mmc_set_reject and drop the game


    // ---- game log: persistent RAM the game reads/writes through pointers (mode 0 current game record, 2 history, ...); one zeroed buffer per (mode, size)
    const logBufs = new Map();
    // ---- power-up recovery, as on the real machine: its game log (10 entries in NVRAM) keeps every record the ROM passes to gmc_read_write_log,
    // a mode-0 record opening each game's entry. On a power-up from a save, gmc_initialise_game_log reports the last entry: 2 for a game in
    // progress, 1 (and game mode 4) for a finished one, 0 for none (Memory Reset). The ROM then runs that game again from its start-up state, and in that
    // recovery each gmc_read_write_log gets the next logged record back (states 1/2/4) while the gmc meter calls do nothing (system state 0 only), so the restored meters stay as saved. Once the logged records are used up the game goes on as normal play.
    // vm.gameLog is set by the page that saves (play.html), never by the scanners; vm.powerUpLog is the restored log for the next power-up.
    const logged = (mode, ptr, size) => ptr > 0xffff && size > 0 && size <= 64 && !(mode === 2 && size === 4);   // not the 4-word touch polls (a tight loop)
    vm.gameLog = null; vm.powerUpLog = null; vm.replay = null;
    const rwLog = (c, mode, ptr, size) => {
      if (vm.replay && logged(mode, ptr, size)) {
        const R = vm.replay; let r = R.recs[R.i++]; if (R.i >= R.recs.length && !R.done) vm.replay = null;   // a finished game's recovery ends at its gmc_at_end_of_game
        // a finished game (game mode 4) reads only a few of its records (QOTN idle save: modes 0, 2, 2, 2, 2, 1), skipping the rest: hand it the
        // next one it asks for. Taking them in order gives a feature game's free-game or key record, the replay stops, and the ROM takes the game as
        // still in progress (QOTN back at the take-win prompt, Wild Ways at Press START FEATURE, after a reload at idle)
        if (R.done && !R.recall && r && !(r[0] === mode && r[1] === size)) { let j = R.i; while (j < R.recs.length && !(R.recs[j][0] === mode && R.recs[j][1] === size)) j++; if (j < R.recs.length) { r = R.recs[j]; R.i = j + 1; } }
        // a finished game's records are not copied in: the real machine returns the caller's buffer untouched in every mode (see logFn), so the ROM keeps its own
        // copies from the restored battery RAM. Handing it the logged ones takes it back through their states (Wild Ways, Ruby Magic: [4], [9], [4], [4];
        // state 9 waited for START FEATURE). Except the mode-0 record, the game's start with its line bets: without them the redrawn result paid nothing and a
        // finished feature went straight to idle (QOTN: the real machine replays the free games; mode 0 post [1, 2, 2, ...]). Only with the game's own
        // draws to hand back (vm.drawStops): on a random redraw Ruby Magic replays free games its log does not hold and parks at state 8
        if (r && r[0] === mode && r[1] === size) { if (!(R.done && !R.recall) || (mode === 0 && vm.drawStops)) r[2].forEach((w, i) => mem.w32(ptr + 4 * i, w)); if (mode === 2 && size === 8 && Math.abs(ptr - (c.r[15] >>> 0)) >= 0x10000) vm.gameRec = ptr; return ptr; }
        if (R.done && !R.recall) { R.i--; return ptr; }   // a record the finished game never logged (Dragon Lord's 2/2 at the take-win after a feature): its buffer as it is, the replay goes on to the logged key
        vm.replay = null;   // the ROM asked for another record than the log holds: play on from here
      }
      const ret = logFn(c, mode, ptr, size);
      if (vm.gameLog && logged(mode, ptr, size)) {
        let e = vm.gameLog[vm.gameLog.length - 1];
        if (mode === 0 || !e || e.done) { vm.gameLog.push(e = { done: false, recs: [] }); if (vm.gameLog.length > 10) vm.gameLog.shift(); }
        const words = []; for (let i = 0; i < size; i++) words.push(mem.r32(ptr + 4 * i));
        if (e.recs.length < 20000) e.recs.push([mode, size, words]); else e.over = true;   // a game that never ends its log entry: not resumed
      }
      return ret;
    };
    // a logged game's end also keeps the meters as it left them (the recall list's Credit and Win)
    S.gmc_at_end_of_game = () => { if (vm.replay) { if (vm.replay.recall) { vm.recallEnd = vm.frameNo | 0; if (vm.recall.end) vm.meters = new Map(vm.recall.end); } vm.replay = null; return 0; } const L = vm.gameLog, e = L && L[L.length - 1]; if (e) { e.done = true; e.end = [...vm.meters]; } return 0; };
    const logFn = (c, mode, ptr, size) => {                    // write modes copy `size` words from ptr into the log and return the stored record; mode 0 returns the current record
      // mode 2 on a 4-word stack record, polled in a tight loop (Grizzly state 18): in game mode 1 the ROM replays recorded touches from the log and proceeds only when
      // word 1 == 7 and word 3 == 1 (the real OS sends game mode 0, where it polls the game port instead). Treat a queued port-2 touch {7, code, 1} as that record;
      // the host answers a long poll like a hotspot wait (vm.hotspotWait, ids [1]).
      if (mode === 2 && ptr > 0xffff && size === 4) {
        const P = port(2), fn = vm.frameNo | 0, lw = vm.logPoll || (vm.logPoll = { frame: -1, n: 0 });
        const k = P.q.findIndex(m => m[0] === 7 && m[2] === 1);
        const st = vm.stateAddr ? mem.r32(vm.stateAddr) : -1;
        if (k >= 0) { const m = P.q.splice(k, 1)[0]; lw.rec = [0, 7, m[1] | 0, 1]; lw.state = st; vm.hotspotWait = null; lw.n = 0; }
        if (lw.rec && lw.state === st) { lw.rec.forEach((w, i) => mem.w32(ptr + 4 * i, w)); return ptr; }   // the touch stays in the log until the game leaves the state it answered
        lw.rec = null;
        if (lw.frame !== fn) { lw.frame = fn; lw.n = 0; } else if (++lw.n === 50) { const hw = vm.hotspotWait || (vm.hotspotWait = { polls: 0, buf: ptr }); Object.assign(hw, { mode: 'log', keys: [], ids: [1] }); }
        if (lw.n >= 50 && vm.hotspotWait && vm.hotspotWait.mode === 'log' && lw.counted !== fn) { lw.counted = fn; vm.hotspotWait.polls++; }
      }
      // mode 2 on an 8-word block: the real machine returns the pointer itself and leaves the words alone. The seeding of word 4
      // with the bet is for Golden Archer Jackpot's running meters only (map.meterBlock, 0xcf0015c): there word 4 is meter 1, the total bet; the ROM clears
      // the block at state 1 and skips its own meter read on the feature path, so the jackpot amount (2 x word 4) comes out 0 and state 62 never ends.
      // Other ROMs fill their own 8-word records: Sweet Hearts 2 Lucky Devil's 0xcf0176c holds the total bet in word 4, written by the ROM,
      // so seeding it with the bet in cents multiplies every free-game win by the bet (RTP 2.7 at 10c). Bush Ranger has four such records.
      // a record on the caller's stack is a scratch copy, not the game record (Money Tree, Show Me The Money, Sweet Hearts 2)
      if (mode === 2 && ptr > 0xffff && size === 8) { if (Math.abs(ptr - (c.r[15] >>> 0)) >= 0x10000) vm.gameRec = ptr; if (ptr === vm.meterBlock && !mem.r32(ptr + 16)) mem.w32(ptr + 16, vm.betCents || 1); return ptr; }
      const k = String(mode); if (!logBufs.has(k)) logBufs.set(k, vm.alloc(0x400));
      const rec = logBufs.get(k); if (mode !== 0 && ptr > 0xffff && size > 0 && size <= 64) for (let i = 0; i < size; i++) mem.w32(rec + 4 * i, mem.r32(ptr + 4 * i));
      // the mode-0 record is the system's game log: words 52-55 (+0xd0) carry the progressive jackpot levels (meters 0x95 + 2*level), which the
      // ROM restores at game start (Golden Archer Jackpot 0x080043ac); the real machine keeps them in its SRAM log (20000 / 5000). Zeros there reset the levels.
      if (mode === 0) for (let i = 0; i < 4; i++) mem.w32(rec + 0xd0 + 4 * i, vm.meters.get(0x95 + 2 * i) | 0);
      // The real machine returns the caller's own buffer in every mode; mode 0 stores it as the next of 10 log entries. The ROM reads the
      // record back through the returned pointer: Wild Tepee copies its line bets from +4 at game start, so a zeroed copy clears them, the start picks
      // the 1-reel strip set and the reels spin on the 5-reel set towards stops past its end (state 3 never ends)
      if (ptr > 0xffff && size > 0) {
        if (mode === 0 && size > 0x37 && ![0, 1, 2, 3].some(i => mem.r32(ptr + 0xd0 + 4 * i))) for (let i = 0; i < 4; i++) mem.w32(ptr + 0xd0 + 4 * i, mem.r32(rec + 0xd0 + 4 * i));
        return ptr;
      }
      return rec;
    };
    S.gmc_read_write_log = rwLog;
    // game recall (the Audit > 2.3 Replay of Previous Games): vm.recall is one logged game, run again from its start the same way (2, in
    // progress) on a VM whose meters are a scratch copy from that game's start (entry.m); the replay lasts to its gmc_at_end_of_game (vm.recallEnd),
    // where the meters become those the game ended with (entry.end). The live meters are never loaded
    S.gmc_initialise_game_log = (c, pstate, pmode) => {
      if (vm.recall) { vm.powerUpLog = null; vm.replay = { recs: vm.recall.recs, i: 0, done: true, recall: true }; return 2; }
      const L = vm.powerUpLog; vm.powerUpLog = null; if (!L || mem.r32(pmode) !== 1) return 0;
      const e = L.length && L[L.length - 1]; if (!e || !e.recs.length || e.over) return 0;
      if (vm.gameLog) vm.gameLog = L;
      vm.replay = { recs: e.recs, i: 0, done: e.done }; if (e.done) { mem.w32(pmode, 4); return 1; } return 2;
    };
    // ---- messages between game and system (mmc/gam ports)
    vm.msgq = {};                                                    // port -> { q: [[words]], waiters: [] }
    const port = p => vm.msgq[p] || (vm.msgq[p] = { q: [], waiters: [] });
    // get_pressed_key answers the key of the last [7, key, state] message to the game port, press or release (the handler skips key 0x3f0); -1 after game load. Pompei lights its Spin lamp steady unless the pressed key is Spin
    vm.pressedKey = -1;
    // a key sent to the game during a logged game goes in its log entry too: in recovery the real machine hands the ROM the player's choices again (the gamble screen
    // opens 5 ms after the take-win prompt comes back, with no key pressed). vm.replayKey() sends the next one when the ROM waits for it
    // vm.logHost / vm.replayHost: the same for what the host decides in a game (the free-game stops it gives the ROM, Host: state 7)
    vm.logHost = (kind, words) => { const L = vm.gameLog, e = L && L[L.length - 1]; if (e && !e.done && !vm.replay) e.recs.push([kind, words.length, words.map(w => w | 0)]); };
    vm.replayHost = kind => { const R = vm.replay, r = R && R.recs[R.i]; if (!r || r[0] !== kind) return null; if (++R.i >= R.recs.length && !R.done) vm.replay = null; return r[2]; };
    const logKey = (p, words) => { if (p === 2 && words[0] === 7) vm.logHost('key', words.slice(0, 3)); };
    vm.replayKey = () => { const R = vm.replay, r = R && R.recs[R.i]; if (!r || r[0] !== 'key') return false; R.i++; vm.sendMessage(2, r[2]); if (R.i >= R.recs.length && !R.done) vm.replay = null; return true; };   // sent while still replaying: not logged again
    vm.sendMessage = (p, words) => { logKey(p, words); if (p === 2 && words[0] === 7 && words[1] !== 0x3f0) vm.pressedKey = words[1] | 0; const P = port(p), w = P.waiters.shift(); if (w) { for (let i = 0; i < 3; i++) mem.w32(w.buf + 4 * i, words[i] | 0); vm.resume(w, 0); } else P.q.push(words); };
    S.msg_send = (c, p, a, b, d) => { if (vm.opts.traceSend) console.log('msg_send', p, a, b, d, 'from', (c.pr >>> 0).toString(16), (vm.recent || []).join(' ')); const words = [a, b, d]; if (p === 2 && vm.hostLoop !== false) { vm.sendMessage(2, words); return 0; } vm.outbox = vm.outbox || []; vm.outbox.push({ port: p, words }); return 0; };   // msg_send(port, type, p1, p2): words travel in registers; game port = 2, mmc port = 1
    S.msg_recv = (c, p, buf) => {
      const P = port(p); if (P.q.length) { const m = P.q.shift(); for (let i = 0; i < 3; i++) mem.w32(buf + 4 * i, m[i] | 0); return 0; }
      if (!vm.cur) return 0; vm.cur.buf = buf; P.waiters.push(vm.cur); vm.block('waiting', { waitSem: P, deadline: 0 }); return undefined;
    };
    S.msg_count = (c, p) => port(p).q.length; S.msg_get_mmc_port = () => 1; S.msg_get_gam_port = () => 2;
    // message_line_handler(op, text, colour, priority, *handle, line): the system's message lines. Each ROM message
    // line 0..3 keeps a list of messages sorted by priority; the ROM keeps each message's handle in its own word (*handle) and draws a line through
    // write_message_handler_mes(text, colour, line). op 1 adds a message and shows it, op 2 adds it to the line's rotation (a line with more than one
    // message shows the next every 2000 ms: Pompei's "1 credit per WAY BET" / "GAME OVER PLAY NOW"), op 3 removes the handle's message and a line
    // left empty is cleared (api_clear_line_image), op 4 removes it and redraws the line at once (African Dusk's "Press TAKE WIN to PLAY ON"
    // stays in line 2's rotation for good without it), op 11 redraws a line. The line comes from the stack: using op as the line draws Pompei's
    // GOOD LUCK on line 1 instead of 0, where nothing ever removed it. Other ops (lines held during the reel spin) are not modelled; the op 10 thresholds are (mlVis below).
    const ML = vm.msgLines = [0, 1, 2, 3].map(() => ({ msgs: [], cur: null, at: 0, th: 0, ths: 0 })); let mlId = 0;
    const mlBuf = [];
    const mlWin = l => { const W = vm.openWindows().filter(w => w.font && w.font.name === 'MESSAGE').slice(-4); return W[l - (4 - W.length)] || null; };   // a game screen has two (lines 2 and 3), the menu four   // the ROM creates its four message windows (lines 0..3) in order
    const mlDraw = (l, m) => {
      const L = ML[l]; L.cur = m; L.at = vm.now + 2000; if (!vm.exports || vm.inMsgLine) return;
      if (vm.windowPrio) { const w = mlWin(l); if (w) { w.text = m ? m.text : ''; w.align = 'center'; w.valign = 'top'; w.rect = null; } return; }   // touch ROMs: write_message_handler_mes is an empty stub there (rts at 0x800543c), the system draws the line itself, centred in its window
      vm.inMsgLine = true;
      try { if (m) { const b = mlBuf[l] || (mlBuf[l] = vm.alloc(96)); vm.writeStr(b, m.text.slice(0, 95)); vm.call('write_message_handler_mes', b, m.colour, l); } else if (vm.exports.includes('api_clear_line_image')) vm.call('api_clear_line_image', l); } catch (e) {} finally { vm.inMsgLine = false; }
    };
    // the rotation only runs through the line's highest-priority messages: QOTN's free games put "N free games remaining" (priority 12) on line 2
  // beside "1 credit per line" (10), and the real machine shows only the count; the base game's "1 credit per line" / "GAME OVER PLAY NOW" (both 10) still alternate
  // Op 10 / 0xf / 0x10 set the line's minimum display priority (the line shows a message only when its priority is at least the threshold, else the
  // line is cleared): Dragon Magic's feature trigger calls op 10 with 15 on line 2, which hides "1 credit per line" under line 1's "Press START FEATURE button" (both
  // windows sit at y 84). `th` is the active threshold, `ths` the saved one that op 10 sets too and op 0x10 restores; both start at 0.
  const mlVis = L => L.msgs.filter(x => x.prio >= L.th);
  const mlTop = L => { const v = mlVis(L); return v.length ? v.filter(x => x.prio === v[0].prio) : []; };
  const mlRefresh = l => { const L = ML[l], top = mlTop(L); if (!top.length) { if (L.cur) mlDraw(l, null); } else if (!top.includes(L.cur)) mlDraw(l, top[0]); };
  // touch machines: the ROM re-creates its four MESSAGE windows (lines 0..3, in creation order) when a scene changes, and the OS's message list keeps
  // the lines' messages, so a line whose new window is blank gets its current message drawn again
  const mlRedraw = () => { for (let l = 0; l < 4; l++) { const w = mlWin(l), c = ML[l].cur; if (w && c && w.text !== c.text) mlDraw(l, c); } };
  vm.msgFooter = text => mlDraw(3, { id: ++mlId, text, colour: 3, prio: 0 });   // the OS's own line-3 text (touch machines: "Memory Reset" after a power-up without a saved game)
  vm.msgTick = () => { if (vm.windowPrio) mlRedraw(); for (let l = 0; l < 4; l++) { const L = ML[l], top = mlTop(L); if (top.length > 1 && vm.now >= L.at) mlDraw(l, top[(top.indexOf(L.cur) + 1) % top.length]); } };
    S.message_line_handler = (c, op, text, colour, prio) => {
      const h = mem.r32(c.r[15]) >>> 0, l = mem.r32(c.r[15] + 4) | 0, ok = h > 0x8000000 && h < 0xd000000, L = ML[l];
      if ((op === 1 || op === 2) && L && (text >>> 0) > 0x8000000) {
        if (ok && mem.r32(h)) return 1;   // the handle already holds a message
        const m = { id: ++mlId, text: vm.cstr(text), colour, prio: prio | 0 }; if (ok) mem.w32(h, m.id);
        let i = L.msgs.findIndex(x => x.prio < m.prio); if (i < 0) i = L.msgs.length; L.msgs.splice(i, 0, m);
        if (m.prio >= L.th && (op === 1 || !L.cur || m.prio > L.cur.prio)) mlDraw(l, m);
        return 1;
      }
      if ((op === 3 || op === 4) && ok) {
        const id = mem.r32(h); if (!id) return 1; mem.w32(h, 0);
        for (let k = 0; k < 4; k++) { const K = ML[k], i = K.msgs.findIndex(x => x.id === id); if (i < 0) continue; K.msgs.splice(i, 1); if (K.cur && K.cur.id === id) { const top = mlTop(K), n = K.msgs[i % (K.msgs.length || 1)]; mlDraw(k, n && top.includes(n) ? n : top[0] || null); } }   // the next of the top priority (the removed one was the top: a lower one never shows while a higher one is listed)
        return 1;
      }
      if (op === 11 && L && L.cur) { if (L.cur.prio < L.th) mlRefresh(l); else mlDraw(l, L.cur); }
      if ((op === 10 || op === 0xf) && L) { const old = op === 10 ? L.ths : L.th; L.th = prio | 0; if (op === 10) L.ths = L.th; mlRefresh(l); return old; }   // returns the previous value (the ROM restores it later)
      if (op === 0x10) for (let k = 0; k < 4; k++) { ML[k].th = ML[k].ths; mlRefresh(k); }
      return 1;
    };
    // player keys: the game asks the system for the next key press; key presses arrive as [7,key,flag] on the game port
    vm.keyWait = null; vm.assigned = [];
    // The system also keeps the key list in ROM memory: 0x21 entries { flag, value }, cleared on reset, list[key] = { 1, value } on assign.
    // The hotspot waits (modes 4, 5, 8) read it to know which keys are valid (Corrida De Toros pick: keys 2 and 4).
    const keyList = a => a > 0xa000000 && a < 0xd000000;
    S.gmc_reset_player_keys = (c, list) => { vm.assigned = []; if (keyList(list)) for (let i = 0; i < 0x21; i++) { mem.w32(list + 8 * i, 0); mem.w32(list + 8 * i + 4, 0); } return 0; };
    S.gmc_assign_key = (c, set, key, value) => { vm.assigned.push(key); if (keyList(set) && key >= 0 && key < 0x21) { mem.w32(set + 8 * key, 1); mem.w32(set + 8 * key + 4, value); } return 0; };
    S.gmc_get_next_key = S.gmc_get_next_specific_key = (c, a, out) => {
      if (a > 0xffff && out < 0x10000) out = a;                                    // gmc_get_next_key(out)
      const P = port(2); if (P.q.length) { const m = P.q.shift(); for (let i = 0; i < 3; i++) mem.w32(out + 4 * i, m[i] | 0); return 0; }
      // A wait the host has not answered (vm.keyWait still set) that a non-key message ended (SP_TIMER ticks [15,4] every second) keeps its start time,
      // so the host's "press after 1500 ms" rule still fires (Corrida De Toros state 20 after the free games)
      const keys = vm.assigned.slice(), prev = vm.keyWait, since = prev && prev.keys.join() === keys.join() ? prev.since : vm.now;
      if (!vm.cur) return 0; vm.cur.buf = out; vm.keyWait = { keys, since }; P.waiters.push(vm.cur); vm.block('waiting', { waitSem: P, deadline: 0 }); return undefined;
    };

    // ---- accounting: meters and options
    S.acc_enter_critical_region = S.acc_exit_critical_region = S.gmc_enter_critical_region = S.gmc_exit_critical_region = () => 0;
    // meter ids are 16-bit: the ROM leaves garbage in the upper bits of r4
    S.acc_read_meter = S.gmc_read_meter = S.acc_read_meter_3w = (c, id, out) => { id &= 0xffff; if (out) { mem.w32(out, vm.meters.get(id) | 0); } return 0; };   // value is returned through the pointer
    S.acc_write_meter = (c, id, v) => { id &= 0xffff; vm.meters.set(id, v); return 0; };
    S.acc_decrement_meter = (c, id, n) => { id &= 0xffff; vm.meters.set(id, (vm.meters.get(id) | 0) - n); return 0; };
    S.acc_increment_meter = (c, id, n) => { id &= 0xffff; vm.meters.set(id, (vm.meters.get(id) | 0) + (n === undefined ? 1 : n)); return 0; };
    // the gmc meter calls do nothing while the ROM replays a logged game after a power-up (see gmc_initialise_game_log).
    S.gmc_write_meter = (c, ...a) => vm.replay ? 0 : S.acc_write_meter(c, ...a); S.gmc_decrement_meter = (c, ...a) => vm.replay ? 0 : S.acc_decrement_meter(c, ...a); S.gmc_increment_meter = (c, ...a) => vm.replay ? 0 : S.acc_increment_meter(c, ...a);
    // Get_Data_From_System_game2sys(req, &a, &b). Request 0: meter id of jackpot level *a, column *b, from the system's table
    // (column 0 = the level's current value: 0x95, 0x97, 0x99, 0x9b). Other requests are not implemented (they return 0).
    const JP_METERS = [[0x95, 0x96, 0x9d, 0x9e, 0xa5, 0x18, 0x203, 0x207], [0x97, 0x98, 0x9f, 0xa0, 0xa6, 0x19, 0x204, 0x208], [0x99, 0x9a, 0xa1, 0xa2, 0xa7, 0x1a, 0x205, 0x209], [0x9b, 0x9c, 0xa3, 0xa4, 0xa8, 0x1b, 0x206, 0x20a]];
    // request 5: the ROM has hit progressive levels (Outback Jack's card game: Major, Minor). The system asks the ROM which ones
    // (sys2game 6: a bit mask), and for each adds the level's value (cents, meter 0x95 + 2*level) to word 3 of the game's running record (the
    // 8-word block the ROM registers through gmc_read_write_log mode 2), sets its word 0 to 14, puts the amount on meter 0x93 and starts the level
    // over. The ROM then pays the difference in word 3 as the prize; without this a Major or Minor pays nothing.
    const jackpotHit = () => {
      let mask = romCall('Get_Data_From_Game_sys2game', 6, 0, 0, 0) >>> 0; const rec = vm.gameRec, recs = romCall('Get_Data_From_Game_sys2game', 5, 0, 0, 0) >>> 0;
      const n = romCall('get_progressive_levels') | 0; let paid = 0;
      for (let i = 0; i < n && i < 4 && mask; i++, mask >>>= 1) {
        if (!(mask & 1)) continue;
        const start = recs >= 0x8000000 && recs < 0xc000000 ? mem.r32(recs + 12 * i) | 0 : 0, v = (vm.meters.get(0x95 + 2 * i) | 0) || start, M = JP_METERS[i];
        // the level starts over from its start value plus the reserve that built up beside it
        paid += v; vm.meters.set(0x93, v); vm.meters.set(M[1], vm.meters.get(M[3]) | 0); vm.meters.set(M[0], start + (vm.meters.get(M[2]) | 0)); vm.meters.set(M[2], 0); vm.meters.set(M[3], 0);
        (vm.jackpotsHit = vm.jackpotsHit || []).push({ level: i, cents: v });
      }
      if (rec && paid) { mem.w32(rec + 12, (mem.r32(rec + 12) | 0) + paid); mem.w32(rec, 14); }
      return 1;
    };
    // request 6: a paid game's bet (cents) feeds the levels, as the real machine does. The ROM's level table (sys2game 5) has 3 words a level:
    // start (cents), the rate of the level shown, the rate of a reserve kept for its next start, both in 1/100,000,000 of the bet (Outback Jack: Major
    // 90000, 1%, 0.5%; Minor 1000, 1%, 0.1%). Whole cents go to the level meter (column 0 / 2), the rest to its fraction meter (column 1 / 3, 1e-8 cent)
    const jackpotContribute = bet => {
      const recs = romCall('Get_Data_From_Game_sys2game', 5, 0, 0, 0) >>> 0, n = romCall('get_progressive_levels') | 0;
      if (bet <= 0 || n < 1 || recs < 0x8000000 || recs >= 0xc000000) return 1;
      const add = (id, fr, rate) => { const t = bet * rate + (vm.meters.get(fr) | 0), whole = Math.floor(t / 1e8); vm.meters.set(fr, t - whole * 1e8); if (whole) vm.meters.set(id, (vm.meters.get(id) | 0) + whole); };
      for (let i = 0; i < n && i < 4; i++) { const M = JP_METERS[i], start = mem.r32(recs + 12 * i) | 0;
        if (!(vm.meters.get(M[0]) | 0)) vm.meters.set(M[0], start);
        add(M[0], M[1], mem.r32(recs + 12 * i + 4) | 0); add(M[2], M[3], mem.r32(recs + 12 * i + 8) | 0); }
      return 1;
    };
    S.Get_Data_From_System_game2sys = (c, req, pa, pb) => {
      if (req === 0 && pa && pb) { const row = JP_METERS[mem.r32(pa) | 0], v = row && row[mem.r32(pb) | 0]; return v || 0; }
      if (req === 5) return jackpotHit();
      if (req === 6 && pa) return jackpotContribute(mem.r32(pa) | 0);
      return 0;
    };
    // acc_get_cents_per_token: default 10000; the denomination box reads "$100 Buys 2000 Credits" from it
    S.acc_get_cents_per_token = () => vm.options.centsPerToken || 10000; S.acc_get_base_credit_value = () => vm.options.denom || 1; S.acc_get_cr_multiplier = () => 0;
    vm.options = Object.assign({ lineIdx: 0, betIdx: 0, variation: 1 }, vm.opts.options);    // acc_get_num_lines/bets return the *selected configuration indices* (byte globals the system also hands to set_base_credit/prvrn_init)
    S.acc_get_num_lines = () => vm.options.lineIdx; S.acc_get_num_bets = () => vm.options.betIdx; S.acc_get_percentage_variation_index = () => vm.options.variation;
    S.acc_get_max_doubleups = () => 5; S.acc_set_lines_bets = () => 0;
    // ---- touch-screen buttons (Players Choice, Cashman Tonight), as the system implements them; both tables come from
    // ROM exports and depend on the selected game, so they are read on every use: Get_Data_From_Game_sys2game(0x1f) -> [+4], 16-byte entries
    // {code, type, ptr, slot} ended by code -100; get_token_credit(0, 0, i) for i = 0.. until -1 (the physical button list).
    const romCall = (n, ...a) => { try { return vm.call(n, ...a); } catch (e) { return -1; } };
    const buttonTable = () => { const p = romCall('Get_Data_From_Game_sys2game', 0x1f, 0, 0, 0) >>> 0; return p >= 0x8000000 && p < 0x10000000 ? mem.r32(p + 4) >>> 0 : 0; };
    const buttonFind = (match, want) => { let e = buttonTable(); if (!e) return -1; for (let k = 0; k < 256 && (mem.r32(e) | 0) !== -100; k++, e += 16) if ((mem.r32(e + match) | 0) === (want | 0)) return e; return -1; };
    S.get_driver_id = (c, code) => { const e = buttonFind(0, code); return e < 0 ? -1 : mem.r32(e + 12) | 0; };      // button code -> slot
    S.get_action_id = (c, slot) => { const e = buttonFind(12, slot); return e < 0 ? -1 : mem.r32(e) | 0; };       // slot -> button code
    S.enable_button_map = (c, list) => { const old = vm.buttonMap | 0; vm.buttonMap = list >>> 0; return old; };   // {code, flags} pairs ended by -1; a touch counts only if listed with flags & 1
    S.flush_button_input = (c, p) => { const q = port(p).q; for (let k = q.length - 1; k >= 0; k--) if (q[k][0] === 7 || q[k][0] === 0x15) q.splice(k, 1); return 0; };   // drop queued key messages
    // touch machines: the system's version returns the ROM's own physical-button record (Get_Data_From_Game_sys2game 0x1f); its +4 field is the panel type the ROM
    // looks up at power-up (on_powerup_game_init) to decide whether the game draws its own on-screen bet / line buttons (AD_SCN_MAIN_BUTTON, the 1/2/5/10 and 1/5/10/20/20+ plates)
    S.acc_get_physical_button_ptr = (c, code) => { if (vm.options.touchButtons) return romCall('Get_Data_From_Game_sys2game', 0x1f, 0xcff0000, 0); return S.acc_get_physical_button_ptr_idx(c, code); };
    S.acc_get_physical_button_ptr_idx = (c, code) => { for (let i = 0; i < 64; i++) { const v = romCall('get_token_credit', 0, 0, i) | 0; if (v === -1) return 0; if (v === (code | 0)) return i; } return 0; };   // index of the code in the physical button list, 0 if absent

    // ---- objects, positions, strings
    // multi-game ROMs keep each game's art in its own media pack (avl.js openPacks); the system keeps a table of loaded files (100 slots)
    S._loadmediafile = (c, name) => (vm.db && vm.db.load ? vm.db.load(vm.cstr(name)) : 1); S._unloadmediafile = (c, name) => { if (vm.db && vm.db.unload) vm.db.unload(vm.cstr(name)); return 0; };
    S._loadresourcedata = () => 1; S._setvideomode = () => 1; S._initscenesystem = () => 1; S._waitDMrefresh = () => 0;
    S._getobjecthandle = (c, name, type) => {
      const sec = TYPE_SECTION[type]; if (!vm.db || !sec) return 0; const rec = vm.db.get(sec, vm.cstr(name));
      return rec ? vm.handle(rec) : 0;
    };
    S._getposition = (c, name, px, py, pz) => {
      if (px) mem.w32(px, 0); if (py) mem.w32(py, 0); if (pz) mem.w32(pz, 0);
      const rec = vm.db.get(3, vm.cstr(name)); if (!rec) return -1;   // 0 when found, -1 when not (Players Choice tries "BP_" + name, "PK_" + name, name)
      const v = new DataView(rec.body.buffer, rec.body.byteOffset, rec.body.byteLength);
      if (px) mem.w32(px, v.getInt32(0, true)); if (py) mem.w32(py, v.getInt32(4, true)); if (pz) mem.w32(pz, rec.b | 0); return 0;   // z is the record's b word (POS_REEL_1_SYM: 16200, the reel symbols' draw priority)
    };
    // _getstring(name) -> the text of string resource `name` (the name is looked up; a handle is accepted too). STRG body: text from +32
    // A name the ROM does not hold comes from the system's own resources (mk6.avl, loaded with market.avl): Big Ben Jackpot's denomination badge asks for "% Credits"
    // and "GAM Letter S". the real machine answers "String Not Found" for a name in neither
    const exeStrings = { '% Credits': '%d Credit%s', 'GAM Letter S': 's', '% Large Buys': '$%d Buys', '% Small Buys': '%d\x9b Buys', '% Large Game Denom': '$%d', '% Small Game Denom': '%d\x9b', '% Credits Per Line': '%d credit%s X line bet' }, exeRecs = {};
    S._getstring = (c, h) => {
      let rec = (h >>> 0) >= 0x8000000 ? vm.db.get(5, vm.cstr(h)) : vm.handles[h];
      if (!rec && (h >>> 0) >= 0x8000000) { const n = vm.cstr(h); if (exeStrings[n] !== undefined) rec = exeRecs[n] || (exeRecs[n] = { body: Uint8Array.from(exeStrings[n], ch => ch.charCodeAt(0)) }); }
      if (!rec) return 0; let a = vm.strCache.get(rec);
      if (!a) { const b = rec.body, at = b.length > 32 && b[0] === 0x53 && b[1] === 0x54 && b[2] === 0x52 && b[3] === 0x47 ? 32 : 0; let e = at; while (e < b.length && b[e]) e++; a = vm.alloc(e - at + 1); for (let i = at; i < e; i++) mem.w8(a + i - at, b[i]); mem.w8(a + e - at, 0); vm.strCache.set(rec, a); }
      return a;
    };
    // string objects (Players Choice menu labels, denomination box): _createstring(text, flags, font handle, length (0 / -1: all); stack: ?, rectangle out [0, 0, w, h]) -> handle; placed with _setsceneentry or _addscene
    S._createstring = (c, ptr, flags, fh, len) => { const frec = vm.handles[fh]; if (!frec || frec.kind !== 4) return 0; let t = vm.cstr(ptr); if (vm.windowPrio && t.includes('%')) t = format(c, t, 0, 2);   /* touch machines: the string is a format, its arguments follow the colour and rect words (the bet / line plates: "%d", "%s") */
      if ((len | 0) > 0) t = t.slice(0, len); const f = vm.font(frec), rect = mem.r32(c.r[15] + 4) >>> 0; if (rect) { mem.w32(rect, 0); mem.w32(rect + 4, 0); mem.w32(rect + 8, vm.textWidth(f, t)); mem.w32(rect + 12, f.h || 16); } const h = vm.nextObj++; vm.objs.set(h, { kind: 'str', text: t, font: f }); return h; };
    S._destroystring = (c, h) => { if (vm.objs) vm.objs.delete(h); return 0; };
    let propVtable = 0;
    S.pProp = S.pMath = () => {
      if (!propVtable) {
        const stubFn = vm.alloc(4);
        mem.w16(stubFn, 0x000b); // RTS
        mem.w16(stubFn + 2, 0x0009); // NOP
        propVtable = vm.alloc(64);
        for (let i = 0; i < 16; i++) mem.w32(propVtable + 4 * i, stubFn);
      }
      return propVtable;
    };


    // ---- text windows: _drawtextDC stores the string on the window; MK6RENDER lays it out with the window's bitmap font (FONT record: image id, first char, glyph count, then an x-offset table, one entry per glyph)
    const win = h => D.windows[h - 1];
    // the windows not yet destroyed, in creation order: a touch ROM makes new MESSAGE windows at each scene change and a handle is never reused, so
    // D.windows only grows (about 26 a game on Players Choice); the message lines (every frame) and the renderer walk this list instead
    vm.openWindows = () => (D.open = (D.open || D.windows).filter(w => w.visible));
    S._createwin = (c, x, y, w, h) => { const o = { x, y, w, h, text: '', font: null, fg: -1, mode: 0, visible: true, prio: mem.r32(c.r[15]) & 0x7fffffff }; D.windows.push(o); if (D.open) D.open.push(o);   // prio: the 5th argument (the display item's priority; only drawn by it when vm.windowPrio)
      return D.windows.length; };
    S._getscreenDC = () => 1;
    S._clearDC = (c, dc) => { const w = win(dc); if (w) w.text = ''; return 0; };   // a cleared window shows nothing until the next _drawtextDC (Pompei blanks a meter at each spin)
    S._getwinDC = (c, h) => h;
    S._setfontDC = (c, dc, fh) => { const w = win(dc); if (w) w.font = vm.handles[fh] ? vm.font(vm.handles[fh]) : null; return 0; };
    S._setfgcolorDC = (c, dc, col) => { const w = win(dc); if (w) w.fg = col | 0; return 0; };
    S._setbkmodeDC = () => 0;
    S._setwinmode = (c, h, m) => { const w = win(h); if (w) w.mode = m; return 0; };
    // _drawtextDC(dc, text, length or -1, rect; stack: flags): the system keeps the text, flags and rect {left, top, right, bottom} on the window (no rect: the
    // window's own) and lays it out each frame in the rect moved to the window's origin: flags & 0xc == 0xc centres it across, else 8 puts it at the right;
    // flags & 3 == 3 centres it down, else 2 puts it at the bottom; otherwise left / top. The meters and message lines pass 0x1000c (centred across, top),
    // Big Ben Jackpot's jackpot amount 0x10008 (right, top: "        50.00" ends at the rect's right edge, 419 + 208)
    S._drawtextDC = (c, dc, str, len, rc) => { const w = win(dc); if (w) { const t = vm.cstr(str), fl = mem.r32(c.r[15]) >>> 0; w.text = len >= 0 ? t.slice(0, len) : t;
      w.align = (fl & 0xc) === 0xc ? 'center' : fl & 8 ? 'right' : 'left'; w.valign = (fl & 3) === 3 ? 'center' : fl & 2 ? 'bottom' : 'top';
      w.rect = rc ? [0, 4, 8, 12].map(i => mem.r32(rc + i) | 0) : null; } return 0; };
    S._getwidthDC = (c, dc) => (win(dc) || { w: 640 }).w; S._getheightDC = (c, dc) => (win(dc) || { h: 480 }).h;
    S._destroywin = (c, h) => { const w = win(h); if (w) w.visible = false; return 0; };
    S._lockwin = S._unlockwin = S._invalidatewin = () => 0;
    S._getfonttype = (c, fh) => { const rec = vm.handles[fh]; return rec ? new DataView(rec.body.buffer, rec.body.byteOffset, rec.body.byteLength).getInt32(4, true) : 0; };
    // _gettextlength(font handle, text) like _getfontheight (the meter windows are sized from it: 8 x width of "0"); a window's font as a fallback
    S._gettextlength = (c, h, str) => { const rec = vm.handles[h], f = rec && rec.kind === 4 ? vm.font(rec) : (win(h) || {}).font; return f ? vm.textWidth(f, vm.cstr(str)) : vm.cstr(str).length * 8; };
    S._getfontheight = (c, fh) => { const rec = vm.handles[fh], f = rec && vm.font(rec); return f ? f.h : 16; };
    // language-specific strings of the system (default locale): 1 currency symbol, 2 cent symbol, 3 decimal point
    const LANG = {}; S.get_language_specific = (c, n) => { if (!(n in LANG)) { const t = { 1: '$', 2: '\xa2', 3: '.' }[n]; if (t === undefined) return 0; LANG[n] = vm.alloc(4); vm.writeStr(LANG[n], t); } return LANG[n]; };
    S.isMultiLangString = () => 0;
    S.flt_set_game_played_since_door_closed = () => 0;
    let errnoAddr = 0; S.addr_errno = () => (errnoAddr || (errnoAddr = vm.alloc(4)));

    // ---- scenes
    // Objects the game builds at run time (_createscene, _createbox, _createstring return object handles like _getobjecthandle):
    // kept apart from resource handles and scene ids, from 0x10000 up, so _destroyobject can tell an object from a running scene
    vm.objs = vm.objs || new Map(); vm.nextObj = vm.nextObj || 0x10000;
    const newObj = o => { const h = vm.nextObj++; vm.objs.set(h, o); return h; };
    const obj = h => (h >= 0x10000 ? vm.objs.get(h) : vm.handles[h]) || null;
    // a scene instance's display items; touch boxes are items without art (the compositor skips them), vm.touchAt hit-tests them
    // a touch-flagged image in one solid colour is only the touch area, not art (Outback Jack's river rocks: IMG_ROCK_HOTSPOT, 61x58 plain white): a box
    const hitAreas = new Map(), hitArea = id => { if (hitAreas.has(id)) return hitAreas.get(id); const im = vm.image(id); if (!im) return false; const r = im.rgba; let one = true;
      for (let k = 4; k < r.length && one; k += 4) if (r[k] !== r[0] || r[k + 1] !== r[1] || r[k + 2] !== r[2] || r[k + 3] !== r[3]) one = false; hitAreas.set(id, one); return one; };
    const place = (sc, it) => {
      let d = null;
      if (it.kind === 0) d = { box: true, x: it.x, y: it.y, w: it.w, h: it.h, code: it.code, prio: it.prio, flags: it.flags, visible: true, scene: sc.id };
      else if (it.kind === 1 && it.code !== undefined && hitArea(it.id)) { const im = vm.image(it.id); d = { box: true, x: it.x, y: it.y, w: im.w, h: im.h, code: it.code, prio: it.prio, flags: it.flags, visible: true, scene: sc.id }; }
      else if (it.kind === 1) d = { img: it.id, x: it.x, y: it.y, prio: it.prio, flags: it.flags, visible: true, scene: sc.id, code: it.code, ePlays: it.ePlays };   // ePlays: the entry's play count (_setsceneentry 7th argument); the host tells the ROM's win-flash symbol copies by -1
      else if (it.kind === 7) d = { flic: it.id, x: it.x, y: it.y, prio: it.prio, flags: it.flags, visible: true, scene: sc.id, t0: vm.now, plays: it.plays };
      else if (it.kind === 'str') d = { text: it.text, font: it.font, x: it.x, y: it.y, prio: it.prio, flags: it.flags, visible: true, scene: sc.id };
      if (d) { D.items.push(d); sc.dm.push(D.items.length - 1); }
    };
    // sprites (SPRT, section 11): a frame list played by time. Body: 'SPRT', frame count, 1, 0, then 9 words a frame: kind (1 image), image index, -1,
    // sequence, duration in ms, scale (256 = 1), rotation, dx, dy. a sprite runs as a scene slot of its own ('Spr}'), also when it is an entry of a
    // scene: _findscene finds it by name and its end fires its _setsceneevent callback (QOTN Clown Jackpot's API_rotate plays SCN_headNN and sleeps
    // until SP_Clown_Head_NN ends; without the sprite slot it never sleeps and state 17 spins forever). Scale and rotation are not drawn.
    const spriteFrames = rec => {
      const b = rec.body, v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getInt32(4, true), fr = [];
      for (let k = 0, o = 16; k < n && o + 36 <= b.length; k++, o += 36) fr.push({ kind: v.getInt32(o, true), img: v.getInt32(o + 4, true) + (rec.pack ? rec.pack.base[v.getInt32(o, true)] | 0 : 0), ms: Math.max(1, v.getInt32(o + 16, true)), dx: v.getInt32(o + 28, true), dy: v.getInt32(o + 32, true) });
      return fr;
    };
    // motions (MSEQ, section 8): a scene entry's word 2 names one; it moves the entry over time. Body: 'MSEQ', step count, mode, then 6 words a step:
    // duration (ms), flag, dx, dy (from the start), 2 words not used here. Double Dolphin's dives share one sprite per reel group and reach their
    // row and reel by motion (SCN_SP_Dive_4_3: SP_down_5 with MOTION_DIVE_3_5to4); without it the dolphin lands in the wrong tile.
    const motionSteps = idx => motionOf(idx >= 0 && vm.db.byIndex(8, idx));
    const motionOf = r => {
      if (!r || !r.body || r.body.length < 12) return null;
      const v = new DataView(r.body.buffer, r.body.byteOffset, r.body.byteLength), n = v.getInt32(4, true), st = [];
      for (let k = 0, o = 12; k < n && o + 24 <= r.body.length; k++, o += 24) st.push({ ms: Math.max(1, v.getInt32(o, true)), dx: v.getInt32(o + 8, true), dy: v.getInt32(o + 12, true) });
      return st.length ? st : null;
    };
    // plays: the play count, -1 for ever. A scene entry gives its own (word 4 low half, Pompei's SCN_A_Volcano runs SP_SP_vulc and SP_SP_COINSPIN_n with -1, its fades
    // with 1); a sprite added on its own takes its header word 2 (1, or -1 for SPRITE_Coin). The real machine plays the volcano's
    // eruption from the reel stop until the next press; played once, it freezes on its last frame after 1.4 s
    const newSprite = (rec, x, y, prio, base, motion = -1, plays, code, depth = 0) => {
      const fr = spriteFrames(rec); if (!fr.length) return null; const mo = motionSteps(motion);
      if (plays === undefined) plays = new DataView(rec.body.buffer, rec.body.byteOffset, rec.body.byteLength).getInt32(8, true);
      const sp = { id: D.nextScene++, rec, x, y, base, items: [], dm: [], visible: true, sprite: fr, motion: mo, plays, spriteMs: Math.max(fr.reduce((t, f) => t + f.ms, 0), mo ? mo.reduce((t, s) => t + s.ms, 0) : 0), t0: vm.now };
      const d = { img: fr[0].img, x: x + fr[0].dx, y: y + fr[0].dy, prio, flags: 0, visible: fr[0].kind === 1, scene: sp.id, code };
      D.items.push(d); sp.dm.push(D.items.length - 1); sp.spriteItem = d; D.scenes.push(sp);
      // frames can also start a FLIC (kind 7), play a sound (9) or start a sub-sprite (11). A FLIC frame is a slot of its own from the start, so
      // _findscene finds it before the sprite plays (Outback Jack's catch: SP_BMRG_CATCH2 starts FLC_FEA_catch, the ROM hooks its end); it runs once
      // the sprite reaches that frame
      fr.forEach((f, k) => { if (f.kind !== 7) return; const fl = vm.db.byIndex(7, f.img); if (!fl) return;
        const it = { kind: 7, id: f.img, x: x + f.dx, y: y + f.dy, prio }, di = { flic: f.img, x: it.x, y: it.y, prio, flags: 0, visible: false, scene: 0, t0: vm.now };
        const ch = { id: D.nextScene++, rec: fl, x: it.x, y: it.y, base, items: [it], dm: [], visible: true, parent: sp, frameIdx: k, viaSprite: true };
        di.scene = ch.id; D.items.push(di); ch.dm.push(D.items.length - 1); D.scenes.push(ch); (sp.fx = sp.fx || []).push(ch); (sp.children = sp.children || []).push(ch); });
      // a kind 11 frame starts another sprite when the frame is reached (5 Dragons' pick screen: SSP_Sel_DragFade_<colour> frame 1 starts SP_Sel_DragonFade_<colour>, the dragon's
      // fade-in that ends on its picture; without it the five dragons only appear once a key brought the "selected" scene)
      if (depth < 4) fr.forEach((f, k) => { if (f.kind !== 11) return; const sr = vm.db.byIndex(11, f.img); if (!sr) return;
        const ch = newSprite(sr, x + f.dx, y + f.dy, prio, base, -1, undefined, undefined, depth + 1); if (!ch) return;
        ch.visible = false; const di = D.items[ch.dm[0]]; if (di) di.visible = false; ch.parent = sp; ch.frameIdx = k; ch.viaSprite = true; (sp.fx = sp.fx || []).push(ch); (sp.children = sp.children || []).push(ch); });
      return sp;
    };
    const showSpriteFrame = sp => {   // the frame at the time played so far (the last one once it has run out)
      const d = sp.spriteItem; if (!d) return; let t = sp.playing ? vm.now - sp.t0 : sp.ran ? sp.spriteMs : 0, f = sp.sprite[sp.sprite.length - 1];
      // a repeating sprite goes round again (as a FLIC with a play count, mk6render): -1 for ever, n for n passes. Its end callback still fires after the
      // first pass (sceneLength); only the picture repeats. Sounds and FLICs on its frames start on the first pass only
      if (sp.ran && sp.plays !== 1 && sp.plays !== 0 && sp.spriteMs > 0) { const u = vm.now - sp.t0; if (sp.plays < 0 || u < sp.plays * sp.spriteMs) t = u % sp.spriteMs; }
      const t1 = t; for (const g of sp.sprite) { if (t < g.ms) { f = g; break; } t -= g.ms; }
      let mx = 0, my = 0; if (sp.motion) { let u = t1, m = sp.motion[sp.motion.length - 1]; for (const s of sp.motion) { if (u < s.ms) { m = s; break; } u -= s.ms; } mx = m.dx; my = m.dy; }
      d.img = f.img; d.x = sp.x + f.dx + mx; d.y = sp.y + f.dy + my; d.visible = sp.visible !== false && f.kind === 1;
      if (!sp.playing) return; const fi = sp.sprite.indexOf(f); sp.fxDone = sp.fxDone || new Set();
      sp.sprite.forEach((g, k) => { if (k > fi || sp.fxDone.has(k)) return; sp.fxDone.add(k);
        if (g.kind === 9 && !vm.muteSound) vm.sound.play(vm.db.byIndex(9, g.img), sp.id);
        for (const ch of sp.fx || []) if (ch.frameIdx === k) { if (ch.sprite) ch.visible = true; ch.playing = true; ch.ran = true; ch.t0 = vm.now; ch.endAt = vm.now + sceneLength(ch); const di = D.items[ch.dm[0]]; if (di) { di.visible = true; di.t0 = vm.now; } } });
    };
    // put the reel symbols under a flash scene back: only where the blank is still shown (a new spin may already have drawn other symbols there)
    const unblank = sc => { for (const h of sc.hid || []) if (h[2] !== undefined && h[0].img === h[2]) { h[0].img = h[1]; h[2] = undefined; } };
    // the sprites and FLICs a play starts: the scene's own and those of the scenes nested in it (Outback Jack's cave plays SCN_FEA_CAVE_SHAKE and waits
    // for SP_cave_run inside its nested scene)
    const playTree = sc => { const out = []; for (const ch of sc.children || []) { if (ch.viaSprite) continue; if (ch.nested) { ch.playing = true; ch.ran = true; ch.t0 = vm.now; const kids = playTree(ch); out.push(...kids);
        // its end, which fires its callback: the longest of its own items and its sprites / FLICs (Big Hearted waits for the nested SCN_A_Heart; with no end time it never ends)
        ch.cycleMs = Math.max(sceneLength(ch), ...kids.map(k => sceneLength(k))); ch.endAt = vm.now + ch.cycleMs; } else { ch.fxDone = null; out.push(ch); } } return out; };
    const unhide = sc => { unblank(sc); sc.hid = null; };
    // the game's blank reel symbol: GS_BLANK, IMG_SYM_BLANK, CSR_GS_BLANK, HL_IMG_SYM_blank, blank ... (115 of 119 ROMs); not feature / help / per-position tiles
    let blankIdx; const blankSymbol = () => {
      if (blankIdx !== undefined) return blankIdx; const recs = (vm.db.sections[1] || { recs: [] }).recs.filter(r => r && /blank/i.test(r.name) && !/feat|help|bars|royal|^IMG_HL_|^BOX|_\d+$/i.test(r.name));
      const r = recs.find(r => /(^|_)(GS_|SYM_)blank$/i.test(r.name)) || recs.find(r => /^blank$/i.test(r.name)) || recs.find(r => /(^|_)blank$/i.test(r.name)) || recs.find(r => /blank_image|base_blank/i.test(r.name))
        || (vm.db.sections[1] || { recs: [] }).recs.find(r => r && /^IMG_BG_BLANK_\d+$/i.test(r.name));   // QOTN: IMG_BG_BLANK_11 (its parchment tile)
      return (blankIdx = r ? r.index : -1);
    };
    // the blank of the symbol set a tile belongs to: Where Is The Gold's free games draw GS_B_<symbol> tiles on black, and their blank is GS_B_BLANK (the base set's
    // GS_BLANK is tan); a tile with no blank of its own set gets the game's blank
    const setBlanks = new Map();
    // the free games' cloud backdrop is up: a scene holds a whole grid of per-cell background tiles (Arabian Nights' SCN_FEATURE_REELS, 15 IMG_a_feat_blank_<reel><row>).
    // It goes when the free games end, before the win is collected: the host's flash and the scene blink then go back to the game's light blue
    vm.skyShowing = () => { let n = 0; for (const d of D.items) if (d && !d.dead && d.visible && d.scene !== undefined && d.img !== undefined && /feat_blank_\d\d$/i.test((vm.db.byIndex(1, d.img) || {}).name || '') && ++n >= 10) return true; return false; };
    const blankFor = (img, it) => {
      const r = vm.db.byIndex(1, img), pre = r && /^(.*_)[^_]*$/.exec(r.name || '');
      if (!pre) return blankSymbol();
      // while the cloud backdrop is up a tile at a reel cell that has its own background tile (Arabian Nights: IMG_a_feat_blank_<reel><row>, the cloud sky) blanks to that, not to the game's light-blue IMG_a_BLANK; the base game keeps the light blue
      if (it && vm.skyShowing()) { const own = vm.db.get(1, pre[1] + 'feat_blank_' + (Math.round((it.x - 50) / 110) + 1) + (Math.round((it.y - 121) / 100) + 1)); if (own) return own.index; }
      if (!setBlanks.has(pre[1])) { const want = (pre[1] + 'blank').toLowerCase(), b = (vm.db.sections[1] || { recs: [] }).recs.find(q => q && (q.name || '').toLowerCase() === want); setBlanks.set(pre[1], b ? b.index : -1); }
      const b = setBlanks.get(pre[1]); return b >= 0 ? b : blankSymbol();
    };
    const dropScene = sc => { unhide(sc); for (const i of (sc.dm || []).concat(sc.altDm || [])) if (D.items[i]) D.items[i].visible = false; const k = D.scenes.indexOf(sc); if (k >= 0) D.scenes.splice(k, 1); for (const ch of sc.children || []) dropScene(ch); };
    // expand an object into scene items at (x, y): a resource scene (SCNE), a scene built with _createscene, or a single object
    const expand = (inst, o, x, y, prio = 0, depth = 0, e = {}) => {   // e: the entry that placed o (flags, touch code)
      if (!o || depth > 8) return;
      if (o.composite) { for (const k of o.entries) if (k) expand(inst, k.obj, x + k.x, y + k.y, prio + k.prio, depth + 1, k); return; }
      if (o.kind === 2) vm.instantiate(inst, o, x, y, prio);
      else if (o.kind === 0) inst.items.push({ kind: 0, x, y, prio, flags: e.flags, w: o.w, h: o.h, code: e.code | 0 });
      else if (o.kind === 'str') inst.items.push({ kind: 'str', text: o.text, font: o.font, x, y, prio, flags: e.flags });
      else if (o.kind !== 'motion') inst.items.push({ kind: o.kind, id: o.index, x, y, prio, flags: e.flags, ePlays: e.ePlays });   // a motion path moves nothing
    };
    // draw order as on the real machine: every item's key is the scene's base priority + its entry priority. The base is the ROM's argument (stack word 1)
    // when positive, else the scene record's own (SCNE header word +12: SCN_MAIN 14000, line boxes 20000..18800, denomination box 3000000)
    const sceneBase = (rec, arg) => { if ((arg | 0) > 0) return arg | 0; if (rec.body && rec.body.length >= 16) return new DataView(rec.body.buffer, rec.body.byteOffset, rec.body.byteLength).getInt32(12, true) | 0; return 0; };
    S._addscene = (c, h, x, y) => {
      const rec = obj(h); if (rec && rec.kind === 11) { const sp = newSprite(rec, x | 0, y | 0, sceneBase(rec, mem.r32(c.r[15] + 4)), 0); return sp ? sp.id : -1; }
      if (!rec || (rec.kind !== 2 && rec.kind !== 9 && rec.kind !== 7 && rec.kind !== 1 && rec.kind !== 'str')) return -1;       // scenes (resource or built), a sound / FLIC played as a scene of its own, or a string object (denomination box "$100 Buys 2000 Credits")
      const base = sceneBase(rec, mem.r32(c.r[15] + 4)), id = D.nextScene++, inst = { id, rec, x: x | 0, y: y | 0, base, items: [], visible: true };
      if (rec.kind === 2 || rec.kind === 1 || rec.kind === 'str') expand(inst, rec, inst.x, inst.y, base); else inst.items.push({ kind: rec.kind, id: rec.index }); D.scenes.push(inst);
      inst.dm = [];
      for (const it of inst.items) if (it.kind === 1 || it.kind === 0 || it.kind === 'str' || (it.kind === 7 && rec.kind === 2)) place(inst, it);
      // a scene the ROM builds from copies of reel symbols (the win flash: the winning symbols and the line pieces) covers those symbols. In the real machine's
      // off phase those tiles show the game's blank symbol (5 Dragons GS_Blank, Double Dolphin blank), so while the scene
      // exists the reel symbols underneath show the blank symbol (or are hidden when the ROM has none); restored when the scene goes
      if (rec.composite) inst.lines = (rec.entries || []).map(e => e && e.obj && /^SCN_WL_\d*?(\d\d)(\d\d)_WIN$/.exec(e.obj.name || '')).filter(Boolean).map(m => ({ n: m[2], set: m[1] }));   // SCN_WL_05<lines><line>_WIN
      // the alternate looks of the scenes it holds (record a bit 2, b the alternate's index), built hidden: the blink tick shows them in the off phase
      // (QOTN's win step holds SCN_WIN_20_nn, its alternate SCN_DRK_20_nn is the dark line box)
      if (rec.composite) for (const e of rec.entries || []) { const o = e && e.obj; if (!o || o.kind !== 2 || o.composite || !(o.a & 2) || !o.body) continue;
        const ar = vm.db.byIndex(2, o.b + (o.pack ? o.pack.base[2] | 0 : 0)); if (!ar) continue; const tmp = { id, items: [], dm: [] };
        expand(tmp, ar, inst.x + e.x, inst.y + e.y, base + e.prio); for (const it of tmp.items) if (it.kind === 1) place(tmp, it);
        for (const i of tmp.dm) if (D.items[i]) D.items[i].visible = false; inst.altDm = (inst.altDm || []).concat(tmp.dm); }
      if (rec.composite) for (const i of inst.dm) { const d = D.items[i]; if (!d || d.img === undefined) continue;
        for (const r of D.items) if (r && r.scene === undefined && r.img === d.img && r.x === d.x && r.y === d.y && r.visible) (inst.hid = inst.hid || []).push([r, r.img]); }
      // a scene nested in this one is a slot of its own too, so _findscene finds it (Outback Jack's boomerang round looks up SCN_FEA_BMRG_THROW
      // inside SCN_FEA_BMRG_THROW_MAIN); playing the outer scene plays it as well (playTree), and it can be played again on its own
      const nested = new Map(), owner = it => { if (rec.kind !== 2 || !it.scene || it.scene === rec.name) return inst; let n = nested.get(it.scene);
        if (!n) { n = { id: D.nextScene++, rec: vm.db.get(2, it.scene) || { name: it.scene }, x: inst.x, y: inst.y, base, items: [], dm: [], visible: true, parent: inst, nested: true };
          nested.set(it.scene, n); D.scenes.push(n); (inst.children = inst.children || []).push(n); }
        return n; };
      for (const it of inst.items) if (it.kind === 11) { const sr = vm.db.byIndex(11, it.id), sp = sr && newSprite(sr, it.x, it.y, it.prio, base, it.motion ?? -1, it.plays, it.code); if (sp) { const o = owner(it); sp.parent = o; (o.children = o.children || []).push(sp); } }
      // a FLIC in a scene is a slot of its own on the real machine too ('Ani}'): _findscene(scene, "FLC_...") finds it and its end fires its callback (Where Is The
      // Gold's pick waits for FLC_DIG_PROFESS to end; without the slot it got -1 and the feature hung). It shares the parent's display item.
      // A sound in a scene is a slot too ('Snd}'): Lord Leopard's multiplier exit hooks its callback to SND_monkeyout inside SCN_FEA_MUL_Out; with -1
      // from _findscene the callback never fired and the free games hung in state 8. Its end is the sound's length; the parent plays the sound.
      if (rec.kind === 2) inst.items.forEach((it, k) => { if (it.kind !== 7 && it.kind !== 9) return; const fr = vm.db.byIndex(it.kind, it.id), di = it.kind !== 7 ? undefined : inst.dm.find(i => D.items[i] && D.items[i].flic === it.id && D.items[i].x === it.x && D.items[i].y === it.y);
        const ch = { id: D.nextScene++, rec: fr || { name: '' }, x: it.x, y: it.y, base, items: [it], dm: di === undefined ? [] : [di], visible: true, parent: inst };
        D.scenes.push(ch); const o = owner(it); ch.parent = o; (o.children = o.children || []).push(ch); });
      return id;
    };
    const sceneById = id => D.scenes.find(x => x.id === id);
    // composite scenes the game builds itself: _createscene(count) returns an object; _setsceneentry(scene, index, object, 0, x, y, plays, flags,
    // code << 16, prio) (args 5+ on the stack; the system keeps the 10th, stack word 5, as the entry's priority, the 7th as its play count) fills it; _addscene(object, x, y) shows it like a resource scene
    S._createscene = (c, n) => newObj({ kind: 2, composite: true, name: '', entries: [] });
    // _createmotion(x0, y0, x1, y1, ms, steps, flags, total*): a path of `steps` points from (x0, y0) to (x1, y1) over `ms` milliseconds, each with its own
    // duration (at least one frame); *total gets the summed duration. 0 for fewer than two steps. Cashman Tonight makes 16-step, 528 ms, 55 px rises (374 in 25 s) and never
    // hands them to _setscenemotion, so the object only has to exist. The real machine builds a 'Mot}' record.
    S._createmotion = (c, x0, y0, x1, y1) => {
      const sp = c.r[15], ms = mem.r32(sp) | 0, n = mem.r32(sp + 4) | 0, flags = mem.r32(sp + 8) | 0, out = mem.r32(sp + 12) >>> 0;
      if (n <= 1) return 0; if (out) mem.w32(out, 0);
      const FRAME_MS = 16, steps = []; let acc = 0, total = 0;
      for (let i = 0; i < n; i++) { acc += ms * 1000 / n; let d = Math.floor(acc / 1000); acc -= d * 1000; d = Math.max(d, FRAME_MS); total += d;
        steps.push({ ms: d, x: Math.round((x0 | 0) + i * ((x1 | 0) - (x0 | 0)) / (n - 1)), y: Math.round((y0 | 0) + i * ((y1 | 0) - (y0 | 0)) / (n - 1)) }); }
      if (out) mem.w32(out, total);
      return newObj({ kind: 'motion', flags, steps, total });
    };
    // _setscenemotion(scene, motion, motion) (the system stores both motion records in the scene slot with their counters at 0; the scene tick adds each record's current
    // (dx, dy) to the scene and its parents): a running scene moves along a motion resource (MSEQ, or an object of _createmotion), from now, and holds its last
    // step. Only African Dusk Mr Cashman calls it (the camera-out FLICs FLC_CAM2_af_0/1 with MTN_CAM2_OUT, 3 times in 400 spins, in its free games); -1 for a bad scene id.
    S._setscenemotion = (c, id, m1, m2) => {
      const sc = (id | 0) > 0 && sceneById(id | 0); if (!sc) return -1;
      const get = h => { const r = h ? obj(h) : null; return !r ? null : r.kind === 'motion' ? r.steps.map(q => ({ ms: q.ms, dx: q.x - r.steps[0].x, dy: q.y - r.steps[0].y })) : motionOf(r); };
      // a FLIC scene of its own is not drawn (it is a timing slot); one given a motion is there to be seen, so it gets its item (African Dusk's camera FLIC)
      if (!(sc.dm || []).length) { sc.dm = sc.dm || []; for (const it of sc.items || []) if (it.kind === 7) { place(sc, { kind: 7, id: it.id, x: sc.x, y: sc.y, prio: sc.base, plays: 1 }); sc.motionFlic = true; } }
      sc.mots = [get(m1), get(m2)].filter(Boolean).map(steps => ({ steps, t0: vm.now })); return 0;
    };
    // sysw__createbox reads call arguments 4 and 5 (the stack words, not r4/r5): the touch tiles come as w = [sp], h = [sp+4] (Cashman Tonight tiles 173 x 109,
    // denomination buttons 87 x 109, with r4..r6 all 0); without them every menu box is 0 x 0 and no tap reaches the menu. Only when r4 and r5 are both 0; the panel-button boxes pass their height in r5 and keep the registers
    S._createbox = (c, w, h) => { const sw = mem.r32(c.r[15]) | 0, sh = mem.r32(c.r[15] + 4) | 0; if (!(w | 0) && !(h | 0) && sw > 0 && sh > 0 && sw < 4096 && sh < 4096) { w = sw; h = sh; } return newObj({ kind: 0, w: w | 0, h: h | 0 }); };   // an invisible touchable rectangle; its code comes with _setsceneentry
    S._setsceneentry = (c, id, idx, h) => {
      const tpl = obj(id), o = obj(h); if (!tpl || !tpl.composite || !o) return -1; const sp = c.r[15];
      tpl.entries[idx] = { obj: o, x: mem.r32(sp) | 0, y: mem.r32(sp + 4) | 0, prio: mem.r32(sp + 20) | 0, ePlays: mem.r32(sp + 8) | 0, flags: mem.r32(sp + 12), code: mem.r32(sp + 16) >>> 16 };
      return 0;
    };
    // find a running scene by the name of its object: -1 when there is none
    S._findscene = (c, a, name, type, out) => {
      // the real machine returns the first slot after `a` (a scene id, or -1) running that object; JS scene ids grow, so: the lowest id above a.
      // A match also writes the slot's outermost parent scene to *out (-1 for a top-level slot): Indian Dreaming Lady Luck's 0x80194c0 skips matches
      // until that is its SCN_Fade_In_Back_Out, then hooks the fade timers whose end starts the Lady Luck feature (without it the intro waits in state 22)
      const s = vm.cstr(name), n = s.toLowerCase(); let sc = null;
      for (const x of D.scenes) if (x.rec && x.rec.name && x.rec.name.toLowerCase() === n && ((a | 0) < 0 || x.id > (a | 0)) && (!sc || x.id < sc.id)) sc = x;
      if (sc) { if (out) { let p = sc.parent; while (p && p.parent) p = p.parent; mem.w32(out, p ? p.id : -1); } return sc.id; }
      // built-in timer scenes ("SP_TIMER_1000ms"): the system provides them; ROMs play one with an end callback as a delay (Corrida De Toros pick rounds wait for its [15,4])
      const tm = /^sp_timer_(\d+)ms$/.exec(n);
      if (tm) { const id = D.nextScene++; D.scenes.push({ id, rec: { name: s }, x: 0, y: 0, base: 0, items: [], dm: [], visible: false, fixedMs: +tm[1] }); return id; }
      return -1;
    };
    // the base priority of a scene resource: its SCNE header word (HOV's line indicators read it, 19000, and set it back with _setsceneproperty(9));
    // 0 here drops them to 1000, under the plain column SCN_WL_IND_000 (20000)
    S._getbasepriority = (c, id, out) => { const rec = obj(id), v = rec && rec.kind === 2 ? sceneBase(rec, 0) : 0; if (out) mem.w32(out, v); return 0; };
    // ---- display manager items: positioned images drawn by priority
    const item = id => D.items[id];
    // _addasitemDM(object, x, y, flags; stack: ?, priority) as on the real machine
    S._addasitemDM = (c, h, x, y, flags) => { const rec = vm.handles[h], prio = mem.r32(c.r[15] + 4) | 0, it = { img: rec && rec.kind === 1 ? rec.index : 0, x, y, prio, flags, visible: true }; if (rec && rec.kind === 7) { it.flic = rec.index; it.t0 = vm.now; } D.items.push(it); return D.items.length - 1; };
    S._setitempositionDM = (c, id, x, y) => { const it = item(id); if (it) { it.x = x; it.y = y; } return 0; };
    S._setitempriorityDM = (c, id, p) => { const it = item(id); if (it && (p | 0) !== -1) it.prio = p; return 0; };   // -1 keeps the priority
    S._replaceimageDM = (c, id, h) => { const it = item(id), rec = vm.handles[h]; if (it) { it.img = rec && rec.kind === 1 ? rec.index : 0; if (rec && rec.kind === 7) { it.flic = rec.index; it.t0 = vm.now; } else delete it.flic; } return 0; };
    S._removeitemDM = (c, id) => { const it = item(id); if (it) it.visible = false; return 0; };
    // _setitemclipDM(item, rect*) as the real machine does: rect is 4 int32 {left, top, right, bottom} in item-local pixels, right/bottom exclusive; the
    // compositor draws only the part of the item inside it (and the item moves with its clip). All zero draws nothing. Only Players Choice By Demand
    // uses it, clipping each reel symbol to the reel window. _getitemclipDM hands the clip back, the whole item when none was set.
    S._setitemclipDM = (c, id, p) => { const it = item(id); if (!it) return -1; const r = [0, 4, 8, 12].map(o => mem.r32(p + o) | 0); it.clip = r.every(v => !v) ? [0, 0, 0, 0] : r; return 0; };
    S._getitemclipDM = (c, id, p) => { const it = item(id); if (!it) return -1; const im = vm._img && vm._img.get(it.img); (it.clip || [0, 0, im ? im.w : 0, im ? im.h : 0]).forEach((v, k) => mem.w32(p + 4 * k, v)); return 0; };
    S._lockDM = S._unlockDM = S._invalidateitemDM = S._setstartprioDM = () => 0;
    S._getobjectarea = (c, h, out) => { const rec = h >= 0x10000 ? vm.objs.get(h) : vm.handles[h]; let w = 0, hh = 0; if (rec && rec.kind === 1) { const im = vm.image(rec.index); if (im) { w = im.w; hh = im.h; } } else if (rec && rec.kind === 'str') { w = vm.textWidth(rec.font, rec.text); hh = rec.font.h || 16; } else if (rec && rec.kind === 0) { w = rec.w; hh = rec.h; } if (out) { mem.w32(out, 0); mem.w32(out + 4, 0); mem.w32(out + 8, w); mem.w32(out + 12, hh); } return 1; };
    // flyback period in us as the real machine returns it (32000; it really runs every 33.07 ms, see vm.frame): its flyback handler runs every other frame. Pompei's rsa.c divides by 1000 and, given 16,
    // logged "Could not retrieve flyback period" and set its win-flash scene property 6 to 260 instead of 260 / 32 = 8; the reel handler at 0x800d18c
    // resumes the reel task on every flyback from 30000 up, on every other one below
    S._getflybackperiod = () => 32000;
    // vertical-retrace callback: the reel task suspends itself each frame and this handler resumes it (nrresume)
    vm.flyback = null; vm.frameNo = 0;
    S._attachflybackhandler = (c, fn, arg) => { vm.flyback = { fn, arg }; return 1; };
    S._detachflybackhandler = () => { vm.flyback = null; return 0; };
    S.nrresume = S.gos_resume;
    // the real machine's flyback comes every 33.07 ms on average, not the 32 ms it reports (Pompei, Calypso King,
    // Lady Luck, Sweet Hearts 2 all 33.07-33.10; gaps of 32/33/34 ms). Frames advance 16.535 ms (16 or 17 ms steps), so a reel stop 14 flybacks
    // apart comes 0.463 s apart as on the real machine (Pompei 0.463), and time in ms stays real time
    const FRAME_MS = 33.07 / 2;
    vm.frame = () => {            // one display frame: virtual time, flyback handler, then run woken tasks
      if (!(Math.abs(vm.vnow - vm.now) < 1)) vm.vnow = vm.now;   // (a restored snapshot carries only vm.now)
      vm.vnow += FRAME_MS; vm.advance(Math.round(vm.vnow) - vm.now); vm.frameNo++; vm.tickScenes();
      if (vm.flyback && !(vm.frameNo & 1)) vm.callAddr(vm.flyback.fn, [vm.frameNo >> 1]);   // every other frame, as on the real machine
      vm.msgTick(); vm.runTasks();
    };
    // a Standard MIDI file's length in ms, to its last note event (the win tunes: QOTN WINTUNE32 57.3 s, the real machine stops it at 58.2 s; the end-of-track
    // meta pads most tunes to 6.4 s, which the real machine does not wait for)
    const midiMs = d => {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength); let p = 8;
      const ntr = v.getUint16(p + 2), div = v.getUint16(p + 4) || 96; p += 6;
      const tempos = [[0, 500000]]; let last = 0;
      for (let t = 0; t < ntr && p + 8 <= d.length; t++) {
        if (v.getUint32(p) !== 0x4d54726b) break; const end = Math.min(d.length, p + 8 + v.getUint32(p + 4)); p += 8; let tick = 0, run = 0;
        const vlq = () => { let x = 0, b; do { b = d[p++]; x = (x << 7) | (b & 127); } while (b & 128 && p < end); return x; };
        while (p < end) {
          tick += vlq(); let st = d[p];
          if (st === 0xff) { p++; const type = d[p++], l = vlq(); if (type === 0x51) tempos.push([tick, (d[p] << 16) | (d[p + 1] << 8) | d[p + 2]]); p += l; if (type === 0x2f) break; continue; }
          if (st === 0xf0 || st === 0xf7) { p++; p += vlq(); continue; }
          if (st & 128) { run = st; p++; } else st = run;
          const hi = st >> 4; if (hi === 8 || hi === 9) last = Math.max(last, tick); p += hi === 0xc || hi === 0xd ? 1 : 2;
        }
        p = end;
      }
      tempos.sort((a, b) => a[0] - b[0]);
      let ms = 0, at = 0, us = 500000; for (const [tk, u] of tempos) { if (tk >= last) break; ms += (tk - at) * us / div / 1e3; at = tk; us = u; }
      return ms + (last - at) * us / div / 1e3;
    };
    // The real machine ends a MIDI sound scene about 0.2 s after the last note (release tail): win 5/10/15 scenes run 495/697/1026 ms for tunes whose last note is 300/500/800 ms,
    // and without it small tunes end about 0.2 s early.
    const MIDI_TAIL_MS = 200;
    // The real machine does not play the MIDI of a sound scene (WINTUNEnn) but the sampled voice object, and ends the scene its record's authored duration plus about 160 ms
    // (mixer chunk granularity) after the start: the duration is the high half of record word a, in 10 ms units (wintune15 4570 ms against a 3200 ms MIDI, wintune05 500).
    // win 5/10/15/100 scenes: 462-529/660-726/958-1058/4662-4729 ms. Records without a duration fall back to the MIDI length plus MIDI_TAIL_MS.
    // 160 is the shortest tail seen; the scene ends at a mixer chunk (100 ms) boundary, so the tail varies over about 100 ms,
    // mean 195 (scene 4 credits 363-462, mean 416 against 364 at 160; 10 credits 660-727, mean 707 against 662). The mean is used.
    const SND_TAIL_MS = 195;
    // The scene of a longer tune ends 5.27-5.3 s in whatever its duration: win_inc ticks 143 times (5.3 s) for every win from WINTUNE18 up (authored 6.5 to 58 s; Dragons and QOTN).
    // (QOTN: scene stop 5304-5372 ms, mean 5340.)
    const SND_MAX_MS = 5340;
    const SND_WAV_TAIL_MS = 165;
    // scene runtime: _controlscene(id, 0) plays (completion fires the callback from _setsceneevent after the length of its longest FLIC / sound), 3 destroys
    const sceneLength = inst => {
      if (inst.fixedMs) return inst.fixedMs;   // SP_TIMER_<n>ms
      // a sound played as a scene of its own (WINTUNEnn) lasts as long as its sound: the win meter counts 1 credit a tick while the tune's scene runs, then
      // 25 (win_inc table). The real machine with sound: QOTN 235 credits count in 214 steps, the tune stops 2-3 steps before
      // the end. Without an audio device the real machine ends the scene about 25 ms in and counts 25 a tick from the start.
      if (inst.sprite) return inst.spriteMs + (inst.delayMs | 0);
      let ms = inst.frameMs || 300;
      // touch machines: a scene lasts as long as the sprites it holds itself (not those of the scenes inside it): Cashman Tonight's "Select Denomination" popup
      // (SCN_GAME_MENU_PU_CD_A) holds a 5000 ms SP_GMENU_CREDIT_TIMER and its callback closes the popup; with the 300 ms default it closes at once (it stays 5 s)
      if (vm.windowPrio) for (const ch of inst.children || []) if (ch.sprite && ch.plays !== -1) ms = Math.max(ms, (ch.spriteMs | 0) + (ch.delayMs | 0));
      for (const it of inst.items) {
        if (it.kind === 7) { const f = vm.flic(it.id); if (f) ms = Math.max(ms, f.count * f.delay); }
        else if (it.kind === 9) { const r = vm.db.byIndex(9, it.id); if (r && r.body[0] === 0x52 && r.body.length > 44) { if (inst.rec && inst.rec.kind === 9 && inst.items.length === 1 && (r.a >>> 16)) return Math.min(SND_MAX_MS, (r.a >>> 16) * 10 + SND_WAV_TAIL_MS) + (inst.delayMs | 0);   /* a sample played as a scene of its own ends like a WINTUNE scene: authored duration plus the mixer tail (QOTN feature_bell, 2540 ms: scene stop 2679-2745, mean 2709, JS rounds up to its 16.5 ms frame, so the tail is 165 and not 169) */ const dv = new DataView(r.body.buffer, r.body.byteOffset, r.body.byteLength); ms = Math.max(ms, 1000 * (r.body.length - 44) / (dv.getUint32(28, true) || 44100)); }
          else if (r && r.body[0] === 0x4d) { if (r.midiMs === undefined) r.midiMs = midiMs(r.body); if (inst.rec && inst.rec.kind === 9 && inst.items.length === 1) return Math.max(16, Math.min(SND_MAX_MS, ((r.a >>> 16) * 10 || r.midiMs + MIDI_TAIL_MS - SND_TAIL_MS) + SND_TAIL_MS)) + (inst.delayMs | 0); ms = Math.max(ms, r.midiMs); } }
      }
      return ms + (inst.delayMs | 0);
    };
    // _getsoundtimelength(sound): the sound's length in ms (the length word of the 'Snd}' record, -1 for anything else). The argument is an object handle
    // (Cashman Tonight asks for its 32 wintune01..32 sounds, 100 ms to 58010 ms, the same values as authored). The authored duration is the high half of word a in
    // 10 ms units; a record without one falls back to its MIDI length.
    S._getsoundtimelength = (c, o) => { const r = obj(o >>> 0); const R = !r || r.kind !== 9 ? -1 : (r.a >>> 16) ? (r.a >>> 16) * 10 : r.body && r.body[0] === 0x4d ? Math.round(r.midiMs !== undefined ? r.midiMs : (r.midiMs = midiMs(r.body))) : -1; return R; };
    S._setsceneevent = (c, id, fn, arg) => {
      const sc = sceneById(id); if (!sc) return -1; sc.event = { fn, arg };
      // a callback hooked to a sprite or FLIC that has already run out fires at once instead of never: Outback Jack's boomerang round hooks its
      // 1.9 s SP_BMRG_THROW_TIMECNTRL only after the Feature key, long after the round's scene started it
      if (fn && sc.ran && !sc.playing && !sc.fixedMs && (sc.sprite || (sc.rec && sc.rec.kind === 7))) { sc.playing = true; sc.endAt = vm.now; }
      if (sc.fixedMs) { sc.playing = !!fn; sc.endAt = fn ? vm.now + sc.fixedMs : 0; }   // SP_TIMER scenes run by themselves: the ROM attaches a callback and never plays them; they tick every fixedMs (see tickScenes) until the callback is detached
      return 0;
    };
    // ops 4 / 5 as a function: setLook(sc, true) is op 5, false op 4 (also driven by the scene tick, see tickScenes)
    const setLook = (sc, alt5) => {
        // an image record can carry an alternate the same way (+0x28 bit 2, +0x2c its index): op 5 shows it in place of the primary
        const altImg = r => r && (r.a & 2) && vm.db.byIndex(1, r.b + (r.pack ? r.pack.base[1] | 0 : 0));
        const show = (list, on, alt) => { for (const i of list) { const d = D.items[i]; if (!d || d.dead || d.flic !== undefined || d.img === undefined) continue; if (d.key0 === undefined) d.key0 = d.prio; d.visible = false;
          if (d.img0 === undefined) d.img0 = d.img; const ai = alt && altImg(vm.db.byIndex(1, d.img0)); d.img = ai ? ai.index : d.img0;
          if (on || ai) { let k = d.key0; while (D.items.some(o => o !== d && o.visible && !o.dead && o.prio === k)) k++; d.prio = k; d.visible = true; } } };
        const look = s => { if (s.sprite || (s.rec && (s.rec.kind === 7 || s.rec.kind === 'str'))) return; s.alt = alt5;
          // the alternate look is another scene record: record field a (+0x28) bit 2 set, b (+0x2c) its index (QOTN's SCN_BRI_20_01 -> SCN_DRK_20_01,
          // the dark line box)
          if (alt5 && !s.altDm && s.rec && (s.rec.a & 2) && s.rec.body) { const ar = vm.db.byIndex(2, s.rec.b + (s.rec.pack ? s.rec.pack.base[2] | 0 : 0)), tmp = { id: s.id, items: [], dm: [] };
            if (ar) { expand(tmp, ar, s.x | 0, s.y | 0, s.base | 0); for (const it of tmp.items) if (it.kind === 1) place(tmp, it); } s.altDm = tmp.dm; }
          show(s.dm || [], !alt5, alt5 && !s.altDm); if (s.altDm) show(s.altDm, alt5);
          for (const ch of s.children || []) look(ch); };
        look(sc); };
    const WIN_PHASE_MS = 319;   // one hide or show phase of a win-line flash: a repeats-4 line lasts 1275 ms, a design choice between 1229 and 1312 on the real machine
    vm.winPhaseMs = WIN_PHASE_MS;   // the host's free-game win cycle (mk6host buildWinCycle) uses the same phase
    S._controlscene = (c, id, cmd) => {
      const sc = sceneById(id); if (!sc) return -1;
      // a blink scene without a rate runs at the default rate 5 (625 ms a frame): Double Dolphin's win flash shows ~0.63 s, then hides for its
      // 260 ms delay; 5 Dragons' runs at rate 10 (0.32 s on)
      // a repeated scene blinks even without a delay (Double Dolphin's rollup flash: repeats 4, no delay; the real machine hides it ~0.2 s between repeats).
      // A repeated composite (a win flash) is hidden one phase, then shown one phase, and each repeat is one of those phases.
      // The real machine runs a scene with rate 3, repeats 4, delay 7 in 1229-1312 ms, about 307-328 ms a phase. WIN_PHASE_MS holds the phase.
      if (cmd === 0 && sc.repeats > 0 && !sc.sprite && sc.rec && sc.rec.composite) { sc.delayMs = WIN_PHASE_MS; sc.frameMs = WIN_PHASE_MS; sc.winBlink = true; }
      if (cmd === 0 && sc.delayMs > 0 && sc.repeats > 0 && !sc.frameMs && !sc.sprite) sc.frameMs = Math.floor(1000 / 5) * 3125 / 1000;
      if (cmd === 0) { sc.cycleMs = sc.winBlink ? 2 * WIN_PHASE_MS : sceneLength(sc); sc.endAt = vm.now + (sc.winBlink ? Math.max(sc.repeats * WIN_PHASE_MS, sceneLength(sc) - WIN_PHASE_MS) : sc.cycleMs * (sc.delayMs > 0 && sc.repeats > 0 ? sc.repeats : 1));   /* a win flash still lasts as long as its sounds and FLICs */ sc.playing = true; sc.t0 = vm.now; if (sc.sprite) { sc.t0 = vm.now; sc.ran = true; sc.fxDone = null; }
        for (const ch of playTree(sc)) { ch.playing = true; ch.ran = true; ch.t0 = vm.now; ch.endAt = vm.now + sceneLength(ch); }   // a scene's sprites and FLICs play with it
        for (const i of sc.dm || []) if (D.items[i] && D.items[i].flic !== undefined) D.items[i].t0 = vm.now;   // playing a scene restarts its FLICs from frame 0 (a play-once FLIC would otherwise stay on its last frame)
        if (!vm.muteSound) for (const it of sc.items) if (it.kind === 9) vm.sound.play(vm.db.byIndex(9, it.id), sc.id, { plays: it.plays, vol: it.w6 }); }   // muteSound: host-made key presses the player did not make
      else if (cmd === 3) { if (!(sc.rec && sc.rec.kind === 9)) vm.sound.stop(sc.id); else (vm.releasedSounds = vm.releasedSounds || new Set()).add(sc.id);   /* a sound scene (Snd}) is released, its sound plays to the end (QOTN stops WINTUNE06 19 ms in, the tune plays out); a scene's own sounds stop */ sc.playing = false; sc.endAt = 0; for (const i of (sc.dm || []).concat(sc.altDm || [])) if (D.items[i]) D.items[i].visible = false; const k = D.scenes.indexOf(sc); if (k >= 0) D.scenes.splice(k, 1); unhide(sc); for (const ch of sc.children || []) dropScene(ch); }   // destroyed scenes leave the list (it is scanned every frame)
      // ops 4 and 5 rebuild the scene's image items from its primary look (4) or from its alternate
      // look (5); a scene without an alternate gets no items, so op 5 hides it. Play state, frame and sound stay as they are;
      // sprites, FLICs and strings are left alone; the ops reach the scene's children too. Heart Of Vegas lights its selected '100 LINES' tab with op 4.
      // A rebuilt item takes the key base + entry priority, and the display list bumps a key that is taken by one until it is free:
      // the tab asks for 20000 and gets 20002, over SCN_WL_IND_000's 20000/20001
      else if (cmd === 4 || cmd === 5) setLook(sc, cmd === 5);
      return 0;
    };
    S._destroyobject = (c, id) => { if (id >= 0x10000) return vm.objs.delete(id) ? 0 : -1; const sc = sceneById(id); if (!sc) return -1; vm.sound.stop(sc.id); for (const i of (sc.dm || []).concat(sc.altDm || [])) if (D.items[i]) { D.items[i].visible = false; D.items[i].dead = true; } while (D.items.length && D.items[D.items.length - 1].dead) D.items.pop(); const k = D.scenes.indexOf(sc); if (k >= 0) D.scenes.splice(k, 1); unhide(sc); for (const ch of sc.children || []) dropScene(ch); return 0; };   // (items at the end of the list are really dropped, so the list does not grow) scenes the game built itself (_createscene) go away through this
    S._getscenestate = (c, id) => { const sc = sceneById(id); return sc && sc.playing ? 1 : 0; };
    // Scene timing: property 7 = rate, a frame lasts (1e8 / 32000) * (1000 / rate) us (rate 3: 1041 ms, the
    // win-line steps of Queen Of The Nile); property 6 = a delay in ms added to the scene's run (260: the later steps last 1.30 s, as on the real machine);
    // 8 / 10 = play / repeat counts (kept; not used). Without them a scene keeps the length of its content (sounds, FLICs, 300 ms).
    S._setsceneproperty = (c, id, prop, v) => {
      const sc = sceneById(id); if (!sc) return 0; v |= 0;
      if (prop === 7 && v > 0) sc.frameMs = Math.floor(1000 / v) * 3125 / 1000;
      else if (prop === 6) sc.delayMs = Math.max(0, v);
      else if (prop === 8) { sc.plays = v; for (const i of sc.dm || []) if (D.items[i] && D.items[i].flic !== undefined) D.items[i].plays = v; }   // the play count of the scene's FLICs
      else if (prop === 10) sc.repeats = v;
      else if (prop === 9) { const d = v - (sc.base | 0); sc.base = v; for (const i of (sc.dm || []).concat(sc.altDm || [])) if (D.items[i]) { D.items[i].prio += d; if (D.items[i].key0 !== undefined) D.items[i].key0 += d; } }   // base priority (QOTN win-line steps: added with base 0, then set to 16300 so they draw over the reels)
      return 0;
    };
    // a scene's motion offset (sum of its records) applied to its items and, through the children, theirs; base positions are kept in bx / by
    const motionAt = m => { let u = vm.now - m.t0, q = m.steps[m.steps.length - 1]; for (const s of m.steps) { if (u < s.ms) { q = s; break; } u -= s.ms; } return q; };
    const moveScene = (sc, top, ox, oy) => {
      if (top === sc) for (const m of sc.mots) { const q = motionAt(m); ox += q.dx; oy += q.dy; }
      for (const i of sc.dm || []) { const d = D.items[i]; if (!d || d.dead) continue; if (sc.motionFlic) d.visible = !!sc.playing; if (d.bx === undefined) { d.bx = d.x; d.by = d.y; } d.x = d.bx + ox; d.y = d.by + oy; }
      for (const ch of sc.children || []) moveScene(ch, top, ox, oy);
    };
    vm.tickScenes = () => {
      for (const sc of D.scenes) if (sc.mots && sc.mots.length) moveScene(sc, sc, 0, 0);
      for (const sc of D.scenes) if (sc.sprite) showSpriteFrame(sc);
      // property 6 (delay) with property 10 (repeats): the scene shows for its length, then is hidden for the delay, repeats times. Double Dolphin's
      // win flash (the winning symbols and the line, delay 260, repeat 4) blinks this way on the real machine: about 350 ms on, 260 ms off
      for (const sc of D.scenes) if (!sc.sprite && sc.delayMs > 0 && sc.repeats > 0 && sc.cycleMs) {
        // the reels have moved on under the flash (a free game drew new symbols where its copies sit): its copies are stale, hide them for good;
        // blinking on, they would alternate an old symbol with the new one (Double Dolphin: 9 / J, turtle / fish)
        if (sc.stale) continue;
        if ((sc.hid || []).some(h => h[0].img !== h[1] && h[0].img !== h[2])) { sc.stale = true; for (const i of sc.dm || []) { const d = D.items[i]; if (d && !d.dead) d.visible = false; } sc.hid = null; continue; }
        const ph = (vm.now - sc.t0) % sc.cycleMs, on = !sc.playing || (sc.winBlink ? ph >= sc.delayMs : ph < sc.cycleMs - sc.delayMs), b = blankSymbol();   // a win flash starts hidden
        if (sc.blinkOn === on) continue; sc.blinkOn = on;
        for (const i of sc.dm || []) { const d = D.items[i]; if (d && !d.dead) d.visible = on; }
        // a child scene with an alternate look swaps to it in the off phase: the scene tick toggles the look of a scene
        // with a repeat count (prop 10) every period and rebuilds its items. QOTN's win step holds SCN_WIN_20_nn, whose alternate is
        // SCN_DRK_20_nn, the dark line box: the winning line's number flashes dark
        if (sc.altDm && sc.rec && sc.rec.composite) for (const i of sc.altDm) { const d = D.items[i]; if (!d || d.dead) continue; if (d.key0 === undefined) d.key0 = d.prio; d.visible = !on; if (!on) { let k = d.key0; while (D.items.some(o => o !== d && o.visible && !o.dead && o.prio === k)) k++; d.prio = k; } }
        if (on) unblank(sc); else for (const h of sc.hid || []) if (h[0].img === h[1]) { const bb = blankFor(h[1], h[0]); if (bb >= 0) { h[0].img = bb; h[2] = bb; } }
        // the winning line's number box blinks with it: bright IMG_WLB<nn> in the on phase, dark IMG_WLD<nn> in the off phase (Double Dolphin line 8).
        // Games with a set of boxes per line count name them IMG_WL<lines>_B<nn> / _D<nn> (Big Ben Jackpot at 25 lines)
        for (const { n, set } of sc.lines || []) for (const [bn, dn] of [['IMG_WLB' + n, 'IMG_WLD' + n], ['IMG_WL' + set + '_B' + n, 'IMG_WL' + set + '_D' + n]]) {
          const bri = vm.db.get(1, bn), drk = vm.db.get(1, dn); if (!bri || !drk) continue;
          for (const d of D.items) if (d && d.visible && d.img === (on ? drk.index : bri.index) && (on ? d.dimmed : true)) { d.img = on ? bri.index : drk.index; d.dimmed = !on; if (!on) { d.dimBy = sc; d.briImg = bri.index; d.drkImg = drk.index; (vm.dimBoxes = vm.dimBoxes || new Set()).add(d); } }
        }
      }
      // a flash destroyed (or gone stale) in its off phase leaves its line boxes dark; the box shows a played line, so it goes back to bright
      if (vm.dimBoxes) for (const d of vm.dimBoxes) { const o = d.dimBy; if (d.dimmed && o && D.scenes.includes(o) && !o.stale) continue; vm.dimBoxes.delete(d); if (d.dimmed && d.img === d.drkImg) d.img = d.briImg; d.dimmed = false; d.dimBy = null; }
      for (const sc of D.scenes) if (sc.playing && sc.endAt && sc.endAt <= vm.now) {
        // The real machine runs scene-end callbacks on its scene engine thread, so a callback may sleep or wait while the game task runs. Each runs as a task
        // started at once: one that returns behaves as a direct call; one that blocks parks and carries on later (Alchemy's 0x800f1d0 polls a flag
        // the Game task clears, sleeping 10 ms a time; as a direct call the sleep returns at once and the call spins until the instruction limit)
        sc.playing = false; sc.endAt = 0; if (sc.event) { const t = vm.createTask(sc.event.fn, 'scene_cb', -1, sc.event.arg); t.ctx.r[5] = sc.id; t.state = 'ready'; vm.runTask(t); }
        if (sc.fixedMs && sc.event && sc.event.fn && D.scenes.includes(sc)) { sc.playing = true; sc.endAt = vm.now + sc.fixedMs; }   // SP_TIMER: periodic tick (Corrida De Toros counts N ticks of [15,4] in 0x0801a170)
      }
    };

    return S;
  });

  function module_exports(f) { if (typeof module !== 'undefined' && module.exports) module.exports = f; else root.MK6SYS = f; }
})(typeof window !== 'undefined' ? window : globalThis);
