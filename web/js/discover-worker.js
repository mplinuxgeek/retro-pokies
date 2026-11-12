// Worker for the launcher's ROM scan: generate a game's map (addresses, config, keys) off the main thread.  postMessage({ id, buf }) -> { id, map, log } | { id, error }
importScripts('mk6.js', 'sh4.js', 'avl.js', 'flic.js', 'mk6tables.js', 'mk6sys.js', 'jpeg.js', 'mk6vm.js', 'mk6host.js', 'mk6discover.js');
onmessage = async e => {
  const { id, buf } = e.data, log = [];
  try { const rom = await MK6.openZip(new Uint8Array(buf)), map = await MK6DISCOVER.discover(rom, (...a) => { const t = a.join(' '); if (!/^config \d/.test(t)) { log.push(t); postMessage({ id, progress: t }); } }, {}); postMessage({ id, map, log }); }
  catch (err) { postMessage({ id, error: String(err && err.message || err), log }); }
};
