#!/usr/bin/env node
// Autoscan all ROMs in roms/ directory and generate maps with discover.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function slug(name) {
  return name.replace(/\.zip$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const romsDir = process.env.ROMS_DIR || path.join(__dirname, '../roms');
const mapsDir = process.env.MAPS_DIR || path.join(__dirname, '../web/maps');
const discoverScript = path.join(__dirname, 'discover.js');

if (!fs.existsSync(romsDir)) {
  console.log(`[autoscan] ROMs directory "${romsDir}" does not exist, skipping.`);
  process.exit(0);
}

fs.mkdirSync(mapsDir, { recursive: true });

async function scan() {
  const files = fs.readdirSync(romsDir).filter(f => f.toLowerCase().endsWith('.zip'));
  console.log(`[autoscan] Found ${files.length} ROMs in "${romsDir}"`);

  let scanned = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of files) {
    const nameWithoutZip = f.replace(/\.zip$/i, '');
    const id = slug(f);
    const mapFile = path.join(mapsDir, id + '.json');

    if (fs.existsSync(mapFile)) {
      skipped++;
      continue;
    }

    console.log(`[autoscan] (${scanned + 1}/${files.length - skipped}) Scanning "${nameWithoutZip}" -> ${id}...`);
    try {
      // Execute discover in a separate process with a timeout of 120s per ROM
      cp.execFileSync('node', [discoverScript, nameWithoutZip, id], {
        stdio: 'inherit',
        timeout: 120000,
        env: Object.assign({}, process.env, { ROMS_DIR: romsDir, MAPS_DIR: mapsDir })
      });
      scanned++;
    } catch (err) {
      console.error(`[autoscan] Failed or timed out scanning "${nameWithoutZip}":`, err.message);
      failed++;
    }
  }

  console.log(`[autoscan] Completed. Scanned: ${scanned}, Skipped (already mapped): ${skipped}, Failed: ${failed}`);
}

scan().catch(err => {
  console.error('[autoscan] Error during scan:', err);
});
