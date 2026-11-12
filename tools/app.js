// Where the Retro Pokies app is, for the dev tools in this folder: the retro-pokies checkout beside it (Aristocrat_MK6/retro-pokies),
// or, inside the LAN image where these tools are copied into /app/tools, the folder above. APP_DIR overrides.
// roms: ROMS, else <app>/roms (an empty folder in a checkout, so point ROMS at a ROM folder; the containers mount theirs there).
const fs = require('fs'), path = require('path');
const up = path.resolve(__dirname, '..'), beside = path.join(up, 'retro-pokies');
const dir = path.resolve(process.env.APP_DIR || (fs.existsSync(path.join(beside, 'server.py')) ? beside : up));
module.exports = { dir, roms: path.resolve(process.env.ROMS || path.join(dir, 'roms')) };
