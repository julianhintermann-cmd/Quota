#!/usr/bin/env bash
# Startet das Docker-Image wie auf dem NAS (gleiche Härtung, gemounteter Ordner)
# und prüft Einrichtung, Speichern, Laden, Neustart und Dateirechte.
set -euo pipefail
IMAGE="${1:?Aufruf: test/smoke.sh <image>}"
PORT=18090
B="http://127.0.0.1:$PORT"
DIR="$(mktemp -d)"
NAME="monatsbudget-smoke-$$"
JAR="$(mktemp)"
H=(-H 'X-Requested-With: monatsbudget' -H 'Content-Type: application/json')

run() {
  docker run -d --name "$1" -p "$PORT:8080" -v "$2:/data" "${@:3}" \
    --read-only --tmpfs /tmp --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
    --security-opt no-new-privileges:true "$IMAGE" >/dev/null
}
wait_ready() {
  for _ in $(seq 1 30); do curl -fsS "$B/healthz" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "Server startet nicht"; docker logs "$1"; return 1
}
cleanup() { docker rm -f "$NAME" "$NAME-puid" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'echo "✗ Fehler in Zeile $LINENO"; docker logs "$NAME" 2>&1 | tail -20 || true' ERR
# Der Datenordner gehört nach dem Start dem App-Benutzer; der Host prüft ihn als root (wie auf dem NAS)
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"

echo "▸ Start mit leerem Ordner"
run "$NAME" "$DIR"
wait_ready "$NAME"

echo "▸ Ohne Anmeldung → Login"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/")" = 302 ]

echo "▸ Admin einrichten, Monat speichern, laden"
curl -fsS -c "$JAR" "${H[@]}" -d '{"username":"admin","password":"smoke-test-123"}' "$B/api/auth/setup" >/dev/null
curl -fsS -b "$JAR" "${H[@]}" -X PUT \
  -d '{"income":100,"budget":50,"expenses":[{"id":"x1","amt":12.5,"title":"Test","cat":"essen","date":"2026-01-05","rep":false,"ts":1}]}' \
  "$B/api/months/2026-01" >/dev/null
grep -q '"amt":12.5' <<<"$(curl -fsS -b "$JAR" "$B/api/data")"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$B/")" = 200 ]

echo "▸ Datenbank und Backup liegen im gemounteten Ordner, Prozess läuft nicht als root"
$SUDO test -f "$DIR/monatsbudget.db"
[ "$($SUDO stat -c %u "$DIR/monatsbudget.db")" = 1000 ]
grep -q '^monatsbudget-.*\.db$' <<<"$($SUDO ls "$DIR/backups")"
[ "$(docker exec "$NAME" stat -c %u /proc/1)" = 1000 ]
grep -q node <<<"$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')"
[ "$(docker exec -u 1000 "$NAME" sh -c 'grep CapEff /proc/1/status' | awk '{print $2}')" = 0000000000000000 ]

echo "▸ Neustart: Daten und Anmeldung bleiben erhalten"
docker restart "$NAME" >/dev/null
wait_ready "$NAME"
grep -q '"amt":12.5' <<<"$(curl -fsS -b "$JAR" "$B/api/data")"
docker rm -f "$NAME" >/dev/null

echo "▸ PUID/PGID: Dateien gehören dem gewünschten Benutzer"
DIR2="$(mktemp -d)"
run "$NAME-puid" "$DIR2" -e PUID=1234 -e PGID=1234
wait_ready "$NAME-puid"
[ "$($SUDO stat -c '%u:%g' "$DIR2/monatsbudget.db")" = "1234:1234" ]

echo "✓ Smoke-Test bestanden"
