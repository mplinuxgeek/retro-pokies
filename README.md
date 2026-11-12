# Retro Pokies

A play-money slot machine simulator for study and preservation. It runs the **game's own SH-4 code** from an Aristocrat MK6 ROM in a JavaScript VM, with a host layer standing in for the cabinet (credits, bets, gamble, free games, lamps, sound).

**No ROMs are included.** You bring your own ROM zips from a machine you own or are entitled to use. See [NOTICE.md](NOTICE.md). Licence: MIT ([LICENSE](LICENSE)).

It comes in two forms, both running the same engine (`web/js/`), so a game plays the same in either:

* **Web player**: runs in a browser. Host it yourself with Docker, or put the static build on any web host such as GitHub Pages.
* **App mode** (preview): a program on your own computer with its own window. It runs the engine in Node.js and draws with SDL, so it needs no browser and no server.

| | Web, self-hosted (Docker) | Web, static site (GitHub Pages) | App (Windows, Mac, Linux) |
|---|---|---|---|
| What | `server.py` + `web/` in a container | `web/` only, built into `dist/pages/` | `app/`: the engine in Node.js, an SDL window |
| Start | `docker compose up -d`, then open the page | open the site | double-click the launcher for your system |
| ROMs | a folder on the host, mounted read-only | added in the browser, kept in IndexedDB, never uploaded | the `roms/` folder, or a folder you give it |
| Extras | game library, server-side screenshots, shared notes | works offline as a PWA | keyboard play, money balance kept between runs |
| Not yet | | | sound, gamble and feature choices, two-screen touch games |

## Self-hosted (Docker or Podman)

```
mkdir -p /path/to/roms/IMG && sudo chown 10001 /path/to/roms/IMG   # IMG: writable, screenshots and banners
# edit docker-compose.yml: replace /path/to/your/roms (twice) with your ROM folder
docker compose up -d --build        # podman compose works the same
```

Then open <http://localhost:8791/> and pick a game.

* **ROM folder**: your zips, one per game, mounted read-only at `/roms` (`ARISTO_ROMS`). Copy new zips in and reload the Games page. The `IMG/` folder inside it is the only writable part (`ARISTO_IMG`).
* **Data folder**: `/data` (the `aristo-data` volume, `ARISTO_DATA`) holds per-game notes and reports. Delete the volume to reset. `ARISTO_READONLY=1` turns all writes off.
* **Port**: `8791`. Change the left number in `ports:`; use `127.0.0.1:8791:8791` to keep it off the network. There is no login and no HTTPS: run it on a trusted network or behind a reverse proxy.
* SELinux hosts (Fedora, RHEL): add `security_opt: ["label=disable"]` or mount with `:ro,z`.

More detail: [distro/docker/README.md](distro/docker/README.md).

Without Docker: `python3 server.py 8791 0.0.0.0` (needs Python 3, plus Node for the screenshot scan). ROMs go in `roms/` or wherever `ARISTO_ROMS` points.

## Static build (stripped-down copy)

```
python3 tools/build-pages.py      # or distro/pages/build.sh; needs Python 3 with Pillow
```

Writes `dist/pages/` (about 1.5 MB, git-ignored): the player, game maps, a manifest and a service worker, without developer pages and without ROMs. Host the **contents of `dist/pages/`** on any static host (GitHub Pages included). Players press **Add games** and choose their own zips. Details: [distro/pages/README.md](distro/pages/README.md).

## App mode (preview)

The same engine as the web player in a native window (Node.js and SDL): no browser, no server. It draws the web build's look (games list, banner with the CREDIT / BET / WIN LCD, control panel) and keeps your money balance, favourites and settings between runs.

