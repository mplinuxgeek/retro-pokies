# Self-hosted Retro Pokies web player. Build from the repository root (docker-compose.yml does that):
#   docker compose up -d --build
# Contains only what the player serves: server.py, web/ (without the developer pages) and the few files tools/shots.js needs for server-side
# screenshots. No ROMs. Users mount their own ROM folder read-only at /roms.
FROM python:3.11-alpine

RUN apk add --no-cache nodejs \
 && adduser -D -u 10001 aristo \
 && mkdir -p /app/tools/data /data /roms \
 && chown aristo /data

WORKDIR /app
COPY server.py NOTICE.md ./
COPY web/ ./web/
COPY tools/shots.js tools/engine.js ./tools/
COPY tools/data/syscalls.json tools/data/exports.json ./tools/data/
# developer-only pages, the same set tools/build-pages.py leaves out
RUN cd web && rm -rf debug.html js/scan-worker.js

ENV ARISTO_ROMS=/roms \
    ARISTO_DATA=/data \
    ARISTO_STATUS=/data/rom-status.json \
    ARISTO_FEEDBACK=/data/visual-feedback.json \
    SHOT_JOBS=2

USER aristo
VOLUME ["/data"]
EXPOSE 8791

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8791/api/roms')" || exit 1

ENTRYPOINT ["python3", "server.py", "8791", "0.0.0.0"]
