// Decodes a ROM's PNG and JPEG images off the main thread (core.js's decoder pool): { n, png, b } in, { n, im } or { n, err } out,
// the picture's pixels handed over, not copied.
const { parentPort } = require('worker_threads'), path = require('path');
const MK6 = require(path.join(__dirname, '..', '..', 'web', 'js', 'mk6.js')), J = require(path.join(__dirname, '..', '..', 'web', 'js', 'jpeg.js'));
parentPort.on('message', async ({ n, png, b }) => {
  try { const im = png ? await MK6.decodePngRGBA(b) : J.decodeJpeg(b); parentPort.postMessage({ n, im }, im ? [im.rgba.buffer] : []); }
  catch (e) { parentPort.postMessage({ n, err: e.message }); }
});
