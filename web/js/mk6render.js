// Software compositor for the VM's display-manager items (640x480). Works in Node and in the browser.
(function (root) {
  'use strict';
  // each row of a picture as runs of one kind (0 clear, 1 opaque, 2 blended: [x0, x1, kind, ...]), worked out once per picture: clear runs are skipped,
  // opaque ones copied whole. Runs shorter than 16 pixels are blended (exact for clear and opaque pixels too) and join their neighbours: fewer, longer runs
  function runsOf(im, s32) {
    if (im.runsOf === s32) return im.runs;
    const src = im.rgba; im.runs = [];
    for (let y = 0; y < im.h; y++) { const r = []; let k = -1, x0 = 0;
      const end = (x1, t) => { if (t !== 2 && x1 - x0 < 16) t = 2; if (r.length && r[r.length - 1] === t) r[r.length - 2] = x1; else r.push(x0, x1, t); };
      for (let x = 0, i = y * im.w * 4 + 3; x < im.w; x++, i += 4) { const a = src[i], t = a === 255 ? 1 : a ? 2 : 0; if (t !== k) { if (k >= 0) end(x, k); x0 = x; k = t; } }
      if (k >= 0) end(im.w, k); im.runs.push(Int32Array.from(r)); }
    im.runsOf = s32; return im.runs;
  }
  const u32Of = im => im.u32 && im.u32.buffer === im.rgba.buffer ? im.u32 : (im.u32 = new Uint32Array(im.rgba.buffer, im.rgba.byteOffset, im.w * im.h));
  // what an image's name says about where it is drawn, worked out once per image
  function tagOf(vm, id) {
    const c = vm._renderTags || (vm._renderTags = new Map()); let t = c.get(id); if (t) return t;
    const n = vm.db ? (vm.db.byIndex(1, id)?.name || '') : '';
    t = { n, front: n.includes('WLB') || n.includes('WLD') || n.includes('WLL') || n.includes('BRI') || n.startsWith('IMG_DRK_') || /^IMG_WL\d+_/.test(n),
      reelBg: n === 'IMG_REEL', win: n.startsWith('IMG_WIN_'), blank: n.includes('feat_blank'), div: n.startsWith('IMG_MS_BEV_REELDIV_'), divAny: /BEV_REELDIV_/.test(n) };
    c.set(id, t); return t;
  }
  // everything compose reads from the VM, written into vm._inputs; true when it is all as for the last frame (then so is the picture).
  // Pictures by their objects (a decoded one replaces null), flics by the frame shown
  function sameInputs(vm, W, H, oy) {
    const K = vm._inputs || (vm._inputs = []); let n = 0, same = true; const put = v => { if (K[n] !== v) { K[n] = v; same = false; } n++; };
    put(W); put(H); put(oy); const vis = vm.display.items; put(vis.length);
    for (let i = 0; i < vis.length; i++) { const it = vis[i];
      if (!it.visible || (it.img === undefined && it.flic === undefined)) { put(0); continue; }
      let im = null; if (it.flic !== undefined) { const f = vm.flic(it.flic); if (f) { const k = Math.floor((vm.now - (it.t0 || 0)) / f.delay); im = f.frames[it.plays === undefined || it.plays === -1 || k < Math.max(1, it.plays) * f.count ? k % f.count : f.count - 1]; } }
      else if (vm._img) im = vm._img.get(it.img);
      const c = it.clip; put(it.img); put(it.flic); put(im); put(it.prio); put(it.scene); put(it.x); put(it.y); put(it.glow); put(c); if (c) { put(c[0]); put(c[1]); put(c[2]); put(c[3]); }
    }
    const wins = vm.openWindows ? vm.openWindows() : vm.display.windows; put(wins.length);
    for (let i = 0; i < wins.length; i++) { const w = wins[i], r = w.rect;
      put(w.visible); put(w.text); put(w.font); put(w.font && vm._img ? vm._img.get(w.font.img) : null); put(w.x); put(w.y); put(w.w); put(w.h); put(w.align); put(w.valign); put(w.prio);
      put(r); if (r) { put(r[0]); put(r[1]); put(r[2]); put(r[3]); } }
    if (K.length !== n) { K.length = n; same = false; }
    return same;
  }
  // vm.reuseOut: the same picture is returned every frame (the desktop app, which is done with it before the next), and when nothing it
  // is drawn from has changed it is not drawn again (vm.outSame says so); else a new one each time
  async function compose(vm, W = 640, H = 480, oy = 0) {   // oy: rows added to every y (the two-screen touch machines: the top screen lies at y -480..0)
    if (vm.reuseOut) { const same = sameInputs(vm, W, H, oy); vm.outSame = same && !!vm._out && vm._out.length === W * H * 4; if (vm.outSame) return vm._out; }
    let out = vm.reuseOut && vm._out && vm._out.length === W * H * 4 ? vm._out : null;
    if (!out) { out = new Uint8ClampedArray(W * H * 4); if (vm.reuseOut) vm._out = out; }
    const out32 = new Uint32Array(out.buffer); out32.fill(0xff000000);   // opaque black (little-endian RGBA)
    const items = [], vis = vm.display.items;
    for (let i = 0; i < vis.length; i++) {
      const it = vis[i]; if (!it.visible || (it.img === undefined && it.flic === undefined)) continue;
      let prio = it.prio;
      if (it.img !== undefined && vm.db) { const t = tagOf(vm, it.img);
        if (t.front) prio += 5000; // line indicator boxes and win lines render in front of frame borders and top/bottom bars (prio 3000)
        if (it.scene !== undefined && t.reelBg) prio -= 5000; // opaque reel backdrop (Arabian Nights, prio 2001+) belongs behind the reel strips (prio 0)
        if (it.scene !== undefined && t.win) prio -= 1000; // win line pieces (Arabian Nights, prio 0-4) go behind the reel symbols (prio 0) and show only between them
        if (it.scene !== undefined && t.blank) prio -= 1000; // free-game blank tile grid (Arabian Nights, prio 0-14) sits behind the reel symbols
      }
      items.push({ it, prio, i });
    }
    items.sort((a, b) => (a.prio - b.prio) || (a.i - b.i));
    const sceneTop = new Map(); for (const { it, prio } of items) if (it.scene !== undefined) sceneTop.set(it.scene, Math.max(sceneTop.get(it.scene) ?? -Infinity, prio | 0));
    // a label in a scene is drawn over the scene's own button art when the art is at most 10 above it (Cashman Tonight's tile buttons: text at base + 0, the key at + 10 on the same scene;
    // so the labels stay readable)
    const strings = vis.filter(it => it.visible && it.text && it.font).map(it => { const top = sceneTop.get(it.scene), p = it.prio | 0; return { visible: true, text: it.text, font: it.font, x: it.x, y: it.y, w: 0, h: it.font.h || 0, prio: vm.labelsOnTop && top !== undefined && top > p && top - p <= 10 ? top + .5 : it.prio }; });   // string objects placed in scenes (_createstring)
    // two-screen touch machines: a window is a display item with the priority _createwin was given, so a menu overlay hides the paytable text under it
    const wins = (vm.openWindows ? vm.openWindows() : vm.display.windows).concat(strings);
    // the pictures this frame needs, decoded first (once per game: then they are all at hand), so the drawing below never waits
    for (const { it } of items) if (it.img !== undefined && !(vm._img && vm._img.has(it.img))) await vm.loadImage(it.img);
    for (const w of wins) if (w.visible && w.text && w.font && !(vm._img && vm._img.has(w.font.img))) await vm.loadImage(w.font.img);
    const img = id => vm._img ? vm._img.get(id) : null;
    let apTop = 124, apBot = 424;                                                  // reel aperture: the reel divider bars span it (50 Lions 109..429), else the 3-row default
    for (const { it } of items) { if (it.scene === undefined || it.img === undefined || !vm.db) continue; const t = tagOf(vm, it.img); if (t.n && (t.div || (vm.windowPrio && t.divAny))) { const dv = img(it.img); if (dv) { apTop = it.y | 0; apBot = apTop + dv.h; break; } } }
    // pixel sp (alpha honoured) over opaque pixel dp, both little-endian RGBA words: each channel d + (s - d) * a / 255 rounded, in integers
    // ((t + (t >> 8)) >> 8 with t = n + 128 is n / 255 rounded, exactly, for n up to 65535)
    const blend = (dp, sp) => {
      const a = sp >>> 24, b = 255 - a;
      let t = (dp & 255) * b + (sp & 255) * a + 128; const r = (t + (t >> 8)) >> 8;
      t = ((dp >>> 8) & 255) * b + ((sp >>> 8) & 255) * a + 128; const g = (t + (t >> 8)) >> 8;
      t = ((dp >>> 16) & 255) * b + ((sp >>> 16) & 255) * a + 128;
      return (0xff000000 | ((t + (t >> 8)) >> 8) << 16 | g << 8 | r) >>> 0;
    };
    // columns p..q of source row sr into destination row dr (dr + p is the first pixel written), by the row's runs r
    const row = (s32, r, sr, dr, lo, hi) => {
      const o32 = out32;
      for (let k = 0; k < r.length; k += 3) {
        const p = Math.max(r[k], lo), q = Math.min(r[k + 1], hi); if (p >= q || !r[k + 2]) continue;
        if (r[k + 2] === 1) { o32.set(s32.subarray(sr + p, sr + q), dr + p); continue; }
        for (let x = p, si = sr + p, di = dr + p; x < q; x++, si++, di++) o32[di] = blend(o32[di], s32[si]);
      }
    };
    const drawItem = it => {
      let im; if (it.flic !== undefined) { const f = vm.flic(it.flic); if (!f) return; const n = Math.floor((vm.now - (it.t0 || 0)) / f.delay); im = f.frames[it.plays === undefined || it.plays === -1 || n < Math.max(1, it.plays) * f.count ? n % f.count : f.count - 1]; } else im = img(it.img);
      if (!im) return;
      const isReel = (it.scene === undefined);
      const x0 = it.x | 0, y0 = (it.y | 0) + oy, gl = it.glow || 0;                       // glow: blend towards white (the winning-symbol flash)
      const [cl, ct, cr, cb] = it.clip || [0, 0, im.w, im.h];                       // _setitemclipDM's item-local clip rect
      // the visible columns and rows worked out once (clip rect, screen, reel aperture), then each row: opaque pixels copied whole, translucent ones blended
      const xa = Math.max(0, cl, -x0), xb = Math.min(im.w, cr, W - x0); if (xa >= xb) return;
      const src = im.rgba, s32 = u32Of(im), runs = gl ? null : runsOf(im, s32);
      for (let y = Math.max(0, ct, -y0); y < Math.min(im.h, cb, H - y0); y++) {
        const dy = y0 + y;
        if (isReel && (dy - oy < apTop || dy - oy >= apBot)) continue;                           // hardware reel aperture clipping
        if (!gl) { row(s32, runs[y], y * im.w, dy * W + x0, xa, xb); continue; }
        for (let x = xa, s = (y * im.w + xa) * 4, d = (dy * W + x0 + xa) * 4; x < xb; x++, s += 4, d += 4) {
          const a = src[s + 3];
          if (a === 255) { out[d] = src[s] + (255 - src[s]) * gl; out[d + 1] = src[s + 1] + (255 - src[s + 1]) * gl; out[d + 2] = src[s + 2] + (255 - src[s + 2]) * gl; }
          else if (a) { out[d] += (src[s] - out[d]) * a / 255; out[d + 1] += (src[s + 1] - out[d + 1]) * a / 255; out[d + 2] += (src[s + 2] - out[d + 2]) * a / 255; }
        }
      }
    };
    const drawText = w => {                  // text layer: bitmap-font strings drawn by the game into its windows
      if (!w.visible || !w.text || !w.font) return;
      const f = w.font, im = img(f.img); if (!im) return; f.w = im.w; f.h = im.h;
      const g32 = u32Of(im), runs = runsOf(im, g32);
      const tw = vm.textWidth(f, w.text);
      // the text's rect (_drawtextDC's, else the window's) at the window's origin; scene strings sit at their x, y (boxed at their own size)
      const [l, t, r, b] = w.rect || [0, 0, w.w | 0, w.h | 0], a = w.align || 'left', va = w.valign || 'top';
      let px = (w.x | 0) + l; if (a === 'right') px += r - l - tw; else if (a === 'center') px += (r - l - tw) >> 1;
      let py = (w.y | 0) + t + oy; if (va === 'bottom') py += b - t - im.h; else if (va === 'center') py += (b - t - im.h) >> 1;
      for (let k = 0; k < w.text.length; k++) {
        const g = vm.glyph(f, w.text.charCodeAt(k)); if (!g) continue;
        // the glyph's columns of the font picture, cut to the screen: font column x lands at px + x - g.x
        const lo = Math.max(g.x, g.x - px), hi = Math.min(g.x + g.w, g.x + W - px);
        if (lo < hi) for (let y = 0; y < im.h; y++) { const dy = py + y; if (dy < 0 || dy >= H) continue; row(g32, runs[y], y * im.w, dy * W + px - g.x, lo, hi); }
        px += vm.glyphAdvance(f, w.text, k);
      }
    };
    if (vm.windowPrio) {
      const all = items.map(({ it, prio }, i) => ({ prio, i, it })).concat(wins.map((w, i) => ({ prio: w.prio | 0, i: items.length + i, w })));
      all.sort((a, b) => (a.prio - b.prio) || (a.i - b.i));
      for (const e of all) { if (e.it) drawItem(e.it); else drawText(e.w); }
    } else { for (const { it } of items) drawItem(it); for (const w of wins) drawText(w); }
    return out;
  }
  // The game's marquee for games.html and the play.html title: its attract art. Most ROMs have IMG_ATTRACT (or a look-alike name),
  // 640x300 with the game logo; some name a 32x32 stub like that, which is not art. ROMs that build their attract screen from parts fall back
  // to the first full-size (600x280 or more), opaque, not blank image whose name says attract. Returns the image ({w, h, rgba}) or null.
  async function marquee(vm, opt) {
    // a placeholder IMG_ATTRACT: one flat colour with a line of plain text (King Neptune's is blue with KING NEPTUNE in white): most samples are the same colour
    const placeholder = im => { const p = im.rgba, n = im.w * im.h, step = Math.max(1, (n / 4000) | 0), c = new Map(); let k = 0;
      for (let i = 0; i < n; i += step, k++) { const o = i * 4, key = p[o] << 16 | p[o + 1] << 8 | p[o + 2]; c.set(key, (c.get(key) || 0) + 1); }
      return Math.max(...c.values()) / k > 0.85; };
    const recs = ((vm.db.sections[1] || {}).recs || []).filter(r => r && r.name);
    const load = r => vm.loadImage(r.index).catch(() => null);
    // the last one: a multi-game ROM (Players Choice By Demand) has one per game and its first is a "DEMO GAME" placeholder
    for (const r of recs.filter(r => /^(IMG_ATTRACT|Img_Attract|IMG_CAM_ATTRACT|IMG_HL_Attract|ATTRACT image00)$/.test(r.name)).reverse()) {
      const im = await load(r);
      if (im && im.w >= 320 && im.h >= 100 && !placeholder(im)) return im;
    }
    // opaque and not one flat colour: sampled alpha and brightness spread
    const art = im => {
      const p = im.rgba, n = im.w * im.h, step = Math.max(1, (n / 4000) | 0);
      let k = 0, solid = 0, sum = 0, sq = 0;
      for (let i = 0; i < n; i += step, k++) {
        const o = i * 4, y = (p[o] * 3 + p[o + 1] * 6 + p[o + 2]) / 10;
        if (p[o + 3] > 200) solid++;
        sum += y; sq += y * y;
      }
      return solid / k > 0.9 && Math.sqrt(sq / k - (sum / k) ** 2) > 25;
    };
    for (const r of recs.filter(r => /attract/i.test(r.name))) {
      const im = await load(r);
      if (im && im.w >= 600 && im.h >= 280 && art(im)) return im;
    }
    // last resorts, for ROMs the two rules above leave without a marquee (the others never get here):
    // attract art that is only partly opaque (Alchemy's ATTRACT_background, a still life over transparency) or named with the Atr
    // abbreviation (Sweet Hearts 2's SP_Atr0000 logo frames); then a jackpot's "hype" art (Queen Of The Nile Clown Jackpot's clown)
    const soft = im => { const p = im.rgba, n = im.w * im.h, step = Math.max(1, (n / 4000) | 0);
      let k = 0, solid = 0, sum = 0, sq = 0;
      for (let i = 0; i < n; i += step, k++) { const o = i * 4, y = (p[o] * 3 + p[o + 1] * 6 + p[o + 2]) / 10; if (p[o + 3] > 200) solid++; sum += y; sq += y * y; }
      return solid / k > 0.5 && Math.sqrt(sq / k - (sum / k) ** 2) > 25; };
    for (const re of [/attract|(^|_)atr\d/i, /hype_big/i]) for (const r of recs.filter(r => re.test(r.name))) {
      const im = await load(r);
      if (im && im.w >= 480 && im.h >= 240 && soft(im)) return im;
    }
    return scene(vm, recs, load, opt && opt.variant);
  }
  // the very last resort: ten ROMs (Arabian Nights, Black Brumby, both Cash Express, Corrida De Toros, Mystic Mermaid, Outback Jack Jackpot, Peacock Magic,
  // Queen Of The Nile, Venetian Nights) have no logo image at all (the game names are drawn by the game from fonts and sprites) and no attract art the rules above
  // accept. They get a 640x300 card composed here from their own art: a backdrop cropped from the top, then the hero sprites / promo banner / name sign fitted into boxes,
  // then (where the recipe has `text`) the game name in gold Bungee lettering (below). GAMES: one entry per ROM, keyed by image names only that ROM has (the other ROMs all have
  // a marquee already, so none can match). `on` is the variant that is used; the others (`v`, A..) are alternates kept for comparison: change `on` to pick another.
  // A variant is {bg, art, text} or {crop}. bg: an image name (scaled to cover the card, top aligned), ['tile', name], ['fit', name] (stretched whole) or ['win', name, sx, sy, sw, sh]. art items [name, x, y, w, h, opt]: the image is scaled to fit
  // the box and centred in it; opt 's' stretches it to the box instead, or an array [sx, sy, sw, sh] takes just that window of the image. text [y, h, x, w, title]: the title's box (x, w default 20, 600; title defaults to the game's).
  const GAMES = [
    { name: 'King Neptune', title: 'KING\nNEPTUNE', need: ['IMG_TRIDENT_0000', 'IMG_SYM_PIC_6', 'IMG_WILD_0000'], on: 'A', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['IMG_WILD_0000', 15, 30, 240, 240]], text: [70, 160, 270, 355] },
      B: { bg: 'IMG_MS_OLAY', art: [['IMG_WILD_0000', 15, 30, 240, 240], ['IMG_SYM_PIC_6', 520, 170, 100, 110]], text: [40, 130, 270, 355] } } },
    { name: 'Arabian Nights', title: 'ARABIAN\nNIGHTS', need: ['HORSE_screen_saver'], on: 'A', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['HORSE_screen_saver', 10, 5, 390, 290]], text: [60, 150, 395, 235] } } },
    { name: 'Black Brumby', title: 'BLACK BRUMBY', need: ['ATTRACT banner'], on: 'B', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['ATTRACT man00', 30, 0, 230, 300], ['ATTRACT banner', 250, 80, 370, 140]] },
      B: { bg: 'IMG_MS_OLAY', art: [['IMG_sym_HORSE', 60, 5, 200, 200], ['IMG_sym_STOCKMAN', 370, 5, 200, 200]], text: [208, 85] },
      C: { bg: 'IMG_MS_OLAY', art: [['cardback01', 30, 0, 160, 300], ['IMG_sym_DOG', 450, 30, 150, 170], ['ATTRACT banner', 190, 195, 280, 100]], text: [10, 85, 190, 440] },
      D: { bg: 'IMG_MS_OLAY', art: [['ATTRACT man00', 20, 0, 230, 300], ['IMG_sym_HORSE', 400, 150, 140, 140], ['IMG_sym_HAT', 290, 170, 100, 100]], text: [20, 130, 250, 380] } } },
    { name: 'Venetian Nights', title: 'VENETIAN NIGHTS', need: ['IMG_ATTRACT_BOAT'], on: 'B', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['IMG_ATTRACT_BOAT', 70, 120, 500, 175], ['IMG_ATTRACT_BANNER', 140, 5, 360, 120]] },
      B: { bg: 'IMG_MS_OLAY', art: [['IMG_ATTRACT_BOAT', 70, 130, 500, 170]], text: [20, 90] },
      C: { bg: 'IMG_MS_OLAY', art: [['IMG_SYM_MASK', 20, 130, 150, 150], ['IMG_SYM_COUPLE', 180, 130, 150, 150], ['IMG_SYM_ACTOR', 340, 130, 150, 150], ['IMG_man06', 500, 130, 130, 150]], text: [15, 95] },
      D: { bg: 'IMG_MS_OLAY', art: [['IMG_ATTRACT_BOAT', 20, 150, 400, 145], ['IMG_man06', 450, 140, 150, 150], ['IMG_ATTRACT_BANNER', 220, 5, 200, 66]], text: [75, 70] } } },
    { name: 'Mystic Mermaid', title: 'MYSTIC\nMERMAID', need: ['Attract_RL_mermaid12'], on: 'A', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['Attract_RL_mermaid12', 140, 90, 480, 200]], text: [10, 140, 30, 330] } } },
    { name: 'Peacock Magic', title: 'PEACOCK\nMAGIC', need: ['lookLeft01'], on: 'A', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['lookLeft01', 10, 60, 400, 235]], text: [30, 140, 330, 300] } } },
    { name: 'Corrida De Toros', title: 'CORRIDA DE TOROS', need: ['IMG_FEA_BANNER_BG', 'IMG_STARTPOSE_BULL1_0000'], on: 'B', v: {
      A: { bg: 'IMG_BG', art: [['IMG_STARTPOSE_BULL1_0000', 20, 40, 300, 250], ['IMG_FEA_BANNER_BG', 360, 10, 240, 280]] },
      B: { bg: 'IMG_BG', art: [['IMG_STARTPOSE_BULL1_0000', 170, 60, 300, 235]], text: [10, 70] },
      C: { bg: 'IMG_BG', art: [['IMG_SYM_PIC_1', 20, 120, 170, 170], ['IMG_SYM_WILD', 235, 120, 170, 170], ['IMG_SYM_SCATTER', 450, 120, 170, 170]], text: [15, 90] },
      D: { bg: 'IMG_BG', art: [['IMG_FEA_BANNER_BG', 20, 5, 210, 290], ['IMG_STARTPOSE_BULL1_0000', 250, 60, 360, 235]], text: [95, 120, 38, 175, 'CORRIDA\nDE\nTOROS'] } } },
    { name: 'Outback Jack Jackpot', title: 'OUTBACK JACK', need: ['outback_sign'], on: 'A', v: {
      A: { bg: 'IMG_MS_OLAY', art: [['outback_sign', 50, 15, 540, 90], ['GS_OJACK', 60, 140, 150, 150], ['GS_ROO', 245, 140, 150, 150], ['GS_CROC', 430, 140, 150, 150]] },
      B: { bg: 'map', art: [['outback_sign', 50, 15, 540, 90], ['Decide', 40, 110, 200, 185], ['GS_OJACK', 400, 130, 150, 150]] },
      C: { bg: 'RiverCrossing_bg', art: [['outback_sign', 50, 15, 540, 90], ['GS_ROO', 60, 135, 140, 150], ['GS_SHARK', 240, 135, 140, 150], ['GS_CROC', 430, 135, 140, 150]] },
      D: { bg: 'IMG_MS_OLAY', art: [['GS_OJACK', 20, 30, 240, 240], ['IMG_CARDGAME_BG', 300, 20, 300, 160], ['GS_ROO', 440, 170, 130, 125]] } } },
    { name: 'Queen Of The Nile', title: 'QUEEN OF\nTHE NILE', need: ['IMG_HL_JP_TITLE_CRUISE'], on: 'C', v: {
      A: { bg: 'IMG_BG_BLANK_ALT_11', art: [['IMG_SYM_CLAPPERBOARD', 40, 60, 170, 170], ['IMG_SYM_BOB', 235, 30, 230, 230], ['IMG_SYM_PASSBOOK', 490, 60, 110, 110]] },
      B: { bg: ['tile', 'IMG_BG_BLANK_ALT_11'], art: [['IMG_MS_TOP', 0, 0, 640, 40, 's'], ['IMG_MS_BOTTOM', 0, 275, 640, 25, 's'], ['IMG_SYM_BOB', 40, 50, 220, 220], ['IMG_SYM_CLAPPERBOARD', 540, 60, 80, 80], ['IMG_SYM_PASSBOOK', 540, 160, 80, 80]], text: [60, 160, 290, 240] },
      C: { bg: ['tile', 'IMG_BG_BLANK_ALT_11'], art: [['IMG_SYM_TROPHY', 20, 150, 130, 130], ['IMG_SYM_DOLLY', 160, 150, 130, 130], ['IMG_SYM_BOB', 300, 150, 130, 130], ['IMG_SYM_ENCYLOPEDIA', 440, 150, 130, 130]], text: [15, 120] },
      D: { bg: ['tile', 'IMG_BG_BLANK_ALT_11'], art: [['IMG_SYM_BOB', 380, 20, 260, 260], ['IMG_SYM_CLAPPERBOARD', 30, 160, 110, 110], ['IMG_SYM_PASSBOOK', 150, 160, 110, 110]], text: [30, 120, 20, 340] } } },
    { name: 'Choy Sun Doa Cash Express', title: 'CHOY SUN DOA\nCASH EXPRESS', need: ['IMG_HL_A_TEXT', 'IMG_HLMS_BEV_TOP', 'GS_ChoiSun'], on: 'G', v: {
      A: { crop: ['IMG_HL_A_TEXT', 0, 0, 533, 138] },
      B: { bg: 'IMG_MS_OLAY', art: [['IMG_HL_A_TEXT', 50, 10, 540, 140, [0, 0, 533, 138]], ['GS_ChoiSun', 40, 160, 130, 130], ['SYM_HL_TRAIN', 255, 160, 130, 130], ['GS_DRAGON', 470, 160, 130, 130]] },
      C: { bg: 'IMG_MS_OLAY', art: [['GS_ChoiSun', 20, 30, 240, 240], ['SYM_HL_TRAIN', 400, 130, 170, 160]], text: [30, 90, 270, 360] },
      D: { bg: 'IMG_MS_OLAY', art: [['GS_ChoiSun', 20, 20, 260, 260], ['IMG_FREEGAMES15', 390, 150, 220, 140]], text: [20, 120, 300, 320] },
      E: { bg: 'IMG_MS_OLAY', art: [['GS_ChoiSun', 15, 30, 240, 240], ['SYM_HL_TRAIN', 390, 175, 120, 110]], text: [25, 140, 265, 360] },
      F: { bg: 'IMG_MS_OLAY', art: [['GS_ChoiSun', 70, 145, 145, 145], ['SYM_HL_TRAIN', 248, 145, 145, 145], ['GS_DRAGON', 426, 145, 145, 145]], text: [10, 125] },
      G: { bg: 'IMG_MS_OLAY', art: [['GS_ChoiSun', 15, 30, 240, 240]], text: [80, 140, 270, 355] } } },
    { name: 'Indian Dreaming Cash Express', title: 'INDIAN DREAMING\nCASH EXPRESS', need: ['IMG_HL_A_TEXT', 'IMG_HLMS_BEV_TOP', 'gs_INDIANCHIEF'], on: 'H', v: {
      A: { crop: ['IMG_HL_A_TEXT', 0, 0, 533, 138] },
      B: { bg: 'IMG_MS_OLAY', art: [['IMG_HL_A_TEXT', 50, 10, 540, 140, [0, 0, 533, 138]], ['gs_INDIANCHIEF', 40, 160, 130, 130], ['SYM_HL_TRAIN', 255, 160, 130, 130], ['gs_BUFFALO', 470, 160, 130, 130]] },
      C: { bg: 'IMG_MS_OLAY', art: [['gs_INDIANCHIEF', 20, 30, 240, 240], ['SYM_HL_TRAIN', 400, 130, 170, 160]], text: [30, 90, 270, 360] },
      D: { bg: 'IMG_MS_OLAY', art: [['gs_tent', 30, 100, 190, 190], ['gs_BUFFALO', 225, 100, 190, 190], ['gs_TOTEMPOLE', 420, 100, 190, 190]], text: [10, 85] },
      E: { bg: 'IMG_MS_OLAY', art: [['gs_INDIANCHIEF', 15, 30, 240, 240], ['SYM_HL_TRAIN', 390, 175, 120, 110]], text: [25, 140, 265, 360] },
      F: { bg: 'IMG_MS_OLAY', art: [['gs_INDIANCHIEF', 70, 145, 145, 145], ['SYM_HL_TRAIN', 248, 145, 145, 145], ['gs_BUFFALO', 426, 145, 145, 145]], text: [10, 125] },
      G: { bg: ['fit', 'IMG_MS_OLAY'], art: [['gs_INDIANCHIEF', 60, 45, 210, 210]], text: [90, 120, 285, 295] },
      H: { bg: ['win', 'IMG_MS_OLAY', 60, 25, 520, 280], art: [['gs_INDIANCHIEF', 15, 30, 240, 240]], text: [80, 140, 270, 355] } } },
  ];
  // The title lettering: Bungee (web/fonts/Bungee-Regular-latin.woff2, SIL OFL, see OFL-Bungee.txt) outlines flattened to polygons, 1000 units to the em, y up: [advance, [contour x,y,x,y...]].
  // Only the characters a title needs. Drawn here (Node has no canvas; shots.js caches the marquee there) with a nonzero-winding scanline rasteriser.
  const BUNGEE = {"A":[730,[[273,36,271,20,264,9,253,2,237,0,90,0,74,2,63,9,56,20,54,36,54,300,55,316,56,332,59,350,64,369,69,389,76,411,84,435,93,460,180,687,187,701,198,712,213,718,231,720,500,720,518,718,532,712,543,701,550,687,637,460,646,435,654,411,661,389,666,369,671,350,674,332,675,316,676,300,676,36,674,20,667,9,656,2,640,0,489,0,472,2,460,9,452,20,450,36,450,176,273,176],[330,510,283,358,440,358,393,510,389,517,385,523,380,526,374,527,349,527,343,526,338,523,334,517,330,510]]],"B":[725,[[489,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,424,720,470,718,509,711,542,699,569,683,590,662,604,636,613,604,616,567,616,519,612,481,601,450,583,427,557,411,587,406,613,397,635,384,652,368,666,346,675,321,681,291,683,256,683,164,680,125,671,91,657,63,636,40,609,22,576,10,536,2,489,0],[294,288,294,170,424,170,441,172,452,180,460,192,462,210,462,249,460,266,452,278,441,286,424,288],[294,550,294,442,379,442,396,444,408,452,415,464,417,482,417,510,415,528,408,540,396,548,379,550]]],"C":[628,[[548,0,304,0,245,3,194,12,152,28,118,50,92,78,73,114,62,155,58,204,58,515,62,564,73,606,92,642,118,670,152,692,194,708,245,717,304,720,548,720,564,718,575,711,582,700,584,684,584,563,582,547,575,536,564,529,548,527,347,527,320,524,301,514,290,499,286,477,286,239,290,218,301,203,320,194,347,191,548,191,564,189,575,182,582,171,584,155,584,36,582,20,575,9,564,2,548,0]]],"D":[746,[[442,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,442,720,501,717,552,708,594,692,628,670,654,642,673,606,684,565,688,516,688,204,684,155,673,114,654,78,628,50,594,28,552,12,501,3,442,0],[296,529,296,189,415,189,436,192,450,201,459,217,462,238,462,481,459,502,450,517,436,526,415,529]]],"E":[654,[[569,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,569,720,585,718,596,711,603,700,605,684,605,567,603,551,596,540,585,533,569,531,293,531,293,454,488,454,504,452,515,445,522,434,524,418,524,311,522,295,515,284,504,277,488,275,293,275,293,189,569,189,585,187,596,180,603,169,605,153,605,36,603,20,596,9,585,2,569,0]]],"F":[618,[[260,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,551,720,567,718,578,711,585,700,587,684,587,565,585,549,578,538,567,531,551,529,296,529,296,425,470,425,486,423,497,416,504,405,506,389,506,269,504,253,497,242,486,235,470,233,296,233,296,36,294,20,287,9,276,2,260,0]]],"G":[708,[[619,0,304,0,245,3,194,12,152,28,118,50,92,78,73,114,62,155,58,204,58,516,62,565,73,606,92,642,118,670,152,692,194,708,245,717,304,720,554,720,570,718,581,711,588,700,590,684,590,563,588,547,581,536,570,529,554,527,346,527,319,524,300,514,289,499,285,477,285,238,288,217,296,201,311,192,331,189,428,189,428,345,430,361,437,372,448,379,464,381,619,381,635,379,646,372,653,361,655,345,655,36,653,20,646,9,635,2,619,0]]],"H":[759,[[260,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,260,720,276,718,287,711,294,700,296,684,296,467,463,467,463,684,465,700,472,711,483,718,499,720,654,720,670,718,681,711,688,700,690,684,690,36,688,20,681,9,670,2,654,0,499,0,483,2,472,9,465,20,463,36,463,258,296,258,296,36,294,20,287,9,276,2,260,0]]],"I":[605,[[89,0,73,2,62,9,55,20,53,36,53,155,55,171,62,182,73,189,89,191,188,191,188,527,89,527,73,529,62,536,55,547,53,563,53,684,55,700,62,711,73,718,89,720,515,720,531,718,542,711,549,700,551,684,551,563,549,547,542,536,531,529,515,527,418,527,418,191,515,191,531,189,542,182,549,171,551,155,551,36,549,20,542,9,531,2,515,0]]],"J":[688,[[624,189,622,159,618,132,610,106,600,82,585,60,565,41,541,25,512,10,477,-1,435,-9,387,-13,331,-15,276,-13,228,-9,187,-1,152,10,123,25,99,41,79,60,65,82,54,106,47,132,42,159,41,189,41,351,43,367,50,378,61,385,77,387,222,387,238,385,249,378,256,367,258,351,258,229,259,219,261,211,265,203,270,196,279,190,291,185,308,183,329,182,349,183,365,185,376,190,384,196,389,203,392,211,394,219,395,229,395,684,397,700,404,711,415,718,431,720,588,720,604,718,615,711,622,700,624,684]]],"K":[746,[[260,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,260,720,276,718,287,711,294,700,296,684,296,454,336,454,439,687,447,701,458,712,472,718,489,720,643,720,658,718,666,712,669,701,665,687,563,454,590,450,613,443,634,431,652,414,667,395,678,372,684,347,686,318,686,36,684,20,677,9,666,2,650,0,496,0,480,2,469,9,462,20,460,36,460,231,458,246,452,256,442,263,428,265,296,265,296,36,294,20,287,9,276,2,260,0]]],"L":[695,[[614,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,260,720,276,718,287,711,294,700,296,684,296,189,433,189,433,351,435,367,442,378,453,385,469,387,614,387,630,385,641,378,648,367,650,351,650,36,648,20,641,9,630,2,614,0]]],"M":[849,[[254,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,266,720,280,718,292,712,303,703,312,690,402,527,404,523,407,519,409,516,410,514,412,512,415,511,417,510,420,510,429,510,432,510,434,511,437,512,438,514,440,516,442,519,445,523,447,527,536,690,545,703,556,712,568,718,582,720,744,720,760,718,771,711,778,700,780,684,780,36,778,20,771,9,760,2,744,0,590,0,574,2,563,9,556,20,554,36,554,388,495,279,485,265,473,255,459,249,442,247,402,247,385,249,371,255,359,265,349,279,290,388,290,36,288,20,281,9,270,2,254,0]]],"N":[753,[[255,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,209,720,226,718,242,713,256,705,268,693,462,471,462,684,464,700,471,711,482,718,498,720,648,720,664,718,675,711,682,700,684,684,684,36,682,20,675,9,664,2,648,0,498,0,482,2,471,9,464,20,462,36,462,159,291,366,291,36,289,20,282,9,271,2,255,0]]],"O":[737,[[679,189,678,167,676,145,671,125,666,106,657,87,647,71,634,55,618,41,599,28,577,17,552,8,524,0,491,-7,455,-11,414,-14,369,-15,324,-14,283,-11,247,-7,214,0,186,8,161,17,139,28,120,41,104,55,91,71,80,87,72,106,66,125,62,145,59,167,58,189,58,530,59,552,62,574,66,594,72,614,80,632,91,648,104,664,120,678,139,691,161,702,186,712,214,720,247,727,283,731,324,734,369,735,414,734,455,731,491,727,524,720,552,712,577,702,599,691,618,678,634,664,647,648,657,632,666,614,671,594,676,574,678,552,679,530],[285,225,286,215,289,207,293,199,300,192,310,186,325,181,344,179,369,178,394,179,414,181,429,186,438,192,445,199,449,207,452,215,453,225,453,494,452,504,449,512,445,520,438,527,429,533,414,537,394,539,369,540,344,539,325,537,310,533,300,527,293,520,289,512,286,504,285,494]]],"P":[682,[[260,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,411,720,454,718,492,714,525,706,554,696,577,682,597,666,614,648,626,627,635,604,642,580,646,553,647,525,647,397,646,369,642,342,635,318,626,295,614,274,597,256,577,240,554,226,525,216,492,208,454,204,411,202,296,202,296,36,294,20,287,9,276,2,260,0],[294,533,294,382,384,382,397,383,408,386,416,390,422,397,426,405,429,413,430,422,431,431,431,484,430,494,429,503,426,511,422,518,416,525,408,529,397,532,384,533]]],"Q":[737,[[445,-90,291,-90,275,-88,264,-81,257,-70,255,-54,255,1,219,8,186,17,159,27,135,40,115,54,98,70,85,88,75,108,68,128,62,150,59,174,58,198,58,530,59,552,62,574,66,594,72,614,80,632,91,648,104,664,120,678,139,691,161,702,186,712,214,720,247,727,283,731,324,734,369,735,414,734,455,731,491,727,524,720,552,712,577,702,599,691,618,678,634,664,647,648,657,632,666,614,671,594,676,574,678,552,679,530,679,198,678,174,675,150,669,128,662,108,652,88,639,70,622,54,602,40,579,27,551,16,518,8,481,1,481,-54,479,-70,472,-81,461,-88,445,-90],[285,220,286,210,289,202,293,194,300,186,310,181,325,176,344,174,369,173,394,174,414,176,429,181,438,186,445,194,449,202,452,210,453,220,453,493,452,503,449,511,445,519,438,526,429,532,414,536,394,538,369,539,344,538,325,536,310,532,300,526,293,519,289,511,286,503,285,493]]],"R":[743,[[259,0,105,0,89,2,78,9,71,20,69,36,69,684,71,700,78,711,89,718,105,720,438,720,474,719,505,715,532,708,556,699,576,687,593,674,606,658,617,640,625,621,630,600,634,577,635,553,635,507,634,487,632,468,628,451,623,436,616,422,606,411,594,401,579,393,605,388,628,379,649,366,667,349,681,328,692,305,698,278,700,248,700,36,698,20,691,9,680,2,664,0,509,0,493,2,482,9,475,20,473,36,473,189,472,200,471,209,468,216,464,222,459,226,453,230,445,231,435,232,295,232,295,36,293,20,286,9,275,2,259,0],[295,540,295,412,370,412,382,413,392,415,399,420,405,426,409,433,412,441,413,449,414,459,414,493,413,503,412,511,409,519,405,526,399,532,392,537,382,539,370,540]]],"S":[650,[[403,0,87,0,71,2,60,9,53,20,51,36,51,153,53,169,60,180,71,187,87,189,356,189,362,190,367,191,372,194,376,198,378,202,380,207,382,212,382,218,382,226,380,233,378,238,376,243,372,247,367,249,362,251,356,252,206,273,173,280,143,290,116,303,94,320,75,340,62,367,54,400,51,439,51,544,54,584,65,620,82,650,106,675,136,695,172,709,212,717,258,720,538,720,554,718,565,711,572,700,574,684,574,565,572,549,565,538,554,531,538,529,305,529,293,527,285,522,280,512,278,499,280,486,285,476,293,470,305,467,454,447,477,443,498,437,518,431,536,422,553,413,567,401,580,387,590,371,599,353,605,332,609,308,610,281,610,176,607,136,596,101,579,71,555,46,525,26,490,11,449,3,403,0]]],"T":[656,[[409,0,247,0,231,2,220,9,213,20,211,36,211,527,64,527,48,529,37,536,30,547,28,563,28,684,30,700,37,711,48,718,64,720,592,720,608,718,619,711,626,700,628,684,628,563,626,547,619,536,608,529,592,527,445,527,445,36,443,20,436,9,425,2,409,0]]],"U":[746,[[682,189,681,167,679,145,674,125,668,106,660,87,650,71,636,55,620,41,602,28,580,17,554,8,526,0,494,-7,458,-11,417,-14,373,-15,329,-14,288,-11,252,-7,220,0,192,8,166,17,144,28,126,41,110,55,96,71,86,87,78,106,72,125,67,145,65,167,64,189,64,684,66,700,73,711,84,718,100,720,257,720,273,718,284,711,291,700,293,684,293,228,294,218,297,210,301,202,308,194,318,189,332,184,351,182,375,181,399,182,418,184,433,189,443,194,450,202,454,210,457,218,458,228,458,684,460,700,467,711,478,718,494,720,646,720,662,718,673,711,680,700,682,684]]],"V":[730,[[495,0,235,0,226,0,218,2,210,4,204,7,198,11,193,17,188,24,184,33,86,278,80,292,75,306,71,317,67,328,64,338,61,348,59,358,57,368,56,379,55,392,54,405,54,420,54,684,56,700,63,711,74,718,90,720,249,720,266,718,278,711,286,700,288,684,288,408,288,403,288,398,289,393,290,388,291,383,292,378,294,372,296,367,343,227,346,220,350,214,356,211,362,210,373,210,379,211,385,214,389,220,392,227,439,368,441,373,442,379,444,384,445,389,446,394,446,399,447,404,447,409,447,684,449,700,456,711,467,718,483,720,640,720,656,718,667,711,674,700,676,684,676,420,676,405,675,392,674,379,673,368,671,358,669,348,666,338,663,328,659,317,655,306,650,292,644,278,546,33,542,24,538,17,533,11,527,7,520,4,513,2,504,0,495,0]]],"W":[831,[[586,720,735,720,751,718,762,711,769,700,771,684,771,296,771,280,770,265,770,251,769,236,767,222,764,207,759,190,753,172,703,36,700,29,697,22,693,16,688,10,683,6,677,3,671,1,663,0,530,0,522,0,515,2,508,4,502,7,496,11,491,16,487,23,484,30,438,193,435,200,431,206,426,209,420,210,411,210,405,209,400,206,396,200,393,193,346,30,340,17,331,8,319,2,304,0,172,0,164,1,157,2,151,6,144,10,139,15,135,22,131,28,128,36,78,174,72,192,68,209,64,224,62,238,61,253,61,267,60,282,60,298,60,684,62,700,69,711,80,718,96,720,250,720,266,718,277,711,284,700,286,684,286,316,344,442,348,450,353,456,359,462,365,466,372,469,380,471,388,473,397,473,439,473,449,473,457,471,465,469,472,466,477,462,483,456,488,450,492,442,550,316,550,684,552,700,559,711,570,718,586,720]]],"X":[737,[[284,36,282,20,275,9,264,2,248,0,96,0,80,2,69,9,62,20,60,36,60,143,60,158,61,171,62,183,64,194,66,203,68,212,71,221,75,230,79,238,85,247,91,256,98,266,179,375,98,484,91,494,85,504,79,513,74,521,71,529,67,538,65,547,63,556,62,567,61,579,60,592,60,607,60,684,62,700,69,711,80,718,96,720,250,720,266,718,277,711,284,700,286,684,286,615,286,610,286,605,287,599,287,594,288,589,290,583,292,578,295,573,339,510,342,506,344,503,347,500,350,498,352,496,356,494,359,493,363,493,375,493,379,493,382,494,385,496,388,498,391,500,393,503,396,506,399,510,444,573,447,578,450,583,451,589,452,594,452,599,453,605,453,610,453,615,453,684,455,700,462,711,473,718,489,720,641,720,657,718,668,711,675,700,677,684,677,607,677,592,676,579,675,567,674,556,672,547,670,538,666,529,662,521,658,513,652,504,646,494,639,484,558,374,639,266,646,256,653,247,658,238,663,230,667,221,670,212,672,203,674,194,675,183,676,171,677,158,677,143,677,36,675,20,668,9,657,2,641,0,489,0,473,2,462,9,455,20,453,36,453,135,453,136,453,136,453,138,453,139,453,144,453,148,452,153,452,158,451,162,450,167,447,172,444,177,400,240,397,244,394,248,392,251,389,253,386,255,383,256,380,257,376,257,362,257,358,257,355,256,352,255,349,253,346,251,344,248,341,244,338,240,293,177,290,172,288,167,286,162,285,158,285,153,284,148,284,144,284,139,284,138,284,136,284,136,284,135]]],"Y":[705,[[434,0,272,0,256,2,245,9,238,20,236,36,236,164,83,369,76,379,70,389,64,398,60,406,56,414,52,423,50,432,48,442,47,452,46,464,45,477,45,492,45,684,47,700,54,711,65,718,81,720,235,720,251,718,262,711,269,700,271,684,271,520,271,515,271,510,272,505,272,500,273,494,274,489,277,483,280,478,326,406,331,399,337,393,343,390,350,389,360,389,367,390,373,393,379,399,384,406,430,478,433,483,436,489,437,494,438,500,438,505,439,510,439,515,439,520,439,684,441,700,448,711,459,718,475,720,624,720,640,718,651,711,658,700,660,684,660,492,660,477,659,464,658,452,657,442,655,432,653,423,649,414,646,406,641,398,635,389,629,379,622,369,470,163,470,36,468,20,461,9,450,2,434,0]]],"Z":[660,[[578,0,82,0,66,2,55,9,48,20,46,36,46,170,48,187,52,204,60,218,71,232,314,527,100,527,84,529,73,536,66,547,64,563,64,684,66,700,73,711,84,718,100,720,560,720,576,718,587,711,594,700,596,684,596,535,594,517,590,501,582,486,571,472,339,191,578,191,594,189,605,182,612,171,614,155,614,36,612,20,605,9,594,2,578,0]]],"0":[727,[[669,189,668,167,666,145,661,125,656,106,648,87,637,71,624,55,608,41,590,28,568,17,544,8,516,0,484,-7,448,-11,408,-14,364,-15,320,-14,280,-11,244,-7,212,0,184,8,159,17,137,28,118,41,103,55,90,71,80,87,72,106,66,125,61,145,59,167,58,189,58,530,59,552,61,574,66,594,72,614,80,632,90,648,103,664,118,678,137,691,159,702,184,712,212,720,244,727,280,731,320,734,364,735,408,734,448,731,484,727,516,720,544,712,568,702,590,691,608,678,624,664,637,648,648,632,656,614,661,594,666,574,668,552,669,530],[284,225,285,215,288,207,292,199,298,192,308,186,322,181,341,179,364,178,388,179,406,181,421,186,430,192,436,199,440,207,443,215,444,225,444,494,443,504,440,512,436,520,430,527,421,533,406,537,388,539,364,540,341,539,322,537,308,533,298,527,292,520,288,512,285,504,284,494]]],"1":[601,[[526,0,84,0,68,2,57,9,50,20,48,36,48,157,50,173,57,184,68,191,84,193,196,193,196,527,104,527,88,529,77,536,70,547,68,563,68,684,70,700,77,711,88,718,104,720,394,720,410,718,421,711,428,700,430,684,430,193,526,193,542,191,553,184,560,173,562,157,562,36,560,20,553,9,542,2,526,0]]],"2":[639,[[552,0,76,0,60,2,49,9,42,20,40,36,40,208,41,245,45,277,51,305,60,328,71,348,84,365,99,379,116,392,134,402,154,411,175,420,197,427,331,469,338,472,344,475,349,478,352,482,355,486,357,491,358,498,358,505,358,512,356,518,355,522,352,526,348,528,344,530,338,531,331,531,114,531,98,533,87,540,80,551,78,567,78,684,80,700,87,711,98,718,114,720,409,720,449,717,485,709,515,696,540,678,560,654,574,625,582,592,585,554,585,460,582,424,575,393,562,367,544,345,521,326,494,310,464,296,429,283,293,240,286,238,280,236,276,234,272,232,270,228,268,224,267,218,267,210,267,189,552,189,568,187,579,180,586,169,588,153,588,36,586,20,579,9,568,2,552,0]]],"3":[637,[[85,189,336,189,347,190,356,191,362,194,367,198,370,203,372,208,374,213,374,219,374,246,374,252,372,257,370,262,367,266,362,270,356,273,347,274,336,275,166,275,150,277,139,284,132,295,130,311,130,418,132,434,139,445,150,452,166,454,271,454,282,455,291,456,297,459,302,463,305,468,307,473,309,478,309,484,309,499,309,505,307,510,305,515,302,520,297,524,291,527,282,528,271,529,85,529,69,531,58,538,51,549,49,565,49,684,51,700,58,711,69,718,85,720,364,720,403,718,436,710,465,698,488,682,505,661,518,636,525,608,528,577,528,519,527,501,525,484,521,468,515,453,507,440,497,428,484,419,469,411,502,405,529,396,551,384,568,368,580,348,588,324,593,297,595,266,595,166,592,130,583,97,567,69,546,44,519,25,485,11,446,3,401,0,85,0,69,2,58,9,51,20,49,36,49,153,51,169,58,180,69,187,85,189]]],"4":[709,[[414,167,245,167,200,170,162,177,130,190,106,208,87,231,74,259,66,293,63,333,63,684,65,700,72,711,83,718,99,720,254,720,270,718,281,711,288,700,290,684,290,410,292,395,298,384,307,378,321,376,414,376,414,684,416,700,423,711,434,718,450,720,604,720,620,718,631,711,638,700,640,684,640,36,638,20,631,9,620,2,604,0,450,0,434,2,423,9,416,20,414,36]]],"5":[647,[[409,0,91,0,75,2,64,9,57,20,55,36,55,153,57,169,64,180,75,187,91,189,349,189,361,190,369,195,374,202,376,212,376,251,374,261,369,268,361,273,349,274,101,274,85,276,74,283,67,294,65,310,65,684,67,700,74,711,85,718,101,720,532,720,548,718,559,711,566,700,568,684,568,565,566,549,559,538,548,531,532,529,292,529,292,464,429,464,467,462,502,454,531,442,557,424,578,402,592,375,601,342,604,305,604,166,601,130,591,98,574,69,552,45,523,25,490,11,452,3,409,0]]],"6":[693,[[284,448,311,455,341,459,374,462,411,463,454,462,492,458,525,452,553,443,577,432,596,418,613,402,625,383,634,362,641,338,645,312,646,283,646,187,644,157,640,130,632,104,622,80,608,59,588,40,564,24,536,10,501,-1,460,-9,412,-13,358,-15,314,-14,274,-11,239,-7,207,0,179,8,155,17,133,28,116,40,100,54,88,70,78,86,70,104,65,123,61,143,59,165,58,187,58,515,59,545,64,572,70,598,80,622,93,644,110,663,131,680,156,694,186,705,220,714,260,718,304,720,534,720,550,718,561,711,568,700,570,684,570,566,568,550,561,539,550,532,534,530,347,530,330,529,316,527,305,524,297,518,291,511,287,501,285,487,284,470],[284,262,284,203,285,195,287,188,291,182,296,176,304,172,316,169,331,167,351,166,371,167,388,169,400,172,408,176,413,182,417,188,419,195,420,203,420,262,419,269,417,276,413,282,408,288,400,292,388,295,371,297,351,298,331,297,316,295,304,292,296,288,291,282,287,276,285,269,284,262]]],"7":[627,[[539,720,555,718,566,711,573,700,575,684,575,431,574,401,571,374,566,351,558,330,549,312,538,296,524,282,508,270,489,260,468,250,445,241,419,233,345,211,345,36,343,20,336,9,325,2,309,0,147,0,131,2,120,9,113,20,111,36,111,217,112,247,115,274,120,298,128,318,137,336,149,352,163,366,179,378,198,388,218,398,242,407,267,415,348,437,348,527,74,527,58,529,47,536,40,547,38,563,38,684,40,700,47,711,58,718,74,720]]],"8":[711,[[664,256,664,159,662,134,657,110,649,88,637,68,621,50,600,33,574,19,544,7,507,-3,463,-10,413,-14,356,-15,299,-14,249,-10,206,-3,168,7,137,19,111,33,90,50,74,68,62,88,54,110,49,134,47,159,47,256,49,289,55,319,64,344,78,364,94,381,112,395,131,405,153,411,138,419,125,428,115,440,107,453,101,468,97,484,95,501,94,519,94,577,96,601,100,623,108,643,118,662,132,678,150,693,173,705,200,716,231,724,268,730,310,734,357,735,405,734,447,730,483,724,514,716,541,705,563,693,580,678,594,662,604,643,611,623,616,601,617,577,617,519,616,501,614,484,610,468,604,453,596,440,586,428,573,419,558,411,580,405,599,395,617,381,634,364,647,344,656,319,662,289,664,256],[268,197,269,189,272,182,278,176,285,170,296,166,311,163,331,161,356,160,381,161,401,163,417,166,427,170,434,176,439,182,442,189,443,197,443,250,442,257,439,264,434,270,427,276,417,280,401,283,381,285,356,286,331,285,311,283,296,280,285,276,278,270,272,264,269,257,268,250],[293,480,294,472,296,465,299,459,304,454,311,449,322,446,337,444,356,443,375,444,391,446,402,449,408,454,413,459,416,465,417,472,418,480,418,524,417,531,416,538,413,544,408,550,402,554,391,557,375,559,356,560,337,559,322,557,311,554,304,550,299,544,296,538,294,531,293,524]]],"9":[693,[[409,272,382,265,352,261,319,258,282,257,239,258,202,262,169,268,140,277,117,288,97,302,80,319,68,338,59,359,52,383,48,409,47,437,47,533,48,563,53,590,60,616,71,640,85,661,105,680,129,696,158,710,192,721,233,729,281,733,335,735,379,734,419,731,454,727,486,720,514,712,538,703,560,692,578,680,592,666,605,650,615,634,622,616,628,597,632,577,634,555,635,533,635,205,634,175,630,148,623,122,613,98,600,76,583,57,562,40,538,26,508,15,474,6,434,2,389,0,159,0,143,2,132,9,125,20,123,36,123,154,125,170,132,181,143,188,159,190,346,190,363,191,377,193,388,196,396,202,402,209,406,219,408,233,409,250],[409,458,409,517,408,525,406,532,403,538,398,544,390,548,378,551,362,553,342,554,322,553,305,551,293,548,285,544,280,538,276,532,274,525,273,517,273,458,274,451,276,444,280,438,285,432,293,428,305,425,322,423,342,422,362,423,378,425,390,428,398,432,403,438,406,444,408,451,409,458]]],"'":[356,[[250,345,106,345,94,345,85,347,77,349,72,352,69,357,67,365,65,374,64,386,56,679,56,691,57,700,59,708,62,712,67,716,75,718,84,720,96,720,261,720,273,720,282,718,289,716,294,712,297,708,299,700,300,691,300,679,292,386,291,374,289,365,287,357,284,352,279,349,271,347,262,345,250,345]]],"&":[766,[[296,187,438,187,448,188,456,190,463,193,468,197,472,203,474,210,476,218,476,227,476,365,478,381,485,392,496,399,512,401,706,401,722,399,733,392,740,381,742,365,742,257,740,241,733,230,722,223,706,221,683,221,683,176,680,138,672,104,657,74,637,48,611,27,581,12,545,3,504,0,226,0,183,3,145,12,112,27,86,48,64,74,49,104,40,138,37,176,37,256,39,290,46,319,57,345,73,366,92,384,114,397,137,406,163,411,148,419,135,428,125,440,117,453,111,468,107,484,105,501,104,519,104,567,107,599,115,627,129,653,149,676,175,696,208,709,249,717,296,720,507,720,523,718,534,711,541,700,543,684,543,569,541,553,534,542,523,535,507,533,361,533,350,532,341,531,335,528,330,524,327,519,325,514,323,509,323,503,323,482,323,476,325,471,327,466,330,461,335,457,341,454,350,453,361,452,376,452,392,450,403,443,410,432,412,416,412,313,410,297,403,286,392,279,376,277,296,277,285,276,276,275,270,272,265,268,262,264,260,259,258,254,258,248,258,217,258,211,260,206,262,201,265,196,270,192,276,189,285,188,296,187]]],"!":[424,[[289,262,134,262,118,264,107,271,100,282,97,298,82,684,84,700,90,711,101,718,116,720,307,720,322,718,333,711,339,700,341,684,327,298,324,282,317,271,305,264,289,262],[304,0,120,0,104,2,93,9,86,20,84,36,84,167,86,183,93,194,104,201,120,203,304,203,320,201,331,194,338,183,340,167,340,36,338,20,331,9,320,2,304,0]]],"-":[420,[[76,257,60,259,49,266,42,277,40,293,40,427,42,443,49,454,60,461,76,463,344,463,360,461,371,454,378,443,380,427,380,293,378,277,371,266,360,259,344,257]]],".":[384,[[293,0,91,0,75,2,64,9,57,20,55,36,55,239,57,255,64,266,75,273,91,275,293,275,309,273,320,266,327,255,329,239,329,36,327,20,320,9,309,2,293,0]]]," ":[225,[]]};
  // Gold title: black drop shadow, dark brown outline, vertical gold gradient. box [y, h, x, w] (x, w default 20, 600; a fifth item is the text, see scene): the text is scaled to fit the box, centred, lines split at \n.
  function drawTitle(out, W, H, text, box) {
    const [by, bh, bx = 20, bw = 600] = box, lines = text.split('\n'), CAP = 720, GAP = 130;
    const adv = l => { let a = 0; for (const c of l) a += (BUNGEE[c] || BUNGEE[' '])[0]; return a; };
    const s = Math.min(bh / (lines.length * CAP + (lines.length - 1) * GAP), bw / Math.max(...lines.map(adv)) * .94);
    const blockH = (lines.length * CAP + (lines.length - 1) * GAP) * s, top = by + (bh - blockH) / 2;
    const m = new Float32Array(W * H), SS = 3;
    lines.forEach((l, li) => {
      const x0 = bx + (bw - adv(l) * s) / 2, base = top + (li * (CAP + GAP) + CAP) * s;          // baseline y
      const edges = []; let px = x0;
      for (const c of l) { const [a, cons] = BUNGEE[c] || BUNGEE[' ']; for (const q of cons) for (let i = 0; i < q.length; i += 2) { const j = (i + 2) % q.length, ax = px + q[i] * s, ay = base - q[i + 1] * s, bx2 = px + q[j] * s, by2 = base - q[j + 1] * s; if (ay !== by2) edges.push(ay < by2 ? [ax, ay, bx2, by2, 1] : [bx2, by2, ax, ay, -1]); } px += a * s; }
      for (let sy = Math.max(0, Math.floor((base - CAP * s) * SS) - SS); sy < Math.min(H * SS, Math.ceil((base + 1) * SS) + SS); sy++) {
        const y = (sy + .5) / SS, xs = [];
        for (const [ax, ay, bx2, by2, d] of edges) if (y >= ay && y < by2) xs.push([ax + (bx2 - ax) * (y - ay) / (by2 - ay), d]);
        xs.sort((p, q) => p[0] - q[0]); let wnd = 0; const row = (sy / SS) | 0;
        for (let i = 0; i < xs.length - 1; i++) { wnd += xs[i][1]; if (!wnd) continue;
          const xa = Math.max(0, xs[i][0]), xb = Math.min(W, xs[i + 1][0]);
          for (let x = Math.floor(xa); x < xb; x++) m[row * W + x] += (Math.min(x + 1, xb) - Math.max(x, xa)) / SS; }
      }
    });
    const R = Math.max(2, Math.round(s * 1000 * .05)), dil = new Float32Array(W * H), sh = Math.max(2, Math.round(R * .8));
    const offs = []; for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R) offs.push([dx, dy]);
    const y0 = Math.max(0, Math.floor(top - R - 2)), y1 = Math.min(H, Math.ceil(top + blockH + R + 2));
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { let v = 0; for (const [dx, dy] of offs) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < W && yy >= 0 && yy < H && m[yy * W + xx] > v) v = m[yy * W + xx]; } dil[y * W + x] = Math.min(1, v * 1.5); }
    const lerp = (a, b, t) => a + (b - a) * t, grad = t => t < .4 ? [lerp(255, 255, t / .4), lerp(250, 214, t / .4), lerp(190, 40, t / .4)] : t < .62 ? [255, lerp(214, 160, (t - .4) / .22), lerp(40, 0, (t - .4) / .22)] : [lerp(255, 168, (t - .62) / .38), lerp(160, 84, (t - .62) / .38), 0];
    const over = (x, y, r, g, b, a) => { if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return; const d = (y * W + x) * 4; out[d] += (r - out[d]) * a; out[d + 1] += (g - out[d + 1]) * a; out[d + 2] += (b - out[d + 2]) * a; };
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) over(x, y, 0, 0, 0, (dil[Math.max(0, y - sh) * W + Math.max(0, x - sh)]) * .6);
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) over(x, y, 50, 18, 0, dil[y * W + x]);
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { const c = m[y * W + x]; if (c > 0) { const [r, g, b] = grad(Math.min(1, Math.max(0, (y - top) / blockH))); over(x, y, r, g, b, Math.min(1, c)); } }
  }
  async function scene(vm, recs, load, want) {
    const byName = new Map(); for (const r of recs) if (!byName.has(r.name)) byName.set(r.name, r);
    const get = async n => { const r = byName.get(n); return r ? load(r) : null; };
    const W = 640, H = 300;
    // bilinear scale of src (alpha-weighted) into out at (x0, y0) size (w, h), src-over; sx0, sy0, sw, sh: the source window
    const blit = (out, src, x0, y0, w, h, sx0 = 0, sy0 = 0, sw = src.w, sh = src.h) => {
      for (let y = 0; y < h; y++) { const dy = y0 + y; if (dy < 0 || dy >= H) continue;
        const fy = Math.min(sy0 + sh - 1, Math.max(sy0, sy0 + (y + .5) * sh / h - .5)), iy = fy | 0, ty = fy - iy, iy2 = Math.min(sy0 + sh - 1, iy + 1);
        for (let x = 0; x < w; x++) { const dx = x0 + x; if (dx < 0 || dx >= W) continue;
          const fx = Math.min(sx0 + sw - 1, Math.max(sx0, sx0 + (x + .5) * sw / w - .5)), ix = fx | 0, tx = fx - ix, ix2 = Math.min(sx0 + sw - 1, ix + 1);
          let a = 0, r = 0, g = 0, b = 0;
          for (const [px, py, wt] of [[ix, iy, (1 - tx) * (1 - ty)], [ix2, iy, tx * (1 - ty)], [ix, iy2, (1 - tx) * ty], [ix2, iy2, tx * ty]]) {
            const o = (py * src.w + px) * 4, al = src.rgba[o + 3] * wt; a += al; r += src.rgba[o] * al; g += src.rgba[o + 1] * al; b += src.rgba[o + 2] * al; }
          if (a <= 0) continue; r /= a; g /= a; b /= a; const d = (dy * W + dx) * 4, k = a / 255;
          out[d] += (r - out[d]) * k; out[d + 1] += (g - out[d + 1]) * k; out[d + 2] += (b - out[d + 2]) * k; out[d + 3] = 255; } }
    };
    for (const g of GAMES) {
      if (!g.need.every(n => byName.has(n))) continue;
      const sc = g.v[want || g.on]; if (!sc) continue;
      const bgn = Array.isArray(sc.bg) ? sc.bg[1] : sc.bg, names = sc.crop ? [sc.crop[0]] : [bgn, ...sc.art.map(a => a[0])];
      if (!names.every(n => byName.has(n))) continue;
      const imgs = []; for (const n of names) imgs.push(await get(n));
      if (imgs.some(im => !im)) continue;
      if (sc.crop) { const [, cx, cy, cw, ch] = sc.crop, im = imgs[0]; if (im.w < cx + cw || im.h < cy + ch) continue;
        const o2 = new Uint8ClampedArray(cw * ch * 4);
        for (let y = 0; y < ch; y++) o2.set(im.rgba.subarray(((cy + y) * im.w + cx) * 4, ((cy + y) * im.w + cx + cw) * 4), y * cw * 4);
        return { w: cw, h: ch, rgba: o2 }; }
      const out = new Uint8ClampedArray(W * H * 4), bg = imgs[0];
      if (Array.isArray(sc.bg) && sc.bg[0] === 'fit') blit(out, bg, 0, 0, W, H);   // the whole image stretched to the card (a frame keeps all four borders)
      else if (Array.isArray(sc.bg) && sc.bg[0] === 'win') blit(out, bg, 0, 0, W, H, ...sc.bg.slice(2));   // just that window [sx, sy, sw, sh], stretched to the card
      else if (Array.isArray(sc.bg)) { for (let y = 0; y < H; y += bg.h) for (let x = 0; x < W; x += bg.w) blit(out, bg, x, y, bg.w, bg.h); }
      else { const s = Math.max(W / bg.w, H / bg.h), bw = Math.ceil(bg.w * s), bh = Math.ceil(bg.h * s);   // cover, top and centre aligned
        blit(out, bg, (W - bw) >> 1, 0, bw, bh); }
      for (let i = 0; i < sc.art.length; i++) { const im = imgs[i + 1], [, x, y, w, h, opt] = sc.art[i], win = Array.isArray(opt) ? opt : [0, 0, im.w, im.h], k = Math.min(w / win[2], h / win[3]);
        if (opt === 's') blit(out, im, x, y, w, h);
        else { const dw = Math.round(win[2] * k), dh = Math.round(win[3] * k); blit(out, im, x + ((w - dw) >> 1), y + ((h - dh) >> 1), dw, dh, ...win); } }
      for (let i = 3; i < out.length; i += 4) out[i] = 255;
      if (sc.text) drawTitle(out, W, H, sc.text[4] || g.title, sc.text);
      return { w: W, h: H, rgba: out };
    }
    return null;
  }
  const api = { compose, marquee };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6RENDER = api;
})(typeof window !== 'undefined' ? window : globalThis);
