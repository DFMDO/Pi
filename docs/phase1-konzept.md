# DFM Signage – Phase 1: Konzept

Stand: Phase 1 (Entwurf, zur Freigabe). Alle Aussagen zu Hardware-Verhalten sind **Annahmen, bis sie auf echten Geräten gemessen sind** (siehe Abschnitt 11).

## 0. Getroffene Entscheidungen (aus Rückfragen)

| Thema | Entscheidung |
|---|---|
| Headless-PIN | PIN = letzte 6 Zeichen der Pi-Seriennummer (Gerätelabel). Begründung und Restrisiko: Abschnitt 6.3 |
| Image B (armhf-lite) | **Entfällt.** Begründung: Abschnitt 2.4 |
| Image-Build | Zuerst Build in der Entwicklungsumgebung versuchen (Phase 2), sonst lokal durch dich. Machbarkeit in der Cloud-Sitzung ist unsicher (Abschnitt 11) |
| Design | Logo, Schriften, Farben liefert das DFM. Bis dahin Platzhalter über `--dfm-*`-Variablen |

## 1. Gesamtarchitektur

```
 Handy ──WLAN DFM-Setup-xxxx──► [dfm-setup]  (nur im Einrichtungsmodus)
                                     │ schreibt /data/config, startet Rolle
 Admin-Browser ──HTTPS 443──►  ┌─────────── HUB (ein Pi) ───────────┐
                               │ dfm-hub (Node/Fastify, SQLite WAL) │
                               │ Medienspeicher, Variantenjobs      │
                               │ chrony (NTP), avahi, nginx? (s.u.) │
                               └──────────────▲─────────────────────┘
                                   WSS 443 + HTTPS (SPKI-Pinning)
                               ┌──────────────┴─────────────────────┐
                               │ PLAYER (beliebig viele)            │
                               │ dfm-agent (systemd) ─► Chromium    │
                               │   (Standard/Pro) oder mpv (Lite)   │
                               │ Cache + Zeitplan 14 Tage lokal     │
                               └────────────────────────────────────┘
```

Komponenten und Verantwortung:

| Komponente | Sprache | Aufgabe | Läuft |
|---|---|---|---|
| `dfm-firstboot` | Shell + kleines Node-Skript | Erststart (1.2 der Aufgabe) | einmalig |
| `dfm-setup` | Node (ein Prozess, keine Frameworks außer `qrcode`) | Hotspot, Captive Portal, WLAN-Test, PIN, QR, Rollenwahl | nur Einrichtungsmodus |
| `dfm-hub` | Node LTS, Fastify, better-sqlite3 | API, WSS, Auth, TLS, Planung, Medien | Hub |
| `dfm-agent` | Node LTS (Standard/Pro); Lite: gleicher Agent, mpv statt Chromium | Pairing, Heartbeat, Sync, Zeitplan lokal, Fernbefehle | Player |
| Admin-UI | Vanilla JS/Web Components, Build-Schritt mit esbuild | Oberfläche | statisch vom Hub |
| Playerseite | Vanilla JS, ohne Framework | Wiedergabe im Chromium | Player |

Begründung „Node auch auf dem Lite-Player“: Zero 2 W hat 512 MB RAM; Agent ohne Chromium bleibt < 150 MB (Ziel, zu messen). Eine zweite Sprache würde Wartung und Tests verdoppeln. Dies ist der Hauptgrund, Image B zu streichen (2.4).

**Medien ausliefern: Fastify oder nginx?** Entscheidung: **Fastify** (`@fastify/static`, Range-Unterstützung), kein nginx. Grund: ein Prozess weniger, ein TLS-Stack, weniger RAM und Angriffsfläche; die Last (≤ 4 gleichzeitige Downloads, Limit per Konfiguration) ist gering. Wird in Phase 5 mit 4 parallelen 100-MB-Downloads auf Pi 3 gemessen; ist der Durchsatz < 60 % des nginx-Wertes, wechseln wir (Austausch hinter derselben URL möglich).

## 2. Image-Konzept

