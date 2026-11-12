#!/bin/sh
# Builds the Batocera / KNULLI port of the app (arm64 handhelds) into dist/knulli/: copy the contents of that folder into
# /userdata/roms/ports/ on the device, put ROM zips in ports/retro-pokies/Roms, and refresh the games list.
# It bundles the official Node.js for linux-arm64 (checked against nodejs.org's SHASUMS256.txt) and the @kmamal/sdl binding's arm64
# build, without its own SDL: the system's SDL (which has the device's video driver, such as mali) is used instead.
# usage: sh distro/knulli/build.sh   (needs curl, tar, xz, sha256sum; app/node_modules installed with npm install in app/)
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd); NODE=${NODE:-24.16.0}
SDLV=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/app/node_modules/@kmamal/sdl/package.json" | head -1)
OUT="$ROOT/dist/knulli"; P="$OUT/retro-pokies"; DL="$ROOT/dist/knulli-downloads"
rm -rf "$OUT"; mkdir -p "$P/web" "$P/node/bin" "$P/Roms" "$DL"
n="node-v$NODE-linux-arm64.tar.xz"; s="sdl.node-v$SDLV-linux-arm64.tar.gz"
[ -f "$DL/$n" ] || curl -sSLf -o "$DL/$n" "https://nodejs.org/dist/v$NODE/$n"
(cd "$DL" && curl -sSLf "https://nodejs.org/dist/v$NODE/SHASUMS256.txt" | grep " $n\$" | sha256sum -c -)
[ -f "$DL/$s" ] || curl -sSLf -o "$DL/$s" "https://github.com/kmamal/node-sdl/releases/download/v$SDLV/$s"
tar xJf "$DL/$n" -C "$DL"; cp "$DL/node-v$NODE-linux-arm64/bin/node" "$P/node/bin/"; cp "$DL/node-v$NODE-linux-arm64/LICENSE" "$P/node/"
# the app without its tests and tools, the engine and maps it loads from web/, the game data
mkdir -p "$P/app"; cp -r "$ROOT/app/src" "$ROOT/app/assets" "$ROOT/app/bin" "$ROOT/app/package.json" "$ROOT/app/README.md" "$ROOT/app/node_modules" "$P/app/"
rm -rf "$P/app/node_modules/@kmamal/sdl/dist"; mkdir -p "$P/app/node_modules/@kmamal/sdl/dist"
tar xzf "$DL/$s" -C "$P/app/node_modules/@kmamal/sdl/dist" sdl.node
cp -r "$ROOT/web/js" "$ROOT/web/maps" "$ROOT/web/favicon.png" "$ROOT/web/games.json" "$P/web/"
[ -d "$ROOT/data" ] && cp -r "$ROOT/data" "$P/"
cp "$ROOT/LICENSE" "$ROOT/NOTICE.md" "$P/"
cp "$ROOT/distro/knulli/RetroPokies.sh" "$ROOT/distro/knulli/RetroPokies.sh.keys" "$ROOT/distro/knulli/RetroPokies.txt" "$OUT/"
chmod +x "$OUT/RetroPokies.sh"
echo "built $OUT ($(du -sh "$OUT" | cut -f1))"
