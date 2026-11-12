#!/bin/bash
# Batocera / KNULLI port launcher for Retro Pokies in app mode (the engine in Node.js, an SDL window), for arm64 handhelds.
# Goes in /userdata/roms/ports/ next to the retro-pokies folder that distro/knulli/build.sh makes; ROM zips go in retro-pokies/Roms.
# The pad works through RetroPokies.sh.keys (Batocera's evmapy turns the buttons into keys). See RetroPokies.txt.
D="$(cd "$(dirname "$0")" && pwd)/retro-pokies"
cd "$D" || exit 1
mkdir -p "$D/Roms" "$D/save"
# settings, favourites, the balance and the picture cache stay in the port's own folder
export XDG_CONFIG_HOME="$D/save" XDG_CACHE_HOME="$D/save/cache"
[ -z "$XDG_RUNTIME_DIR" ] && [ -S /var/run/pipewire-0 ] && export XDG_RUNTIME_DIR=/var/run   # Batocera audio is PipeWire; a plain SSH shell lacks this
# first run: full screen, no banner (the game shows its own meters, and the menu button sits in the game's corner); F3 or the menu brings it back
if [ ! -f "$D/save/retro-pokies-desktop/settings.json" ]; then
  mkdir -p "$D/save/retro-pokies-desktop" && echo '{ "banner": false, "fullscreen": true }' > "$D/save/retro-pokies-desktop/settings.json"
fi
# glibc keeps freed picture memory (each game's images are some 150 MB) unless large blocks are always mapped and the heap trimmed:
# without these the app grew past 450 MB after a few games, which locked up a 1 GB handheld
export MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072
# the D-pad keeps left / right for the bet and up / down for the lines in a game (a keyboard has them the other way round, as the web build)
export RP_PAD=1
[ -f "$D/local.env" ] && . "$D/local.env"
exec ./node/bin/node app/src/main.js "${ROMS:-$D/Roms}" > "$D/retro-pokies.log" 2>&1