### 2.1 Build
- `build/build-image.sh` nutzt **pi-gen** (arm64-Zweig, Stage 0–2 + eigene `stage-dfm`) in Docker auf dem Entwicklungsrechner. `rpi-image-gen` wäre moderner, ist aber weniger verbreitet; pi-gen ist erprobt. Revisit in Phase 2, falls pi-gen-Aufwand zu hoch.
- Reproduzierbarkeit: pi-gen-Commit gepinnt, Paketliste mit `apt` Snapshot-Datum (`snapshot.raspberrypi.com`/`snapshot.debian.org`), `SOURCE_DATE_EPOCH`, npm mit `package-lock.json` und `npm ci --omit=dev`. Eine **vollständig bitgleiche** Wiederholbarkeit ist bei ext4 + Zeitstempeln nur bedingt erreichbar; wir dokumentieren ehrlich „funktional reproduzierbar“ und prüfen Paketlisten-Gleichheit.
- Ausgabe: `dfm-signage-arm64-<version>.img.xz`, `.sha256`, `.sig` (Ed25519; Signierschlüssel liegt **nur** beim Release-Verantwortlichen, nie im Repo; öffentlicher Schlüssel im Image unter `/etc/dfm/update-key.pub`).
- Ziel < 2,5 GB entpackt: Chromium (~300 MB), Node (~100 MB), mpv/ffmpeg (~150 MB) – machbar, wird in Phase 2 gemessen.

### 2.2 Partitionen

| Nr | Name | FS | Größe | Zugriff | Inhalt |
|---|---|---|---|---|---|
| p1 | `DFMBOOT` | FAT32 | 256 MB | rw (nur Erststart/Reset) | Kernel, Firmware, `cmdline.txt`, `dfm-setup.txt`-Vorlage, `dfm-reset-wifi` |
| p2 | `DFMROOT` | ext4 | ~2,3 GB | **read-only** | System, Node, Chromium, Admin-UI |
| p3 | `DFMDATA` | ext4 | wächst auf Rest | rw | `/data`: Config, SQLite, Medien, Cache, Journal, Schlüssel, NetworkManager-Verbindungen |

- Root read-only (`ro` in `fstab`), `/tmp`, `/run`, `/var/tmp` als tmpfs. `/var/lib/NetworkManager`, `/var/lib/chrony`, `/var/log/journal`, `/etc/dfm-state` zeigen per Bind-Mount nach `/data/...`. Einfacher und robuster als overlayfs; kein Doppel-Schreiben.
- p3 wird beim ersten Start mit `growpart`/`resize2fs` auf die ganze Karte erweitert (Ersatz für Standard-`resize2fs_once`, das bei ro-Root nicht passt).
- **A/B-Update:** nicht in V1. Updates sind signierte Pakete, die nur `/data/app/<version>` ablegen (App-Code und Admin-UI liegen in `/data/app`, das System-Image enthält die Basisversion). Rollback = Symlink zurück. Betriebssystem-Updates nur per Neu-Flashen (wie gefordert).
- **Werksreset:** leert p3 (`mkfs.ext4`) und löscht Schlüssel/Konfiguration → nächster Start = Erststart. Auslöser: Admin-Panel, Geräte-Reset (6.5).
- Hub-Daten optional auf USB-SSD: wenn Label `DFMSSD` vorhanden und Nutzer bestätigt, wird `/data/media` dorthin verschoben (Phase 8, mit Warnung).

### 2.3 Erststart-Ablauf (`dfm-firstboot`)

1. Plymouth/`fbi` zeigt sofort DFM-Logo („Willkommen“) – **nie Konsole**: `quiet splash loglevel=0 vt.global_cursor_default=0 consoleblank=0`, Konsole auf `tty3`, Autologin deaktiviert.
2. p3 erweitern → `/data` mounten.
3. Zufallswerte (`getrandom`): Geräte-ID (UUIDv4), SSH-Hostkeys (nur falls SSH später aktiviert; zunächst nicht erzeugt), Hostname-Suffix (4 Zeichen aus `a-z2-9` ohne Verwechsler), Hotspot-Passwort (pro Modus-Start, nicht pro Boot gespeichert).
4. WLAN-Land DE (`iw reg set DE`, `cfg80211`-Regdom in `/etc/default/crda`/`wpa_supplicant`), Energiesparen aus (NetworkManager-Datei `wifi.powersave=2` + udev-Regel).
5. Hardware erkennen: `/proc/device-tree/model`, `/proc/cpuinfo`, `MemTotal`, `uname -m`, DRM-Connector-Status (`/sys/class/drm/*/status`), Seriennummer → Profilvorschlag (Tabelle Abschnitt 4).
6. Konfiguration suchen, in dieser Reihenfolge: `dfm-setup.json`/`dfm-setup.txt` auf p1 → gültige `/data/config.json` → Ethernet-Link → sonst **Einrichtungsmodus**.
7. Konfigurationsdatei nach Einlesen **sicher löschen**: Hinweis ehrlich dokumentieren – auf SD/FAT ist „sicheres Löschen“ nicht garantierbar (Wear-Leveling). Maßnahmen: Datei mit Nullen überschreiben, `fsync`, löschen, `fstrim`. Empfehlung in Doku: Einrichtungscode ist einmalig und läuft in 10 Min ab, WLAN-Passwort ggf. ein eigenes Signage-WLAN.

