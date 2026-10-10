# DFM Signage – Technikhandbuch

Für die IT und alle, die das System bauen, betreiben oder erweitern. Sicherheitskonzept: `sicherheit.md`. API: `openapi.json`, `websocket.md`.

## 1. Überblick und Architektur

```
 Handy ──WLAN DFM-Setup-xxxx──► dfm-setup (nur im Einrichtungsmodus)
 Admin-Browser ──HTTPS 443──►  ┌──────────── HUB (ein Pi) ────────────┐
                               │ dfm-hub: Node 22 + Fastify + SQLite  │
                               │ Medien, Varianten (ffmpeg/sharp)     │
                               │ chrony (NTP-Quelle), avahi (mDNS)    │
                               └───────────▲──────────────────────────┘
                              WSS 443 + HTTPS, SPKI-Pinning
                               ┌───────────┴──────────────────────────┐
                               │ PLAYER: dfm-agent (Node)             │
                               │  ├ Standard/Pro: cage + Chromium     │
                               │  └ Lite: mpv (DRM/KMS, ohne Browser) │
                               │ Cache + Zeitplan (14 Tage) lokal     │
                               └──────────────────────────────────────┘
```

| Verzeichnis | Inhalt |
|---|---|
| `hub/` | Backend (`app.js`, `server.js`, `lib/*`, Migrationen, Tests) |
| `admin-ui/` | Oberfläche (Vanilla-JS, esbuild → `dist/`, Gzip/Brotli vorkomprimiert, Startseite ≈ 23 KB gzip) |
| `player/agent/` | Player-Agent, Pinning, Pairing, Sync, lokaler Server, Renderer, `privd` |
| `player/chromium/` | Playerseite (Vanilla-JS) für den Kiosk |
| `player/lite/` | Platzhalter: der Lite-Renderer (mpv) steckt in `player/agent/lib/renderers.js` |
| `setup/` | Einrichtungsdienst, Erststart, Parser, Netzwächter |
| `shared/` | Code, den Hub, Agent und Browser gemeinsam nutzen: Zeitplan, Zeitzone, Protokoll, Update-Prüfung |
| `build/` | Image-Bau (pi-gen), Systemdateien, Prüfwerkzeuge, Signieren |
| `tests/`, `*/test/` | Automatische Tests (`npm test`) |
| `tools/` | Screenshots, OpenAPI, Messung, Diagnose |
| `assets/` | Logo, Design-Variablen (`dfm-theme.css`) – **hier das echte DFM-Corporate-Design eintragen** |

**Entscheidung Medien-Auslieferung:** Fastify direkt (kein nginx): ein Prozess weniger, ein TLS-Stack, weniger RAM und Angriffsfläche; Range-Unterstützung ist eingebaut. Wird auf Pi 3 mit 4 parallelen Downloads gemessen (Checkliste D); bleibt der Durchsatz deutlich hinter nginx, ist ein Wechsel hinter derselben URL möglich.

**Entscheidung Hotspot:** NetworkManager-Hotspot (`nmcli`, intern `wpa_supplicant` + dnsmasq) statt separatem `hostapd`: ein Werkzeug weniger, gleiche Funktion; dnsmasq-Konfiguration `address=/#/10.42.0.1` macht das Captive Portal.

**Entscheidung Firewall:** `nftables` statt `ufw`: kleinere Abhängigkeitsmenge, schreibgeschütztes Root; Regeln je Betriebsart in `build/rootfs/usr/share/dfm/nft-*.conf`.

## 2. Image bauen

**Voraussetzungen (Entwicklungsrechner, nicht der Pi):** Linux, Docker mit privilegierten Containern (für pi-gen), `qemu-user-static` mit registriertem `aarch64`-Handler (bei x86-Rechnern), Node ≥ 22, git, xz, openssl, curl, ~25 GB frei, Internet **nur zur Bauzeit** (Debian-/Raspberry-Pi-Pakete, Node-Archiv, npm-Binärpakete).

**Ablauf des Bauskripts:** (1) Tests + Oberfläche bauen, (2) Anwendung zusammenstellen und die Laufzeit-Abhängigkeiten **auf dem Entwicklungsrechner für linux/arm64 installieren** (`npm ci --os=linux --cpu=arm64`; `build/check-native.js` prüft jedes `.node`-Modul auf ARM64), Node-Archiv laden und per SHA-256 prüfen, (3) Boot-Bilder erzeugen, (4) pi-gen (`bookworm-arm64`) baut das Root-Dateisystem (Stufen 0–2 + `stage-dfm`: Pakete, Aufräumen, Dienste, Härtung), (5) `build/assemble-image.sh` setzt daraus das Image zusammen – **ohne Loop-Geräte und ohne Einbinden**: `mkfs.ext4 -d` und `mtools` erzeugen die Dateisysteme direkt aus Verzeichnissen, `sfdisk` schreibt die Partitionstabelle –, danach läuft `build/check-image.mjs` (siehe `sicherheit.md`), (6) xz, SHA-256, Ed25519-Signatur. Bricht der Bau in `stage-dfm` ab, setzt `build/build-image.sh --continue` dort fort (der Container `dfm-pigen` bleibt erhalten).

```bash
build/gen-release-key.sh ~/dfm-release-key.pem     # einmalig: Ed25519-Schlüsselpaar (privat NIE ins Repository)
export DFM_SIGN_KEY=~/dfm-release-key.pem
build/build-image.sh                                # Tests, UI, pi-gen, Layout, Prüfung, xz, SHA-256, Signatur (30–120 min)
```
Ergebnis in `build/out/`: `dfm-signage-arm64-<version>.img.xz`, `.sha256`, `.sig`, `check-<version>.txt`, `build-info-<version>.txt` (pi-gen-Commit).
Prüfen: `build/verify-release.sh build/out/dfm-signage-arm64-<version>.img.xz` (nutzt `build/keys/update-key.pub`).

**Reproduzierbarkeit:** pi-gen-Branch/Commit (`PIGEN_REF`, in `build-info` vermerkt), Node-Version samt Prüfsumme, `package-lock.json` + `npm ci`. *Bit-genau* identisch sind zwei Builds nicht (ext4-Zeitstempel, Debian-Paketstand); Ziel ist „funktional reproduzierbar“. Für strengere Reproduzierbarkeit `PIGEN_REF` auf einen Commit-Hash und einen Debian-Snapshot-Mirror festlegen.

**Image B (armhf-lite) entfällt:** Pi Zero W/Pi 1 sind ARMv6 – Debian Stable (armhf) läuft darauf nicht; 512 MB RAM; zweiter Build und zweite Testmatrix. Alternative: Pi Zero 2 W (Lite-Profil im arm64-Image).

