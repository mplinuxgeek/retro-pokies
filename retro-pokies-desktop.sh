#!/bin/sh
# Starts Retro Pokies as a desktop app (an SDL window, no browser or server needed).
# The first run installs the window library (SDL, about 7 MB) into app/node_modules; it needs Node.js 22 or newer and npm.
# Games come from the roms folder next to this file, or from the folder or ROM zip given on the command line.
# usage: ./retro-pokies-desktop.sh [ROM folder | ROM zip]
here=$(cd "$(dirname "$0")" && pwd); app="$here/app"
node="$app/node/bin/node"; [ -x "$node" ] || node=$(command -v node)
if [ -z "$node" ]; then echo "Retro Pokies needs Node.js 22 or newer: https://nodejs.org/ (or your package manager's nodejs)." >&2; exit 1; fi
major=$("$node" -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then echo "Retro Pokies needs Node.js 22 or newer; this one is $("$node" -v). Get a newer one from https://nodejs.org/" >&2; exit 1; fi
if [ ! -d "$app/node_modules/@kmamal/sdl" ]; then
  echo "First run: installing the window library (SDL, about 7 MB)..."
  npm --prefix "$app" install --omit=dev --no-audit --no-fund || { echo "Could not install it. Check the internet connection and that npm is installed, then try again." >&2; exit 1; }
fi
exec "$node" "$app/src/main.js" "$@"