### 2.4 Image B (armhf-lite): Streichen, Begründung
- Pi Zero W/Pi 1 sind **ARMv6**: Debian-Stable-armhf läuft darauf nicht (ARMv7-Basis); Raspberry Pi OS armhf ist ein Sonderbau.
- 512 MB RAM, Einkern-CPU: mpv mit 720p H.264 ist grenzwertig; Node-Agent plus mpv ist knapp.
- Zweiter Build, zweite Testmatrix, zweite Paketbasis – Aufwand weit größer als der Nutzen.
- **Alternative:** Pi Zero 2 W (~20 €) ist das Lite-Profil im arm64-Image. Falls Bedarf entsteht: Neubewertung nach Phase 7.

## 3. Datenmodell (SQLite, WAL)

Alle IDs UUID (Text), Zeit als ISO-8601-Text; Termine speichern **lokale Zeit + Regel** (Abschnitt 7).

```
users(id, name, pw_hash, role, totp_secret_enc, recovery_hashes, locked_until, created_at)
sessions(id_hash, user_id, csrf, expires_at, last_seen, ip)
roles(id, name)  permissions(role, resource, action)   -- Admin/Redakteur/Betrachter
devices(id, name, group_id, model, profile, token_hash, spki_seen, status, last_seen, hw_json, orientation, blocked)
device_groups(id, name, location, color)
media(id, name, kind, original_path, sha256, size, duration_s, width, height, tags, folder, created_by, created_at)
media_variants(id, media_id, profile, path, sha256, size, status, error)
playlists(id, name, is_default)  playlist_items(id, playlist_id, media_id, pos, duration_s, transition, valid_from, valid_to)
schedules(id, target_type, target_id, playlist_id|media_id, start_local, end_local, rrule, exdates, priority, valid_from, valid_to, created_by)
settings(key, value)  setup_state(key, value)
audit_log(id, ts, user_id, action, target, ip, security, detail_json)   -- append-only (Trigger verbietet UPDATE/DELETE)
pairing_codes(id, code_hash, expires_at, attempts, used, created_by)
commands(id, device_id, type, args_json, status, result_json, created_at)
trash(id, kind, ref_id, payload_json, deleted_at, deleted_by)
```
- `audit_log` unveränderbar: SQLite-`TRIGGER ... RAISE(ABORT)` für UPDATE/DELETE; zusätzlich Hash-Verkettung (`prev_hash`) zur Manipulationserkennung (Admin mit Dateizugriff kann trotzdem alles – ehrlich dokumentieren).
- Papierkorb 30 Tage: Cleanup-Job; Medien-Dateien erst nach Ablauf gelöscht.
- Migrationen: nummerierte SQL-Dateien, `PRAGMA user_version`.

## 4. Profilkonzept

Profil wird beim Erststart aus Modell/RAM vorgeschlagen; Überschreiben nur unter „Erweitert“.

| Profil | Geräte | Renderer | Variante |
|---|---|---|---|
| Lite | Zero 2 W (<1 GB) | mpv DRM/KMS | 720p, H.264 Baseline, ≤ 2 Mbit/s, Bilder ≤ 1280 px |
| Standard | Pi 3 / 3 B+ | Chromium-Kiosk | 1080p30 H.264 High, ≤ 6 Mbit/s |
| Pro | Pi 4 / 400 / 5 / 500 | Chromium-Kiosk | siehe unten |