### Partitionen
| Nr | Name | Dateisystem | Zugriff | Inhalt |
|---|---|---|---|---|
| p1 | boot | FAT32 | nur lesen (kurz schreibbar beim Erststart) | Kernel, `cmdline.txt`, `dfm-setup.vorlage.txt`, `LIES-MICH.txt`, später `geraeteinfo.txt` |
| p2 | root | ext4 | **schreibgeschützt** | System, Node, Chromium, Anwendung (`/opt/dfm`) |
| p3 | `DFMDATA` | ext4 | schreibbar | `/data`: Hub-Daten, Agent-Cache, NetworkManager-Profile, Journal (50 MB), Schlüssel; wächst beim ersten Start auf die ganze Karte (`growpart`) |

`/tmp`, `/var/log` u. a. liegen im RAM (tmpfs). Eine **Hardware-Watchdog**-Vorlage liegt unter `build/optional/` (nicht aktiv: im QEMU-Test erzeugte sie eine Neustart-Schleife; erst nach Hardware-Test einschalten). Zustand, der Neustarts überleben muss, wird per Bind-Mount von `/data/state/*` eingeblendet (machine-id, NetworkManager, chrony, fake-hwclock, Journal). SQLite läuft im WAL-Modus; Cache der Lite-Geräte ist klein; Hub-Daten können später auf eine USB-SSD verschoben werden (Medienordner).

### Erststart (`dfm-data` → `dfm-firstboot` → `dfm-mode`)
1. Datenpartition erweitern und mounten. 2. Persistente zufällige `machine-id`. 3. Geräte-ID, Hostname-Suffix, Seriennummer, Hardware/Profilvorschlag, `geraeteinfo.txt`. 4. Konfigurationsdatei auf der Boot-Partition? → anwenden und **überschreiben + löschen**. 5. Reset-Auslöser prüfen (`dfm-reset-wifi`, 5× Strom). 6. Betriebsart wählen: *nicht eingerichtet* → Einrichtungsmodus; *Hub* → `dfm-hub.target`; *Player* → `dfm-player.target`.
WLAN-Land `DE` steht im Kernel-Parameter (`cfg80211.ieee80211_regdom=DE`), Energiesparen aus in `/etc/NetworkManager/conf.d/dfm.conf`.

## 3. Einrichtungsmodus im Detail
- **AP-only:** Zuerst werden WLAN-Netze gescannt (danach ist auf einem Radio kein Scan mehr möglich), dann startet der Hotspot.
- **WLAN-Test (Zwei-Phasen):** Auf Pi 3 und Zero 2 W kann das einzelne Funkmodul nicht gleichzeitig AP und Client sein. Beim Test wird der Hotspot kurz abgeschaltet, das WLAN verbunden und das Ergebnis gemerkt; dann startet der Hotspot mit **denselben** Zugangsdaten neu, das Handy verbindet sich selbst wieder und holt das Ergebnis. Dasselbe Verfahren gilt für alle Modelle, damit das Verhalten gleich ist. *Auf echter Hardware zu prüfen (Checkliste B5), besonders das automatische Wiederverbinden von iOS/Android.*
- **Hub-Erkennung:** Nach erfolgreichem Test sucht der Pi per mDNS (`_dfm-signage._tcp`) nach einem Hub und schlägt „Player“ vor.
- **Abschluss:** Hotspot aus, WLAN dauerhaft verbinden, Konfiguration atomar (temp + fsync + rename), erst zuletzt `config.json`, dann Neustart.
- **Zwei Server:** `0.0.0.0:80` für das Handy, `127.0.0.1:8081` für die Bildschirmanzeige (nur dort sind PIN und Hotspot-Passwort abrufbar).
- **Captive-Portal-Sonden** (iOS `hotspot-detect.html`, Android `generate_204`, Windows `connecttest.txt`/`ncsi.txt`) werden auf `http://10.42.0.1/` umgeleitet, ebenso jede andere Adresse.
- **Kamera (optional):** `zbar-tools`/`v4l-utils` sind im Image; der Parser `parseWifiQr` (`setup/lib/parse.js`) versteht das Standardformat `WIFI:T:WPA;S:…;P:…;;`. Die Anbindung der Kamera-Schleife ist als Zusatz vorgesehen, aber noch nicht an `dfm-setup` angeschlossen (siehe Abschlussbericht).
- **Verlust des WLAN im Betrieb:** `dfm-netwatch` startet nach 10 Minuten ohne WLAN den Einrichtungsmodus, die Anzeige läuft unverändert weiter; Technikhinweise erscheinen am Bildschirm nur nach 24 h Ausfall *und* ohne Cache.

## 4. Netzwerk
- NetworkManager, Land DE, Energiesparen aus. Hub: `dfm-signage.local` (avahi) plus Empfehlung feste IP (MAC im Admin-Panel unter „Hub-Adresse & Fingerabdruck“ für die IT).
- Ports Hub: 443 (UI, API, WSS, Medien), 80 (nur Weiterleitung), 123/UDP (NTP), 5353/UDP (mDNS). Player: nichts eingehend (außer mDNS-Antworten).
- **Empfehlungen an die IT:** eigenes Signage-WLAN **ohne** Internet; *Client-/AP-Isolation aus*; mDNS (UDP 5353) nicht filtern; für Pi 3/Zero 2 W 2,4 GHz anbieten; feste IP/DHCP-Reservierung für den Hub.
- Sync: im Hintergrund, fortsetzbar (HTTP Range), SHA-256, Delta, max. 2 parallele Downloads je Player (4 gleichzeitig am Hub über Fastify-Limit der Verbindungen), Zufallsverzögerung, optionales Zeitfenster, Bandbreitenlimit.

### Zeit
Der Pi hat keine Batterieuhr. Der Hub ist lokale NTP-Quelle (`local stratum 10`), die Player folgen ihm. Ohne Internet **kennt der Hub die richtige Zeit nicht von selbst**: `fake-hwclock` hält die letzte bekannte Zeit; die Oberfläche warnt bei Abweichung und bietet „Uhr mit diesem Computer abgleichen“. Besser: NTP-Server der IT (`/etc/chrony` in `select-mode.sh` anpassen) oder Pi 5 mit RTC-Batterie. Player ohne gültige Zeit zeigen „Einen Moment bitte“.

