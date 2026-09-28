# Monatsbudget

Persönliche Budget-App (Einkommen, Budget, Ausgaben pro Lohnperiode) als einzelne HTML-Datei.
Die App (`index.html`) ist unverändert aus dem Claude-Artefakt übernommen und wird hier von
einem schlanken nginx-Container ausgeliefert.

## Docker-Image

Jeder Push baut automatisch ein Image über GitHub Actions
(`.github/workflows/docker-image.yml`) und legt es in der GitHub Container Registry ab:

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

> **Sichtbarkeit:** Neue Pakete auf GHCR sind zunächst privat. Entweder auf GitHub unter
> *Packages → quota → Package settings → Change visibility* auf **Public** stellen, oder auf dem
> NAS einmalig `docker login ghcr.io` mit einem Personal Access Token (Scope `read:packages`) ausführen.

## Auf dem NAS starten

`docker-compose.yml` aus diesem Repo verwenden:

- **Synology (Container Manager):** Projekt → Erstellen → Pfad wählen → „docker-compose.yml hochladen“.
- **QNAP (Container Station):** Anwendungen → Erstellen → YAML einfügen.
- **Portainer / Unraid (Compose Manager):** Stack anlegen und YAML einfügen.
- **Per SSH:** `docker compose up -d` im Ordner mit der Datei.

Danach im Browser: `http://<NAS-IP>:8090`. Der Port links in `ports:` ist frei wählbar.

**Update:** `docker compose pull && docker compose up -d` (bzw. im NAS-GUI „Projekt neu erstellen“ / „Image aktualisieren“).

## Wo liegen die Daten?

Die App speichert alles im Browser (`localStorage`) des jeweiligen Geräts – der Container selbst
speichert nichts und braucht kein Volume. Deshalb:

- Immer dieselbe Adresse aufrufen (z. B. nicht mal IP, mal Hostname), sonst sieht der Browser getrennte Speicher.
- Handy und Computer haben jeweils eigene Daten.
- Browserdaten für die Seite löschen = Budgetdaten weg.

Auf dem iPhone lässt sich die Seite über *Teilen → Zum Home-Bildschirm* wie eine App starten.

## Lokal testen

```
docker build -t monatsbudget .
docker run --rm -p 8090:8080 monatsbudget
```