Anmerkung: Pi Zero 2 W ist im arm64-Image das einzige Lite-Gerät (Image B entfällt). Zeigt das Gerät Chromium-Inhalte (Web-URL, Widgets), gilt es nicht als Lite-fähig – Hub überspringt solche Elemente und erklärt es („Dieser Bildschirm ist dafür zu schwach“).

**Codec je Modell (Annahmen, vor Phase 4/7 zu messen):**
- **Pi 3 / 3 B+:** H.264-Hardwaredecoder (V4L2 M2M), max. 1080p30. Kein HEVC-Hardware.
- **Pi 4:** H.264 bis 1080p60 und HEVC bis 4Kp60 in Hardware. Variante Pro: H.264 1080p60 (kompatibelste Wahl); 4K nur wenn Medium es verlangt und HEVC-Chromium-Wiedergabe getestet ist.
- **Pi 5:** **kein H.264-Hardwaredecoder**, nur HEVC. 1080p H.264 per Software läuft auf 4 Kernen i. d. R. problemlos (zu messen); 4K-H.264 nicht empfohlen. Variante Pro für Pi 5: H.264 1080p30/60 Software als Standard; HEVC-Variante nur als Option, weil Chromium unter Linux HEVC-Hardwaredekodierung nicht zuverlässig bietet (zu prüfen, ggf. mpv als Pro-Renderer für Pi 5 erwägen).
- Entscheidung wird in `docs/codec-entscheidung.md` mit Messwerten festgehalten (Phase 4/7).

Variantenjobs: `nice -n 19` + `ionice -c3`, nur für Profile, für die mind. ein gepaartes Gerät existiert; Änderung der Geräteprofile erzeugt fehlende Varianten nach.

RAM-Budgets (Ziele, werden gemessen): Lite < 150 MB, Standard < 400 MB, Hub ohne Player < 150 MB.

## 5. Netzwerk (Kurzfassung)

- NetworkManager, Land DE, Energiesparen aus.
- Hub: `dfm-signage.local` (avahi) + Empfehlung feste IP; MAC-Adresse im Admin-Panel.
- Ports Hub: 443, 80→443, 123/UDP, 5353/UDP; Player: keine. ufw `deny incoming`.
- Hub-Erkennung: gespeicherte Adresse → mDNS (`_dfm-signage._tcp`) → manuell/QR.
- Reconnect: Backoff 1–60 s mit Jitter; ein WSS pro Player, Heartbeat 30 s, Polling 60 s als Fallback.
- Sync: Range-Resume, SHA-256, Delta-Sync, 2 Downloads/Player, 4/Hub, Zufallsverzögerung, Zeitfenster, Bandbreitenlimit.

## 6. Einrichtung und Sicherheit

### 6.1 Einrichtungsmodus (AP-only)
1. WLAN-Interface in AP-Modus (NetworkManager-Hotspot oder `hostapd`; Entscheidung Phase 2 nach Test: NM-Hotspot bevorzugt, ein Werkzeug weniger). Subnetz `10.42.0.0/24`, Gateway `10.42.0.1`.
2. DHCP/DNS (dnsmasq via NM): **jede** DNS-Anfrage → `10.42.0.1` (Captive Portal); HTTP-Port 80 → `dfm-setup`. Captive-Portal-Erkennung (iOS `captive.apple.com`/`hotspot-detect.html`, Android `generate_204`, Windows `ncsi`) wird bedient.
3. Bildschirm: Schritt 1 WLAN-QR (`WIFI:T:WPA;S:..;P:..;;`; WPA3-Transition-Mode wo Chipsatz es kann, sonst WPA2) + PIN; Schritt 2 sobald Station verbunden → QR `http://10.42.0.1/`.
4. Einrichtungsseite: PIN (6 Stellen, 5 Fehlversuche → neue PIN), dann 4 Schritte.
5. WLAN-Test: Wechsel **AP → Client ist bei Pi 3/Zero 2 W destruktiv** (Handy verliert Verbindung). Lösung: Test im „Zwei-Phasen-Verfahren“: Handy sendet Daten → Pi zeigt „Ich teste jetzt, das dauert ~20 s, deine Verbindung bricht kurz ab“ → AP aus, Client-Test → bei Erfolg: Abschluss auf dem **Bildschirm** (Ergebnis dort sichtbar) und Handy erhält nach Rückkehr in das Heim-/Signage-WLAN die Statusseite per Hub; bei Fehler: AP wieder an, Handy verbindet sich automatisch neu (gespeichertes Netz) und die Seite zeigt „Das Passwort scheint falsch zu sein“. **Dieses Verhalten muss in Phase 2 auf Pi 3/Zero 2 W gemessen werden**; Pi 4/5 können AP+Client parallel (nur 2,4 GHz-Kanal-Bindung beachten), nutzen aber dasselbe Verfahren für identisches Verhalten.
6. Strenge Validierung: SSID 1–32 Byte, Passwort WPA 8–63 ASCII bzw. 64 Hex; Übergabe an `nmcli` nur über Argumentliste (`execFile`, kein Shell-Aufruf), nie Interpolation; Hostnamen/Adressen gegen Regex, Hub-Adresse nur private/Link-Local-Adressbereiche (SSRF-Schutz).
7. Timeout 15 min Inaktivität → Modus neu starten (neues Passwort/PIN); nach Erfolg sofort AP aus, Dienst beendet, Konfiguration atomar geschrieben (`rename`).
8. Stromausfall: Konfiguration wird erst nach erfolgreichem Test und `fsync` aktiv; halb fertige Einrichtung = Einrichtungsmodus beim nächsten Start.