## 5. Zertifikat, Fingerabdruck, Browser-Warnung
Siehe `sicherheit.md`. Der Fingerabdruck steht in der Oberfläche (Vierergruppen), auf der Startkarte und in `/api/v1/system/hub`. Neuer Schlüssel nur durch bewusstes Löschen von `/data/hub/tls/hub.key` (danach müssen **alle** Player neu verbunden werden) – das ist absichtlich nicht per Klick möglich.

## 6. Backup und Wiederherstellung
- **Einrichten:** Oberfläche → Erweitert → Sicherung. Die Passphrase wird nicht gespeichert (scrypt → schützt ein X25519-Schlüsselpaar; auf dem Gerät liegt nur der öffentliche Teil). Der Hub sichert täglich (7) und wöchentlich (4) nach `/data/hub/backups`; die Einstellung `backup.extraDir` (zusätzliche Kopie) funktioniert **nicht** wie früher beschrieben: Der Hub-Dienst darf (ProtectSystem=strict) nur unter `/data/hub` schreiben, und USB-Sticks werden bewusst schreibgeschützt eingebunden. Eine zweite Kopie entsteht deshalb durch regelmäßiges Herunterladen (Oberfläche „Hub ersetzen“).
- **Inhalt:** Datenbank (Schnappschuss), Master-Schlüssel, TLS-Schlüssel+Zertifikat, Konfiguration. Medien nicht (sie lassen sich neu hochladen; Größe!).
- **Wiederherstellung ohne Konsole:** Neue SD-Karte flashen, `*.dfmbak` auf die Boot-Partition kopieren und in `dfm-setup.txt` eintragen:
  ```
  rolle = hub
  backup_datei = dfm-backup.dfmbak
  backup_passphrase = …
  wlan_name = …
  wlan_passwort = …
  ```
  Der neue Hub hat denselben Schlüssel und Fingerabdruck – **Bildschirme müssen nicht neu verbunden werden**.

## 7. Updates
`build/make-update.sh <version>` erzeugt ein signiertes `.dfmpkg` (tar mit `manifest.json`, `manifest.sig`, `payload.tar`). Im Admin-Panel hochladen: Signatur (Ed25519, öffentlicher Schlüssel `/etc/dfm/update-key.pub`) und SHA-256 sind Pflicht; ohne gültige Signatur wird **nichts** installiert (Sicherheitsereignis im Protokoll). Die neue Version liegt unter `/data/hub/app/<version>` (Symlink `current`, `previous` für Rollback); `launch` startet bevorzugt `current`. `bootGuard` rollt nach 3 nicht bestätigten Starts automatisch zurück. Verteilung an Player: Hub speichert das Paket, Player holen es per Befehl „Update“ (gepinnt), prüfen die Signatur selbst und starten neu. Betriebssystem-Updates: neues Image flashen.

## 8. Werksreset
Admin-Panel („Auf Werkseinstellungen zurücksetzen“) oder Geräte-Reset: `factory-reset` stoppt die Dienste, formatiert die Datenpartition neu (Label `DFMDATA`) und startet neu → Erststart. **Rolle ändern:** zurücksetzen und neu einrichten.

## 9. Tests
`npm test` (96 Tests): Zeitplan inkl. Sommer-/Winterzeit, Auth/Rate-Limit/CSRF/Rechte je Route und Rolle, Pairing und Pinning über echtes TLS (inkl. simuliertem Man-in-the-Middle), WebSocket, Medien/Upload/Varianten (ffmpeg, sharp, PDF), Papierkorb, Backup/Restore, signierte Updates und Rollback, Einrichtungslogik, Validierung/Injection, Erststart, Image-Prüfung, Release-Werkzeuge, **Ende-zu-Ende im echten Chromium** (Admin-UI, Handy-Einrichtung, Playerseite; ohne externe Anfragen, 44-px-Klickflächen). Hardware-Punkte: `hardware-checkliste.md`.

## 10. Kompatibilitätstabelle
| Modell | Image | Profil | Renderer | Rolle Hub | Bemerkung |
|---|---|---|---|---|---|
| Pi Zero 2 W | arm64 | Lite | mpv | nicht empfohlen | 512 MB RAM, nur 2,4 GHz |
| Pi 3 B Rev 1.2 / 3 B+ | arm64 | Standard | Chromium | mit Warnung (kleine Anlagen) | nur 2,4 GHz (3 B+: 5 GHz) |
| Pi 4 / 400 (≥ 2 GB) | arm64 | Pro | Chromium | **empfohlen** | |
| Pi 5 / 500 | arm64 | Pro | Chromium | **empfohlen** | RTC-Batterie möglich; H.264 per Software |
| Pi Zero W / 1 / 2 | – | – | – | – | **nicht unterstützt** (Image B entfällt) |

Hub auf Pi 3/Zero 2 W: Warnung in der Einrichtung; Richtwert höchstens ~5 Player. Ein Pi 4 (2 GB) trägt deutlich mehr (zu messen).

## 11. Fehlersuche
| Symptom | Ursache / Maßnahme |
|---|---|
| Player „Nicht erreichbar“ | Strom/WLAN; im Hub „Mit dem Hub neu verbinden“; Hub-IP geändert? (Player suchen per mDNS neu) |
| Player verbindet nicht, Hub-Schlüssel geändert | Absicht: Pinning. Player neu verbinden (Werksreset/Einrichtung) |
| Browser: `dfm-signage.local` unbekannt | `.local` auf manchen Android-Browsern: IP nutzen; mDNS im Netz nicht filtern |
| „Die Uhr des Hubs geht falsch“ | Uhr abgleichen oder NTP der IT |
| Videos „werden vorbereitet“ sehr lange | Hub-CPU (Pi 3: langsam). Läuft mit `nice 19`/`ionice idle`; Tabelle `media_variants` zeigt Fehler |
| Update abgelehnt | Signatur ungültig / falsches Paket – Protokoll → Sicherheitsereignisse |
| Einrichtungsmodus startet immer wieder | 15 min ohne Eingabe → Neustart des Modus (neues Passwort/PIN am Bildschirm ablesen) |
| Diagnose | Oberfläche → Bildschirme → „Diagnose …“ oder `tools/diagnose.sh` (nur Entwicklung/Abnahme) |

## 12. Datenmodell
Tabellen: `users, sessions, roles, permissions, devices, device_groups, media, media_variants, playlists, playlist_items, schedules, settings, audit_log, pairing_codes, commands, trash, setup_state` (`hub/migrations/001_init.sql`). Termine speichern **lokale Zeit + Regel** (`startLocal`, `endLocal`, RRULE-Teilmenge DAILY/WEEKLY/MONTHLY mit INTERVAL/BYDAY/UNTIL/COUNT, `exdates`, Priorität 1–10, Gültig-von/bis).

