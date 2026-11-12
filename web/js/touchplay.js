// Touch-screen multi-game ROMs in play.html (Cashman Tonight, Players Choice By Demand / Favourites): the ROM runs the whole game, MK6TOUCHHOST plays
// the host OS (touch forwarding, spin messages, credit meter). This page part draws the display, sends pointer taps to the ROM's touch boxes and offers
// the panel buttons the host OS draws itself (lines, bet, Play, Take Win) and a note slot. Only used when the game's map has "touch": true.
(function (root) {
  'use strict';
  const PLAY = 0x1e, TAKE_WIN = 0x3e9, GAME_MENU = 0x20, LINES = [0x21, 0x22, 0x23, 0x24, 0x25], BETS = [0x26, 0x27, 0x28, 0x29], TURNOVER = 0x14;
  const SKIP = new Set([PLAY, TAKE_WIN, GAME_MENU, 0x3f1, 0x3f0, 0xc, 0x3fb, 0x2a, 0x3f9, ...LINES, ...BETS]);
  const FRAME_MS = 33.07 / 2, NOTE = 10000, LIMIT = 989000, START = 100000;
  const api = { start };
  async function start(o) {
    const { vm, map, id, $, store } = o, speed0 = Math.min(16, +new URLSearchParams(location.search).get('speed') || 1), TH = root.MK6TOUCHHOST.TouchHost;
    const host = new TH(vm, { map, game: +(map.game || 0), menu: true, credits: store.get('wallet') ?? START });   // the wallet every game shares (play.html), in cents as this host's credit meter
    vm.meters.set(0, host.credits);
    host.init(); host.credits = vm.meters.get(0) | 0; host.machineEvent();
    window.host = host; window.vm = vm;
    // layout: the marquee shows the meters, the stage the game screen, a strip under it the buttons the host OS draws itself
    $('notes').innerHTML = 'Touch the game screen to choose a game and its denomination, then use <kbd>Space</kbd> / PLAY. <kbd>Enter</kbd> inserts a note.';
    // no banner, LCD meters or Games button above the stage: the page's own Menu button (Games, sound, display, help...) sits at the top right of the top screen
    $('marquee').style.display = 'none';
    const wb = $('wmenubtn'); if (wb) { const st = $('stage'); st.appendChild(wb); Object.assign(wb.style, { position: 'absolute', top: '6px', right: '6px', margin: '0', zIndex: '30', background: '#000a' });
      for (const ev of ['pointerdown', 'pointerup', 'click', 'touchstart']) wb.addEventListener(ev, e => e.stopPropagation()); }
    // two screens: the game's coordinate space is 640 x 960, the top screen (jackpots, paytable) at y -480..0 and the touch screen at 0..480; they are shown stacked, top above
    const cv = $('screen'); cv.width = 640; cv.height = 960; $('stage').style.aspectRatio = '640/960';
    // the control panel is the cabinet games' own (#cab in play.html): same markup, CSS, key sizes and breakpoints; no touch-only CSS
    $('cab').classList.add('tc');
    const mk = (el, fn) => { el.onclick = e => { fn(); e.currentTarget.blur(); }; return el; };
    const keyBtn = (cls, html, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'cb ' + cls; b.innerHTML = html; b.setAttribute('aria-label', label); b.disabled = true; return b; };
    const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let c0 = 0, t0 = 0, lastWin = 0, lastBet = 0, playing = false;
    const credit = () => vm.meters.get(0) | 0;
    const note = () => { if (credit() + NOTE > LIMIT) return; vm.meters.set(0, credit() + NOTE); host.machineEvent(); const n = $('add'); n.classList.remove('feed'); void n.offsetWidth; n.classList.add('feed'); setTimeout(() => n.classList.remove('feed'), 1000); };
    const featureOn = () => host.enabledCodes().some(c => c >= 0xfa1 && c < 0x2000);
    const press = code => { if (!host.enabledCodes().includes(code)) return false; if (code === PLAY && featureOn()) host.key(code);   // a bonus waits for Play as a key press (a touch is ignored)
      else if (code === PLAY) { c0 = credit(); t0 = vm.meters.get(TURNOVER) | 0; playing = true; host.send(code); } else host.send(code); return true; };
    // 0x3fb is listed while a game runs. PLAY starts a game only when none runs: `playing` alone is not enough, a PLAY the ROM refused (no credit) never ends a game, so
    // `playing` would stay on and every later PLAY would go out as a key press, which starts nothing
    const running = () => host.enabledCodes().includes(0x3fb);
    let walletStale = false, walletSeen = null; addEventListener('storage', e => { if (e.key === 'emu-wallet') walletStale = true; });   // another tab changed the wallet: taken over between games
    const playKey = () => { if (host.enabledCodes().includes(PLAY) && !running()) press(PLAY); else host.key(host.enabledCodes().includes(TAKE_WIN) ? TAKE_WIN : PLAY); };
    // the cabinet panel: note acceptor, Game Menu in the GAMBLE key's place, AUTO, SPIN as Play / Take Win, line keys in the PLAY row, bet keys in the BET row
    const addB = $('add'), menuB = document.createElement('button'), autoBtn = $('auto'), spinB = $('spin'), fk = $('fk');
    mk(addB, note); $('notev').textContent = '$' + NOTE / 100; mk(spinB, playKey); menuB.type = 'button'; menuB.className = 'cb fkey'; menuB.textContent = 'GAME MENU'; $('gamble').classList.add('nogamble'); $('gamble').hidden = false;   // GAME MENU takes the FEATURE key's place; the empty GAMBLE spot keeps the grid
     menuB.title = 'Back to the game menu'; menuB.disabled = true; mk(menuB, () => press(GAME_MENU));
    spinB.textContent = 'PLAY'; spinB.title = 'Space'; addB.title = 'Insert note: Enter';
    // the keys' meaning on the four games (stake of a game on each key): lines 1 5 10 20 and 20 + the feature bet (30 credits), bets 1 2 5 10 credits a line; a game starts on 1 line, bet 1
    const LINE_LBL = ['1', '5', '10', '20', '20+'], BET_LBL = ['1', '2', '5', '10']; let lineSel = 0, betSel = 0;
    // a key's number is what the game prints on its own on-screen button: the label (_createstring) lying in the button's touch box; Cashman Tonight's 20+ is art, so it keeps its default
    const setLine = (b, t, i) => { if (b.dataset.t === t) return; b.dataset.t = t; b.innerHTML = `PLAY<big>${t}</big><small>${t === '1' ? 'LINE' : 'LINES'}</small>`; b.setAttribute('aria-label', 'Lines ' + (i + 1) + ': ' + t); };
    const setBet = (b, t, i) => { if (b.dataset.t === t) return; b.dataset.t = t; b.innerHTML = `BET<big>${t}</big><small>${t === '1' ? 'CREDIT' : 'CREDITS'}<span class="pl"> PER LINE</span></small>`; b.setAttribute('aria-label', 'Bet ' + (i + 1) + ': ' + t + ' per line'); };
    const lineB = LINES.map((c, i) => { const b = mk(keyBtn('play', '', ''), () => { if (press(c)) { lineSel = i; lamps(); } }); setLine(b, LINE_LBL[i], i); return b; });
    const betB = BETS.map((c, i) => { const b = mk(keyBtn('bet', '', ''), () => { if (press(c)) { betSel = i; lamps(); } }); setBet(b, BET_LBL[i], i); return b; });
    const labelOf = (boxes, code) => { const b = boxes.find(b => b.code === code); if (!b) return null; const it = vm.display.items.find(i => i && i.visible && i.text && i.x >= b.x && i.x < b.x + b.w && i.y >= b.y && i.y < b.y + b.h); return { text: it ? it.text : '' }; };
    const relabel = () => {   // the game screen's own buttons: as many keys as it has, numbered as it prints them
      const bx = vm.touchBoxes(), ls = LINES.map(c => labelOf(bx, c)), bs = BETS.map(c => labelOf(bx, c)), inGame = ls.some(Boolean) || bs.some(Boolean);
      lineB.forEach((b, i) => { b.style.visibility = !inGame || ls[i] ? '' : 'hidden'; if (inGame && ls[i] && /^\d+$/.test(ls[i].text)) setLine(b, ls[i].text, i); else if (!inGame || ls[i]) setLine(b, LINE_LBL[i], i); });
      betB.forEach((b, i) => { b.style.visibility = !inGame || bs[i] ? '' : 'hidden'; if (inGame && bs[i] && /^\d+$/.test(bs[i].text)) setBet(b, bs[i].text, i); else if (!inGame || bs[i]) setBet(b, BET_LBL[i], i); });
    };
    const lamps = () => { lineB.forEach((b, i) => b.classList.toggle('on', i === lineSel)); betB.forEach((b, i) => b.classList.toggle('on', i === betSel)); }; lamps();
    lineB.forEach(b => $('playrow').appendChild(b)); betB.forEach(b => $('betrow').appendChild(b));
    for (let n = BETS.length; n < LINES.length; n++) { const ph = keyBtn('bet', '', ''); ph.style.visibility = 'hidden'; ph.setAttribute('aria-hidden', 'true'); ph.tabIndex = -1; $('betrow').appendChild(ph); }   // fewer bet keys than line keys: an empty slot keeps every key the cabinet's size
    // AUTO: presses Play when the game is idle (a note when the credit is low) and answers what a started game waits for, as the scanner does (TouchHost.prompt)
    host.hold = host.quiet = 0; let auto = false, af = 0, since = 0, tog = 0; autoBtn.title = 'Autoplay'; mk(autoBtn, () => { auto = !auto; autoBtn.classList.toggle('lit', auto); autoBtn.setAttribute('aria-pressed', auto); af = since = 0; if (o.keepAwake) o.keepAwake(auto); });   // the screen stays on while AUTO runs, as on the cabinet layout
    const autoTick = () => {
      host.frames = ++af; since++;
      if (featureOn()) { auto = false; autoBtn.classList.remove('lit'); autoBtn.setAttribute('aria-pressed', false); if (o.keepAwake) o.keepAwake(false); return; }   // AUTO stops at a bonus: the player picks and watches it
      if (playing && since > 150 && !running()) playing = false;   // the ROM refused the Play (no credit): no game is coming
      if (!playing) { if (since > 90) { since = 0; if (credit() < 20000) note(); if (host.enabledCodes().includes(PLAY)) press(PLAY); else host.key(host.enabledCodes().includes(TAKE_WIN) ? TAKE_WIN : PLAY); } return; }
      if (since > 300 && since % 90 === 0 && af >= host.hold) host.prompt();
    };
    let sig = '';
    const refresh = () => {   // keys for the codes the ROM lists as enabled now
      const on = host.enabledCodes(), boxes = new Set(vm.touchBoxes().map(b => b.code)), picks = on.filter(c => !SKIP.has(c) && !boxes.has(c) && c >= 0xfa1 && c < 0x2000);
      const s = on.join() + '|' + picks.join() + '|' + vm.touchBoxes().filter(b => b.code >= 0x21 && b.code <= 0x29).map(b => b.code + ':' + b.x + ',' + b.y).join(); relabel(); if (s === sig) return; sig = s;
      if (!on.includes(LINES[0]) && (lineSel || betSel)) { lineSel = betSel = 0; lamps(); }   // the menu: the next game starts on 1 line, bet 1
      const tw = on.includes(TAKE_WIN); spinB.disabled = !on.includes(PLAY) && !tw; spinB.textContent = tw && !on.includes(PLAY) ? 'TAKE WIN' : 'PLAY'; spinB.classList.toggle('collect', spinB.textContent !== 'PLAY');
      menuB.disabled = !on.includes(GAME_MENU); LINES.forEach((c, i) => { lineB[i].disabled = !on.includes(c); }); BETS.forEach((c, i) => { betB[i].disabled = !on.includes(c); });
      fk.replaceChildren(menuB, ...picks.map(c => { const b = mk(keyBtn('fkey', 'PICK ' + c.toString(16).toUpperCase(), 'Pick ' + c.toString(16)), () => host.key(c)); b.disabled = false; return b; }));
    };
    // pointer -> game screen coordinates -> the ROM's touch box (the host hit test), forwarded as [0x1d, code, 0]
    // The stage is what is visible and what the finger is on: its rect, not the (hidden under the CRT shader) canvas's; with the CRT effect on the picture is
    // barrel-distorted and zoomed, QotnCRT.unwarp undoes that
    const xy = e => { const r = $('stage').getBoundingClientRect(); let fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height; if (window.QotnCRT) [fx, fy] = QotnCRT.unwarp(fx, fy); return [Math.floor(fx * 640), Math.floor(fy * 960) - 480]; };   // y < 0: the top screen, not touchable
    // the most specific enabled box under the point: Cashman Tonight's denomination buttons lie inside the game tile's box and the tile has the higher priority, so
    // vm.touchAt (the topmost box) would always answer the tile; the smallest box wins, the topmost among equals
    const hit = (x, y) => { let best = null; for (const b of vm.touchBoxes()) if (b.code > 0 && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && vm.touchEnabled(b.code)) { const a = b.w * b.h; if (!best || a < best.a || (a === best.a && (b.prio | 0) >= (best.p | 0))) best = { a, p: b.prio, c: b.code }; } return best ? best.c : -1; };
    // A mouse acts on the press. A finger acts on the lift when it has not moved (the canvas is taller than a phone's screen: a drag on it is the page scrolling, which
    // would pick whatever lay under the finger when it landed); `touch-action: manipulation` keeps scrolling and drops double-tap zoom and the tap delay.
    $('stage').style.touchAction = 'manipulation';
    const act = e => { const [x, y] = xy(e); const c = hit(x, y); if (c >= 0) { e.preventDefault(); if (c === PLAY) press(PLAY); else host.send(c); } };
    let down = null;
    $('stage').addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || e.pointerType === 'pen') { act(e); return; } down = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
    $('stage').addEventListener('pointerup', e => { const d = down; down = null; if (d && d.id === e.pointerId && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12) act(e); });
    $('stage').addEventListener('pointercancel', () => { down = null; });
    $('stage').addEventListener('pointermove', e => { const [x, y] = xy(e); $('stage').style.cursor = hit(x, y) >= 0 ? 'pointer' : ''; });
    addEventListener('keydown', e => { if (e.target.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return; if (e.key === 'Enter') { e.preventDefault(); note(); } else if (e.key === ' ') { e.preventDefault(); playKey(); } });
    const meters = () => { const cr = credit(); $('cab').classList.toggle('needcash', (!running() && cr < Math.max(lastBet, 1)) || ($('cab').classList.contains('needcash') && $('add').classList.contains('feed')));   /* phone: the note acceptor pops up */ $('hcr').textContent = money(cr); $('hbet').textContent = money(lastBet); $('hwin').textContent = money(lastWin); };
    // a game ended (ROM [10] answered by the host): the win is what the credit gained over the stake
    const cx = $('screen').getContext('2d'); let acc = 0, lastT = 0, busy = false;
    const loop = async t => {
      const sp = host.enabledCodes().includes(0x384) ? 1 : speed0;   // the menu's confirm dialog (0x384) closes itself after 10 ROM seconds: run it at 1x so a player has those 10 s
      acc = Math.min(acc + (lastT ? t - lastT : FRAME_MS) * sp, 4 * FRAME_MS * sp); lastT = t;
      if (!busy) { busy = true; try { let n = 0;
        while (acc >= FRAME_MS) { acc -= FRAME_MS; n++; host.step(1); if (auto) autoTick(); }
        if (n) { const px = await MK6RENDER.compose(vm, 640, 960, 480); cx.putImageData(new ImageData(px, 640, 960), 0, 0); if (walletStale && !playing) { walletStale = false; const w = store.get('wallet'); if (Number.isFinite(w) && w !== credit()) { vm.meters.set(0, w); host.machineEvent(); } }
          refresh(); meters(); if (walletSeen !== credit()) store.set('wallet', walletSeen = credit()); }
      } finally { busy = false; } }
      requestAnimationFrame(loop);
    };
    host.onGameOver = () => { api.games = (api.games | 0) + 1; const cost = (vm.meters.get(TURNOVER) | 0) - t0, win = credit() - c0 + cost; if (playing) { lastBet = cost; lastWin = win; playing = false; since = 0; } };
    // a phone shows less than the stacked screens: bring the touch screen (the lower half) into view once, so the menu can be tapped without hunting for it
    try { if (matchMedia('(pointer: coarse)').matches) { const r = $('stage').getBoundingClientRect(), mid = r.top + scrollY + r.height / 2; if (r.bottom > innerHeight) scrollTo(0, Math.max(0, Math.min(mid - 8, r.bottom + scrollY - innerHeight + 8))); } } catch (e) {}
    refresh(); meters(); requestAnimationFrame(loop);
    window.touchplay = Object.assign(api, { host, note, press, hit, playKey });
    dispatchEvent(new Event('resize'));   // the page's fit rule (fitMarquee) measures the two-screen stage only now
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6TOUCHPLAY = api;
})(typeof window !== 'undefined' ? window : globalThis);
