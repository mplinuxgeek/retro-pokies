// Added by tools/build-pages.py to the static (GitHub Pages) build only, so the LAN server (server.py) never runs a service worker with stale code.
// Registers sw.js (offline app shell) and asks the browser to keep this site's storage (the ROMs saved in IndexedDB) instead of evicting it.
(function () {
  'use strict';
  // No server behind a static host: /api/ and /roms/ requests (ROM listing, library store, feedback) never leave the page, they answer 404 at once.
  // The ROMs come only from drag and drop or the file picker and live in this browser (IndexedDB, romstore.js).
  const realFetch = window.fetch.bind(window);
  window.fetch = (u, o) => /^\/(api|roms)\//.test(typeof u === 'string' ? u : (u && u.url) || '') ? Promise.resolve(new Response('{}', { status: 404 })) : realFetch(u, o);
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker:', e)));
  const persist = () => navigator.storage && navigator.storage.persist && navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {});
  // Chrome grants it quietly for an installed or often used site; Firefox may ask, so ask once the user has added a ROM (romstore.js put) or on first play
  window.MK6_PERSIST = persist;
  if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { window.MK6_PERSISTED = p; }).catch(() => {});
  // iPhone / iPad Safari deletes a site's storage after 7 days without a visit unless the site was added to the Home Screen
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.MK6_IOS_HINT = ios && !standalone;
  addEventListener('DOMContentLoaded', () => {
    // ask for persistent storage once a ROM is saved in this browser
    if (window.RomStore && RomStore.put) { const put = RomStore.put; RomStore.put = (...a) => put(...a).then(v => { persist(); return v; }); }
    let dismissed = false; try { dismissed = localStorage.getItem('mk6-ios-hint') === '1'; } catch (e) {}
    if (!window.MK6_IOS_HINT || dismissed || !/games\.html$|\/$/.test(location.pathname)) return;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99;padding:10px 40px 10px 12px;border-radius:10px;background:#2a1a08;color:#ffe27a;font:14px/1.35 system-ui,sans-serif;box-shadow:0 4px 18px #000a';
    bar.textContent = 'To keep your ROMs on this iPhone or iPad, tap Share, then "Add to Home Screen", and play from there. Safari clears saved ROMs after 7 days without a visit otherwise.';
    const x = document.createElement('button'); x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'position:absolute;right:6px;top:6px;border:0;background:none;color:#ffe27a;font-size:22px;line-height:1;cursor:pointer';
    x.onclick = () => { bar.remove(); try { localStorage.setItem('mk6-ios-hint', '1'); } catch (e) {} };
    bar.appendChild(x); document.body.appendChild(bar);
  });
})();