## Erweiterung (Version 0.2)
- **Migrationen** `003_erweiterung.sql` (Rollen, Entwurf/Veröffentlicht, Versionen) und `004_erweiterung2.sql` (Geräteprofil, Szenen, Übersteuerungen, Sondertage, Vorlagen, Prüfprotokolle, WLAN-/Ereignisverlauf, Lese-Token).
- **Auflösung im Player** (`shared/sequencer.js`): Halt → Übersteuerung → Termin → Sondertag → Standard → Standby. Der 14-Tage-Plan enthält `overrides`, `specialDays`, `hold`, `tickers`, `layout`; abgelaufene Übersteuerungen ignoriert der Player selbst (offline-fähig).
- **Live:** `status`-Nachricht des Players (Chromium-Seite → `POST /status` auf 127.0.0.1 → WSS). Screenshots nur bei Betrachtern (`devices.js: screenshotTick`), JPEG ~640 px im RAM. Lite und überlastete Geräte (Temperatur > 78 °C, < 100 MB RAM frei) bleiben bei Stufe 1.
- **Wartungsdienste:** `dfm-netwatch` (Netzwächter + GPIO-Taster, `DFM_BUTTON_GPIO`, Standard 3, per `pinctrl`), `dfm-powercounter-reset` (nach 120 s Laufzeit; 5 kurze Starts in Folge = Einrichtungsmodus), nächtlicher Neustart durch den Agent (`maintenance.rebootAt`).
- **WLAN-Wechsel:** privd-Aktion `wifi-switch` → `/usr/lib/dfm/launch wifi-switch` → `setup/wifi-switch-main.js`; Ergebnis in `/data/state/wifi-switch-result.json` (wird im Heartbeat gemeldet).
- **Import:** `DFM_IMPORT_ROOTS` (Standard `/media:/mnt:/data/import`). USB-Sticks/Freigaben muss die IT einbinden (z. B. `/etc/fstab` mit `nofail,ro,nosuid,nodev,noexec`).
- **Datenpflege:** täglich (`extras2.js: retentionTick`), manuell über *Erweitert → Alte Daten jetzt aufräumen*.
- **Feiertage** werden aus der Osterformel berechnet (4 Jahre voraus, ohne Datendatei); eigene Regeln/Tage in `special_days`.

- **Videos ohne Neuberechnung (0.2.2):** `canPassThrough()` in `hub/lib/variants.js` – H.264, yuv420p, ≤ 1920×1080, Bildrate ≤ Profilgrenze (Standard 30, Pro 60), Datenrate ≤ 20 (Standard) bzw. 40 Mbit/s (Pro) → `ffmpeg -c:v copy` + faststart. Lite bekommt immer eine eigene 720p-Fassung.
- **Betriebsart „kombi“ (Hub + Bildschirm):** `config.json` `role: "kombi"` → `select-mode.sh` startet `dfm-hub.target`, das wegen vorhandener `/data/agent/agent.json` auch `dfm-agent` startet. Die Einrichtung schreibt `agent.json` (Token, `hubUrl https://127.0.0.1`, `hubSpki` = eigener Hub-Schlüssel) und `/data/hub/local-player.json` (nur SHA-256 des Tokens); der Hub legt den Bildschirm beim Start an (`importLocalPlayer`) und löscht die Datei. Kein Einmalcode, kein Sonderzugang – der Agent nutzt denselben gepinnten WSS-Weg.
- **Dateirechte der Einrichtung (behoben in 0.2.1):** `writeFinalConfig` legt `hub-bootstrap.json`/`local-player.json` unter `/data/hub` (Besitzer 990) und `agent.json` unter `/data/agent` (Besitzer 991) ab; `datamount.sh` setzt die Besitzer beim Start zusätzlich. Vorher lagen die Dateien root-eigen bzw. am falschen Ort.
- **Ressourcen (0.2.2):** Hub und Anzeige haben **keine festen Speichergrenzen** mehr und dürfen den ganzen Pi nutzen. Bei Speichermangel beendet der Kernel zuerst den Hub (`OOMScoreAdjust=300`, startet automatisch neu), die Anzeige zuletzt (`-500`). `dfm-zram.service` richtet komprimierten Auslagerungsspeicher im RAM ein (halber Arbeitsspeicher, zstd) – auf dem Pi 3 B+ effektiv deutlich mehr als 1 GB, ohne SD-Schreiblast. Bildumwandlung nutzt alle Kerne (`sharp.concurrency(0)`), Umwandlungen laufen weiter mit `nice 19`/`ionice idle`, damit die Anzeige Vorrang hat.
- **Wiedergabe (0.2.2):** Chromium mit `--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-accelerated-video-decode`; Video-Elemente werden nach dem Ausblenden sofort freigegeben (`src` entfernen + `load()`), damit der begrenzte Hardware-Decoder frei ist. `config.txt`: `[pi3] dtoverlay=cma,cma-256`, `[pi4] dtoverlay=cma,cma-384` (Decoder-Speicher). `select-mode.sh` setzt den CPU-Governor auf `performance`. Je Bildschirm wählbar `renderer` = `auto|browser|mpv` (`PUT /api/v1/devices/:id/playback`); bei `mpv` nutzt der Agent den mpv-Renderer (DRM/KMS, `--hwdec=auto-safe`), Texte kommen als Bild-Variante, Laufband/Zonen entfallen. Wechsel → der Agent speichert die Art und startet neu. **Auf echter Hardware zu messen** (Checkliste E1, Codec-Entscheidung Messpunkt 1).

