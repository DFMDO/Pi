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
- **Einrichten:** Oberfläche → Erweitert → Sicherung. Die Passphrase wird nicht gespeichert (scrypt → schützt ein X25519-Schlüsselpaar; auf dem Gerät liegt nur der öffentliche Teil). Der Hub sichert täglich (7) und wöchentlich (4) nach `/data/hub/backups`; optional zusätzlich in ein USB-/Netzlaufwerk (`backup.extraDir`).
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
