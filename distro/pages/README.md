# MK6 player, static site (GitHub Pages)

A static copy of the MK6 slot player for GitHub Pages or any static host. There is no server: no ROM listing, no uploads. It is a play-money simulator for preservation and study.

**ROMs are not included.** Each player supplies their own ROM zip files and must own the right to use them.

## For players

1. Open the site's Games page.
2. Press **Add games** and choose zip files (several at once are fine), or **drag and drop** zips anywhere on the page.
3. Press a game to play.

The ROMs are saved in your browser (IndexedDB) on this device and are never uploaded, so they are still there after a reload or restart, and the site works offline once loaded. To remove one, press **Remove from this browser** on its card. Clearing the site's data in the browser also removes them.

Tips: on iPhone and iPad, use Share > Add to Home Screen, otherwise Safari deletes saved data after 7 days without a visit. Chrome and Firefox may ask to keep storage persistent: allow it.

## For the publisher

From the repository root:

```
distro/pages/build.sh          # same as: python3 tools/build-pages.py
```

Output: `dist/pages/` (includes LICENSE, README.md, NOTICE.md; games.json is trimmed to id, title, zip, size, reel count) (about 1.5 MB, git-ignored). It has the player, game maps, a web app manifest and a service worker for offline use. It leaves out the developer pages, and no ROMs are ever copied in.

Test locally: `python3 -m http.server -d dist/pages 8080 --bind 127.0.0.1`, then open <http://localhost:8080/>. Automated checks: `python3 tests/browser_pages.py` (offline reload) and `python3 tests/browser_pages_upload.py` (file input, drop, reload, remove, play).

Publish: copy the **contents of `dist/pages/` only** into its own public repository and enable GitHub Pages on it (branch root). Do not publish the ROM folder or the data folder, only the build output. The build also works under a sub-path such as `https://user.github.io/repo/`.

In this build, requests to `/api/` and `/roms/` are blocked in the page (`deploy/pages/pwa.js`), so it never looks for a server. Games load only from the browser's own saved ROMs.