## 11. Version 0.2.23 – Technik
- **Notfall-Meldung** (`hub/lib/notfall.js`): `POST /api/v1/emergency/start` (Bestätigung Pflicht) legt eine Textfolie (Vorlage `notfall`, Ordner „Notfall“) an, beendet **alle** anderen Übersteuerungen und Szenen, setzt eine Übersteuerung auf alle Bildschirme (Label `NOTFALL`) und beendet geteilte Bildschirme. Texte: Einstellung `emergency.presets`.
- **Update per USB** (`hub/lib/system.js`): `GET /api/v1/update/usb` prüft `*.dfmpkg` im Hauptordner von `/media/usb` (Signatur Pflicht, nur lesend); `POST /api/v1/update/usb/install` installiert nach Bestätigung (Dateiname geprüft, `realpath` muss im Stick-Ordner liegen). Der Workflow `image.yml` erzeugt ein `.dfmpkg` nur, wenn das Geheimnis `DFM_SIGN_KEY` gesetzt ist (`HAS_PERMANENT_KEY`). Seit 09.10.2026 ist es gesetzt (Ed25519, mit `build/gen-release-key.sh` erzeugt; Sicherungskopie siehe `LIES-MICH.txt` im Ordner `Dokumente\DFM-Schluessel`). Schlüsselwechsel: neues Paar erzeugen, Geheimnis ersetzen, alle Geräte mit neuem Image aufsetzen.
- **Meldung bei Ausfall** (`hub/lib/alerts.js`, `smtp.js`): eigener SMTP-Client ohne Abhängigkeit (TLS/STARTTLS, AUTH PLAIN/LOGIN, Anmeldung nie ohne Verschlüsselung), Einstellungen in Tabelle `alert_config` (Passwort mit dem Hub-Schlüssel verschlüsselt, `alert_state` merkt Ausfälle), Wächter alle 30 s. `GET /api/v1/status` (Rolle `live.read`, auch mit Lese-Token im Header `X-Live-Token`): 200 ok/warn, 503 bei Ausfall.
- **Wiedergabe-Nachweis** (`hub/lib/nachweis.js`, Tabelle `plays`, Agent `player/agent/lib/plays.js`): Der Agent zählt je Einblendung lokal (Datei `/data/agent/state/plays.json`, höchstens alle 5 Min. geschrieben) und meldet alle 5 Min. `plays {id, days}`; der Hub antwortet `plays_ack {id}`. Dieselbe Nummer wird wiederholt, bis bestätigt; der Hub erkennt Doppeltes. Berichte: `/api/v1/reports/plays` und `.csv`.
- **Laufband/Uhr auf mpv** (`player/agent/lib/zones.js`): `osd-overlay` (ASS) und `video-margin-ratio-*`, nur wenn der Plan ein Layout enthält; nicht bei Drehung, auf Hinweisbildern und während des Teilens. Auf mpv 0.37 geprüft (Pi OS Bookworm liefert 0.35). **Auf einem Pi mit `--vo=drm` noch nicht gesehen.**
- **Bildschirm teilen** (`hub/lib/teilen.js`): `POST /api/v1/share`, `POST /api/v1/share/:id/frame` (JPEG ≤ 2,5 MB, `image/jpeg`), `DELETE`, `GET`. Nachrichten `share_start`/`share_frame`/`share_stop` an die Agenten; Browser-Bildschirme bekommen das Bild über den lokalen Server (`/share/frame.jpg`, Ereignis `share`), mpv-Bildschirme als Datei in `/run/dfm-agent/share-{0,1}.jpg` (höchstens ca. 1 Bild/s). Die Aufnahme läuft in einem **Web-Worker** (`admin-ui/src/share-worker.js`, als eigene Datei gebaut), damit der Browser sie nicht drosselt, wenn ein Präsentationsfenster die Seite verdeckt. Ende: von Hand, Höchstzeit, 20 s ohne Bild (Hub) bzw. 30 s (Agent), Notfall-Meldung.
- Migration 010 (`alert_config`, `alert_state`, `plays`).

## 12. Version 0.2.24 – Technik
- **Migration 011:** `apps.state_json`, `app_slides`, `override_kind(id, kind, prio)` (Art der Übersteuerung: `manual|notfall|tor|regel`; ohne Eintrag „manual“ – die Tabelle `overrides` bleibt unverändert, weil dort positional eingefügt wird), `live_state`, `rules`, `rule_state`, `metrics.disk_free`.
- **Rangfolge im Player** (`shared/sequencer.js: overrideRank`): Notfall 100 > Tor 60 > manuell 50 > Regel 10 (+ Wichtigkeit 0–9 / 10 für Regeln untereinander), dann „alle“ vor Gruppe/Gerät, dann neueste. Der Plan trägt `kind` und `prio`; ältere Player kennen sie nicht und sortieren wie bisher (neueste/„alle“ zuerst).
- **Regeln** (`hub/lib/rules.js`, `regeln.js`): Auswertung jede Minute (und nach jedem Abruf der Wetter-/Live-App) in `app.rules.tick()`. Eine zutreffende Regel erzeugt eine Übersteuerung (Label `REGEL: <Name>`, `until` = jetzt + 15 Min., verlängert bei < 8 Min. Rest, Push nur bei Start/Verlängerung/Ende). Zustand je Regel in `rule_state` (`true_since`, `false_since`, `blocked`, `override_id`). Wetter/Spiel: Nachlauf 2 Min. (`OFF_DELAY_MS`), Uhrzeit sofort; Wartezeit `stable_s`; Daten älter als 2 h (Wetter) / 3 h (Spiel) = unbekannt = nicht erfüllt. Von Hand beendete Anzeige setzt `blocked` bis die Bedingung einmal nicht galt. Handaktionen und Notfall beenden Regel-/Tor-Übersteuerungen **nicht** (`endOverrides` und `notfall.js` überspringen `regel`/`tor`). Routen: `GET/POST /api/v1/rules`, `PUT/DELETE /api/v1/rules/:id`, `POST /rules/:id/resume`, `POST /rules/preview` (Recht `schedules.read` bzw. `scenes.write`).
- **Vorab laden:** `manifestPayload` nimmt die Jubel-Folie (solange die Live-App an ist) und die Inhalte eingeschalteter Regeln mit auf, damit mpv-Bildschirme das fertige Bild schon haben.
- **Live-Spiel/Jubel:** `buildLive`/`liveIntervalMin` in `hub/lib/apps/builders.js`; `POST /api/v1/apps/livespiel/jubel-test` (Admin).
- **Nächster Programmpunkt:** `buildNext`; Zwischenspeicher `fetchCached` (5 Min.) im Apps-Rahmen.
- **Prognose** (`hub/lib/prognose.js`, `GET /api/v1/prognose`, Recht `system.read`): Stundenmittel der letzten 7 Tage aus `metrics`, Regression (kleinste Quadrate) mit Güte r²; Schwellen im Quelltext. Der Hub misst `disk_free` per `statfs` des Datenordners, Bildschirme liefern `diskFreeMB` im Heartbeat. Aufbewahrung der Messwerte weiter 14 Tage.
- Tests: `livespiel`, `regeln`, `naechster`, `prognose` (hub/test), Rangfolge in `shared/sequencer.test.js`.

