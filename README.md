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
- Handy und Desktop: Auf dem Handy die gewohnte App-Ansicht, ab 960 px Breite automatisch ein
  Desktop-Layout (Übersicht und Kalender links, Ausgabenliste rechts, Dialoge statt Bottom-Sheets,
  Beträge per Tastatur, Löschen per Knopf beim Überfahren, Tastenkürzel ← → und N)
- Eigene Bedienelemente statt Browser-Standard: schmale Scrollbalken im App-Stil (erscheinen beim
  Scrollen, am Desktop auch ziehbar) und ein eigener Kalender für die Datumswahl mit Schnellwahl
  Heute/Gestern/Vorgestern (am Desktop per Pfeiltasten und Bild auf/ab bedienbar)
- Eigenes App-Icon und Web-App-Manifest: *Teilen → Zum Home-Bildschirm* (iPhone) bzw.
  *App installieren* (Android/Chrome) legt die App mit Icon an, sie startet danach ohne Browserleiste.
  Die Icons liegen in `public/icons/` und werden mit `node tools/build-icons.mjs` (Playwright) neu erzeugt.

### Neu in Version 3.0

- **Suche und Filter** über alle Monate (Text, Betrag, Monat, Kategorie); am Desktop mit der Taste `/`
- **Hell/Dunkel** von Hand wählen oder dem System folgen (Einstellungen → Darstellung, pro Gerät)
- **Eigene Kategorien** mit Symbol anlegen, umbenennen, löschen (Ausgaben gelöschter Kategorien zählen als „Sonstiges“)
- **Export** aller Ausgaben als CSV (Excel/Numbers) und vollständige **Sicherung** als JSON
- **Bankauszug importieren** (CSV): erkennt UBS, PostFinance, Raiffeisen, ZKB, Migros Bank, Revolut, Neon,
  Yuh, Wise und beliebige andere Exporte. Gutschriften werden ignoriert, bereits Erfasstes erkannt,
  Kategorien vorgeschlagen; Spalten lassen sich von Hand zuordnen. Die Datei verlässt dabei das Gerät nicht.
- **Statistik**: Ausgaben der letzten 6 oder 12 Monate mit Budget-Linie (auch als Tabelle),
  Kategorien im Vergleich zum Vormonat und Auffälligkeiten
