// Aristocrat FLIC palette chunk 64: the colours start after the offset table, not right after the 6-byte header.
const test = require('node:test'), assert = require('node:assert'), FL = require('../web/js/flic.js');
const le = (n, k) => Array.from({ length: k }, (_, i) => (n >>> (8 * i)) & 255);
test('chunk 64 palette starts after the offset table', () => {
  const ents = [[0, 0, 0, 255], [10, 20, 30, 255], [40, 50, 60, 255]];   // B, G, R, A: palette entries 0..2
  const pal = [].concat(...ents), c64body = [...le(3, 2), ...le(1, 2), ...le(1, 2), ...le(10, 4), ...pal];
  const c64 = [...le(6 + c64body.length, 4), ...le(64, 2), ...c64body];
  const px = [0xfe, 1, 255, 2, 255], c73 = [...le(6 + px.length, 4), ...le(73, 2), ...px];
  const frame = [...le(16 + c64.length + c73.length, 4), 0xfa, 0xf1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...c64, ...c73];
  const hdr = new Array(44).fill(0); hdr.splice(0, 4, 0x46, 0x4c, 0x49, 0x43); hdr.splice(12, 4, ...le(2, 4)); hdr.splice(16, 4, ...le(1, 4)); hdr.splice(28, 4, 255, 255, 255, 255); hdr.splice(32, 4, ...le(1, 4));
  const f = FL.parse(Uint8Array.from([...hdr, ...frame])).frames(null)[0];
  assert.deepEqual(Array.from(f.rgba), [30, 20, 10, 255, 60, 50, 40, 255]);
});