## 13. Version 0.2.25 – Größe des Systembereichs
- Das Image hat drei Partitionen: Start (96 MB), **System (p2, ext4, schreibgeschützt)** und Daten (p3, wächst beim ersten Start über `growpart`/`resize2fs` auf den Rest der SD-Karte). Bis 0.2.24 war p2 nur Inhalt + 2 % + 24 MB groß (zuletzt ≈ 2 GB, 97 % belegt, 55–60 MB frei).
- Seit 0.2.25: p2 = Inhalt + 2 % + **2 GB Reserve** (`DFM_ROOT_HEADROOM_MIB`, Standard 2048). Das Image ist roh ≈ 4,1 GB; der xz-Download bleibt etwa gleich groß, weil der freie Platz nur aus Nullen besteht. Empfohlen werden SD-Karten ab 32 GB, mindestens 16 GB.
- Eine Partitionsvergrößerung ist **kein Update**: Bestehende Geräte behalten ihr altes Schema, bis die SD-Karte mit einem neuen Image beschrieben wird. Der lokale Schnellbau (`tools/local-image-export.sh`) übernimmt die Partitionsgrößen seines Basis-Images.
- Größte Posten im System (0.2.24): `/usr/lib` 1,2 GB (davon Systembibliotheken 552 MB, Chromium 394 MB), Node 135 MB, `/usr/bin` 108 MB, `/opt/dfm` 69 MB (davon `node_modules` 68 MB), Schriften 44 MB, Python 46 MB.

## 14. Version 0.2.26 – Technik
- **Migration 012:** `watch_state`, `care_done`, `inserts`.
- **Einschübe** (`hub/lib/einschuebe.js`, Planfeld `inserts`): `GET/POST /api/v1/inserts`, `PUT/DELETE /api/v1/inserts/:id` (Rechte `schedules.read`/`schedules.write`, Gruppen-Beschränkung wie bei Regeln). `schedulePayload` nimmt die Einschübe nur auf, wenn der Bildschirm **Version ≥ 0.2.26** meldet (`INSERTS_MIN_VERSION`, `verGte`): `shared/protocol.js` lehnt unbekannte Felder ab, ein älterer Agent würde den ganzen Plan verwerfen. Das Medium steht im Manifest. Im Player entscheidet `shared/sequencer.js: dueInsert` (nur Quellen standard/termin/sondertag und Regel-Übersteuerungen; erster Einschub nach einer vollen Wartezeit; der überfälligere zuerst) und `insertItem` (nutzt `playableItems`: Lizenz, Vorbereitung, Darstellbarkeit). Browser-Player (`player/chromium/player.js`) und mpv-Renderer (`renderers.js`, Merker `advance`) rücken nach einem Einschub **nicht** in der Liste vor. Die Einblendung läuft über `status`/`onShow` und zählt im Wiedergabe-Nachweis. Browser-Player auf Chromium-Seite geprüft; mpv per Test (`hub/test/einschuebe.test.js`).
- **Bild-Wächter** (`hub/lib/waechter.js`): alle 20 s höchstens zwei Bildschirme (Befehl `screenshot`, Kennung `auto-…`); Proben alle 8–12 min (Zufall, damit der Takt nie zur Listenlänge passt). `analyzeImage`: 64×36 Graustufen → Prüfsumme (SHA-1, 16 Zeichen) und Helligkeit; schwarz = Mittelwert < 6/255 und ≥ 98 % der Punkte < 24. `freezeWindow`: Zufallswahrscheinlichkeit für zwei gleiche Proben aus den Zeitanteilen der Elemente (Video zählt als „immer anders“), nötig sind so viele gleiche Proben in Folge, dass die Zufallschance unter 10⁻⁶ liegt (4 bis 24; sonst keine Meldung). `stalled`: `playerStatus.current.since` älter als max(15 min, 2 × längstes Element + 5 min). Ergebnis in `watch_state`, Warnungen `bild_schwarz`, `bild_steht`, `wiedergabe_steht` über `deviceWarnings(…, { watch })` (Ergebnisse älter als 1 h gelten nicht). Es werden **keine Bilder gespeichert**. Lite und überlastete Geräte (`devices.reduced`) bekommen nur die Wiedergabe-Prüfung. Routen `GET/PUT /api/v1/watch`; Einstellung `watch.enabled` (Standard an).
- **Pflege** (`hub/lib/pflege.js`): Aufgaben `reinigung` (12 Monate), `netzteil` (12), `sd` (24), Abstände in der Einstellung `care.tasks`; Bezug: `care_done` → `devices.installed_at` → `created_at`. `GET /api/v1/care`, `POST /api/v1/care/done` (`devices.manage`), `PUT /api/v1/care/tasks` (`settings.manage`). Hinweise erscheinen über `warnings()` auf der Startseite (überfällig oder in 14 Tagen fällig).
- **Etiketten:** nur Oberfläche (`admin-ui/src/pages/etiketten.js`), QR über `POST /api/v1/qr`; `GET /devices` liefert jetzt auch `location`.
- Tests: `einschuebe`, `waechter`, `pflege` (hub/test), Rangfolge in `shared/sequencer.test.js` unverändert.

## 15. Version 0.2.27 – Oberfläche
- **Gestaltung** (`admin-ui/src/app.css`): neue Gestaltungswerte (`--r`, `--btn`, `--shadow`, `--surface-2`, `--muted`) neben den gemeinsamen Farben aus `theme.generated.css` (Quelle `assets/dfm-theme.css`, wird auch von Einrichtungsseite und Playerseite genutzt und blieb unverändert). Gefüllte Knöpfe nutzen `--btn` (weiße Schrift, Kontrast ≥ 5:1 in hell und dunkel). `color-mix()` für Plaketten und Hinweise (Chromium ≥ 111). Keine Schriften und Bilder aus dem Netz; Seiten-Übergänge und Fenster-Animationen schalten sich bei „weniger Bewegung“ ab.
- **Rahmen** (`main.js`): Seitenleiste mit Gruppen (`GROUPS`), Benutzerkasten, am Handy eine wischbare Leiste; `HELP_FOR` ordnet jede Seite einem Kapitel zu (Link „Anleitung zu dieser Seite“); `#/hilfe/<kapitel>` öffnet ein Kapitel; neue Seiten springen nach oben.
- **Anleitung:** Inhalt als reine Daten in `admin-ui/src/pages/help-content.js` (Kapitel, Schritte, Tipps, Warnungen, Suche mit Umlaut-Normalisierung), Darstellung in `help.js` (nie als HTML, nur **fett** wird umgesetzt). `tests/hilfe.test.js` prüft: eindeutige Kennungen, gültige Verweise, jede Seite hat ein Kapitel, kein HTML/keine Platzhalter, Suche, und dass Zahlen im Text zum Programmcode passen.
- Geprüft im echten Browser: `tests/e2e-ui.test.js` (44-px-Klickflächen, ≥ 16 px, kein Querscrollen auf Handy und iPad) läuft auch lokal, wenn `DFM_CHROMIUM` auf einen Chromium-Browser zeigt (z. B. Microsoft Edge unter Windows).