### 6.2 Zertifikats-Pinning und Pairing
- Hub erzeugt beim ersten Start ECDSA P-256 Schlüssel + selbstsigniertes Zertifikat (5 Jahre, SAN: `dfm-signage.local`, Hostname, aktuelle IPs). Zertifikatserneuerung (z. B. IP-Änderung) behält den Schlüssel → SPKI-Hash bleibt.
- Player prüfen den SPKI-SHA-256 in einem eigenen `tls.checkServerIdentity`/Agent (Node) bzw. Chromium über **den Agent als lokalen Proxy-Pfad**: Chromium lädt Inhalte nie direkt vom Hub, sondern vom lokalen Agent (`127.0.0.1`), der gepinnt zum Hub spricht. Dadurch keine Zertifikatsfrage im Kiosk.
- Pairing: wie spezifiziert (Einmalcode 8 Zeichen, 10 min, 5 Versuche, HMAC-SHA256 über `SPKI || Geräte-ID || Nonce`, Bestätigung durch Admin, 256-Bit-Token nur gehasht gespeichert). Zusatz: Nonce vom Hub (Challenge) statt vom Player, gegen Replay; Code als **Hash mit Salt** gespeichert, HMAC wird über den gespeicherten Code-Klartext-Äquivalent geprüft – daher Speicherung des Codes verschlüsselt (Schlüssel aus Hub-Master-Key), nicht nur gehasht. Das ist nötig, weil HMAC den Klartext braucht; Code lebt nur 10 min.
- Startkarte-QR enthält: WLAN (SSID, Passwort), Hub-Adresse, Hub-Fingerabdruck, Einmalcode. **Hinweis:** Der QR enthält das WLAN-Passwort im Klartext – er ist ein Geheimnis und kurzlebig (Code 10 min), das WLAN-Passwort bleibt aber gültig; Druckkarte entsprechend kennzeichnen. Option „WLAN-Passwort nicht in die Karte aufnehmen“.

### 6.3 Headless-PIN (Entscheidung)
- PIN = **letzte 6 Zeichen der Pi-Seriennummer** (Hex, Großbuchstaben), aufgedruckt auf Gerätelabel.
- Begründung: Der PIN darf beim Image-Build nicht festgelegt werden (sonst Geheimnis im Image) und muss ohne Bildschirm bekannt sein. Seriennummer ist hardwareeigen, eindeutig, unveränderlich.
- Restrisiko (ehrlich): Seriennummern sind nicht geheim (stehen u. a. in Systeminformationen, teils sequenziell). Der Schutz beruht daher auf **physischem Zugang zum Label** plus 5 Versuchen, 15 min Fenster, nur im Einrichtungsmodus. Nach 5 Fehlversuchen im Headless-Modus: Sperre bis Neustart. Nicht abgedeckt: Angreifer, der Seriennummer kennt und im Funkbereich ist.
- Offener Punkt: Wie kommt die Seriennummer auf das Label, ohne Konsole? Vorschlag: Beim ersten Start schreibt das Gerät `DFMBOOT/geraeteinfo.txt` (Seriennummer, Hostname) → am PC lesbar und druckbar. Zur Entscheidung vorgelegt (Abschnitt 12).

