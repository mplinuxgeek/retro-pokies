// Sound for the emulator page: plays the ROM's own sounds (WAV and MIDI objects of section 9, with the instrument samples '<program>c<octave>' / 'r<key>')
// through js/audio.js. The ROM triggers sounds as scenes (vm.sound.play/stop); sounds the original machine plays itself come from Host.onSound.
(function (root) {
  'use strict';
  function install(vm, host) {
    const A = root.QotnAudio, db = vm.db, sec = db.sections[9], man = { sfx: [], instruments: {}, drums: {}, midi: [] }, recs = new Map();
    for (const r of sec.recs) {
      if (!r || r.tag === 3) continue; recs.set(r.name, r);
      if (r.tag === 2) { man.midi.push(r.name); continue; }
      let m; if ((m = /^(\d+)c(\d)$/i.exec(r.name))) (man.instruments[m[1]] = man.instruments[m[1]] || []).push([+m[2], r.name]);
      else if ((m = /^r(\d+)$/.exec(r.name))) man.drums[m[1]] = r.name; else man.sfx.push(r.name);
    }
    A.configure(man, (name) => { const r = recs.get(name); return r ? r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength) : new ArrayBuffer(0); });
    const live = new Map(), music = {};
    // The ROM's own compiled voice bank (js/sndbank.js, the AVLSoundControl record) plays every sound the way the real machine mixes it. The name-guessing MIDI sampler and the plain
    // WAV player stay as the fallback for a record without a valid block, and with ?snd=guess in the page address (comparison).
    const SB = root.SNDBANK, useBank = !!SB && !/[?&]snd=guess/.test((root.location && root.location.search) || '');
    const bankOf = rec => useBank ? SB.decode(rec.pack ? rec.pack.db : db, rec) : null;
    const run = (rec, o) => { const bk = bankOf(rec); return bk ? Promise.resolve(A.playBank(bk, SB, o)) : rec.tag === 2 ? A.playMidi(rec.name, o) : Promise.resolve(A.play(rec.name, o)); };
    // music and sound effects play on separate channels. Music (win tunes, marches, feature jingles) plays one at a time: a new tune replaces the
    // playing one, and the same tune while it still plays is not started again (a feature can retrigger its tune: Double Dolphin specials piled up
    // copies that crackled on phones). Effects never stop the music (a dolphin splash during the win tune); an effect is not started again while
    // the same effect still plays.
    // Music is also told by length: a sound whose longest voice is 100000 samples (4.7 s) or more is a tune, whatever its name
    // (Choy Sun Doa: collect 53 s, SND_FG1, SND_FG2, SND_SL; they played on a channel of their own over the win tune).
    const MUSIC = /^(wintune|march|special_|trigger\d|instant_win|doubleup)|tune|music|theme/i, MUSIC_MIN_SAMPLES = 100000;
    const playing = new Map();   // channel ('music' or the effect's name) -> { name, p, until (performance.now ms; Infinity until the length is known) }
    vm.sound = {
      play(rec, scene, info) {
        if (!rec) return; const now = performance.now(), bk = bankOf(rec), ch = MUSIC.test(rec.name) || (bk && bk.samples >= MUSIC_MIN_SAMPLES) ? 'music' : rec.name, cur = playing.get(ch), on = cur && cur.until > now;
        if (on && cur.name === rec.name) { live.set(scene, cur.p); return; }
        if (on) cur.p.then(h => h && h.stop && h.stop(0.05));   // only another tune gets here
        const o = {}; if (info && useBank) { if (info.plays === -1 || info.plays > 1) o.loop = info.plays === -1 ? true : info.plays;   /* plays -1 = for ever (coinout, attract and background tunes), n = n times; 0 (Double Dolphin swim): once */ if (info.vol > 0 && info.vol < 100) o.gain = info.vol / 100; }
        const p = run(rec, o), c = { name: rec.name, p, until: Infinity }; playing.set(ch, c);
        p.then(h => { c.until = h && isFinite(h.duration) ? now + h.duration * 1000 : h ? Infinity : 0; });
        live.set(scene, p);
      },
      // A spin starts: the mixer is told to stop every tune (the win tune of the last game, released by the ROM, plays on otherwise)
      stopMusic() { const c = playing.get('music'); if (c) { c.p.then(h => h && h.stop && h.stop(0.05)); playing.delete('music'); } },
      stop(scene) { const p = live.get(scene); if (p) { p.then(h => h && h.stop && h.stop(0.05)); live.delete(scene); } },
    };
    if (host) host.onSound = (kind, name, o = {}) => {          // kind: 'sfx' | 'midi' | 'loop' (stopped with 'stop' + the same slot) ; o.slot keeps one tune per slot
      if (o.slot) { const p = music[o.slot]; if (p) p.then(h => h && h.stop && h.stop()); music[o.slot] = null; }
      const rec = recs.get(name); if (!rec || kind === 'stop') return;
      const p = run(rec, Object.assign({ loop: kind === 'loop' }, o)); if (o.slot) music[o.slot] = p;
    };
    return { man, recs };
  }
  const api = { install };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EMUSOUND = api;
})(typeof window !== 'undefined' ? window : globalThis);
