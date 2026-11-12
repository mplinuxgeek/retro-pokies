// Starts the desktop player apart from the console it was launched from, so the launcher's window can close (Retro Pokies Desktop.cmd).
// The player's output goes to retro-pokies.log in the temp folder. If the player stops with an error within 3 seconds (Node too old,
// the window library missing), the log is printed and this exits 1, so the launcher can keep its window open; otherwise it exits 0.
// usage: node launch-detached.js <main.js> [ROM folder | ROM zip]
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const log = path.join(os.tmpdir(), 'retro-pokies.log'), fd = fs.openSync(log, 'w');
const fail = why => { let t = ''; try { t = fs.readFileSync(log, 'utf8'); } catch (e) {} console.error(t + '\nRetro Pokies did not start: ' + why + ' (log: ' + log + ')'); process.exit(1); };
const child = spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: ['ignore', fd, fd] });
child.on('error', e => fail(e.message));
child.on('exit', code => (code ? fail('exit code ' + code) : process.exit(0)));
setTimeout(() => { child.unref(); process.exit(0); }, 3000);
