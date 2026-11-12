#!/bin/sh
# Starts Retro Pokies as a desktop app on a Mac: double-click it in Finder (it opens in Terminal). The first time, macOS may refuse a
# downloaded script: right-click it, choose Open, then Open again. Needs Node.js 22 or newer (the installer from https://nodejs.org/,
# or Homebrew's node); the first run installs the window library (SDL, about 7 MB). Games come from the roms folder next to this file.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; export PATH   # where the Node installer and Homebrew put node, in case the shell's PATH lacks them
"$(dirname "$0")/retro-pokies-desktop.sh" "$@" || { echo; echo "Press Return to close this window."; read x; }