### 6.4 Admin-Zugriff, Auth, Härtung
Wie in der Aufgabe: argon2id (Native-Modul `argon2` oder `@node-rs/argon2` – Entscheidung Phase 3 nach arm64-Prebuild-Verfügbarkeit, **kein Build auf dem Pi**), Rate-Limit, Sessions serverseitig, `HttpOnly; Secure; SameSite=Strict`, CSRF-Token, 30 min Inaktivität, optional TOTP, Rollen Admin/Redakteur/Betrachter, Routenrechte über zentrale Tabelle (`route → permission`, Test prüft, dass **jede** Route eingetragen ist), JSON-Schema-Validierung (Fastify), CSP `default-src 'self'`, systemd-Härtung je Dienst.
- Updates: `.dfmpkg` = tar + `manifest.json` + `manifest.sig` (Ed25519). Prüfung gegen `/etc/dfm/update-key.pub`; Rollback durch Symlink und Healthcheck-Timer (3 Fehlstarts → zurück).
- Backups: `age` mit Passphrase (scrypt). Enthält Hub-Schlüssel, DB, Medienliste (Medien optional), Hostname.

### 6.5 Zurücksetzen am Gerät (ohne Tastatur)
Entwurf (einfach, sicher):
1. **Datei-Weg:** Datei `dfm-reset-wifi` (leer) auf p1 anlegen (SD-Karte am PC) → beim Start: WLAN-Daten löschen, Einrichtungsmodus, Datei löschen.
2. **Stromweg:** 5× Strom aus/ein innerhalb 10 s je Zyklus (Zähler in `/data`) → Einrichtungsmodus (gleiche Methode wie viele Consumer-Router). Auf dem Bildschirm Rückmeldung.
3. **Taster:** optional GPIO3 (Pin 5, Pi-Pins „Halt“) 10 s gedrückt → Werksreset-Dialog mit Bestätigung am Bildschirm.
4. **Schutz:** Reset von WLAN verlangt nichts Geheimes (physischer Zugriff ist ohnehin nicht abgedeckt); **Werksreset** und Rollenwechsel zeigen Bestätigung auf dem Bildschirm und trennen das Gerät im Hub sofort.

## 7. Zeitplanlogik

- Zeitzone fest `Europe/Berlin`; Speicherung `start_local` (z. B. `2026-03-29T02:30`) + RRULE. Berechnung mit eigener, kleiner RRULE-Teilmenge (DAILY/WEEKLY/MONTHLY, INTERVAL, BYDAY, UNTIL, COUNT, EXDATE) auf Basis `Intl`/`Temporal`-Ersatz; **bewusst keine externe Bibliothek**, wenn Testabdeckung reicht; sonst `rrule` + `luxon` prüfen.
- DST: nicht existierende Zeit (02:30 am Umstellungstag im März) → verschiebt auf 03:00; doppelte Zeit (Oktober) → erste Instanz. Tests Pflicht.
- Auflösung (Zielgerät): 1) direkt zugewiesene aktive Termine vor Gruppentermin, 2) höchste Priorität, 3) später gestartet gewinnt, 4) Standard-Abspielliste, 5) DFM-Standby.
- Hub berechnet konkrete Fenster (UTC-Epoch + lokale Anzeige) für 14 Tage; Player wertet lokal aus (`dfm-agent` hält Fenster in `/data/cache/schedule.json`), Neuberechnung bei `schedule_update`.
- Umschaltung sekundengenau: Agent plant Timer auf die nächste Fensterkante; Playerseite lädt nächstes Element vor (`preload`), schaltet bei Kante um; laufendes Element wird zu Ende gespielt (außer „sofort“).

## 8. Schnittstellen (Entwurf)

REST `/api/v1/…` (OpenAPI 3.1 in `/docs/openapi.yaml`, ab Phase 3). WebSocket-Nachrichten, versioniertes JSON-Schema (`v: 1`): `hello`, `heartbeat`, `schedule_update`, `media_manifest`, `command`, `command_result`, `screenshot`. Schemata liegen in `hub/schemas/ws/` und werden von Hub **und** Agent verwendet (ein Test erzwingt Gleichheit).

## 9. Bedienkonzept

