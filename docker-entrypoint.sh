#!/bin/sh
# Bereitet den Datenordner vor und startet die App – wenn möglich ohne Root-Rechte.
#
# Unter welchem Benutzer die App läuft:
#   1. PUID/PGID, falls gesetzt
#   2. sonst der Besitzer des Datenordners (z.B. der NAS-Benutzer, der ihn angelegt hat)
#   3. sonst "node" (1000:1000) – der Ordner wird ihm übergeben
# Darf dieser Benutzer trotzdem nicht schreiben (z.B. wegen ACLs einer Synology-Freigabe),
# läuft die App als root weiter und meldet das im Log.
set -e
DATA_DIR="${DATA_DIR:-/data}"

[ "$(id -u)" = "0" ] || exec "$@"

PROBE='f="$1/.schreibtest.$$"; touch "$f" && rm -f "$f"'
say() { echo "Quota: $*"; }
details() {
  echo "        Ordner: $(stat -c '%A %u:%g' "$DATA_DIR" 2>/dev/null), Mount: $(awk -v d="$DATA_DIR" '$2 == d { print $3, $4 }' /proc/mounts)" >&2
}
can_write() { su-exec "$1" sh -c "$PROBE" _ "$DATA_DIR" 2>/dev/null; }
can_write_root() { sh -c "$PROBE" _ "$DATA_DIR" 2>/dev/null; }
NODE_UID="$(id -u node 2>/dev/null || echo 1000)"
NODE_GID="$(id -g node 2>/dev/null || echo 1000)"

mkdir -p "$DATA_DIR"
owner="$(stat -c '%u:%g' "$DATA_DIR")"
explicit=0
if [ -n "$PUID" ] || [ -n "$PGID" ]; then
  target="${PUID:-$NODE_UID}:${PGID:-$NODE_GID}"
  explicit=1
elif [ "${owner%%:*}" != "0" ]; then
  target="$owner"
else
  target="$NODE_UID:$NODE_GID"
fi
uid="${target%%:*}"
gid="${target##*:}"

# Alles im Ordner dem Zielbenutzer übergeben (nur wenn nötig)
if [ -n "$(find "$DATA_DIR" \( ! -user "$uid" -o ! -group "$gid" \) 2>/dev/null | head -n 1)" ]; then
  chown -R "$target" "$DATA_DIR" 2>/dev/null || say "Warnung: Rechte für $DATA_DIR konnten nicht angepasst werden." >&2
fi

if can_write "$target"; then
  say "Datenordner $DATA_DIR, läuft als Benutzer $target"
  exec su-exec "$target" "$@"
fi

if [ "$explicit" = 1 ]; then
  echo "FEHLER: Der Datenordner $DATA_DIR ist für PUID/PGID $target nicht beschreibbar." >&2
  details
  echo "        PUID/PGID auf einen NAS-Benutzer mit Schreibrecht auf diesen Ordner setzen." >&2
  exit 1
fi

if can_write_root; then
  say "Hinweis: Benutzer $target darf nicht in $DATA_DIR schreiben (z.B. wegen ACLs der NAS-Freigabe)." >&2
  say "Die App läuft deshalb als root. Wer das nicht möchte: PUID/PGID auf den eigenen NAS-Benutzer setzen (siehe README)." >&2
  exec "$@"
fi

echo "FEHLER: Der Datenordner $DATA_DIR ist nicht beschreibbar." >&2
details
echo "        Ist das Volume schreibgeschützt eingebunden (:ro)?" >&2
exit 1
