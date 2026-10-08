# DFM Signage – Projektwissen für Claude

Lokales Digital-Signage-System auf Raspberry Pi für das **Deutsche Fußballmuseum** (Ersatz für Yodeck). Hub + Player, alles im Museumsnetz, ohne Cloud. Ausgeliefert als flashbares arm64-SD-Karten-Image.

## Zusammenarbeit mit dem Nutzer
- **Immer auf Deutsch** antworten, in einfacher Sprache. Der Nutzer ist kein Entwickler und hat **keinen Linux-Rechner** (Windows/Handy).
- Prioritäten der Aufgabenstellung, in dieser Reihenfolge: **LOKAL → SICHER → EINFACH → ROBUST**.
- Oberfläche für Menschen ohne Technikwissen: Klartext, keine Fehlercodes, Hinweise mit Handlungsanweisung.
- Ehrlich berichten: Was nur in Tests/Emulation geprüft ist, nicht als „auf Hardware bestätigt“ ausgeben. Viele Punkte sind **noch nicht auf echten Pis gemessen** (siehe `docs/hardware-checkliste.md`, E1–E12).
- Nach jeder Änderung: Tests laufen lassen, committen, pushen. Arbeitszweig: `claude/hallo-ip4164`.

## Hardware beim Kunden (wichtig für Entscheidungen)
- Im Haus gibt es **nur Raspberry Pi 3 B+** (1 GB RAM), alle mit Kühlkörper und Gehäuse.
- Geplanter Pilot: **ein Pi 3 B+ an einem Bild-Bildschirm als „Hub und Bildschirm in einem“** (Rolle `kombi`), **ein Pi 3 B+ am Video-Bildschirm** als normaler Player (Einstellung „Video-optimiert“ = mpv testen), übrige als Player.
- Inhalte: Bilder; Videos sind **immer Full HD, ca. 4 Minuten**, MP4. Kunde achtet darauf, dass kein 4K hochgeladen wird.
- Pi 3 B+ kann 2,4 und 5 GHz (Pi 3 B ohne Plus und Zero 2 W nur 2,4 GHz).
- Offenes Angebot: Pi 3 B+ drosselt ab 60 °C – bei Bedarf `temp_soft_limit=70` unter `[pi3]` in `build/boot/config.txt.add` setzen (erst nach Messwerten vom Kunden).

## Aufbau des Repos
- `hub/` – Fastify 5 + better-sqlite3 (WAL, Migrationen `hub/migrations/00N_*.sql` per `PRAGMA user_version`). Plugins: `lib/auth.js`, `devices.js`, `content.js`, `extras.js` (Live, Schnellaktionen, Gesundheit, WLAN, Ersetzen), `extras2.js` (Vorlagen, QR, Sondertage, Zonen, Inbetriebnahme, Import, Datenschutz), `extras3.js` (Hochkant, gestaffelte Updates, Lizenz/Ablauf), `system.js`, `variants.js` (Medien-Varianten, Video-Umverpacken), `plan.js` (14-Tage-Plan je Gerät).
- `player/agent/` – Agent je Bildschirm (Pairing mit SPKI-Pinning, WSS, Sync, Renderer Chromium-Kiosk oder mpv, privd für Root-Aktionen). `player/chromium/` – Playerseite.
- `shared/` – Zeitplan-Logik (`schedule.js`, `sequencer.js` mit Auflösungsreihenfolge Halt → Übersteuerung → Termin → Sondertag → Standard → Standby), `protocol.js` (WebSocket-Schemas).
- `setup/` – Einrichtung per QR/Handy (Hotspot), Erststart, Netzwächter, GPIO-Taster, WLAN-Wechsel mit Rückfall.
- `admin-ui/` – Oberfläche (Vanilla JS, esbuild): `npm run build:ui`.
- `build/` – Image-Bau (pi-gen + `assemble-image.sh`, `check-image.mjs` mit 27 Prüfungen), `build/rootfs/` (systemd-Units, `/usr/lib/dfm/*`).
- `tools/` – Screenshots, OpenAPI, Simulator-Player, Übersicht-PDF (`make-uebersicht-pdf.mjs`).
- `docs/` – Handbücher (Anwender, Technik, Sicherheit, Datenschutz, Hardware, Hub-Ausfall), Abschlussbericht.

## Regeln im Code
- Jede `/api/v1`-Route braucht `config.perm|public|device|authenticated` (sonst startet der Server nicht; Test prüft jede Route je Rolle). Rollen: `admin`, `editor`, `anzeige`.
- Fastify-Plugins mit `Symbol.for('skip-override')`.
- Strenge CSP: keine Inline-Styles/-Skripte außer per CSSOM (`style.cssText` in `h()`), keine externen Hosts (Image-Prüfung „Oberflächen verweisen auf keine externen Hosts“ – auch keine `https://…`-Platzhalter in der UI!).
- Shell-Aufrufe nur per `execFile` mit Argumentlisten. Root-Aktionen nur über die privd-Whitelist (`player/agent/lib/privd.js`, Test erlaubt höchstens 8 Aktionen).
- Einrichtungsdateien: `hub-bootstrap.json`/`local-player.json` nach `/data/hub` (uid 990), `agent.json` nach `/data/agent` (uid 991) – siehe `setup/lib/config.js`.
- Entwurf/Veröffentlichen: Player und Live sehen nur veröffentlichte Stände.

