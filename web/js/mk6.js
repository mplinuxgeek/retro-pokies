// In-browser (and Node) reader for Aristocrat MK6 ROM zips.
// Nothing is written anywhere: the zip bytes stay in memory, images/sounds become Blob URLs on demand, rules come straight from the code ROM.
//   const rom = await MK6.openZip(arrayBuffer);               // { A, B, files }
//   const game = await MK6.buildGame(rom, profile);           // { data, text, audio, res }  (res.url(name) / res.bytes(path))
(function (root) {
  'use strict';
  const BASE = 0x08000000;

  // ---- zip (stored + deflate) -------------------------------------------------------------------
  // Node: its zlib, at once (the streams below wait a turn of the event loop per chunk); the browser: DecompressionStream
  const ZLIB = typeof process !== 'undefined' && process.versions && process.versions.node && typeof require === 'function' ? require('zlib') : null;
  async function inflateRaw(u8) {
    if (ZLIB) return new Uint8Array(ZLIB.inflateRawSync(u8));
    const ds = new DecompressionStream('deflate-raw'), w = ds.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  async function readZip(buf) {
    const u = new Uint8Array(buf), v = new DataView(buf instanceof ArrayBuffer ? buf : u.buffer, u.byteOffset, u.byteLength);
    let e = u.length - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not a zip file');
    const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true); const out = {};
    for (let i = 0; i < n; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
      if (name.endsWith('/')) continue;
      const lnl = v.getUint16(lho + 26, true), lxl = v.getUint16(lho + 28, true), start = lho + 30 + lnl + lxl, raw = u.subarray(start, start + csize);
      out[name] = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : (() => { throw new Error('zip method ' + method); })();
    }
    return out;
  }
  function il16(a, b) { const o = new Uint8Array(a.length * 2); for (let i = 0; i < a.length; i += 2) { o[2 * i] = a[i]; o[2 * i + 1] = a[i + 1]; o[2 * i + 2] = b[i]; o[2 * i + 3] = b[i + 1]; } return o; }
  async function openZip(buf) {
    const files = await readZip(buf), parts = {};
    for (const n of Object.keys(files)) {
      const m = /\.(\d{3})$/.exec(n); if (m) parts[m[1]] = files[n];
      const u = /\.(u\d+)$/i.exec(n); if (u) parts[u[1].toLowerCase()] = files[n];
    }
    let A = null, B = new Uint8Array(0);
    if (parts['000'] && parts['001']) {
      A = il16(parts['000'], parts['001']);
      const chip = k => String(k).padStart(3, '0');
      for (let k = 2; parts[chip(k)] && parts[chip(k + 1)]; k += 2) {      // further chip pairs (.002/.003, .004/.005, ... .012/.013 on Cashman Tonight) extend the media ROM
        const b = il16(parts[chip(k)], parts[chip(k + 1)]), t = new Uint8Array(B.length + b.length); t.set(B, 0); t.set(b, B.length); B = t;
      }
    } else if (parts['u86'] && parts['u73']) {
      A = il16(parts['u86'], parts['u73']);
      if (parts['u85'] && parts['u72']) {
        const b1 = il16(parts['u85'], parts['u72']);
        if (parts['u84'] && parts['u71']) {
          const b2 = il16(parts['u84'], parts['u71']);
          B = new Uint8Array(b1.length + b2.length);
          B.set(b1, 0); B.set(b2, b1.length);
        } else {
          B = b1;
        }
      }
    }
    if (!A) throw new Error('unsupported ROM layout: ' + Object.keys(files).slice(0, 3).map(n => n.split('/').pop()).join(', '));
    return { files, A, B };
  }


  // ---- resource chains: [u32 type][char name[32]][u32 size][u32 x2][data] back to back, with pointer tables in between --------
  const dv = D => new DataView(D.buffer, D.byteOffset, D.byteLength);
  function recordAt(D, V, o) {
    if (o + 0x30 > D.length) return null;
    const t = V.getUint32(o, true); if (t > 20 || t === 0) return null;
    let e = o + 4; while (e < o + 0x24 && D[e] !== 0) { if (D[e] < 32 || D[e] >= 127) return null; e++; }
    if (e === o + 4) return null;
    for (let k = e; k < o + 0x24; k++) if (D[k] > 127) return null;    // (only the first NUL ends the name)
    const size = V.getUint32(o + 0x24, true); if (o + 0x30 + size > D.length) return null;
    return { o, t, name: String.fromCharCode(...D.subarray(o + 4, e)), size };
  }
  function tableAt(D, V, o) {
    if (o + 8 > D.length) return 0;
    const k = V.getUint32(o, true), c = V.getUint32(o + 4, true); if (k > 30 || c === 0 || c > 5000 || o + 8 + 4 * c > D.length) return 0;
    for (let i = 0; i < c; i++) { const p = V.getUint32(o + 8 + 4 * i, true); if (!((p >= 0x800000 && p < 0x1000000) || (p >= BASE && p < BASE + 0x800000))) return 0; }
    return 8 + 4 * c;
  }
  function chains(D, lo, minLen = 3) {
    const V = dv(D), seen = new Set(), out = []; let o = lo;
    while (o < D.length - 0x30) {
      if (seen.has(o)) { o += 4; continue; }
      const run = []; let p = o;
      for (;;) {
        const r = recordAt(D, V, p);
        if (r) { run.push(r); p = r.o + 0x30 + r.size; continue; }
        const tb = tableAt(D, V, p); if (tb && run.length) { p += tb; continue; }
        break;
      }
      if (run.length >= minLen) { run.forEach(r => seen.add(r.o)); out.push(run); o = p; } else o += 4;
    }
    return out;
  }

  // ---- PICT sprites (LZW indices + optional alpha plane) --------------------------------------------
  function unblock(d, pos) { const out = []; let total = 0; const parts = [];
    while (pos < d.length) { const n = d[pos++]; if (n === 0) break; parts.push(d.subarray(pos, pos + n)); total += n; pos += n; }
    const r = new Uint8Array(total); let k = 0; for (const p of parts) { r.set(p, k); k += p.length; } return r; }
  function lzw(data, minbits, limit) {
    const clear = 1 << minbits, eoi = clear + 1, prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097), out = new Uint8Array(limit);
    let op = 0, nxt = clear + 2, bits = minbits + 1, prev = -1, first = 0, acc = 0, nb = 0;
    const expand = code => { let n = 0; while (code >= clear) { stack[n++] = suffix[code]; code = prefix[code]; } stack[n++] = code; first = code; return n; };
    for (let i = 0; i < data.length; i++) {
      acc |= data[i] << nb; nb += 8;
      while (nb >= bits) {
        const code = acc & ((1 << bits) - 1); acc >>>= bits; nb -= bits;
        if (code === clear) { nxt = clear + 2; bits = minbits + 1; prev = -1; continue; }
        if (code === eoi) return out;
        let n;
        if (prev < 0) { n = expand(code); prev = code; }
        else {
          const old = nxt;
          if (code < old) { n = expand(code); prefix[nxt] = prev; suffix[nxt] = first; }      // table entry: previous + first byte of this one
          else { expand(prev); prefix[nxt] = prev; suffix[nxt] = first; n = expand(nxt); }    // KwKwK case
          nxt++; if (nxt === (1 << bits) && bits < 12) bits++;
          prev = code < old ? code : old;
        }
        for (let k = n - 1; k >= 0 && op < limit; k--) out[op++] = stack[k];
      }
    }
    return out;
  }
  function decodePict(body, pals) {
    const V = dv(body), flag = V.getInt32(8, true), w = V.getInt32(12, true), h = V.getInt32(16, true), pal = V.getInt32(24, true), aoff = V.getInt32(28, true);
    const d = body.subarray(40), n = w * h; let px, alpha = null;
    if (flag === 1) px = lzw(unblock(d, 1), d[0], n); else px = d.subarray(0, n);
    if (aoff > 0) { const a = aoff - 40; alpha = flag === 1 ? lzw(unblock(d, a + 1), d[a], n) : d.subarray(a, a + n); }
    const pi = pal < 0 ? pals.length + pal : pal, rgb = (pal >= 0 || flag === 1) && pals[pi] ? pals[pi][1] : null,   // (negative palette indexes count from the end)
       out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const c = px[i] || 0, p = rgb ? rgb[c] : [c, c, c];
      out[4 * i] = p[0]; out[4 * i + 1] = p[1]; out[4 * i + 2] = p[2]; out[4 * i + 3] = alpha && i < alpha.length ? alpha[i] : 255;
    }
    // PICTs (LZW or raw) with no alpha plane carry a colour key in header word +32 (0x00RRGGBB; 0 and -1 mean none): the art's background, drawn transparent by the
    // engine (5 Dragons' IMG_Sel_Pearl_* showed a green square, QOTN Clown Jackpot's IMG_h_* a green frame; raw ones: Choy Sun Doa's COIN01/02 white corners, High Noon's Door_* and Sweet Hearts 2's STAND_DOWN_SHAD2 white
    // boxes, the a_bk_ly / a_darkblue message fonts' yellow / dark red background). Header words that are not keys (the fonts' and bevels' white,
    // 0xcdcdcdcd fill) leave art alone: only an image whose first pixel is the key colour counts.
    const key = V.getUint32(32, true);
    if (aoff <= 0 && key && key !== 0xffffffff && key !== 0xcdcdcdcd) {
      const kr = (key >> 16) & 255, kg = (key >> 8) & 255, kb = key & 255;
      if (out[0] === kr && out[1] === kg && out[2] === kb) for (let i = 0; i < n; i++) if (out[4 * i] === kr && out[4 * i + 1] === kg && out[4 * i + 2] === kb) out[4 * i + 3] = 0;
    }
    return { w, h, rgba: out };
  }

  // ---- scan a ROM for resources ----------------------------------------------------------------------
  function scanResources(rom) {
    const recs = {}; const palRecs = [];
    for (const [src, D, lo] of [['B', rom.B, 0x1000], ['A', rom.A, 0x1000]]) {
      for (const run of chains(D, lo, 3)) for (const r of run) {
        const body = D.subarray(r.o + 0x30, r.o + 0x30 + r.size), isPal = r.t === 1 && r.size === 0x408 && body[0] === 0x50 && body[1] === 0x41 && body[2] === 0x4c && body[3] === 0x54;   // 'PALT'
        if (isPal) palRecs.push([src, r]);                                       // palette index = chain order
        if (isPal && recs[r.name] && !recs[r.name].pal) continue;                      // palettes share names with their images (QotN): keep the image
        recs[r.name] = { src, D, o: r.o, t: r.t, size: r.size, body, pal: isPal };
      }
    }
    const pals = palRecs.map(([src, r]) => { const b = r.o + 0x30 + 8, D = src === 'B' ? rom.B : rom.A, p = []; for (let k = 0; k < 256; k++) p.push([D[b + 4 * k + 2], D[b + 4 * k + 1], D[b + 4 * k]]); return [r.name, p]; });
    return { recs, pals };
  }

  // ---- rules probe ---------------------------------------------------------
  const u32 = (A, V, o) => V.getUint32(o, true);
  const ptrOk = (v, n) => v >= BASE && v < BASE + n;
  function indexOfU32(A, val, from) { const b = [val & 255, (val >>> 8) & 255, (val >>> 16) & 255, (val >>> 24) & 255]; for (let i = from; i < A.length - 3; i++) if (A[i] === b[0] && A[i + 1] === b[1] && A[i + 2] === b[2] && A[i + 3] === b[3]) return i; return -1; }
  function indexOfBytes(A, str, from = 0) { const n = str.length; outer: for (let i = from; i < A.length - n; i++) { for (let k = 0; k < n; k++) if (A[i + k] !== str.charCodeAt(k)) continue outer; return i; } return -1; }
  const cstr = (A, p) => { let o = p - BASE, e = o; while (A[e] !== 0) e++; return String.fromCharCode(...A.subarray(o, e)); };
  function findNames(A, V) {
    let i = indexOfBytes(A, 'INVALID\0');
    while (i >= 0) {
      let j = indexOfU32(A, BASE + i, 0);
      while (j >= 0) {
        const names = []; let o = j;
        while (o + 4 <= A.length && ptrOk(u32(A, V, o), A.length)) {
          let s; try { s = cstr(A, u32(A, V, o)); } catch (e) { break; }
          if (!(s && /^[A-Za-z0-9_ ]+$/.test(s))) break; names.push(s); o += 4;
        }
        if (names.length >= 8) return { at: j, names };
        j = indexOfU32(A, BASE + i, j + 1);
      }
      i = indexOfBytes(A, 'INVALID\0', i + 1);
    }
    return { at: null, names: [] };
  }
  function findStrips(A, V, nsym) {
    const sets = []; const n = A.length; let o = 0;
    while (o < n - 60) {
      let ok = true; const st = [];
      for (let r = 0; r < 5; r++) {
        const c = u32(A, V, o + 12 * r), p = u32(A, V, o + 12 * r + 4), z = u32(A, V, o + 12 * r + 8);
        if (!(c >= 8 && c <= 400 && ptrOk(p, n) && z <= 4 && (p - BASE) + 4 * c <= n)) { ok = false; break; }
        st.push([c, p]);
      }
      if (ok) {
        const vals = st.map(([c, p]) => Array.from({ length: c }, (_, k) => u32(A, V, p - BASE + 4 * k)));
        if (vals.every(v => Math.max(...v) <= nsym + 2)) { sets.push([o, vals]); o += 60; continue; }
      }
      o += 4;
    }
    const groups = [];
    for (const s of sets) { const g = groups[groups.length - 1]; if (g && s[0] - g[g.length - 1][0] <= 0x400) g.push(s); else groups.push([s]); }
    return groups.reduce((b, g) => (!b || g.length > b.length ? g : b), null) || [];
  }
  function findPayList(A, V) {
    let best = null;
    for (let o = 0x400; o < 0x2000; o += 4) {
      if (o + 96 > A.length || u32(A, V, o) !== 0 || u32(A, V, o + 4) < 1) continue;
      let k = 1; while (k < 24 && u32(A, V, o + 4 * k) > u32(A, V, o + 4 * k - 4) && u32(A, V, o + 4 * k) < 100000) k++;
      if (k >= 10 && (!best || k > best[1])) best = [o, k];
    }
    return best;
  }
  function findCombos(A, V) {
    const out = []; const n = A.length; let o = 0;
    const valid = p => { const f = u32(A, V, p), idx = u32(A, V, p + 8), lo = u32(A, V, p + 12), hi = u32(A, V, p + 16), ptr = u32(A, V, p + 24); return ptrOk(f, n) && lo <= hi && hi <= 0x200000 && idx < 64 && ptrOk(ptr, n); };
    while (o < n - 28 * 3) {
      if (valid(o) && u32(A, V, o + 4)) {
        const run = []; let p = o;
        while (p < n - 28 && valid(p)) {
          const ptr = u32(A, V, p + 24), pat = []; for (let k = 0; k < 5; k++) { const x = u32(A, V, ptr - BASE + 4 * k); pat.push(x < 0x80000000 ? x : -1); }
          run.push([u32(A, V, p), u32(A, V, p + 8), pat]); p += 28;
        }
        if (run.length >= 10) { out.push([o, run]); o = p; continue; }
      }
      o += 4;
    }
    return out;
  }
  function findPayEntries(A, V, npays, scatter) {
    const n = A.length, lines = {}, scat = {};
    for (let p = 0x400; p < 0x30000; p += 4) {
      const hi = u32(A, V, p); if ((hi !== 10000 && hi !== 100000) || u32(A, V, p - 4) !== 1) continue;
      const idx = u32(A, V, p - 8), ptr = u32(A, V, p + 8); if (!(idx < npays && ptrOk(ptr, n))) continue;
      const pat = []; for (let k = 0; k < 5; k++) { const x = u32(A, V, ptr - BASE + 4 * k); pat.push(x < 0x80000000 ? x : -1); }
      const used = pat.filter(x => x !== -1); if (!used.length || used[0] > 40) continue;
      if (used[0] === scatter) {
        const same = used.every(x => x === scatter) && used.length > 1 && (used.length === 5 || pat.slice(used.length).every(x => x === -1)) && pat[1] === scatter;
        scat[same ? used.length : pat[1]] = idx;
      } else if (used.every(x => x === used[0]) && pat.slice(0, used.length).every((x, k) => x === used[k])) (lines[used[0]] = lines[used[0]] || {})[used.length] = idx;
    }
    return { lines, scat };
  }
  function findLines(A, V) {
    const pat = new Uint8Array(60); for (let k = 0; k < 5; k++) new DataView(pat.buffer).setInt32(40 + 4 * k, -1, true);
    let best = null, i = -1;
    const find = from => { outer: for (let s = from; s < A.length - 60; s += 4) { for (let k = 0; k < 60; k++) if (A[s + k] !== pat[k]) continue outer; return s; } return -1; };
    i = find(0);
    while (i >= 0) {
      const rows = []; let o = i;
      while (o + 40 <= A.length && rows.length < 240) { const r = []; for (let k = 0; k < 5; k++) r.push(V.getInt32(o + 4 * k, true)); if (!r.every(x => x >= -1 && x <= 1)) break; rows.push(r); o += 40; }
      if (!best || rows.length > best[1].length) best = [i, rows];
      i = find(i + 4);
    }
    if (!best) return { at: null, rows: [] };
    const rows = best[1], eq = (a, b) => a.every((x, k) => x === b[k]), z = [0, 0, 0, 0, 0], m = [-1, -1, -1, -1, -1], p1 = [1, 1, 1, 1, 1], starts = [];
    for (let k = 0; k < rows.length - 2; k++) if (eq(rows[k], z) && eq(rows[k + 1], m) && eq(rows[k + 2], p1)) starts.push(k);
    if (!starts.length) starts.push(0);
    let k0 = starts[0], bs = -1;
    for (const k of starts) { const sc = new Set(rows.slice(k, k + 20).map(r => r.join())).size; if (sc > bs || (sc === bs && k > k0)) { bs = sc; k0 = k; } }
    let full = rows.slice(k0, k0 + 20);
    while (full.length > 1 && eq(full[full.length - 1], z) && eq(full[full.length - 2], z)) full.pop();
    return { at: best[0] + 40 * k0, rows: full };
  }

  // minimal PNG reader (8-bit RGBA, non-interlaced) - only used to rescue sprites whose alpha plane is all zero (the canvas would drop their RGB)
  async function decodePngRGBA(u8) {            // 8-bit non-interlaced PNG of colour type 0, 2, 3 (palette + tRNS), 4 or 6 -> RGBA
    const v = dv(u8), w = v.getUint32(16), h = v.getUint32(20), ct = u8[25]; if (u8[24] !== 8 || u8[28] !== 0 || ![0, 2, 3, 4, 6].includes(ct)) return null;
    const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct], idat = []; let p = 8, total = 0, plte = null, trns = null;
    while (p + 12 <= u8.length) {
      const len = v.getUint32(p), type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      if (type === 'IDAT') { idat.push(u8.subarray(p + 8, p + 8 + len)); total += len; } else if (type === 'PLTE') plte = u8.subarray(p + 8, p + 8 + len); else if (type === 'tRNS') trns = u8.subarray(p + 8, p + 8 + len);
      p += 12 + len;
    }
    const z = new Uint8Array(total); let k = 0; for (const c of idat) { z.set(c, k); k += c.length; }
    let raw; if (ZLIB) raw = new Uint8Array(ZLIB.inflateSync(z));
    else { const ds = new DecompressionStream('deflate'), wr = ds.writable.getWriter(); wr.write(z); wr.close(); raw = new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
    const stride = w * bpp, px = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {   // the row's filter undone: a left, b up, c up-left (0 off the picture)
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
      if (f === 0) px.set(raw.subarray(src, src + stride), dst);
      else if (f === 1) for (let x = 0; x < stride; x++) px[dst + x] = raw[src + x] + (x >= bpp ? px[dst + x - bpp] : 0);
      else if (f === 2) for (let x = 0; x < stride; x++) px[dst + x] = raw[src + x] + (y ? px[up + x] : 0);
      else if (f === 3) for (let x = 0; x < stride; x++) px[dst + x] = raw[src + x] + (((x >= bpp ? px[dst + x - bpp] : 0) + (y ? px[up + x] : 0)) >> 1);
      else for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0; let val = raw[src + x];
        if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); val += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        px[dst + x] = val;
      }
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = 4 * i, q = bpp * i;
      if (ct === 6) { out[o] = px[q]; out[o + 1] = px[q + 1]; out[o + 2] = px[q + 2]; out[o + 3] = px[q + 3]; }
      else if (ct === 2) { out[o] = px[q]; out[o + 1] = px[q + 1]; out[o + 2] = px[q + 2]; out[o + 3] = 255; }
      else if (ct === 3) { const c = px[q]; out[o] = plte ? plte[3 * c] : c; out[o + 1] = plte ? plte[3 * c + 1] : c; out[o + 2] = plte ? plte[3 * c + 2] : c; out[o + 3] = trns && c < trns.length ? trns[c] : 255; }
      else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = px[q]; out[o + 3] = px[q + 1]; }
      else { out[o] = out[o + 1] = out[o + 2] = px[q]; out[o + 3] = 255; }
    }
    let any = false; for (let i = 3; i < out.length; i += 4) if (out[i]) { any = true; break; }
    return { w, h, rgba: out, opaqueAlpha: any };
  }

  // ---- build a playable game from a profile ----------------------------------------------------------------------
  async function buildGame(rom, P) {
    const A = rom.A, V = dv(A), { recs, pals } = scanResources(rom);
    const { names } = findNames(A, V), sets = findStrips(A, V, names.length), pl = findPayList(A, V);
    if (!pl) throw new Error('pay list not found'); const pays = Array.from({ length: pl[1] }, (_, k) => u32(A, V, pl[0] + 4 * k));
    const pe = findPayEntries(A, V, pl[1], P.scatter), pay = {}, scat = {};
    for (const [k, v] of Object.entries(pe.lines)) { pay[k] = {}; for (const [c, i] of Object.entries(v)) pay[k][c] = pays[i]; }
    for (const [c, i] of Object.entries(pe.scat)) scat[c] = pays[i];
    let lineRows;
    if (P.lines) { const at = typeof P.lines.at === 'string' ? parseInt(P.lines.at, 16) : P.lines.at; lineRows = Array.from({ length: P.lines.count }, (_, i) => Array.from({ length: 5 }, (_, k) => V.getInt32(at + 40 * i + 4 * k, true) + P.lines.row_base)); }
    else { const { rows } = findLines(A, V); if (rows.length !== 20) throw new Error('expected 20 paylines, found ' + rows.length); lineRows = rows.map(r => r.map(x => x + 1)); }
    const strips = {}, free_strips = {}; for (const [label, i] of Object.entries(P.sets)) strips[label] = sets[i][1]; for (const [label, i] of Object.entries(P.free_sets || {})) free_strips[label] = sets[i][1];
    const data = { id: P.id, title: P.title, base: '', default_set: P.default_set, rom_pay_values: pays,
      symbols: Object.fromEntries(Object.entries(P.symbols).map(([k, s]) => [k, Object.assign({ image: 'sym_' + k, label: s.label }, s.gold ? { gold: 'sym_' + k + 'g' } : {})])),
      wild: P.wild, scatter: P.scatter, wild_mult: P.wild_mult, strips, pay, scatter_pay: scat, free_games: P.free_games, lines: lineRows };
    if (Object.keys(free_strips).length) data.free_strips = free_strips;
    for (const k of ['rows', 'layout', 'line_options', 'bet_options']) if (P[k]) data[k] = P[k];
    if (P.help) data.help_pages = P.help.length;
    if (P.aliases && P.aliases['IMG_MS_INNER.png']) data.inner = true;
    if (P.qotn_art) data.qotn_art = true;
    // fonts + strings
    const fonts = {}, strings = {};
    for (const [name, r] of Object.entries(recs)) {
      const d = r.body, magic = String.fromCharCode(...d.subarray(0, 4));
      const fkey = Object.keys(P.fonts).find(k => k.toLowerCase() === name.toLowerCase());
      if (magic === 'FONT' && fkey) { const v = dv(d), first = v.getUint32(16, true), count = v.getUint32(20, true), hdr = v.getUint32(32, true);
        fonts[name.toLowerCase()] = { img: P.fonts[fkey], first, off: Array.from({ length: count }, (_, k) => v.getUint32(hdr + 4 * k, true)) }; }
      else if (magic === 'STRG') { const n = dv(d).getUint32(0x1c, true); strings[name] = String.fromCharCode(...d.subarray(0x20, 0x20 + n)); }
    }
    const text = { fonts, strings, win_scenes: {} };
    // audio manifest
    const audio = { sfx: [], instruments: {}, drums: {}, midi: [] };
    for (const [n, r] of Object.entries(recs)) {
      const m4 = String.fromCharCode(...r.body.subarray(0, 4));
      if (r.t === 2 && m4 === 'MThd') audio.midi.push(n);
      else if (r.t === 1 && m4 === 'RIFF') {
        let m = /^(\d+)[cC](\d)$/.exec(n), d = /^r(\d+)$/.exec(n);
        if (m) (audio.instruments[m[1]] = audio.instruments[m[1]] || []).push([+m[2], n]); else if (d) audio.drums[d[1]] = n; else if (!/^(HL_|SND_HL)/.test(n)) audio.sfx.push(n);
      }
    }
    // resolver: file name (ext ignored) -> alias -> record -> Blob URL (cached)
    const alias = {}; for (const [dst, src] of Object.entries(P.aliases || {})) alias[dst.replace(/\.(png|jpg)$/, '')] = src;
    (P.help || []).forEach((h, i) => { alias['IMG_HELP_SCREEN_' + (i + 1)] = h; });
    for (const [k, s] of Object.entries(P.symbols)) { alias['sym_' + k] = s.image; if (s.gold) alias['sym_' + k + 'g'] = s.gold; }
    const cache = {}, hasCanvas = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
    async function toBlob(w, h, draw) {
      if (typeof OffscreenCanvas !== 'undefined') { const c = new OffscreenCanvas(w, h); draw(c.getContext('2d')); return c.convertToBlob({ type: 'image/png' }); }
      const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); return new Promise(r => c.toBlob(r, 'image/png'));
    }
    async function imageBlob(name) {
      const r = recs[name]; if (!r) return null; const m = String.fromCharCode(...r.body.subarray(0, 4));
      if (m === '\x89PNG') {
        const blob = new Blob([r.body], { type: 'image/png' });
        if (r.body[25] !== 6 || typeof createImageBitmap === 'undefined') return blob;       // RGBA only: an all-zero alpha plane means "opaque" to the engine (50 Lions animals)
        const png = await decodePngRGBA(r.body); if (!png || png.opaqueAlpha) return blob;
        for (let i = 3; i < png.rgba.length; i += 4) png.rgba[i] = 255;
        return toBlob(png.w, png.h, cx => cx.putImageData(new ImageData(png.rgba, png.w, png.h), 0, 0));
      }
      if (r.body[0] === 0xff && r.body[1] === 0xd8) return new Blob([r.body], { type: 'image/jpeg' });
      if (m === 'PICT') { const im = decodePict(r.body, pals); return toBlob(im.w, im.h, cx => cx.putImageData(new ImageData(im.rgba, im.w, im.h), 0, 0)); }
      return null;
    }
    async function derived(name, spec) {            // e.g. the title logo cut out of a help screen, brown backdrop keyed to transparent
      const srcUrl = await res.url(spec.from), img = await createImageBitmap(await (await fetch(srcUrl)).blob()), [x0, y0, x1, y1] = spec.crop, s = spec.scale, w = (x1 - x0) * s, h = (y1 - y0) * s;
      return toBlob(w, h, cx => { cx.imageSmoothingQuality = 'high'; cx.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
        const id = cx.getImageData(0, 0, w, h), d = id.data; for (let i = 0; i < d.length; i += 4) d[i + 3] = Math.max(0, Math.min(255, (d[i + 2] - d[i] + 12) * 5)); cx.putImageData(id, 0, 0); });
    }
    const res = {
      async url(file) {
        const stem = file.replace(/\.(png|jpg)$/, ''); if (cache[stem]) return cache[stem];
        return cache[stem] = (async () => {
          let blob = null;
          if (P.derived && P.derived[stem + '.png']) blob = await derived(stem, P.derived[stem + '.png']);
          else blob = await imageBlob(alias[stem] || stem);
          if (!blob) throw new Error('missing ' + file); return URL.createObjectURL(blob);
        })();
      },
      bytes(path) { const m = /^audio\/(.+)\.(wav|mid)$/.exec(path), r = m && recs[m[1]]; if (!r) return Promise.reject(new Error('missing ' + path));
        return Promise.resolve(m[2] === 'wav' ? r.body.slice(0, dv(r.body).getUint32(4, true) + 8) : r.body); },
    };
    return { data, text, audio, res, info: { images: Object.values(recs).filter(r => r.t !== 2).length, palettes: pals.length } };
  }

  const api = { openZip, buildGame, decodePict, decodePngRGBA, lzw, scanResources, findNames, findStrips, findPayList, findCombos, findLines, readZip };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MK6 = api;
})(typeof window !== 'undefined' ? window : globalThis);
