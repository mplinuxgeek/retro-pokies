// Worker for games.html screenshot scan: boots one ROM headless, plays one spin and renders the finished frame.
// in: { id, buf, frames }  out: { id, progress } | { id, shot: { w, h, rgba } } | { id, error }
importScripts('mk6.js', 'sh4.js', 'avl.js', 'flic.js', 'mk6tables.js', 'mk6sys.js', 'jpeg.js', 'mk6vm.js', 'mk6render.js', 'mk6host.js');
console.warn = () => {};
const validMap = m => m && m.state && m.stopBuf && m.starter && Object.keys(m.lineKeys || {}).length && Object.keys(m.betKeys || {}).length;
onmessage = async e => {
  const { id, buf } = e.data, frames = e.data.frames || 40000, say = o => postMessage(Object.assign({ id }, o));
  try {
    const rom = await MK6.openZip(new Uint8Array(buf)); let map = e.data.map;
    { let shipped = null; try { shipped = await (await fetch('../maps/' + id + '.json', { cache: 'no-cache' })).json(); } catch (x) {} if (validMap(shipped)) map = shipped; }
    if (!validMap(map)) throw new Error('no map (scan the ROM in debug.html first)');
    const vm = new MK6VM.VM(rom, Object.assign({ options: { lineIdx: map.lineIdx ?? 1, betIdx: map.betIdx ?? 0 } }, MK6TABLES));
    vm.decodeBlob = async b => { const bm = await createImageBitmap(new Blob([b]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height); return { w: bm.width, h: bm.height, rgba: d.data }; };   // PNG/JPEG items (backgrounds) need the browser decoder, as in play.html
    await vm.preload();
    const ks = Object.keys(map.lineKeys).map(Number), lines = Math.max(...ks), bets = Object.keys(map.betKeys).map(Number);
    const h = new MK6HOST.Host(vm, { map, lines, bet: bets[0] || 1, fast: true }); h.init(map.lineIdx ?? 1, map.betIdx ?? 0, h.bestRtpSet());
    h.credits = 100000; let k = 0;
    for (; k < 60; k++) h.frame();                                   // idle: let the attract/idle screen draw
    if (h.spin()) { k = 0; while (h.frame() && k++ < frames); }      // one spin: reels show their stops
    for (k = 0; k < 300; k++) h.frame();                             // settle: let the ROM redraw background and indicators after the result
    const rgba = await MK6RENDER.compose(vm);
    postMessage({ id, shot: { w: 640, h: 480, rgba } }, [rgba.buffer]);
  } catch (err) { say({ error: String(err && err.message || err).slice(0, 200) }); }
};