## 16. Version 0.2.28 – Stabilität
Ziel: Ein einzelner Fehler (kaputte Daten, hängendes Programm, volle Karte, kurze Datenbanksperre) darf nie Hub oder Anzeige beenden oder einfrieren. Gefunden wurde das bei einer Durchsicht aller Zeitgeber, Ausnahmen und Schreibzugriffe; nichts davon war als Fehler im Pilot aufgefallen, aber jede Stelle hätte auf Dauer einmal getroffen.
- **Schutzbausteine** (`shared/guard.js`): `parseJson` (kaputtes JSON → Ersatzwert), `guarded`/`safeInterval`/`safeTimeout` (Fehler im Takt werden protokolliert, der Zeitgeber läuft weiter), `installProcessGuards` (nicht abgefangene Fehler werden protokolliert; ab 30 Fehlern in 60 s oder bei einem schweren Fehler **sauberer Neustart mit Code 75**, systemd `Restart=on-failure`). Aktiv in Hub, Agent, Netzwächter und Einrichtung. **Wichtig:** `safeInterval` ruft `unref()` auf – in einem Dienst, dessen einziger Halter ein Zeitgeber ist (Netzwächter), `setInterval(guarded(...))` ohne `unref` nehmen.
- **Datenbank** (`hub/lib/db.js`): `busy_timeout 5000`, `wal_autocheckpoint`, `journal_size_limit 64 MB`, stündlich `wal_checkpoint(PASSIVE)`, `quick_check` beim Start (nur Dateien < 400 MB; Ergebnis in `db.integrity`, bei Fehlern **Warnung auf der Startseite** mit Aufforderung zur Sicherung), **Kopie vor jeder Migration** (`hub.db.vor-v<alte Version>` per `VACUUM INTO`, zwei Kopien bleiben), sauberer Abschluss mit `wal_checkpoint(TRUNCATE)`.
- **Hub:** WebSocket-Nachrichten laufen in einem Schutz (Fehler → nur diese Verbindung wird mit 1011 geschlossen, der Bildschirm verbindet sich neu); beschädigte `state_json`/`display_json`/`hw_json`/Befehle machen keine Seite mehr unbrauchbar (`parseJson`; ein kaputter Befehl wird `failed`); `state_json` wird nicht mehr abgeschnitten, sondern von `fitState` um die größten Einträge gekürzt (`gekuerzt: true`); Port-80-Weiterleitung ist optional; Herunterfahren wartet höchstens 8 s; **ffmpeg/ffprobe/pdftoppm haben ein Zeitlimit** (`run(..., { timeoutMs })`, SIGKILL) und die Verarbeitungsschlange fängt jeden Fehler ab; Datenpflege löscht alte Befehle (erledigt > 30 Tage, unzugestellt > 7 Tage).
- **Agent:** Schreiben von Plan/Manifest/Konfiguration über `persist()` – bei voller oder schreibgeschützter Karte läuft der Stand im Arbeitsspeicher weiter (`diskError`, Heartbeat-Feld `speicherFehler`, Hub-Warnung „schreibfehler“); `onMessage` fängt Fehler je Nachricht; alle Zeitgeber über `safeInterval`; `fetchRange` mit Leerlauf-Zeitlimit (30 s) und ohne hängende Zusage bei kaputter Adresse; bricht die Hauptschleife je ab, startet der Agent neu (Code 75); die Signal-Behandlung beendet spätestens nach 5 s.
- **Medien-Sync** (`player/agent/lib/sync.js`): Abbruch bei Stillstand (`stallMs` 45 s, auch für die Antwort), **Platzprüfung vor jedem Download** (`minFreeBytes` 150 MB; bei zu wenig Platz werden zuerst nicht mehr benötigte Medien entfernt, sonst `noSpace` → Hub-Warnung „speicher_voll“), Schreibfehler beenden nur das eine Medium, **Prüfsummen-Zwischenspeicher** (Pfad + Größe + Änderungszeit; vorher wurden bei jedem Abgleich alle Medien von der SD-Karte neu gelesen).
- **Lokaler Server:** Fehler in einer Anfrage ergeben 500 statt Prozessende; Lesefehler beim Senden einer Datei beenden nur diese Antwort; die Dateityp-Erkennung liest nur noch **12 Byte** statt die ganze Mediendatei in den Arbeitsspeicher (bei jeder Videoanfrage bis zu mehrere 100 MB).
- **Anzeige:** Browser-Player (`player/chromium/player.js`): Fehler in der Wiedergabeschleife → 3 s warten, weiter (vorher blieb sie für immer stehen); fehlende Dauer → 10 s (vorher Endlosschleife `NaN`). mpv-Renderer: gleiche Absicherung (`tick`/`applyZones`), Start-Fehler des Programms → später erneut, eingefrorene Prozesse werden nach 5 s mit SIGKILL beendet.
- **Selbstheilung** (`Agent.watchPlayback`, jede Minute): Meldet die Anzeige länger als max(20 Min., 2 × längstes Element + 5 Min.) nichts, wird die Anzeige neu gestartet; beim zweiten Mal in Folge ohne Lebenszeichen der Agent (Code 75). **Höchstens einmal pro Stunde**; nie in den ersten 20 Min., bei ausgeschaltetem Bildschirm, beim Teilen, beim Laden von Medien, bei fehlender Uhrzeit, bei Halt/Wartung oder wenn nichts abspielbar ist. Heartbeat-Feld `selfHeal` → gelbe Hub-Warnung für 24 h.
- Tests: `hub/test/stabilitaet.test.js`, `player/agent/test/stabilitaet.test.js`.

