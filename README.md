# DFM Signage

Selbst gehostetes, lokales Digital-Signage für **Raspberry Pi** im Corporate Design des Deutschen Fußballmuseums (Vorbilder: Yodeck, Anthias/Screenly OSE).
Oberfläche komplett auf Deutsch, für Menschen ohne Technikwissen. **Alles läuft ohne Internet** (keine Cloud, keine Telemetrie, keine Update-Pings, keine externen Schriften).

> **Flashen → einstecken → QR-Code scannen → fertig.** Danach ist keine Konsole, kein SSH und keine Tastatur nötig.

## Dokumentation
| Dokument | Für wen |
|---|---|
| [`docs/anwenderhandbuch.md`](docs/anwenderhandbuch.md) | Alle, die Bildschirme bespielen (mit Screenshots) |
| [`docs/technikhandbuch.md`](docs/technikhandbuch.md) | IT / Entwicklung: Image-Bau, Netzwerk, Backup, Updates, Fehlersuche |
| [`docs/sicherheit.md`](docs/sicherheit.md) | Sicherheitskonzept – auch, was **nicht** abgedeckt ist |
| [`docs/hardware-checkliste.md`](docs/hardware-checkliste.md) | Abnahme auf echten Geräten (Pi 3, Zero 2 W, Pi 4, Pi 5) |
| [`docs/hardware-empfehlung.md`](docs/hardware-empfehlung.md) | Welche Hardware (Netzteil, SD/SSD, USV, Kühlung) |
| [`docs/hub-ausgefallen.md`](docs/hub-ausgefallen.md) | „Hub ausgefallen: was tun?“ – Ersatz-Hub in 15 Minuten |
| [`docs/datenschutz.md`](docs/datenschutz.md) | Datenschutzblatt: welche Daten wo liegen, wie lange |
| [`docs/codec-entscheidung.md`](docs/codec-entscheidung.md) | Videoformat je Pi-Modell |
| [`docs/openapi.json`](docs/openapi.json), [`docs/websocket.md`](docs/websocket.md) | API und WebSocket-Protokoll |
| [`docs/nutzertest.md`](docs/nutzertest.md) | Protokoll für den Test mit einer Person ohne Technikkenntnisse |
| [`docs/abschlussbericht.md`](docs/abschlussbericht.md) | Stand, Messwerte, Testergebnisse, offene Punkte |
| [`docs/phase1-konzept.md`](docs/phase1-konzept.md), [`docs/entwurf/`](docs/entwurf/index.html) | Ursprüngliches Konzept und klickbarer Entwurf |

## Empfehlungen fürs Museumsnetz (kurz)
- Ein **eigenes Signage-WLAN ohne Internet**; *Client-/AP-Isolation aus*; **mDNS (UDP 5353) nicht filtern**.
- **Pi 3 und Zero 2 W: nur 2,4 GHz** anbieten.
- Dem Hub eine **feste IP** (DHCP-Reservierung) geben – die MAC-Adresse zeigt die Oberfläche unter *Bildschirme → Hub-Adresse & Fingerabdruck*.
- Hub: **Pi 4 (2 GB) oder besser, mit USB-SSD, Original-Netzteil, Kühlung und möglichst einer USV** (bei Stromausfall starten alle Geräte von selbst, Player zeigen bis dahin ihren Cache). Ein Pi 3/Zero 2 W als Hub bekommt eine Warnung (nur kleine Anlagen).

## Entwicklung
```bash
npm ci                 # Abhängigkeiten (Node ≥ 22)
npm test               # alle Tests (Chromium nötig für die E2E-Tests)
npm run build:ui       # Admin-Oberfläche bauen (admin-ui/dist)
node tools/gen-openapi.js        # API-Doku neu erzeugen
node tools/make-screenshots.js   # Handbuch-Bilder neu erzeugen
build/build-image.sh   # SD-Karten-Image bauen (siehe Technikhandbuch)
```
Design anpassen: `assets/dfm-logo.svg` und die Variablen in `assets/dfm-theme.css` (`--dfm-primary`, `--dfm-secondary`, `--dfm-accent`, `--dfm-bg`, `--dfm-text`) – gelten für Oberfläche, Einrichtungsseite, Playerseite und Boot-Bilder.

## Lizenz und Hinweise
Interne Software des DFM. Drittanbieter-Komponenten (Node.js, Fastify, SQLite, sharp, Chromium, mpv, ffmpeg …) behalten ihre Lizenzen.
