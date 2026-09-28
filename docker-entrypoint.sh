#!/bin/sh
# Startet kurz als root, um die Rechte des Datenordners zu setzen,
# und führt die App danach ohne Root-Rechte aus.
# Optional: PUID/PGID setzen, damit die Dateien einem bestimmten NAS-Benutzer gehören.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  uid="${PUID:-$(id -u node)}"
  gid="${PGID:-$(id -g node)}"
  mkdir -p "$DATA_DIR"
  # Nur anpassen, wenn etwas im Ordner nicht dem Zielbenutzer gehört
  if [ -n "$(find "$DATA_DIR" \( ! -user "$uid" -o ! -group "$gid" \) 2>/dev/null | head -n 1)" ] \
     || [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$uid:$gid" ]; then
    chown -R "$uid:$gid" "$DATA_DIR" 2>/dev/null || echo "Warnung: Rechte für $DATA_DIR konnten nicht gesetzt werden (benötigt cap_add CHOWN und DAC_OVERRIDE)." >&2
  fi
  echo "Monatsbudget: Datenordner $DATA_DIR, läuft als Benutzer $uid:$gid"
  if ! su-exec "$uid:$gid" sh -c 'touch "$1/.schreibtest" && rm -f "$1/.schreibtest"' _ "$DATA_DIR" 2>/dev/null; then
    echo "FEHLER: Der Datenordner $DATA_DIR ist für Benutzer $uid:$gid nicht beschreibbar." >&2
    echo "        Volume-Pfad prüfen, PUID/PGID auf deinen NAS-Benutzer setzen oder die Ordnerrechte anpassen." >&2
    exit 1
  fi
  exec su-exec "$uid:$gid" "$@"
fi
exec "$@"
