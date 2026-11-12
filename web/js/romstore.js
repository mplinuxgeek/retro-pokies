// Tiny IndexedDB library of the user's own ROM zips (kept in this browser only; nothing is uploaded anywhere).
(function (root) {
  'use strict';
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('mk6-roms', 1); r.onupgradeneeded = () => r.result.createObjectStore('roms'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('roms', mode), s = t.objectStore('roms'), q = fn(s); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
  const slug = n => n.toLowerCase().replace(/\.zip$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  async function fetchServerRoms() {
    try {
      const res = await fetch('/api/roms', { cache: 'no-cache' });
      if (!res.ok) return [];
      const data = await res.json();
      return (data && data.roms) || [];
    } catch (e) {
      return [];
    }
  }

  // a fetch body as an ArrayBuffer, reporting progress as the chunks arrive
  async function readBody(res, onProgress) {
    if (!onProgress || !res.body || !res.body.getReader) return res.arrayBuffer();
    const total = +res.headers.get('Content-Length') || 0, reader = res.body.getReader(), parts = [];
    let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(got, total); }
    const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
  }

  root.RomStore = {
    put: (id, name, buf) => tx('readwrite', s => s.put({ name, buf, added: Date.now() }, id)),
    // onProgress(received, total) while a server ROM downloads (total 0 when the server sends no length)
    get: async (id, onProgress) => {
      // 1. Check server roms/ directory first
      try {
        const serverRoms = await fetchServerRoms();
        const match = serverRoms.find(r => slug(r.name) === id);
        if (match) {
          const res = await fetch(match.url);
          if (res.ok) {
            const buf = await readBody(res, onProgress);
            return { name: match.name, buf, source: 'server' };
          }
        }
      } catch (e) {}

      // 2. Check local browser IndexedDB library
      const local = await tx('readonly', s => s.get(id));
      if (local) return local;

      // 3. Fallback direct try: /roms/<id>.zip
      try {
        const res = await fetch('/roms/' + encodeURIComponent(id) + '.zip');
        if (res.ok) {
          const buf = await res.arrayBuffer();
          return { name: id + '.zip', buf, source: 'server' };
        }
      } catch (e) {}

      return null;
    },
    del: id => tx('readwrite', s => s.delete(id)),
    list: async () => {
      const localKeys = (await tx('readonly', s => s.getAllKeys())) || [];
      const set = new Set(localKeys);
      try {
        const serverRoms = await fetchServerRoms();
        for (const r of serverRoms) set.add(slug(r.name));
      } catch (e) {}
      return [...set];
    },
    serverList: fetchServerRoms
  };
})(window);