## 17. Version 0.2.29 – Fünf Funktionen (Migration 013)
- **Verschachtelte Listen:** Tabelle `playlist_includes(playlist_id, sub_id, pos, valid_from, valid_to)`; Einträge und Einfügungen teilen sich `pos`. `playlistItems()` in `hub/lib/plan.js` macht daraus eine **flache** Liste (Tiefe `MAX_NEST = 3`, Schleifen werden übersprungen, die Gültigkeit der Einfügung wirkt auf alle Einträge der Unterliste, höchstens 500 Elemente) – Player und Protokoll ändern sich nicht. Prüfung beim Speichern (`checkInclude`: nur veröffentlichte, keine Schleife, Tiefe). Papierkorb und frühere Versionen nehmen die Einfügungen mit; Löschen einer eingefügten Liste braucht `?force=1`.
- **Auslöser-Links** (`hub/lib/ausloeser.js`, Tabelle `triggers`): `POST|GET /api/v1/trigger/:token` ist **öffentlich** (das Geheimnis im Link ist die Berechtigung); gespeichert wird nur `sha256(token)`, 256 Bit Zufall. Verwaltung `/api/v1/triggers*` nur mit `settings.manage`. Bremsen: 10 falsche Links je Adresse → 429; derselbe Link höchstens alle 2 s; GET nur mit `allow_get`; **laufende Notfall-Meldung wird nie beendet** (423). Aktion „start“ nutzt `app.scenes.run()` (aus `extras.js` herausgelöst, dieselbe Logik wie die Bedienung von Hand), „stop“ `app.scenes.stop()`. Der Link wird im Hub-Protokoll (`server.js`-Serializer) maskiert.
- **Fluchtweg-Plan:** `devices.escape_media_id`. Im Plan (`overrideList` in `plan.js`) wird aus der Notfall-Übersteuerung (Art `notfall`) für diesen Bildschirm eine eigene Liste „Text `ESCAPE_TEXT_S` = 10 s, Plan `ESCAPE_PLAN_S` = 15 s“. `manifestPayload` nimmt den Plan **immer** mit (Vorab-Laden). `extras6` (Aufräumen) und das Löschen von Medien kennen die Zuweisung.
- **Live-Bild:** **kein neuer Medientyp** (`media.kind` hat eine CHECK-Bedingung, ein Neuaufbau der Tabelle wäre riskant): Text-Medium mit `text_json.stream.url`; das Textbild ist die Ersatzfolie. `shared/stream.js` prüft Adressen (rtsp/rtsps/http/https/udp; nur private IPv4/IPv6, `.local`/`.lan`/…, einfache Namen; Zahlen-Schreibweisen wie `2130706433` werden abgelehnt) – im Hub beim Anlegen und im Renderer vor dem Laden. Das Verzeichnis trägt `stream: { url }` als eigenes Feld; `playableItems` macht daraus `kind: 'stream'` (nur Profil `lite`, also mpv). mpv: `cache=yes` nur für Netzwerkadressen, bei `end-file`/`error` Ersatzfolie und erneuter Versuch nach `streamRetryMs` (10 s). Listenausgabe maskiert Zugangsdaten (`***@`).
- **Gleichtakt und Videowand:** Gruppen-Spalten `sync_mode`, `wall_cols`, `wall_rows`, `sync_epoch`; Bildschirm-Spalten `wall_col`, `wall_row`. Neues Planfeld **`wall`** (nur an Bildschirme ≥ 0.2.29, `WALL_MIN_VERSION`; im Protokoll `opt(obj)`) mit `{ mode, epoch, cols, rows, col, row }`; solche Bildschirme bekommen `renderer: 'mpv'` (`effectiveRenderer`), keine Einschübe. `shared/wall.js`: `wallPosition(items, epoch, now)` (Position aus der Uhr, **ohne** Abstimmung untereinander; die Uhren stimmen über chrony auf dem Hub überein) und `tileCrop()` (mpv-Eigenschaft `video-crop` in ganzen Prozent). **Wichtig:** mpv rechnet `+x%/+y%` als Anteil des **freien** Platzes (Quellbild minus Ausschnitt); verifiziert mit mpv 0.37 unter Xvfb (`tools/wall-experiment3.py`, `tools/wall-experiment4.py` + `tools/wall-crops.mjs`). Das Seitenverhältnis des Inhalts kommt als `aspect` aus `media.width/height` im Verzeichnis. Renderer: gleiche Liste auf allen Bildschirmen (`have: () => true`, fehlende Datei → Standby, Takt bleibt), `keep-open=yes` (letztes Bild bleibt bis zum nächsten Zeitabschnitt), Sprung an die gemeinsame Stelle nach 1,5 s (später dazugekommen) und alle 20 s per `get_property time-pos` (Abweichung > 0,35 s). **Notfall-Meldungen sind nie Teil der Wand.**
- **Hardware-Grenzen (nicht gemessen):** Der Zuschnitt läuft beim Pi 3 B+ mit `--vo=drm` im Prozessor (vermutlich mit swscale skaliert, nicht geprüft) – ob 1080p flüssig bleibt, ist offen (E48). Genauigkeit des Gleichtakts über WLAN (E47).
- Tests: `hub/test/{verschachtelt,ausloeser,fluchtweg,livebild,gleichtakt}.test.js`, `shared/wall.test.js`, `player/agent/test/gleichtakt.test.js`. Gefunden durch die Tests: `haveFile` bekommt ein Verzeichnis-Element (`id`), kein Listen-Element (`mediaId`).

## 18. Version 0.2.30 – Gestaltung (nur Oberfläche)
- **Symbole:** `admin-ui/src/icons.js` (≈ 70 Linien-Symbole, 24 × 24, `currentColor`). `h()` in `ui.js` ersetzt ein **Emoji am Anfang eines Textes** automatisch durch das passende Symbol (Zuordnung `MAP`; nicht aufgeführte Emoji bleiben stehen). Ein einzelnes ▶/◀ ohne Emoji-Variante ist ein Pfeil (Kalender). Neue Symbole: in `D` eintragen, Emoji in `MAP` zuordnen. Die Symbole sind Konstanten – kein Fremdtext fließt hinein.
- **Gestaltung** (`app.css`, Abschnitt „Gestaltung v2“): ruhige Knöpfe (`.btn.sec` neutral, `.btn.link` ohne Unterstreichung, `.btn.iconbtn`), Kartenaufbau `.cardhead / .cardmeta / .cardactions` mit Plaketten `.metachip`, Medienkarten `.mediaCard` (`.kindbadge`, `.textthumb`), Listenkarten `.listcard`, Auf-einen-Blick-Felder `.kpis`, Ladeplatzhalter `.skel`, Seitenkopf `.pagehead`, Spielfeld-Linien auf der Anmeldeseite (als `data:`-Bild im CSS – erlaubt durch `img-src data:`).
- **Gemeinsame Karte:** `devCard()` in `pages/home.js` (Startseite und Seite Bildschirme).
- **Demo-Hub:** `node tools/demo-hub.mjs` startet einen Hub mit Beispieldaten auf `http://127.0.0.1:8765` (Admin: `admin`, Passwort aus `hub/test/helpers.js`). Nach `npm run build:ui` den Hub neu starten (er merkt sich die Dateinamen der Oberfläche).
- Unverändert: Farben aus `theme.generated.css`, Kontraste, 44-px-Klickflächen, ≥ 16 px für Bedienelemente, kein Querscrollen auf dem Handy (`tests/e2e-ui.test.js`).
