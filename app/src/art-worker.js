// Makes a game's card art from its ROM (MK6RENDER.marquee: the attract picture play.html puts behind the title) and caches it as
// <cache>/<id>.png. One ROM at a time; the reply says whether a picture was written.
const { parentPort, workerData } = require('worker_threads'), fs = require('fs'), path = require('path');
const { MK6, VM, RD, T } = require('./core.js'), { png } = require('./ui.js');
console.warn = () => {}; console.log = () => {};
parentPort.on('message', async ({ id, zip }) => {
  let ok = false;
  try {
    const rom = await MK6.openZip(fs.readFileSync(zip)), vm = new VM(rom, Object.assign({ options: {} }, T));
    const im = await RD.marquee(vm).catch(() => null);   // decodes only the images it looks at, not the whole ROM
    if (im) { fs.mkdirSync(workerData.cache, { recursive: true }); const f = path.join(workerData.cache, id + '.png');
      fs.writeFileSync(f + '.tmp', png(new Uint8ClampedArray(im.rgba.buffer, im.rgba.byteOffset, im.w * im.h * 4), im.w, im.h)); fs.renameSync(f + '.tmp', f); ok = true; }
  } catch (e) {}
  parentPort.postMessage({ id, ok });
});
