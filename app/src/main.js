// Desktop player: the games list, the games in their cabinet and the menu (app.js) in an SDL window. The picture keeps its shape, centred.
// Keys in a game: SPACE spins, N inserts a note, Left/Right bet, Up/Down lines, 1-5 bet keys, Q-Y play keys, A auto, Tab games list,
// F2 control panel, F3 banner, F10 or Esc menu, F11 full screen, F12 screenshot. The control panel's keys and note acceptor take mouse clicks.
// Window size: "fit" (the default) makes the window as large as the screen's usable area allows; a scale of x is x times the web build's
// CSS pixels (the app draws at 2x them).
// usage: node src/main.js [ROM folder | ROM zip]
const sdl = require('@kmamal/sdl'), path = require('path');
const { App, settingsStore } = require('./app.js');

// the screen at half size, each pixel the average of four (of two pairs, the bytes rounded down: a handheld halves the games list each
// frame it scrolls, and this is some three times quicker than adding each byte); rows: only the screen's rows [[y0, y1], ...] changed
// since the last one
let halfPic = null;
function half(s, rows) {
  const w = s.w >> 1, h = s.h >> 1; if (!halfPic || halfPic.w !== w || halfPic.h !== h) { halfPic = { w, h, rgba: new Uint8Array(w * h * 4) }; halfPic.u32 = new Uint32Array(halfPic.rgba.buffer); rows = null; }
  const a = s.u32, d = halfPic.u32, row = s.w;
  for (const [y0, y1] of rows || [[0, s.h]]) for (let y = y0 >> 1; y < Math.min(h, (y1 + 1) >> 1); y++) for (let x = 0, i = y * 2 * row, o = y * w; x < w; x++, i += 2, o++) {
    const p = a[i], q = a[i + 1], r = a[i + row], t = a[i + row + 1];
    const u = (p & q) + (((p ^ q) & 0xfefefefe) >>> 1), v = (r & t) + (((r ^ t) & 0xfefefefe) >>> 1);
    d[o] = 0xff000000 | ((u & v) + (((u ^ v) & 0xfefefefe) >>> 1));
  }
  return halfPic;
}

(async () => {
  const args = process.argv.slice(2).filter(a => a !== '--mute'), arg = args[0], st = settingsStore();
  // sound through the first playback device; --mute (or MK6_MUTE=1) opens none
  const sound = process.argv.includes('--mute') || process.env.MK6_MUTE ? null : require('./sound.js').create(sdl);
  const isZip = arg && /\.zip$/i.test(arg), romDir = arg ? (isZip ? path.dirname(arg) : arg) : undefined;
  if (romDir) st.s.romDir = path.resolve(romDir);
  let win = null, quit = false;
  // window size for the app's screen (W x H at 2x CSS pixels): the chosen scale, else the largest that fits the display
  const sizeFor = (W, H) => {
    const x = st.s.scale; if (x) return [Math.round(W / 2 * x), Math.round(H / 2 * x)];
    const d = (win && win.display) || sdl.video.displays[0], u = d ? d.usable : { width: W / 2, height: H / 2 };
    const k = Math.min((u.width - 40) / W, (u.height - 60) / H, 1); return [Math.round(W * k), Math.round(H * k)];
  };
  const fit = () => { if (win && !win.fullscreen) win.setSize(...sizeFor(app.W, app.H)); };
  const app = new App({ settings: st, romDir: st.s.romDir, platform: {
    fullscreen: on => win.setFullscreen(on), scale: () => fit(), resize: () => fit(), quit: () => { quit = true; }, sound,
    display: () => { const d = (win && win.display) || sdl.video.displays[0], u = d && d.usable; return u ? [u.width, u.height] : null; } } });
  const [w0, h0] = sizeFor(app.W, app.H);
  win = sdl.video.createWindow({ title: 'Retro Pokies', width: w0, height: h0, resizable: true, fullscreen: !!st.s.fullscreen });
  if (isZip) app.ready.then(() => { const id = require('./core.js').slug(arg), g = app.games.find(x => x.id === id); if (g) app.launch(g); });   // once the boot screen is done

  // the picture's place in the window, in window units (mouse)
  const toScreen = e => { const W = app.W, H = app.H, k = Math.min(win.width / W, win.height / H); return [(e.x - (win.width - W * k) / 2) / k, (e.y - (win.height - H * k) / 2) / k]; };
  win.on('close', () => { app.quit(); });
  win.on('keyDown', e => { if (e.key) app.key(e.key, e); });
  win.on('textInput', e => app.text(e.text));
  win.on('mouseMove', e => app.move(...toScreen(e)));
  win.on('mouseButtonDown', e => { if (e.button === 1) app.click(...toScreen(e)); });
  win.on('mouseWheel', e => app.wheel(e.flipped ? -e.dy : e.dy));
  let shown = null, shownPic = null; win.on('expose', () => { shown = null; });   // what the window shows: a picture that has not changed is not sent again

  let last = performance.now(), halved = null;
  while (!quit && !win.destroyed) {
    const t = performance.now(), dt = t - last; last = t;
    const k = Math.min(win.pixelWidth / app.W, win.pixelHeight / app.H); app.half = k <= 0.55;   // the app then draws game frames at half size itself
    const s = await app.tick(dt);
    if (win.destroyed) break;
    // the screen is drawn at 2x: shown at half size or smaller it is first averaged 2 x 2 (its text then looks as the browser's, and
    // nothing is lost as by sampling); Smoothing chooses how the picture is enlarged (off: square pixels)
    const w = Math.round(app.W * k), h = Math.round(app.H * k);
    const p = s.w < app.W ? s : k <= 0.55 ? half(s, s === halved ? s.dirty : null) : s, scaling = k < 1 || st.s.linear !== false ? 'linear' : 'nearest';
    const t1 = performance.now(), at = [p.w, p.h, w, h, win.pixelWidth, win.pixelHeight, scaling].join();
    if (!(p.same && p === shownPic && at === shown)) win.render(p.w, p.h, p.w * 4, 'rgba32', Buffer.from(p.rgba.buffer, p.rgba.byteOffset, p.w * p.h * 4), { scaling, dstRect: { x: (win.pixelWidth - w) >> 1, y: (win.pixelHeight - h) >> 1, width: w, height: h } });
    shown = at; shownPic = p;
    halved = p !== s ? s : null;   // the screen whose half halfPic holds
    app.showMs = (app.showMs || 0) * 0.9 + (performance.now() - t1) * 0.1;   // shown by the FPS counter
    await new Promise(r => setTimeout(r, Math.max(1, 16.5 - (performance.now() - t))));
  }
  if (!win.destroyed) win.destroy();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
