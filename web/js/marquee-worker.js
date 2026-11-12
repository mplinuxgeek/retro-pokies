// Worker for games.html card art: opens one ROM and picks its marquee (MK6RENDER.marquee, the attract art play.html puts behind the title).
// No map and no spin: it decodes only the images it looks at. Used when the page has no server store to cache marquees (the static build).
// in: { id, buf }  out: { id, im: { w, h, rgba } } | { id, none: true } (a ROM without attract art) | { id, error }
importScripts('mk6.js', 'sh4.js', 'avl.js', 'flic.js', 'mk6tables.js', 'mk6sys.js', 'jpeg.js', 'mk6vm.js', 'mk6render.js');
console.warn = () => {};
onmessage = async e => {
  const { id, buf } = e.data;
  try {
    const rom = await MK6.openZip(new Uint8Array(buf));
    const vm = new MK6VM.VM(rom, Object.assign({ options: {} }, MK6TABLES));
    vm.decodeBlob = async b => { const bm = await createImageBitmap(new Blob([b]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height); return { w: bm.width, h: bm.height, rgba: d.data }; };   // PNG/JPEG items (backgrounds) need the browser decoder, as in play.html
    const im = await MK6RENDER.marquee(vm).catch(() => null);
    if (!im) return postMessage({ id, none: true });
    const rgba = new Uint8ClampedArray(im.rgba.buffer.slice(im.rgba.byteOffset, im.rgba.byteOffset + im.w * im.h * 4));
    postMessage({ id, im: { w: im.w, h: im.h, rgba } }, [rgba.buffer]);
  } catch (err) { postMessage({ id, error: String(err && err.message || err).slice(0, 200) }); }
};
