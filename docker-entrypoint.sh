#!/bin/sh
# Startet kurz als root, um die Rechte des Datenordners zu setzen,
# und führt die App danach ohne Root-Rechte aus.
# Optional: PUID/PGID setzen, damit die Dateien einem bestimmten NAS-Benutzer gehören.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  RUN_AS="${PUID:-$(id -u node)}:${PGID:-$(id -g node)}"
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$RUN_AS" ]; then
    chown -R "$RUN_AS" "$DATA_DIR"
  fi
  exec su-exec "$RUN_AS" "$@"
fi
exec "$@"
