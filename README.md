# Monatsbudget

Persönliche Budget-App (Einkommen, Budget, Ausgaben pro Lohnperiode) mit Benutzerkonten.
Jede Person meldet sich an und sieht nur ihre eigenen Zahlen. Alles wird in einer
SQLite-Datenbank auf deinem Server gespeichert und täglich gesichert.

- **App:** `public/index.html` – Oberfläche und Rechenlogik aus dem ursprünglichen Claude-Artefakt,
  nur der Speicherteil wurde auf die Datenbank umgestellt (plus Konto-Bereich in den Einstellungen).
- **Login:** `public/login.html` – im selben Design.
- **Server:** `server/` – Node.js ohne zusätzliche Pakete (eingebautes `node:sqlite`).

## Funktionen

- Anmeldung mit Benutzername und Passwort; Sitzung bleibt 90 Tage bestehen (verlängert sich bei Nutzung)
- Das erste Konto wird beim ersten Aufruf angelegt und ist **Administrator**
- Admin kann in den Einstellungen Benutzer anlegen, löschen, Passwörter zurücksetzen und die
  Selbst-Registrierung ein- oder ausschalten (standardmässig aus)
- Jede Person kann ihr Passwort ändern und sich abmelden
- Änderungen erscheinen sofort auf allen angemeldeten Geräten (Live-Sync)
- Kurz ohne Verbindung? Änderungen bleiben im Browser gemerkt und werden nachgereicht
- Daten aus der früheren Version ohne Konten (im Browser gespeichert) werden beim ersten Login
  auf diesem Gerät automatisch ins Konto übernommen
- Sicherheit: Passwörter mit scrypt gehasht, HttpOnly-Cookies, Schutz gegen Cross-Site-Anfragen,
  Sperre nach 10 falschen Passwörtern (15 Minuten), Container läuft ohne Root-Rechte

## Auf dem NAS starten

`docker-compose.yml` aus diesem Repo verwenden:

- **Synology (Container Manager):** Projekt → Erstellen → Pfad wählen → YAML einfügen.
- **QNAP (Container Station):** Anwendungen → Erstellen → YAML einfügen.
- **Portainer / Unraid (Compose Manager):** Stack anlegen und YAML einfügen.
- **Per SSH:** `docker compose up -d` im Ordner mit der Datei.

Danach im Browser `http://<NAS-IP>:8090` öffnen und das Admin-Konto anlegen.

**Wichtig:** Den Pfad bei `volumes:` so wählen, dass er auf deinem NAS liegt, z. B.
`/volume1/docker/monatsbudget/data:/data` (Synology). Dort liegen die Datenbank und die Backups.
Ohne diesen Ordner gehen die Daten beim Neuerstellen des Containers verloren.

**Update:** `docker compose pull && docker compose up -d` (bzw. im NAS-GUI das Projekt neu erstellen).
Die Datenbank im Datenordner bleibt dabei erhalten.

### Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `BACKUP_KEEP` | `14` | So viele Tages-Backups aufbewahren, `0` schaltet Backups aus |
| `PUID` / `PGID` | `1000` | Dateien im Datenordner gehören diesem Benutzer/dieser Gruppe (wird beim Start automatisch gesetzt) |
| `TRUST_PROXY` | `false` | `true`, wenn ein Reverse Proxy davor läuft (echte Client-IP, HTTPS-Erkennung) |
| `COOKIE_SECURE` | `auto` | `true` erzwingt Cookies nur über HTTPS |
| `TZ` | – | Zeitzone, bestimmt das Datum im Backup-Dateinamen |

Soll die App **von ausserhalb** erreichbar sein, bitte nur über HTTPS (z. B. Reverse Proxy des NAS
mit Let's-Encrypt-Zertifikat) und dann `TRUST_PROXY: "true"` setzen.

## Datenbank und Backups

```
data/
├── monatsbudget.db          # Datenbank (SQLite)
└── backups/
    ├── monatsbudget-2026-09-27.db
    └── monatsbudget-2026-09-28.db
```

- Tabellen: `users`, `sessions`, `settings`, `months` (Einkommen/Budget pro Monat) und
  `expenses` (jede Ausgabe als eigene Zeile). Beträge werden in Rappen/Cent gespeichert.
- Backups entstehen beim Start und danach stündlich, sofern sich etwas geändert hat –
  eine Datei pro Tag, die ältesten werden nach `BACKUP_KEEP` Tagen gelöscht.
- **Wiederherstellen:** Container stoppen, `monatsbudget.db` durch die gewünschte Backup-Datei
  ersetzen (umbenennen in `monatsbudget.db`, `monatsbudget.db-wal` und `-shm` löschen), Container starten.
- Die Dateien lassen sich mit jedem SQLite-Programm öffnen (z. B. „DB Browser for SQLite“).

## Docker-Image

Jeder Push baut über GitHub Actions (`.github/workflows/docker-image.yml`) ein Image, nachdem
die Tests und ein Container-Test durchgelaufen sind:

```
ghcr.io/julianhintermann-cmd/quota:latest
```

| Tag | Wann |
|---|---|
| `latest` | Stand des Default-Branches |
| `<branch>` | Stand des jeweiligen Branches |
| `1.2.3`, `1.2` | beim Push eines Git-Tags `v1.2.3` |
| `sha-xxxxxxx` | jeder einzelne Commit |

Plattformen: `linux/amd64`, `linux/arm64`, `linux/arm/v7` – läuft also auf Intel/AMD- und ARM-NAS.

### Zusätzlich auf Docker Hub (optional)

Der Workflow pusht das Image zusätzlich nach Docker Hub als `<dein-dockerhub-name>/monatsbudget`,
sobald zwei Secrets hinterlegt sind:

1. Auf hub.docker.com: *Account settings → Personal access tokens → Generate new token*
   (Berechtigung *Read & Write*).
2. Auf GitHub im Repo: *Settings → Secrets and variables → Actions → New repository secret*
   - `DOCKERHUB_USERNAME` = dein Docker-Hub-Benutzername
   - `DOCKERHUB_TOKEN` = das Token aus Schritt 1
3. Unter *Actions → Docker-Image → Run workflow* einmal manuell starten (oder etwas pushen).

Ohne diese Secrets wird nur nach GHCR gepusht.

## Entwicklung

Voraussetzung: Node.js 22.13 oder neuer.

```
npm start          # Server auf http://localhost:8080, Daten in ./data
npm test           # API-Tests
```

Container lokal bauen und testen:

```
docker build -t monatsbudget .
test/smoke.sh monatsbudget
```
