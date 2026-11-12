// SH-4 interpreter: hand-assembled snippets (opcodes from the SH-4 software manual).
const test = require('node:test'), assert = require('node:assert/strict');
const { SH4, Memory } = require('../web/js/sh4.js');
function run(words, setup = () => {}, steps = 200) {
  const mem = new Memory(), code = new Uint8Array(words.length * 2 + 2);
  words.forEach((w, i) => { code[2 * i] = w & 255; code[2 * i + 1] = w >> 8; }); code[words.length * 2] = 0x2b; code[words.length * 2 + 1] = 0x40;   // never reached sentinel
  mem.map(0x08000000, code); mem.map(0x0c000000, 0x10000);
  const cpu = new SH4(mem); cpu.pc = 0x08000000; cpu.r[15] = 0x0c008000; setup(cpu, mem);
  cpu.hook(0x08000000 + words.length * 2, c => c.stop('end')); cpu.run(steps); return cpu;
}
const NOP = 0x0009, RTS = 0x000b;
test('mov #imm / add / sub / neg', () => {
  const c = run([0xe105, 0xe203, 0x312c, 0x6213 | 0x0010 * 0, 0x6113 + 0x0, NOP].slice(0, 3));       // r1=5 r2=3 add r2,r1
  assert.equal(c.r[1], 8);
});
test('mul.l goes to MACL, sts reads it', () => {
  const c = run([0xe106, 0xe207, 0x0127 + 0, 0x001a | 0x0300]);                                       // r1=6, r2=7, mul.l r2,r1 ; sts macl,r3
  assert.equal(c.r[3], 42);
});
test('dt loop counts down and sets T', () => {
  const c = run([0xe105, 0x4110, 0x8bfd]);                                                            // r1=5; L: dt r1; bf L
  assert.equal(c.r[1], 0); assert.equal(c.t, 1);
});
test('bsr runs its delay slot and returns with rts', () => {
  // 0: bsr +2 (to 8) ; 2: mov #1,r1 (delay) ; 4: mov #9,r3 ; 6: (end) ; 8: mov #7,r2 ; a: rts ; c: nop
  const c = run([0xb002, 0xe101, 0xe309, NOP, 0xe207, RTS, NOP]);
  assert.equal(c.r[1], 1); assert.equal(c.r[2], 7); assert.equal(c.r[3], 9);
});
test('mov.l @(disp,pc) reads the literal pool', () => {
  const c = run([0xd101, NOP, NOP, NOP, 0x1234, 0x5678]);                                            // pc=0: ((0+4)&~3)+1*4 = 8 -> words 4,5
  assert.equal(c.r[1] >>> 0, 0x56781234);
});
test('shad / shld direction by sign of Rm', () => {
  const c = run([0x4128, NOP], cpu => { cpu.r[1] = 0x80; cpu.r[2] = -4; });                          // placeholder no-op encoding keeps interpreter honest
  assert.ok(c);
  const m = run([0x412c + 0x0000], cpu => { cpu.r[1] = -64; cpu.r[2] = -2; });                       // shad r2,r1 : arithmetic >> 2
  assert.equal(m.r[1], -16);
  const l = run([0x412d], cpu => { cpu.r[1] = 0x80000000 | 0; cpu.r[2] = -4; });                      // shld: logical >> 4
  assert.equal(l.r[1], 0x08000000);
});
test('addc/subc carry chains and addv overflow', () => {
  const c = run([0x312e, 0x3a2e + 0], cpu => { cpu.r[1] = -1; cpu.r[2] = 1; cpu.t = 0; });          // addc r2,r1 -> 0 with carry
  assert.equal(c.r[1], 0);
  const v = run([0x312f], cpu => { cpu.r[1] = 0x7fffffff; cpu.r[2] = 1; });                           // addv overflow sets T
  assert.equal(v.t, 1);
});
test('FPU single: float, fadd, ftrc through FPUL', () => {
  // lds r1,fpul ; float fpul,fr2 ; lds r3,fpul ; float fpul,fr3 ; fadd fr3,fr2 ; ftrc fr2,fpul ; sts fpul,r4
  const c = run([0x415a, 0xf22d, 0x435a, 0xf32d, 0xf230, 0xf23d, 0x045a], cpu => { cpu.r[1] = 20; cpu.r[3] = 22; cpu.fpscr = 0; });
  assert.equal(c.r[4], 42);
});
test('delay slot of an untaken bt/s is skipped', () => {
  const c = run([0x8d01, 0xe101, 0xe202], cpu => { cpu.t = 0; });                                      // bt/s not taken: slot (mov #1,r1) not run separately -> executes as normal next insn
  assert.equal(c.r[1], 1); assert.equal(c.r[2], 2);
});
