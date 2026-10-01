# /brag – Quota

## Was ist es?
Quota ist eine persönliche Budget-App, die nach **Lohnperioden** statt Kalendermonaten rechnet und als Docker-Container **auf dem eigenen NAS** läuft.

- **Für wen:** Leute, die monatlich wissen wollen, wie viel bis zum nächsten Lohn bleibt, ohne ihre Zahlen einer Cloud zu geben.
- **Was hebt es ab:** Lohnperiode statt Kalendermonat, selbst gehostet (SQLite, täglich gesichert), Belege per KI, mehrere Produkte pro Ausgabe, Monatsrückblick am Lohntag.
- **Stärkste Aussage:** „Verbleibend CHF 1'836.55 … bis zum Lohn 24 Tage“: die eine Zahl, die man wirklich wissen will.
- **Visueller Hook:** die schwarze „Verbleibend“-Karte der App, monochrom, Inter.
- **Echte UI/Flow:** Startseite → „+“ → „Mehrere Produkte“ (Apfel 2, Bananen 4, Wasser 3 = 9, aus dem README) → Rückblick „CHF 479.99 sind übrig geblieben“ → Statistik.
- **Ton:** `polished`, aber mit Tempo (`app-store`-Karten). Ruhig, präzise, Schweizer Understatement.
- **Share-Caption:** „Wie viel bleibt bis zum Lohn? Quota sagt es dir, auf deinem eigenen Server.“

## Angle
Die Frage, die sich jeder am 20. stellt: *„Wie viel bleibt bis zum Lohn?“* Quota beantwortet sie mit einer einzigen Karte, und die Daten bleiben zu Hause auf dem NAS.

## Visuelle Identität
- Farben aus `public/index.html`: `--bg #F2F2F0`, `--hero #111112`, `--hero-text #F4F4F1`, `--text #0B0B0C`, `--text-2 #6B6B70`, Akzent nur Schwarz/Weiss, `--danger #B8433A` sparsam.
- Schrift: Inter (die App fällt ohne SF Pro auf Inter zurück), 600/700, enge Laufweite (-0.025em) wie `.month-btn .mo`.
- Easing aus der App: `cubic-bezier(.22,1,.36,1)` und iOS-Sheet `cubic-bezier(.32,.72,0,1)`.
- Telefon zeigt echte Frames der laufenden App (Playwright, Animationen Frame für Frame gestoppt).

## Storyboard (1920×1080, 30 fps, 21.0 s, 120 BPM → Schnitte auf Beats)

| # | Zeit | Szene | Bild | Text | Ton |
|---|---|---|---|---|---|
| 1 | 0.0–2.5 | Hook | Schwarz (#111112). Wörter erscheinen nacheinander, dann stehen sie. | **Wie viel bleibt bis zum Lohn?** | Pad + gedämpfte Kick, kleiner Riser |
| 2 | 2.5–6.0 | Reveal | Wechsel auf hell (#F2F2F0). Telefon steigt von unten ein, echte Startseite. Links: App-Icon + „Quota“, darunter „Dein Budget pro Lohnperiode.“ Zoom auf die schwarze Karte „Verbleibend CHF 1'836.55 · Bis zum Lohn 24 Tage“. | Quota / Dein Budget pro Lohnperiode. | Drop: voller Beat |
| 3 | 6.0–11.0 | Highlight 1: Erfassen | Echte Aufnahme: Tipp auf „+“, Sheet fährt hoch, „Mehrere Produkte“, Apfel 2 · Bananen 4 · Wasser 3 werden getippt, Summe CHF 9.00, Hinzufügen. | Ein Einkauf, mehrere Produkte. | Tasten-Klicks in Tonart, leise |
| 4 | 11.0–14.5 | Highlight 2: Rückblick | Rückblick-Sheet fährt hoch: „CHF 479.99 sind übrig geblieben“, langsamer Scroll zu „Wohin das Geld ging“. | Am Lohntag: der Rückblick. | Whoosh in Tonart |
| 5 | 14.5–17.5 | Highlight 3: Eigener Server | Terminal-Karte tippt `docker compose up -d`, daneben Statistik-Sheet (Balken 6 Monate). | Läuft auf deinem NAS. Deine Daten bleiben bei dir. | Tipp-Klicks, dann Akkord |
| 6 | 17.5–21.0 | Outro | Schwarz. Icon, „Quota“, „Dein Budget. Auf deinem Server.“, klein `ghcr.io/julianhintermann-cmd/quota` | Punchline + Bezugsquelle | Schlussakkord, Ausklang |

Summe: 2.5 + 3.5 + 5.0 + 3.5 + 3.0 + 3.5 = **21.0 s**

## Sound
Selbst synthetisiert (numpy): 120 BPM, a-Moll → F → C → G, weiches Rhodes-artiges Pad, gezupfter Bass, Off-Beat-Hats. Klicks und Whooshes in derselben Tonart, mit gleichem Hall, deutlich unter der Musik.
