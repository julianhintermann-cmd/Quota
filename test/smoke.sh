#!/usr/bin/env bash
# Startet das Docker-Image wie auf dem NAS (gleiche Härtung, gemounteter Ordner)
# und prüft Einrichtung, Speichern, Laden, Neustart und die Rechte des Datenordners.
set -Eeuo pipefail
IMAGE="${1:?Aufruf: test/smoke.sh <image>}"
PORT=18090
B="http://127.0.0.1:$PORT"
NAME="monatsbudget-smoke-$$"
JAR="$(mktemp)"
H=(-H 'X-Requested-With: monatsbudget' -H 'Content-Type: application/json')
HARDEN=(--read-only --tmpfs /tmp --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE
        --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true)
# Datenordner gehören nach dem Start anderen Benutzern; der Host prüft sie als root (wie auf dem NAS)
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "✗ Fehler in Zeile $LINENO"; docker logs "$NAME" 2>&1 | tail -20 || true' ERR

# Ordner mit bestimmtem Besitzer und Modus anlegen
mkdata() { local d; d="$(mktemp -d)"; $SUDO chown "$1" "$d"; $SUDO chmod "$2" "$d"; echo "$d"; }
start() { cleanup; docker run -d --name "$NAME" -p "$PORT:8080" -v "$1:/data" "${@:2}" "${HARDEN[@]}" "$IMAGE" >/dev/null; wait_ready; }
wait_ready() {
  for _ in $(seq 1 30); do curl -fsS "$B/healthz" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "Server startet nicht"; docker logs "$NAME"; return 1
}
app_uid() { docker exec "$NAME" stat -c %u /proc/1; }
save_and_load() {
  curl -fsS -c "$JAR" "${H[@]}" -d '{"username":"admin","password":"smoke-test-123"}' "$B/api/auth/setup" >/dev/null
  curl -fsS -b "$JAR" "${H[@]}" -X PUT \
    -d '{"income":100,"budget":50,"expenses":[{"id":"x1","amt":12.5,"title":"Test","cat":"essen","date":"2026-01-05","rep":false,"ts":1}]}' \
    "$B/api/months/2026-01" >/dev/null
  grep -q '"amt":12.5' <<<"$(curl -fsS -b "$JAR" "$B/api/data")"
}

echo "▸ Von Docker angelegter Ordner (root): App übernimmt ihn und läuft als 1000"
DIR="$(mkdata 0:0 755)"
start "$DIR"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/")" = 302 ]
save_and_load
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$B/")" = 200 ]
$SUDO test -f "$DIR/monatsbudget.db"
[ "$($SUDO stat -c %u "$DIR/monatsbudget.db")" = 1000 ]
grep -q '^monatsbudget-.*\.db$' <<<"$($SUDO ls "$DIR/backups")"
# Belegfoto speichern (Ordner receipts/ muss beschreibbar sein) und wieder abrufen
PNG="$(mktemp)"; printf '\x89PNG\r\n\x1a\n0000smoke' >"$PNG"
RC="$(curl -fsS -b "$JAR" -H 'X-Requested-With: monatsbudget' -H 'Content-Type: image/png' --data-binary @"$PNG" "$B/api/receipts" | sed -E 's/.*"id":"([a-f0-9]+)".*/\1/')"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$B/api/receipts/$RC")" = 200 ]
$SUDO test -f "$DIR/receipts/$RC.png"
rm -f "$PNG"
[ "$(app_uid)" = 1000 ]
grep -q node <<<"$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')"
[ "$(docker exec -u 1000 "$NAME" sh -c 'grep CapEff /proc/1/status' | awk '{print $2}')" = 0000000000000000 ]

echo "▸ Neustart: Daten und Anmeldung bleiben erhalten"
docker restart "$NAME" >/dev/null
wait_ready
grep -q '"amt":12.5' <<<"$(curl -fsS -b "$JAR" "$B/api/data")"

echo "▸ Ordner eines NAS-Benutzers (1026:100): App läuft als dieser Benutzer, nichts wird umgeschrieben"
DIR="$(mkdata 1026:100 700)"
start "$DIR"
save_and_load
[ "$(app_uid)" = 1026 ]
[ "$($SUDO stat -c '%u:%g' "$DIR")" = "1026:100" ]

echo "▸ Besitzer darf nicht schreiben (wie bei NAS-ACLs): App läuft trotzdem, als root"
DIR="$(mkdata 1000:1000 500)"
start "$DIR"
save_and_load
[ "$(app_uid)" = 0 ]
grep -q "läuft deshalb als root" <<<"$(docker logs "$NAME" 2>&1)"

echo "▸ PUID/PGID: Dateien gehören dem gewünschten Benutzer"
DIR="$(mkdata 0:0 755)"
start "$DIR" -e PUID=1234 -e PGID=1234
[ "$(app_uid)" = 1234 ]
[ "$($SUDO stat -c '%u:%g' "$DIR/monatsbudget.db")" = "1234:1234" ]
cleanup

echo "▸ Schreibgeschützter Datenordner: klare Fehlermeldung statt stillem Absturz"
DIR="$(mktemp -d)"
set +e
out="$(docker run --rm -v "$DIR:/data:ro" "${HARDEN[@]}" "$IMAGE" 2>&1)"
code=$?
set -e
echo "$out"
[ "$code" = 1 ]
grep -q "nicht beschreibbar" <<<"$out"

echo "✓ Smoke-Test bestanden"
