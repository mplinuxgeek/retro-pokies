// Service worker of the static build (tools/build-pages.py fills in VERSION and FILES). Cache first for the app shell, so the games load offline once
// visited; a new build has a new VERSION, installs beside the old cache and drops it on activate. ROMs are not here: they live in IndexedDB (romstore.js).
const VERSION = '__VERSION__';
const FILES = __FILES__;
const CACHE = 'retro-shell-' + VERSION;
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => (k.startsWith('retro-shell-') || k.startsWith('mk6-shell-')) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/') || u.pathname.includes('/roms/')) return;
  // pages are opened with ?game=..., so match them without the query
  e.respondWith(caches.match(r, { ignoreSearch: r.mode === 'navigate' }).then(hit => hit || fetch(r).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
    return res;
  })));
});
