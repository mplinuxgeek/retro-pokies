// Hitachi/Renesas SH-4 interpreter (little-endian) for running the MK6 game ROMs: integer ISA, single/double FPU, pair moves, FIPR/FTRV/FSCA.
// No MMU, caches or exceptions: an unknown opcode stops the CPU (cpu.halted, cpu.reason). The "system" the games call into is supplied by the host:
//   cpu.hook(addr, fn)        when PC reaches addr, fn(cpu) runs instead, then execution resumes at PR (as if the callee executed RTS); fn may call cpu.jump(a) instead.
//   mem.onUnmapped(kind, addr, size, value)  accesses to memory nothing backs (reads return its result).
(function (root) {
  'use strict';

  class Memory {                                   // 4 KiB pages; the top 3 address bits are ignored (P0..P3 mirrors)
    constructor() { this.pages = new Array(1 << 17).fill(null); this.strict = false; this.onUnmapped = null; this.watchAddr = -1; this.onWatch = null; }
    map(base, bytes) {                             // back [base, base+len) with an existing buffer (ROM, shared) or fresh zeroed RAM when `bytes` is a length
      const buf = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
      for (let o = 0; o < buf.length; o += 4096) this.pages[((base & 0x1fffffff) + o) >>> 12] = buf.subarray(o, Math.min(o + 4096, buf.length));
      return buf;
    }
    page(a, create) {
      const i = (a & 0x1fffffff) >>> 12; let p = this.pages[i];
      if (!p && create) p = this.pages[i] = new Uint8Array(4096);
      return p;
    }
    miss(kind, a, size, v) { return this.onUnmapped ? (this.onUnmapped(kind, a >>> 0, size, v) | 0) : 0; }
    r8(a) { const p = this.page(a); return p ? p[a & 4095] : this.miss('r', a, 1); }
    r16(a) { const p = this.page(a), o = a & 4095; if (!p) return this.miss('r', a, 2); return o > 4094 ? this.r8(a) | (this.r8(a + 1) << 8) : p[o] | (p[o + 1] << 8); }
    r32(a) { const p = this.page(a), o = a & 4095; if (!p) return this.miss('r', a, 4); return o > 4092 ? (this.r16(a) | (this.r16(a + 2) << 16)) : (p[o] | (p[o + 1] << 8) | (p[o + 2] << 16) | (p[o + 3] << 24)); }
    w8(a, v) { const p = this.page(a, !this.strict); if (!p) return void this.miss('w', a, 1, v); p[a & 4095] = v; }
    w16(a, v) { const p = this.page(a, !this.strict), o = a & 4095; if (!p) return void this.miss('w', a, 2, v); if (o > 4094) { this.w8(a, v & 255); this.w8(a + 1, (v >> 8) & 255); } else { p[o] = v; p[o + 1] = v >> 8; } }
    w32(a, v) { if (a === this.watchAddr) this.onWatch(v); const p = this.page(a, !this.strict), o = a & 4095; if (!p) return void this.miss('w', a, 4, v); if (o > 4092) { this.w16(a, v & 0xffff); this.w16(a + 2, (v >>> 16) & 0xffff); } else { p[o] = v; p[o + 1] = v >> 8; p[o + 2] = v >> 16; p[o + 3] = v >> 24; } }
  }

  const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer), F64 = new Float64Array(1), D32 = new Uint32Array(F64.buffer);   // D32[0] = low word, D32[1] = high word (little-endian host)

  class SH4 {
    constructor(mem) {
      this.mem = mem; this.r = new Int32Array(16); this.pc = 0; this.pr = 0; this.gbr = 0; this.vbr = 0; this.ssr = 0; this.spc = 0; this.sgr = 0; this.dbr = 0;
      this.mach = 0; this.macl = 0; this.t = 0; this.s = 0; this.q = 0; this.m = 0; this.srOther = 0x40000000;    // MD=1
      this.fpscr = 0x00040001; this.fp = new Float32Array(32); this.fpb = new Uint32Array(this.fp.buffer); this.fpul = 0;   // fp[0..15] / fp[16..31] are the two register banks
      this.hooks = new Map(); this.halted = false; this.reason = ''; this.cycles = 0; this.trace = null; this.jumped = false;
    }
    hook(addr, fn) { this.hooks.set(addr >>> 0, fn); }
    jump(addr) { this.pc = addr | 0; this.jumped = true; }
    stop(reason) { this.halted = true; this.reason = reason; }
    get sr() { return (this.srOther | this.t | (this.s << 1) | (this.q << 8) | (this.m << 9)) | 0; }
    set sr(v) { this.t = v & 1; this.s = (v >> 1) & 1; this.q = (v >> 8) & 1; this.m = (v >> 9) & 1; this.srOther = v & ~0x303; }

    // FR bank = fp[fb..fb+15], XF bank the other; FPSCR.FR (bit 21) swaps them
    get fb() { return this.fpscr & 0x200000 ? 16 : 0; }
    get xb() { return this.fpscr & 0x200000 ? 0 : 16; }
    dr(n) { const b = this.fb + (n & 14); D32[1] = this.fpb[b]; D32[0] = this.fpb[b + 1]; return F64[0]; }      // DRn: even FR holds the high word
    setdr(n, v) { const b = this.fb + (n & 14); F64[0] = v; this.fpb[b] = D32[1]; this.fpb[b + 1] = D32[0]; }
    pairBase(n) { return (n & 1 ? this.xb : this.fb) + (n & 14); }                                             // FMOV pair moves: odd register number selects the XD bank

    run(limit = 1e9) { let n = 0; while (!this.halted && n < limit) { this.step(); n++; } return n; }
    step() {
      const pc = this.pc >>> 0, h = this.hooks.get(pc);
      if (h) { const ret = this.pr; this.jumped = false; h(this); if (!this.jumped && !this.halted) this.pc = ret; return; }
      const op = this.mem.r16(pc);
      if (this.trace) this.trace(this, pc, op);
      this.pc = (pc + 2) | 0; this.cycles++;
      this.exec(op, pc);
    }
    bad(op, pc) { this.pc = pc | 0; this.stop('illegal opcode 0x' + op.toString(16) + ' at 0x' + (pc >>> 0).toString(16)); }
    slot(pc, target) {                             // run the delay-slot instruction at pc+2, then take the branch
      const sp = (pc + 2) | 0, op = this.mem.r16(sp >>> 0);
      this.pc = (sp + 2) | 0; this.exec(op, sp); this.pc = target | 0;
    }

    exec(op, pc) {
      const R = this.r, mem = this.mem, n = (op >> 8) & 15, m = (op >> 4) & 15;
      switch (op >> 12) {
        case 0x0:
          switch (op & 15) {
            case 0x2: if (m < 5) { R[n] = [this.sr, this.gbr, this.vbr, this.ssr, this.spc][m]; return; } break;
            case 0x3:
              switch (m) {
                case 0: this.pr = (pc + 4) | 0; this.slot(pc, (pc + 4 + R[n]) | 0); return;     // BSRF
                case 2: this.slot(pc, (pc + 4 + R[n]) | 0); return;                              // BRAF
                case 8: case 9: case 10: case 11: return;                                        // PREF / OCBI / OCBP / OCBWB
                case 12: mem.w32(R[n], R[0]); return;                                            // MOVCA.L
              }
              break;
            case 0x4: mem.w8((R[n] + R[0]) | 0, R[m]); return;
            case 0x5: mem.w16((R[n] + R[0]) | 0, R[m]); return;
            case 0x6: mem.w32((R[n] + R[0]) | 0, R[m]); return;
            case 0x7: this.macl = Math.imul(R[m], R[n]); return;                                 // MUL.L
            case 0x8: switch (op & 0xff) { case 0x08: this.t = 0; return; case 0x18: this.t = 1; return; case 0x28: this.mach = 0; this.macl = 0; return; case 0x38: return; case 0x48: this.s = 0; return; case 0x58: this.s = 1; return; } break;
            case 0x9:
              if (op === 0x0009) return;                                                          // NOP
              if (op === 0x0019) { this.m = 0; this.q = 0; this.t = 0; return; }                  // DIV0U
              if (m === 2) { R[n] = this.t; return; }                                             // MOVT
              break;
            case 0xA: switch (m) { case 0: R[n] = this.mach; return; case 1: R[n] = this.macl; return; case 2: R[n] = this.pr; return; case 3: R[n] = this.sgr; return; case 5: R[n] = this.fpul; return; case 6: R[n] = this.fpscr; return; case 15: R[n] = this.dbr; return; } break;
            case 0xB:
              switch (op) {
                case 0x000b: this.slot(pc, this.pr); return;                                      // RTS
                case 0x001b: this.stop('sleep'); return;
                case 0x002b: { const t = this.spc; this.sr = this.ssr; this.slot(pc, t); return; } // RTE
              }
              break;
            case 0xC: R[n] = (mem.r8((R[m] + R[0]) | 0) << 24) >> 24; return;
            case 0xD: R[n] = (mem.r16((R[m] + R[0]) | 0) << 16) >> 16; return;
            case 0xE: R[n] = mem.r32((R[m] + R[0]) | 0); return;
            case 0xF: this.macL(n, m); return;
          }
          return this.bad(op, pc);
        case 0x1: mem.w32((R[n] + ((op & 15) << 2)) | 0, R[m]); return;
        case 0x2:
          switch (op & 15) {
            case 0: mem.w8(R[n], R[m]); return; case 1: mem.w16(R[n], R[m]); return; case 2: mem.w32(R[n], R[m]); return;
            case 4: R[n] = (R[n] - 1) | 0; mem.w8(R[n], R[m]); return;
            case 5: R[n] = (R[n] - 2) | 0; mem.w16(R[n], R[m]); return;
            case 6: R[n] = (R[n] - 4) | 0; mem.w32(R[n], R[m]); return;
            case 7: this.q = R[n] < 0 ? 1 : 0; this.m = R[m] < 0 ? 1 : 0; this.t = this.q ^ this.m; return;     // DIV0S
            case 8: this.t = (R[n] & R[m]) === 0 ? 1 : 0; return;
            case 9: R[n] &= R[m]; return; case 10: R[n] ^= R[m]; return; case 11: R[n] |= R[m]; return;
            case 12: { const x = R[n] ^ R[m]; this.t = ((x & 0xff) === 0 || (x & 0xff00) === 0 || (x & 0xff0000) === 0 || (x & 0xff000000) === 0) ? 1 : 0; return; }   // CMP/STR
            case 13: R[n] = ((R[m] << 16) | (R[n] >>> 16)) | 0; return;                                         // XTRCT
            case 14: this.macl = Math.imul(R[n] & 0xffff, R[m] & 0xffff); return;                               // MULU.W
            case 15: this.macl = Math.imul((R[n] << 16) >> 16, (R[m] << 16) >> 16); return;                     // MULS.W
          }
          return this.bad(op, pc);
        case 0x3: {
          const a = R[n], b = R[m];
          switch (op & 15) {
            case 0: this.t = a === b ? 1 : 0; return;
            case 2: this.t = (a >>> 0) >= (b >>> 0) ? 1 : 0; return;
            case 3: this.t = a >= b ? 1 : 0; return;
            case 4: this.div1(n, m); return;
            case 5: { const p = BigInt(a >>> 0) * BigInt(b >>> 0); this.mach = Number(BigInt.asIntN(32, p >> 32n)); this.macl = Number(BigInt.asIntN(32, p)); return; }   // DMULU.L
            case 6: this.t = (a >>> 0) > (b >>> 0) ? 1 : 0; return;
            case 7: this.t = a > b ? 1 : 0; return;
            case 8: R[n] = (a - b) | 0; return;
            case 10: { const t = (a >>> 0) - (b >>> 0) - this.t; R[n] = t | 0; this.t = t < 0 ? 1 : 0; return; }          // SUBC
            case 11: { const d = (a - b) | 0; this.t = (((a ^ b) & (a ^ d)) < 0) ? 1 : 0; R[n] = d; return; }              // SUBV
            case 12: R[n] = (a + b) | 0; return;
            case 13: { const p = BigInt(a) * BigInt(b); this.mach = Number(BigInt.asIntN(32, p >> 32n)); this.macl = Number(BigInt.asIntN(32, p)); return; }   // DMULS.L
            case 14: { const t = (a >>> 0) + (b >>> 0) + this.t; R[n] = t | 0; this.t = t > 0xffffffff ? 1 : 0; return; }   // ADDC
            case 15: { const d = (a + b) | 0; this.t = ((~(a ^ b) & (a ^ d)) < 0) ? 1 : 0; R[n] = d; return; }             // ADDV
          }
          return this.bad(op, pc);
        }
        case 0x4: return this.op4(op, pc, n, m);
        case 0x5: R[n] = mem.r32((R[m] + ((op & 15) << 2)) | 0); return;
        case 0x6:
          switch (op & 15) {
            case 0: R[n] = (mem.r8(R[m]) << 24) >> 24; return;
            case 1: R[n] = (mem.r16(R[m]) << 16) >> 16; return;
            case 2: R[n] = mem.r32(R[m]); return;
            case 3: R[n] = R[m]; return;
            case 4: { const v = (mem.r8(R[m]) << 24) >> 24; if (n !== m) R[m] = (R[m] + 1) | 0; R[n] = v; return; }
            case 5: { const v = (mem.r16(R[m]) << 16) >> 16; if (n !== m) R[m] = (R[m] + 2) | 0; R[n] = v; return; }
            case 6: { const v = mem.r32(R[m]); if (n !== m) R[m] = (R[m] + 4) | 0; R[n] = v; return; }
            case 7: R[n] = ~R[m]; return;
            case 8: { const v = R[m]; R[n] = (v & 0xffff0000) | ((v & 0xff) << 8) | ((v >> 8) & 0xff); return; }          // SWAP.B
            case 9: { const v = R[m]; R[n] = ((v << 16) | (v >>> 16)) | 0; return; }                                       // SWAP.W
            case 10: { const t = 0 - (R[m] >>> 0) - this.t; R[n] = t | 0; this.t = t < 0 ? 1 : 0; return; }                // NEGC
            case 11: R[n] = (-R[m]) | 0; return;
            case 12: R[n] = R[m] & 0xff; return;
            case 13: R[n] = R[m] & 0xffff; return;
            case 14: R[n] = (R[m] << 24) >> 24; return;
            case 15: R[n] = (R[m] << 16) >> 16; return;
          }
          return this.bad(op, pc);
        case 0x7: R[n] = (R[n] + ((op << 24) >> 24)) | 0; return;
        case 0x8: {
          const d = op & 15, d8 = (op << 24) >> 24;
          switch ((op >> 8) & 15) {
            case 0: mem.w8((R[m] + d) | 0, R[0]); return;
            case 1: mem.w16((R[m] + (d << 1)) | 0, R[0]); return;
            case 4: R[0] = (mem.r8((R[m] + d) | 0) << 24) >> 24; return;
            case 5: R[0] = (mem.r16((R[m] + (d << 1)) | 0) << 16) >> 16; return;
            case 8: this.t = R[0] === d8 ? 1 : 0; return;
            case 9: if (this.t) this.pc = (pc + 4 + (d8 << 1)) | 0; return;                              // BT
            case 11: if (!this.t) this.pc = (pc + 4 + (d8 << 1)) | 0; return;                            // BF
            case 13: if (this.t) this.slot(pc, (pc + 4 + (d8 << 1)) | 0); return;                        // BT/S (slot runs only when taken)
            case 15: if (!this.t) this.slot(pc, (pc + 4 + (d8 << 1)) | 0); return;                       // BF/S
          }
          return this.bad(op, pc);
        }
        case 0x9: R[n] = (mem.r16((pc + 4 + ((op & 255) << 1)) | 0) << 16) >> 16; return;
        case 0xA: this.slot(pc, (pc + 4 + ((((op & 0xfff) << 20) >> 20) << 1)) | 0); return;              // BRA
        case 0xB: this.pr = (pc + 4) | 0; this.slot(pc, (pc + 4 + ((((op & 0xfff) << 20) >> 20) << 1)) | 0); return;   // BSR
        case 0xC: {
          const d = op & 255, g = this.gbr;
          switch ((op >> 8) & 15) {
            case 0: mem.w8((g + d) | 0, R[0]); return; case 1: mem.w16((g + (d << 1)) | 0, R[0]); return; case 2: mem.w32((g + (d << 2)) | 0, R[0]); return;
            case 3: this.pc = pc | 0; return this.stop('trapa #' + d + ' at 0x' + (pc >>> 0).toString(16));
            case 4: R[0] = (mem.r8((g + d) | 0) << 24) >> 24; return; case 5: R[0] = (mem.r16((g + (d << 1)) | 0) << 16) >> 16; return; case 6: R[0] = mem.r32((g + (d << 2)) | 0); return;
            case 7: R[0] = (((pc + 4) & ~3) + (d << 2)) | 0; return;                                     // MOVA
            case 8: this.t = (R[0] & d) === 0 ? 1 : 0; return; case 9: R[0] &= d; return; case 10: R[0] ^= d; return; case 11: R[0] |= d; return;
            case 12: this.t = (mem.r8((g + R[0]) | 0) & d) === 0 ? 1 : 0; return;
            case 13: { const a = (g + R[0]) | 0; mem.w8(a, mem.r8(a) & d); return; }
            case 14: { const a = (g + R[0]) | 0; mem.w8(a, mem.r8(a) ^ d); return; }
            case 15: { const a = (g + R[0]) | 0; mem.w8(a, mem.r8(a) | d); return; }
          }
          return this.bad(op, pc);
        }
        case 0xD: R[n] = mem.r32((((pc + 4) & ~3) + ((op & 255) << 2)) | 0); return;
        case 0xE: R[n] = (op << 24) >> 24; return;
        case 0xF: return this.fpu(op, pc, n, m);
      }
    }

    div1(n, m) {
      const R = this.r, d = R[m], oldq = this.q, x = ((R[n] << 1) | this.t) | 0; let v, tmp;
      this.q = (R[n] >>> 31) & 1;
      if (oldq === this.m) { v = (x - d) | 0; tmp = (v >>> 0) > (x >>> 0) ? 1 : 0; } else { v = (x + d) | 0; tmp = (v >>> 0) < (x >>> 0) ? 1 : 0; }
      this.q = (this.m === 0) === (this.q === 0) ? tmp : 1 - tmp;
      R[n] = v; this.t = this.q === this.m ? 1 : 0;
    }
    macL(n, m) {                                   // MAC.L @Rm+,@Rn+
      const R = this.r, mem = this.mem, a = mem.r32(R[n]); R[n] = (R[n] + 4) | 0; const b = mem.r32(R[m]); R[m] = (R[m] + 4) | 0;
      let acc = BigInt.asIntN(64, (BigInt(this.mach) << 32n) | BigInt(this.macl >>> 0)) + BigInt(a) * BigInt(b);
      if (this.s) { if (acc > 0x7fffffffffffn) acc = 0x7fffffffffffn; else if (acc < -0x800000000000n) acc = -0x800000000000n; } else acc = BigInt.asIntN(64, acc);
      this.mach = Number(BigInt.asIntN(32, acc >> 32n)); this.macl = Number(BigInt.asIntN(32, acc));
    }

    op4(op, pc, n, m) {
      const R = this.r, mem = this.mem, push = v => { R[n] = (R[n] - 4) | 0; mem.w32(R[n], v); }, pop = () => { const v = mem.r32(R[n]); R[n] = (R[n] + 4) | 0; return v; };
      switch (op & 255) {
        case 0x00: case 0x20: this.t = (R[n] >>> 31) & 1; R[n] <<= 1; return;                     // SHLL / SHAL
        case 0x01: this.t = R[n] & 1; R[n] >>>= 1; return;                                        // SHLR
        case 0x21: this.t = R[n] & 1; R[n] >>= 1; return;                                         // SHAR
        case 0x10: R[n] = (R[n] - 1) | 0; this.t = R[n] === 0 ? 1 : 0; return;                    // DT
        case 0x11: this.t = R[n] >= 0 ? 1 : 0; return;                                            // CMP/PZ
        case 0x15: this.t = R[n] > 0 ? 1 : 0; return;                                             // CMP/PL
        case 0x04: { const b = R[n] >>> 31; R[n] = (R[n] << 1) | b; this.t = b; return; }
        case 0x24: { const b = R[n] >>> 31; R[n] = (R[n] << 1) | this.t; this.t = b; return; }
        case 0x05: { const b = R[n] & 1; R[n] = (R[n] >>> 1) | (b << 31); this.t = b; return; }
        case 0x25: { const b = R[n] & 1; R[n] = (R[n] >>> 1) | (this.t << 31); this.t = b; return; }
        case 0x02: return push(this.mach); case 0x12: return push(this.macl); case 0x22: return push(this.pr); case 0x32: return push(this.sgr); case 0x52: return push(this.fpul); case 0x62: return push(this.fpscr); case 0xf2: return push(this.dbr);
        case 0x03: return push(this.sr); case 0x13: return push(this.gbr); case 0x23: return push(this.vbr); case 0x33: return push(this.ssr); case 0x43: return push(this.spc);
        case 0x06: this.mach = pop(); return; case 0x16: this.macl = pop(); return; case 0x26: this.pr = pop(); return; case 0x36: this.sgr = pop(); return; case 0x56: this.fpul = pop(); return; case 0x66: this.fpscr = pop(); return; case 0xf6: this.dbr = pop(); return;
        case 0x07: this.sr = pop(); return; case 0x17: this.gbr = pop(); return; case 0x27: this.vbr = pop(); return; case 0x37: this.ssr = pop(); return; case 0x47: this.spc = pop(); return;
        case 0x08: R[n] <<= 2; return; case 0x18: R[n] <<= 8; return; case 0x28: R[n] <<= 16; return;
        case 0x09: R[n] >>>= 2; return; case 0x19: R[n] >>>= 8; return; case 0x29: R[n] >>>= 16; return;
        case 0x0a: this.mach = R[n]; return; case 0x1a: this.macl = R[n]; return; case 0x2a: this.pr = R[n]; return; case 0x3a: this.sgr = R[n]; return; case 0x5a: this.fpul = R[n]; return; case 0x6a: this.fpscr = R[n]; return; case 0xfa: this.dbr = R[n]; return;
        case 0x0e: this.sr = R[n]; return; case 0x1e: this.gbr = R[n]; return; case 0x2e: this.vbr = R[n]; return; case 0x3e: this.ssr = R[n]; return; case 0x4e: this.spc = R[n]; return;
        case 0x0b: { const t = R[n]; this.pr = (pc + 4) | 0; this.slot(pc, t); return; }          // JSR
        case 0x2b: { const t = R[n]; this.slot(pc, t); return; }                                  // JMP
        case 0x1b: { const a = R[n], v = mem.r8(a); this.t = v === 0 ? 1 : 0; mem.w8(a, v | 0x80); return; }   // TAS.B
      }
      const s = R[m];
      switch (op & 15) {
        case 0xc: { const k = s & 31; R[n] = s >= 0 ? R[n] << k : (k === 0 ? R[n] >> 31 : R[n] >> (32 - k)); return; }       // SHAD
        case 0xd: { const k = s & 31; R[n] = s >= 0 ? R[n] << k : (k === 0 ? 0 : R[n] >>> (32 - k)); return; }                // SHLD
        case 0xf: {                                                                                                             // MAC.W @Rm+,@Rn+
          const a = (mem.r16(R[n]) << 16) >> 16; R[n] = (R[n] + 2) | 0; const b = (mem.r16(R[m]) << 16) >> 16; R[m] = (R[m] + 2) | 0; const prod = Math.imul(a, b);
          if (this.s) { let r = this.macl + prod; if (r > 0x7fffffff) { r = 0x7fffffff; this.mach |= 1; } else if (r < -0x80000000) { r = -0x80000000; this.mach |= 1; } this.macl = r | 0; }
          else { const acc = BigInt.asIntN(64, (BigInt(this.mach) << 32n) | BigInt(this.macl >>> 0)) + BigInt(prod); this.mach = Number(BigInt.asIntN(32, acc >> 32n)); this.macl = Number(BigInt.asIntN(32, acc)); }
          return;
        }
      }
      this.bad(op, pc);
    }

    // ---- FPU -------------------------------------------------------------------------------------------------------
    fpu(op, pc, n, m) {
      const R = this.r, sz = (this.fpscr >> 20) & 1, pr = (this.fpscr >> 19) & 1, fp = this.fp, fb = this.fb;
      switch (op & 15) {
        case 0: if (pr) this.setdr(n, this.dr(n) + this.dr(m)); else fp[fb + n] = fp[fb + n] + fp[fb + m]; return;
        case 1: if (pr) this.setdr(n, this.dr(n) - this.dr(m)); else fp[fb + n] = fp[fb + n] - fp[fb + m]; return;
        case 2: if (pr) this.setdr(n, this.dr(n) * this.dr(m)); else fp[fb + n] = fp[fb + n] * fp[fb + m]; return;
        case 3: if (pr) this.setdr(n, this.dr(n) / this.dr(m)); else fp[fb + n] = fp[fb + n] / fp[fb + m]; return;
        case 4: this.t = (pr ? this.dr(n) === this.dr(m) : fp[fb + n] === fp[fb + m]) ? 1 : 0; return;
        case 5: this.t = (pr ? this.dr(n) > this.dr(m) : fp[fb + n] > fp[fb + m]) ? 1 : 0; return;
        case 6: this.fload(n, (R[m] + R[0]) | 0, sz); return;
        case 7: this.fstore(m, (R[n] + R[0]) | 0, sz); return;
        case 8: this.fload(n, R[m], sz); return;
        case 9: { const a = R[m]; this.fload(n, a, sz); R[m] = (a + (sz ? 8 : 4)) | 0; return; }
        case 10: this.fstore(m, R[n], sz); return;
        case 11: { const a = (R[n] - (sz ? 8 : 4)) | 0; this.fstore(m, a, sz); R[n] = a; return; }
        case 12:
          if (!sz) { fp[fb + n] = fp[fb + m]; return; }
          { const sb = this.pairBase(m), db = this.pairBase(n), a = this.fpb[sb], b = this.fpb[sb + 1]; this.fpb[db] = a; this.fpb[db + 1] = b; return; }
        case 14: fp[fb + n] = fp[fb + n] + fp[fb] * fp[fb + m]; return;                         // FMAC FR0,FRm,FRn
        case 13: return this.fpu2(op, pc, n, m, pr);
      }
      this.bad(op, pc);
    }
    fload(n, a, sz) {
      if (!sz) { this.fpb[this.fb + n] = this.mem.r32(a); return; }
      const b = this.pairBase(n); this.fpb[b] = this.mem.r32(a); this.fpb[b + 1] = this.mem.r32((a + 4) | 0);
    }
    fstore(m, a, sz) {
      if (!sz) { this.mem.w32(a, this.fpb[this.fb + m] | 0); return; }
      const b = this.pairBase(m); this.mem.w32(a, this.fpb[b] | 0); this.mem.w32((a + 4) | 0, this.fpb[b + 1] | 0);
    }
    fpu2(op, pc, n, m, pr) {
      const fp = this.fp, fb = this.fb;
      switch (m) {
        case 0: this.fpb[fb + n] = this.fpul; return;                                           // FSTS FPUL,FRn
        case 1: this.fpul = this.fpb[fb + n] | 0; return;                                       // FLDS FRm,FPUL
        case 2: if (pr) this.setdr(n, this.fpul); else fp[fb + n] = this.fpul; return;          // FLOAT
        case 3: { const v = pr ? this.dr(n) : fp[fb + n]; this.fpul = v >= 2147483647 ? 0x7fffffff : v <= -2147483648 ? -0x80000000 : (Math.trunc(v) | 0); return; }   // FTRC
        case 4: if (pr) this.setdr(n, -this.dr(n)); else this.fpb[fb + n] ^= 0x80000000; return;
        case 5: if (pr) this.setdr(n, Math.abs(this.dr(n))); else this.fpb[fb + n] &= 0x7fffffff; return;
        case 6: if (pr) this.setdr(n, Math.sqrt(this.dr(n))); else fp[fb + n] = Math.sqrt(fp[fb + n]); return;
        case 7: fp[fb + n] = 1 / Math.sqrt(fp[fb + n]); return;                                 // FSRRA
        case 8: fp[fb + n] = 0; return;
        case 9: fp[fb + n] = 1; return;
        case 10: U32[0] = this.fpul; this.setdr(n, F32[0]); return;                             // FCNVSD
        case 11: F32[0] = this.dr(n); this.fpul = U32[0] | 0; return;                           // FCNVDS
        case 14: {                                                                              // FIPR FVm,FVn (n field: high 2 bits FVn, low 2 bits FVm)
          const vn = fb + ((n >> 2) << 2), vm = fb + ((n & 3) << 2); fp[vn + 3] = fp[vm] * fp[vn] + fp[vm + 1] * fp[vn + 1] + fp[vm + 2] * fp[vn + 2] + fp[vm + 3] * fp[vn + 3]; return;
        }
        case 15:
          if (op === 0xf3fd) { this.fpscr ^= 0x100000; return; }                                // FSCHG
          if (op === 0xfbfd) { this.fpscr ^= 0x200000; return; }                                // FRCHG
          if ((op & 0x0300) === 0x0100) {                                                       // FTRV XMTRX,FVn
            const vn = fb + (((op >> 10) & 3) << 2), xb = this.xb, v = [fp[vn], fp[vn + 1], fp[vn + 2], fp[vn + 3]];
            for (let r = 0; r < 4; r++) fp[vn + r] = fp[xb + r] * v[0] + fp[xb + 4 + r] * v[1] + fp[xb + 8 + r] * v[2] + fp[xb + 12 + r] * v[3];
            return;
          }
          if ((op & 0x0100) === 0) {                                                            // FSCA FPUL,DRn: angle in 1/65536 turns
            const ang = ((this.fpul & 0xffff) / 65536) * 2 * Math.PI, b = fb + ((op >> 9) & 7) * 2; fp[b] = Math.sin(ang); fp[b + 1] = Math.cos(ang); return;
          }
      }
      this.bad(op, pc);
    }
  }

  const api = { SH4, Memory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SH4 = api;
})(typeof window !== 'undefined' ? window : globalThis);