Siehe klickbaren Entwurf `docs/entwurf/index.html` (Handy-Einrichtung, Startseite, Kalender, Fingerabdruck-Dialog). Alle Texte in einfacher Sprache; Fachbegriffe nur unter „Erweitert“. Der Entwurf ist offline, ohne Fremdressourcen.

## 10. „Lokal“-Prinzip und Prüfung

- Test `tests/no-external-requests`: Playwright (Chromium, `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"`) lädt Admin-UI, Setup-Seite und Playerseite und schlägt fehl bei jeder Anfrage an einen nicht-lokalen Host.
- Zusätzlich statische Prüfung: `grep` auf `http(s)://` in Build-Artefakten außer Namespace-URIs (Allowlist).
- Image-Scan auf Geheimnisse: `tests/secrets-scan.sh` (Schlüsseldateien, `BEGIN PRIVATE KEY`, bekannte Muster, nicht-leere `machine-id`, Hostkeys) im gemounteten Image.

## 11. Testplan und Machbarkeit

| Bereich | Wo testbar | Wie |
|---|---|---|
| Hub, Auth, Planung, Pairing, Pinning, Updates | Entwicklungsrechner/CI | Node-Tests (`node --test`), Playwright |
| Image-Inhalt (Secrets, Dienste, Partitionen) | Linux mit Loop-Mount | Skripte gegen `.img` |
| Boot, systemd, Firstboot | QEMU `raspi3b`/`virt` arm64 | nur teilweise (kein WLAN-Hotspot, keine GPU) |
| Hotspot, Captive Portal, WLAN-Test, HDMI, CEC, Temperatur | **nur echte Hardware** | Checkliste `docs/hardware-checkliste.md` |
| Messwerte (RAM, CPU, Durchsatz, Startzeit) | **nur echte Hardware** | Skript `tools/diagnose.sh` (Phase 8, früher als Stub) |

Ehrlich: Pi 3, Zero 2 W, Pi 4 und Pi 5 stehen mir **nicht** zur Verfügung. Abnahmekriterien zu Hardware (Startzeit < 90 s, iOS/Android-Captive-Portal, AP→Client-Wechsel) können nur von dir oder einer Testperson mit Geräten bestätigt werden. Ich liefere dafür Checklisten und Messskripte.

**Image-Build in der Cloud-Sitzung:** geprüft – Docker-Daemon lässt sich starten, Debian/Raspberry-Pi-Paketquellen erreichbar; Docker Hub liefert Rate-Limit (HTTP 429), `qemu-user` nicht installiert. Ob ein privilegierter pi-gen-Lauf (Loop-Devices, `binfmt_misc`) hier funktioniert, ist ungeprüft. Entscheidung: Versuch in Phase 2; Fallback = lokaler Build durch dich.

## 12. Offene Punkte / Entscheidungen für dich

1. **Gerätelabel für Headless-PIN:** `geraeteinfo.txt` auf Boot-Partition akzeptabel? (6.3)
2. **Branding:** Bitte Logo (SVG), Schriften (Lizenz für Einbettung?) und Farbwerte nach `/assets` legen bzw. nennen.
3. **Admin-Zugriff über Hostname:** `dfm-signage.local` funktioniert auf Windows nur mit mDNS-Unterstützung (Win 10/11 ok); Android-Chrome löst `.local` teils nicht auf. Wir zeigen immer auch die IP-Adresse. Einverstanden?
4. **Hub-Hostname fest:** Es gibt genau einen Hub; bei Neuinstallation eines zweiten Hubs im selben Netz gibt es einen Namenskonflikt (avahi hängt `-2` an). Akzeptiert?
5. **Hotspot-Sicherheit:** WPA3 nur, wo Chipsatz es zuverlässig kann; Pi 3/Zero 2 W (BCM43438/43455) → WPA2-PSK. Akzeptiert?
6. **Preise/Sprache:** Zwei Sprachen? (Annahme: nur Deutsch.)

## 13. Messwerte Phase 1

Keine – Phase 1 enthält keinen lauffähigen Code. Messwerte ab Phase 2 (Image-Größe) bzw. echte Hardware.

## 14. Bericht und Freigabe

Zur Freigabe von Phase 2 bitte die Punkte aus Abschnitt 12 beantworten und den klickbaren Entwurf (`docs/entwurf/index.html`) prüfen.