## Befehle
```bash
npm ci                         # Node 22
npm test                       # ~136 Tests, ~20 Min. (E2E braucht Chromium; Playwright-Core)
npm run build:ui
node tools/gen-openapi.js
node tools/make-screenshots.js && node tools/make-screenshots-extra.js && node tools/make-uebersicht-pdf.mjs
```
Image bauen: **nicht lokal nötig** – GitHub Actions Workflow `.github/workflows/image.yml` („Image bauen“, Eingabe `version`, z. B. `v0.2.2`), Ergebnis unter Releases.

## Stand (Oktober 2026)
- Version **0.2.11**: Hub-Ger?t (kombi, sp?ter Pi 3 B+) zeigt nur Bilder ?ber mpv statt Chromium (renderer=mpv bei Einrichtung + im Hub gesetzt; im Hub unter Wiedergabe auf ?browser? umstellbar), mpv-Fehler im Journal, Adresse der Verwaltung als OSD im Standby. Zuvor 0.2.10: Diagnose vom Pi (noch 0.2.6) zeigte Kernel-OOM: ffmpeg-Testvideo der Hub-Diagnose (x264 medium) brauchte 285 MB und wurde beendet (OOMScoreAdjust=300 sch?tzt die Anzeige, wie gewollt) ? jetzt veryfast + 2 Threads auf Ger?ten < 1,5 GB, sharp 2 Threads; dpkg-db-backup/logrotate/console-setup maskiert (schlugen wegen ro-Root fehl). Zuvor 0.2.9: Pilot: Hub ?ber Hotspot erreichbar, Uhr-Warnung (normal), aber Bildschirm zeigt nichts (Ursache offen). Neu: cage/Chromium-Fehler landen im Agent-Journal (stderr), plymouth quit als root, Diagnose zeigt 70 Agent-Zeilen. N?chster Schritt: dfm-diagnose.txt von 0.2.9 lesen. Zuvor 0.2.8: Netzwerkkabel ging nie (NetworkManager no-auto-default=* ? kein eth0-Profil) ? behoben; Hub-Bildschirm zeigt im Standby seine Adresse (https://<IP>). Pilot-Netz: WLAN DFM_PRESSE trennt/blockiert (Firewall) ? Test ?ber eigenen Hotspot/Router. Zuvor 0.2.7: Pilot mit 0.2.6: Hub l?uft (443/80), Fontconfig-Fehlerflut behoben (XDG_CACHE_HOME + fc-cache). Anzeige (cage/Chromium) noch unbest?tigt ? Diagnose 0.2.7 zeigt Prozesse/Sitzungen. Zuvor 0.2.6: zweiter Pilot-Fehler (Diagnose von 0.2.5): Einrichtungsdienst (root, ohne CAP_CHOWN) legte /data/hub/tls als root an ? Hub konnte hub.key nicht schreiben. Behoben: CAP_CHOWN am Setup-Dienst + chown -R 990 /data/hub/tls in datamount.sh. Zuvor 0.2.5: Ursache des Pilot-Fehlers (0.2.2/0.2.4) gefunden per Diagnosedatei: dfm-hub.service sperrte AF_NETLINK ? os.networkInterfaces() warf Fehler 97, Hub startete nie (Absturzschleife); gleiche Sperre am Agent verhindert vermutlich auch Cage/Chromium (udev). Behoben + Test tests/systemd-units.test.js. Offen/bekannt: NetworkManager kann /etc/resolv.conf nicht schreiben (Root ro, nur Warnung); Avahi liest /etc/avahi/services nicht (Symlink nach /run + chroot) ? Dienst-Ank?ndigung fehlt. Vorher 0.2.4 (Image mit Chromium-Richtlinien-Korrektur, Hub-Schutz, Diagnosedatei `dfm-diagnose.txt` auf der Boot-Partition). Gemeldeter Fehler beim Pilot mit 0.2.2: nach der Einrichtung grauer Bildschirm / „Diese Seite ist blockiert“, Hub antwortet nicht auf 80/443 – Ursache noch **nicht bestätigt**; `dfm-diagnose.txt` vom Pi auslesen. Werkzeuge: Workflow „Tests“ (npm test unter Linux bei jedem Push), Workflow „Image prüfen“ (`build/smoke-test-image.sh`: Image einbinden, echten Hub + Chromium per Emulation prüfen). Lokal unter Windows laufen ~14 Tests rot (kein ffmpeg/Symlinks/Dateirechte) – Linux-CI ist maßgeblich.
- Version 0.2.2 enthielt: alle Funktionen inkl. Erweiterung (Z.1–Z.15), Teil E, „Hub und Bildschirm in einem“, Video-Umverpacken ohne Neuberechnung, volle Ressourcennutzung (keine MemoryMax, zram, OOM-Vorrang für Anzeige), Wiedergabe-Optimierung (GPU-Flags, CMA, performance-Governor, Decoder-Freigabe, wählbare mpv-Wiedergabe).
- Nächster Schritt: **Kunde testet mit Pi 3 B+** und meldet Ergebnisse (Ruckler, Wartezeiten, Temperatur/Speicher unter Betrieb → Gesundheit). Danach gezielt anpassen.
- Details und offene Punkte: `docs/UEBERGABE.md`, `docs/abschlussbericht.md`.