Needs [Node.js](https://nodejs.org/) 22 or newer. Put your ROM zips in `roms/`, then:

* **Windows**: double-click `Retro Pokies Desktop.cmd` (or drop a ROM folder or zip on it).
* **Mac**: double-click `Retro Pokies Desktop.command` (it opens in Terminal). The first time, macOS may block a downloaded script: right-click it, choose **Open**, then **Open** again.
* **Linux**: `./retro-pokies-desktop.sh [ROM folder | ROM zip]`

The first run installs the window library (SDL, about 7 MB) into `app/node_modules/`. Settings, favourites and the balance are kept in `retro-pokies-desktop/settings.json` in your config folder (`~/.config` on Linux). It is a preview: reel games only, wins are collected at once (no gamble or feature choices yet) and there is no sound. More detail: [app/README.md](app/README.md).

### On a handheld (Batocera / KNULLI, arm64)

`sh distro/knulli/build.sh` writes `dist/knulli/`: the app with its own Node.js for arm64, a port launcher and a pad map. Copy its contents into `/userdata/roms/ports/`, put ROM zips in `ports/retro-pokies/Roms/` and update the games lists. It starts full screen without the banner, with the Menu button in the game's corner. Buttons and files: [distro/knulli/RetroPokies.txt](distro/knulli/RetroPokies.txt).

## Using the player

`games.html` is the game list, `play.html?game=<id>` the cabinet (`?crt` for CRT mode). A game gets **Play** when it has a map in `web/maps/<id>.json`; maps for new games can be generated by the scan in the browser (`discover-worker.js`).

## Keyboard shortcuts

Web player (`play.html`):

| Key | Action |
|---|---|
| Space | Spin; Play On at the take-win prompt, Collect on the gamble screen |
| Enter | Insert a note |
| Left / Right | Fewer / more lines |
| Up / Down | Bet more / less per line |
| G | Gamble (when offered) |
| R / B, 1-4 | Gamble on red / black, or on hearts, diamonds, clubs, spades |
| E | Feature key at a feature prompt |
| H | Help pages |
| F | Full screen |

Desktop app:

| Key | Action |
|---|---|
| Space or Enter | Spin |
| N | Insert a $100 note |
| Left / Right | Bet less / more per line |
| Up / Down | More / fewer lines |
| 1-5 | Bet keys (1 = lowest bet) |
| Q W E R T, Y | Play keys (fewest lines first), Y the extra play key |
| A | Auto play on / off |
| Tab or G | Games list |
| Esc or F10 | Menu |
| F2 / F3 | Show or hide the control panel / banner |
| F4 | Frame rate counter on / off (also in the menu: Show FPS) |
| F11 | Full screen |
| F12 | Screenshot (saved to `~/Pictures`) |

In the app's games list: type to search, arrows / PgUp / PgDn / Home / End to move, Enter to play, Tab / Shift+Tab for the groups (All, Favourites, ...), Ctrl+D to mark a favourite, Esc to clear the search. In the menu: Up / Down to move, Enter to choose, Left or Backspace to go back, Esc to close. The mouse works everywhere: click keys, cards, the note acceptor and the Menu button.

## Layout

```
server.py     web + ROM + game-library server (the Docker entrypoint)
web/          the app: games.html, play.html, js/ (SH-4 VM, ROM reader, syscalls, host, renderer, sound), maps/, ui/, fonts/
tools/        build-pages.py (static build), shots.js (screenshots), engine.js (code hash that dates scan results)
              classify.js (ROM scanner: plays every ROM for a set number of spins and labels it by RTP, into data/rom-status.json),
              scan-loop.sh (keeps scan results and screenshots current; a service loop), app.js (finds the app folder for classify.js)
  data/       exports.json, syscalls.json: names for the ROM's export table and system calls
emu/          map auto-generation used by server.py and the scanner
app/          the desktop app (its own package.json: the SDL binding stays out of the web and Docker builds)
tests/        node --test unit tests and Playwright browser checks
deploy/       static-site templates (pages/)
distro/       READMEs for the web distributions; knulli/: the handheld port (build.sh, launcher, pad map)
```

## How it was made

Retro Pokies was written with Claude, Anthropic's AI model, working in Claude Code, with a human directing the work and playing and checking every game.

The game ROMs hold the game code. The emulator supplies the CPU and the operating-system services those games call, and that behaviour was worked out by running the games and watching what they do: tracing the system calls each game makes and the arguments it passes, watching which memory words change as credits, wins and reel states move, and comparing frames, sounds and lamp timings against the games running on other setups and on video.

The emulator code is written from scratch. No ROM data, game artwork or original system code is included in this repository.

## Development

```
node --test --test-concurrency=1 tests/*.test.js   # unit tests; those that need a ROM read $ROMS (default roms/)
python3 tests/browser_pages.py                      # Playwright: offline static build (needs: pip install playwright pillow)
python3 tests/server_library.test.py                # game-library API
```

Some tests need the ROM zips (for example `Queen Of The Nile.zip`) in `roms/` or in the folder named by `ROMS`.

`web/debug.html` is a developer page: it scans ROMs in the browser (run length, RTP, stalls). It is left out of the Docker image and the static build.
