# Retro Pokies desktop (work in progress)

A desktop player for Windows, Mac and Linux: the Retro Pokies engine running in Node, drawn in an SDL window. The engine is not copied: `src/core.js` loads it from this repository's `web/js/`, so the desktop and web players run the same code. No ROMs are included.

To play, use the launcher in the repository root (`Retro Pokies Desktop.cmd` on Windows, `Retro Pokies Desktop.command` on a Mac, `retro-pokies-desktop.sh` on Linux): it checks for Node.js 22, installs SDL on the first run and starts the app. Games come from the repository's `roms/` folder, or the folder or zip you give it. For development:

```
npm install                                # SDL2 binding (@kmamal/sdl, a prebuilt native module)
bin/retro-pokies [ROM folder | ROM zip]    # opens the games list (or that game); bin/retro-pokies.cmd on Windows (for packaged builds: no setup)
npm test                                   # headless: app flow and core (ROMS=<folder with Queen Of The Nile.zip>)
node src/snap.js "<ROM zip>" [spins] [out.png]   # headless frame timing and a PNG of a mid-spin frame
```

Look: drawn like the web build (games.html and play.html) at twice its CSS pixels, with its fonts (Bungee, Share Tech Mono, Noto Sans, Liberation Sans for the panel keys; `assets/fonts.*`, made by `python3 tools/import-fonts.py`, licences in `assets/fonts/`), colours, LCD and key lighting. The window fits the screen by default; the menu sets a fixed scale.

Games list (after games.html): the LCD with the money balance and the totals bet and won, the brand, a search box (just type), the filters (All games, Favourites; Tab / Shift+Tab or click; favourites are listed first), and cards with the game's art, the catalogue's title (games are sorted by it, numbers as numbers), a favourite star and what the scan found (lines, reels, free games). Arrows / PgUp / PgDn / Home / End move, Enter or click plays, Ctrl+D or the star marks a favourite, Esc clears the search. Art comes from `retro-pokies/data/games/<id>/marquee.*`, else it is made from the ROM's attract art in the background and cached in `~/.cache/retro-pokies-desktop/art/`. Touch games and ROMs without a map are shown dimmed.

In a game (after play.html's cabinet): the banner (the game's art and name, the CREDIT / BET / WIN LCD, key hints and the Menu button) over the game over the control panel; the menu sets what the banner shows and turns the LCD on or off (with the banner off it sits in a slim strip). Keys as play.html's: SPACE (or click) spins, and after a win is PLAY ON (on the gamble screen COLLECT); Enter (or N) inserts a $100 note, Left/Right lines, Up/Down bet, G gamble, then R red, B black, 1-4 heart, diamond, club, spade; E the FEATURE key at a feature prompt; H paytable; 1-5 bet keys, Q W E R T Y play keys, A auto, Tab games list, F2 control panel, F3 banner, F4 frame rate counter, F10 or Esc menu, F11 or Alt+Enter full screen, F12 screenshot (saved to ~/Pictures). At a prompt with several keys to pick from, the arrow keys move between them and SPACE picks. With RP_PAD set (the console launcher) Left/Right are the bet and Up/Down the lines, and PgUp gambles, PgDn opens the paytable. The menu also has Statistics, Speed (1x to 8x), the RTP set and Reset stats & credits; a new balance is $1000. Each game keeps its bet and lines.

Control panel (as play.html's): the web player's brushed-steel fascia, keys, lamps, shadows, glows and note acceptor, rendered from play.html's own CSS by Chromium at the panel's scale (`assets/webpanel.*`, rebuilt with `python3 tools/import-webpanel.py`, which needs Playwright), with labels from the ROM's key text, lamps from the ROM's lamp table, the selected bet and play keys lit green, a labelled play key blue and the suits on five-bet games. Click a key, or the note acceptor to insert a note. A play key selects its lines and spins; AUTO spins again 1.5 s after each game and 3 s after its last spin until the credit runs out, takes a win after 2.5 s, and stops at a feature. GAMBLE flashes while a win can be gambled; on the gamble screen the first and last play keys are RED and BLACK and the bet keys with a suit pick it.

Menu (F10 or the Menu button): Games list, Insert note, Denomination (restarts the game, money kept), Screenshot; Full screen, Window size, Banner, Control panel, LCD colour, Smoothing; Quit. Settings, favourites and the money balance are kept in `~/.config/retro-pokies-desktop/settings.json` (a game's credits too, so they come back if the app is killed).

Status: reel games only, no CRT filter. Next: share play.html's game controller, SDL audio, keymap and gamepad, then a single-file build per platform.