- **Sparziele** mit Zielbetrag, optionalem Termin, nötiger Monatsrate, Ein- und Auszahlungen
- **Belegfotos mit KI**: Foto zur Ausgabe hinzufügen; über [OpenRouter](https://openrouter.ai) liest eine KI
  Betrag, Händler, Datum und Kategorie aus. Personen ohne Admin-Rechte haben 3 Analysen pro Tag
  (einstellbar), Admins unbegrenzt.
- **Offline-Hinweis**: Ist der Server nicht erreichbar, zeigt die App „Der Server scheint nicht erreichbar zu sein“
  und verbindet sich von selbst wieder (braucht HTTPS, siehe unten)
- **Face ID / Touch ID / Windows Hello** (Passkeys): in den Einstellungen einrichten, danach ohne Passwort anmelden –
  auf iPhone, iPad, Mac, Windows und Android (braucht HTTPS, siehe unten)
- **Neuigkeiten**: öffnen sich nach einem Update einmal von selbst, danach unter Einstellungen → App

### KI-Belegerkennung einrichten

1. Auf [openrouter.ai](https://openrouter.ai) ein Konto anlegen, etwas Guthaben laden und unter *Keys* einen Schlüssel erstellen.
2. In der App als Admin: *Einstellungen → KI-Belegerkennung* → Schlüssel einfügen → *Einrichten*.
   Optional ein anderes Modell wählen („Verfügbare Modelle mit Bilderkennung laden“) und das Tageslimit anpassen.
3. Fertig: Beim Erfassen einer Ausgabe oben rechts auf die Kamera tippen.

Der Schlüssel bleibt in der Datenbank auf deinem NAS und wird nie an den Browser geschickt (nur die letzten
4 Zeichen werden angezeigt). Alternativ lässt er sich per Umgebungsvariable `OPENROUTER_API_KEY` setzen.
Belegfotos werden verkleinert (max. 1600 px) im Datenordner unter `receipts/` gespeichert und nur zum Auslesen
an OpenRouter geschickt. Ein Beleg kostet mit dem Standardmodell Bruchteile eines Rappens.

### Face ID und Offline-Seite: nur über HTTPS

Browser erlauben Passkeys und die Offline-Seite (Service Worker) nur über **HTTPS mit einem Hostnamen** –
über `http://192.168.x.x:8090` geht beides nicht (die App zeigt dann einen Hinweis). Der einfachste Weg auf dem NAS:

- **Synology:** *Systemsteuerung → Anmeldeportal → Erweitert → Reverse Proxy*: Quelle `HTTPS`, Hostname
  z. B. `budget.dein-nas.synology.me`, Port `443` → Ziel `HTTP`, `localhost`, Port `8090`.
  Zertifikat unter *Sicherheit → Zertifikat* (Let's Encrypt).
- **QNAP:** *Netzwerk & Dateidienste → Reverse Proxy* analog.
- Danach in der YAML `TRUST_PROXY: "true"` setzen und die App über die HTTPS-Adresse öffnen.

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

**Update:** Dank `pull_policy: always` holt jedes Neuerstellen des Projekts die neueste Version. Per SSH: `docker compose pull && docker compose up -d`.
Die Datenbank im Datenordner bleibt dabei erhalten.

### Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `BACKUP_KEEP` | `14` | So viele Tages-Backups aufbewahren, `0` schaltet Backups aus |
| `PUID` / `PGID` | automatisch | Unter diesem Benutzer läuft die App; der Datenordner wird ihm übergeben (siehe unten) |
| `TRUST_PROXY` | `false` | `true`, wenn ein Reverse Proxy davor läuft (echte Client-IP, HTTPS-Erkennung) |
| `COOKIE_SECURE` | `auto` | `true` erzwingt Cookies nur über HTTPS |
| `TZ` | – | Zeitzone, bestimmt das Datum im Backup-Dateinamen und das Tageslimit der KI |
| `APP_URL` | – | Optional: feste Adresse der App (z. B. `https://budget.dein-nas.ch`), falls Passkeys hinter einem Proxy nicht klappen |
| `OPENROUTER_API_KEY` | – | Optional: OpenRouter-Schlüssel (sonst in der App eintragen) |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash` | Optional: Modell für die Belegerkennung (muss Bilder verstehen) |

### Rechte des Datenordners

Das Start-Skript wählt den Benutzer, unter dem die App läuft, selbst:

1. `PUID`/`PGID`, falls gesetzt.
2. Sonst den Besitzer des Datenordners – hast du den Ordner z. B. in der File Station mit deinem
   NAS-Konto angelegt, läuft die App als dieses Konto.
3. Sonst `1000:1000`; der Ordner wird diesem Benutzer übergeben.

Verhindern die Rechte der NAS-Freigabe das Schreiben trotzdem (typisch bei **Synology**, wo ACLs
statt der Linux-Rechte gelten), läuft die App als root weiter und schreibt einen Hinweis ins Log.
Wer das vermeiden will, setzt `PUID`/`PGID` auf das eigene NAS-Konto mit Schreibrecht auf die
Freigabe. Die Nummern zeigt `id <benutzername>` per SSH (Synology: meist `1026` und Gruppe `100`).

Soll die App **von ausserhalb** erreichbar sein, bitte nur über HTTPS (z. B. Reverse Proxy des NAS
mit Let's-Encrypt-Zertifikat) und dann `TRUST_PROXY: "true"` setzen.

## Datenbank und Backups

```
data/
├── monatsbudget.db          # Datenbank (SQLite)
├── receipts/                # Belegfotos
└── backups/
    ├── monatsbudget-2026-09-27.db
    └── monatsbudget-2026-09-28.db
```

- Tabellen: `users`, `sessions`, `settings`, `months` (Einkommen/Budget pro Monat),
  `expenses` (jede Ausgabe als eigene Zeile), `goals` und `goal_entries` (Sparziele), `receipts`
  (Belegfotos), `ai_usage` (Tageszähler der KI) und `passkeys`. Beträge werden in Rappen/Cent gespeichert.
- Ältere Datenbanken werden beim Start automatisch auf den neuen Stand gebracht.
- Belegfotos, die zu keiner Ausgabe mehr gehören, werden nach drei Tagen gelöscht.
  Die Backups enthalten die Datenbank, nicht die Fotos.
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
npm test           # API-Tests, Bank-Import-Parser, Passkeys, KI (mit nachgebautem OpenRouter)
```

Container lokal bauen und testen:

```
docker build -t monatsbudget .
test/smoke.sh monatsbudget
```
