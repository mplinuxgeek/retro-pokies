#!/bin/sh
# scan-loop.sh - the scanner service of deploy/docker-compose.lan.yml: keeps the scan results (rom-status.json), screenshots and marquees in step
# with the code. Every result is stamped with the engine hash (tools/engine.js); a result from other code is redone once this code has been
# running SETTLE seconds (so a burst of deploys rescans once) and the result is at least MIN_AGE_H hours old (one rescan a day at most), oldest first.
# New ROMs get maps, results and screenshots on the next check. games.html "Rescan" (server.py POST /api/jobs/rescan) leaves rescan-request.json:
# {ids: [...]} redoes those games now, {ids: []} runs the stale check now without either wait. Progress: $ARISTO_DATA/scan-state.json.
# env: ROMS (default /app/roms), ARISTO_DATA (default /app/data), JOBS (16), SPINS (2500), CHECK seconds between checks (3600), SETTLE (1800),
#      MIN_AGE_H (24), RESCAN=1 (redo every game once at start)
set -eu
cd "$(dirname "$0")/.."
ROMS="${ROMS:-/app/roms}"; DATA="${ARISTO_DATA:-/app/data}"; JOBS="${JOBS:-16}"; SPINS="${SPINS:-2500}"
CHECK="${CHECK:-3600}"; SETTLE="${SETTLE:-1800}"; MIN_AGE_H="${MIN_AGE_H:-24}"
REQ="$DATA/rescan-request.json"; SEEN="$DATA/engine-seen"
mkdir -p "$DATA"
ENGINE=$(node tools/engine.js)
# when this engine was first seen, kept across restarts: a restart is not a new deploy
SINCE=$(date +%s)
if [ -f "$SEEN" ] && [ "$(cut -d' ' -f1 "$SEEN")" = "$ENGINE" ]; then SINCE=$(cut -d' ' -f2 "$SEEN"); else echo "$ENGINE $SINCE" > "$SEEN"; fi
echo "$(date '+%F %T') scanner: engine $ENGINE, live since $(date -d "@$SINCE" '+%F %T' 2>/dev/null || echo "$SINCE")"

state() {
  printf '{"engine":"%s","since":%s,"phase":"%s","at":%s,"request":"%s"}\n' "$ENGINE" "$SINCE" "$1" "$(date +%s)" "$2" > "$DATA/scan-state.json.tmp"
  mv "$DATA/scan-state.json.tmp" "$DATA/scan-state.json"
}
# scan FORCE ONLY: maps for new ROMs, then results and screenshots that are missing or stale (FORCE=1: whatever their age; ONLY: just those ids, or *)
scan() {
  echo "$(date '+%F %T') scan: maps for new ROMs"
  state maps "$2"; ROMS_DIR="$ROMS" node emu/autoscan.js || echo "autoscan failed"
  echo "$(date '+%F %T') scan: classify (${2:-stale and new}, $SPINS spins, $JOBS jobs)"
  state classify "$2"
  OUT="$DATA/rom-status.json" STALE=1 FORCE="$1" ONLY="$2" MIN_AGE_H="$MIN_AGE_H" SPINS="$SPINS" JOBS="$JOBS" node tools/classify.js "$ROMS" > "$DATA/classify.log" 2>&1 \
    || echo "classify failed (see $DATA/classify.log)"
  head -1 "$DATA/classify.log"
  echo "$(date '+%F %T') scan: screenshots and marquees"
  state shots "$2"
  ARISTO_DATA="$DATA" STALE=1 FORCE="$1" ONLY="$2" MIN_AGE_H="$MIN_AGE_H" JOBS="$JOBS" node tools/shots.js "$ROMS" || echo "shots failed"
  state idle ""
}

state idle ""
FIRST="${RESCAN:-0}"; LAST=0
while true; do
  NOW=$(date +%s)
  if [ -f "$REQ" ]; then
    IDS=$(node -e 'try { console.log((JSON.parse(require("fs").readFileSync(process.argv[1])).ids || []).join(",")) } catch (e) { console.log("") }' "$REQ")
    rm -f "$REQ"
    echo "$(date '+%F %T') rescan requested: ${IDS:-every stale game}"
    scan 1 "$IDS"; LAST=$NOW
  elif [ "$FIRST" = 1 ]; then
    FIRST=0; scan 1 "*"; LAST=$NOW
  elif [ $((NOW - LAST)) -ge "$CHECK" ] && [ $((NOW - SINCE)) -ge "$SETTLE" ]; then
    scan "" ""; LAST=$NOW
  fi
  sleep 60
done
