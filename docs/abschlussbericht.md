# Abschlussbericht

Stand: Ende der Umsetzung in der Entwicklungsumgebung (Cloud-Container, **ohne Raspberry-Pi-Hardware**).
Ehrlichkeitsregel dieses Berichts: *Was ich gemessen oder getestet habe, steht als Zahl da. Was nur auf echten Geräten geprüft werden kann, steht unter „Nicht verifiziert“.*

## 1. Was geliefert wurde

| Phase | Inhalt | Stand |
|---|---|---|
| 1 Konzept | Architektur, Datenmodell, Profile, Sicherheits-/Pairing-/Image-Konzept, klickbarer Entwurf | ✅ `phase1-konzept.md`, `entwurf/` |
| 2 Image-Grundgerüst | `build/build-image.sh` (pi-gen/Docker), Erststart-Dienst, Einrichtungsmodus (Hotspot, QR, Captive Portal, WLAN-Test, PIN) | ✅ Code + Tests; Image-Bau siehe Abschnitt 4 |
| 3 Hub | Backend, Auth, TLS + Pinning, Admin-Konto in der Einrichtung, Pairing mit Startkarte, Heartbeat | ✅ |
| 4 Standard-Player | Agent, Chromium-Kiosk (cage), Playerseite | ✅ Code + Browser-Test; Kiosk-Dienst auf Hardware ungeprüft |
| 5 Medien | Bibliothek, Abspiellisten, Varianten (ffmpeg/sharp/PDF), Papierkorb | ✅ |
| 6 Kalender | Zeitplan inkl. Sommer-/Winterzeit, Offline-Auswertung, Vorschau, Konflikte | ✅ |
| 7 Lite / Pro | mpv-Renderer (Lite), Profile, Codec-Entscheidung | ✅ Code; **kein Test auf Zero 2 W / Pi 4 / Pi 5**; armhf-Image entfällt (begründet) |
| 8 Betrieb | Fernbefehle, Screenshots, Backup/Restore, signierte Updates, Werksreset, Audit-Log, Hilfe, Handbücher, Barrierefreiheit-Tests | ✅; **Sicherheits-Review nur als Eigenprüfung, Nutzertest nicht durchgeführt** |

## 2. Testergebnisse (automatisch, `npm test`)
**96 von 96 Tests bestanden** (Node 22, Linux x86-64, ein echtes Chromium für die Ende-zu-Ende-Tests).

| Bereich | Was geprüft wird |
|---|---|
| Zeitplan (`shared/`) | Wiederholungen, Priorität, Gleichstand, Gerät-vor-Gruppe, Ausnahmen, Termine über Mitternacht, **Zeitumstellung März/Oktober (02:30)**, Gültigkeit, Konflikte, Offline-Auswertung |
| Auth/Rechte | Login-Rate-Limit mit steigender Sperre, identische Fehlermeldung, Cookie-Attribute, CSRF, Ablauf nach 30 min, **Rechteprüfung jeder Route für jede Rolle**, TOTP + Wiederherstellungscodes, Passwortregeln, Audit-Log unveränderbar |
| Pairing/Pinning | Pairing über **echtes TLS**; falscher Code/Fingerabdruck abgelehnt; simulierter Man-in-the-Middle (fremdes Zertifikat, falscher HMAC) → Ablehnung + Sicherheitsereignis; Code läuft ab/sperrt nach 5 Fehlern; Token nur gehasht; Sperre wirkt sofort (Token + WebSocket) |
| WebSocket | Schema-Prüfung, Heartbeat, Befehle, WLAN-Passwort nach Zustellung gelöscht und nie im Audit-Log |
| Medien | Magic-Bytes (EXE als `.png` abgelehnt), EXIF entfernt, Varianten je Profil (nur für gepaarte Profile), Video Lite = 720p/Baseline/30 fps, PDF → Seiten, Text → Bild für Lite, Bild-Bomben, fremde Container, Range-Download, max. 4 gleichzeitige Downloads |
| Backup/Update | Roundtrip, falsche Passphrase, Wiederherstellung mit **gleichem Fingerabdruck**, 7/4-Aufbewahrung, Update nur mit gültiger Signatur, Manipulation/falscher Schlüssel abgelehnt, Rollback, Auto-Rollback nach 3 Fehlstarts |
| Einrichtung | PIN-Sperre, Passwort/PIN/SSID pro Start verschieden, 15-min-Timeout, falsches WLAN-Passwort, Zwei-Phasen-Test, Kamera, Netzwerkkabel, „Nur WLAN ändern“, **Injection in SSID/Passwort (`$(…)`, Backticks) bleibt ein einzelnes Argument**, Captive-Portal-Sonden (iOS/Android/Windows), SSRF-Schutz, Konfigurationsdatei (+ sicheres Löschen, Fehlerdatei), Reset ohne Tastatur, Backup per Datei |
| Image-Prüfung | `check-image.mjs` erkennt jedes Geheimnis/jede Abweichung; **zwei Karten haben verschiedene Schlüssel, IDs, Hostnamen, Hotspot-Passwörter** |
| Ende-zu-Ende (Chromium) | Admin-UI: Anmelden, Text anlegen (XSS wirkungslos), Termin per Satz, Rollen, **alle Klickflächen ≥ 44×44 px**, iPad/Handy ohne Querscrollen; Handy-Einrichtung in iPhone-Größe; Playerseite aus dem lokalen Plan; **alle Seiten ohne eine einzige Anfrage an externe Hosts, ohne Konsolenfehler** |
| Prozess | `server.js` als echter Prozess: TLS ≥ 1.2 (1.1 abgelehnt), Port 80 nur Weiterleitung, Schlüssel 0600, Zertifikat P-256 ~5 Jahre, sauberes Beenden |

## 3. Messwerte (Entwicklungsrechner, **nicht** Pi)
| Messgröße | Wert | Ziel | Hinweis |
|---|---|---|---|
| Hub-Prozess, Ruhe (RSS) | **118 MB** | < 150 MB | x86, Node 22; auf arm64 ähnlich, zu bestätigen |
| Player-Agent, Ruhe (RSS) | **82 MB** | Lite < 150 MB gesamt | ohne mpv/Chromium; Gesamtwert nur auf Hardware messbar |
| Hub-Start bis HTTPS bereit | 0,7 s | – | x86 |
| Admin-Oberfläche, Startseite | **23,8 KB gzip** (JS+CSS+HTML) | < 300 KB | alle Assets lokal |
| Tests | 96 grün, ~3 min | – | |

**Nicht messbar ohne Hardware:** Startzeit bis QR-Code (Ziel < 90 s auf Pi 3), RAM Chromium/mpv, CPU/Temperatur, WLAN-Durchsatz, Dekodierleistung je Modell → `hardware-checkliste.md` (Messblatt) und `tools/diagnose.sh` / Oberfläche „Diagnose …“.

## 4. Image-Bau
**Das Image wurde tatsächlich gebaut** (in dieser Sitzung, `build/build-image.sh` auf x86 mit qemu-user für arm64; pi-gen-Zweig `bookworm-arm64`, Commit in `image-build-info-0.1.0.txt`).

| Eigenschaft | Ergebnis |
|---|---|
| Datei | `dfm-signage-arm64-0.1.0.img.xz` + `.sha256` + `.sig` (Ed25519) |
| Größe | ≈ **553 MB** komprimiert, **2,38 GB** entpackt (Ziel < 2,5 GB ✅); Root-Inhalt 2,01 GB |
| Partitionen | p1 `DFMBOOT` FAT32 96 MB · p2 `DFMROOT` ext4 (nur lesbar) · p3 `DFMDATA` ext4 128 MB (wächst beim ersten Start) |
| Prüfprotokoll | `image-pruefung-0.1.0.txt`: **alle 27 Prüfungen bestanden** (kein Standardbenutzer/-passwort, SSH aus und maskiert, keine Hostschlüssel, `machine-id` leer, keine privaten Schlüssel, keine WLAN-Profile, Datenpartition leer, Root `ro`, ruhiger Start, Vorlage vorhanden, keine externen Hosts in den Oberflächen, …) |
| Dateisysteme | `e2fsck -fn` auf Root und Daten ohne Fehler; Prüfsumme und Signatur mit `build/verify-release.sh` bestätigt |
| arm64-Funktionstest (Root-Dateisystem unter qemu-user, `chroot`) | **Hub startet** auf aarch64 (HTTPS, Admin-Oberfläche mit CSP), `better-sqlite3`, `argon2`, `sharp` laden als **ARM64-Binärdateien**, `firstboot.js` erzeugt Geräte-ID und `geraeteinfo.txt`; Chromium, mpv, ffmpeg, cage, nftables, chrony, NetworkManager, Avahi, poppler, zbar vorhanden |
| QEMU-Start (`raspi3b`) | Kernel 6.12 bootet, Root wird **schreibgeschützt** eingebunden, systemd 252 startet, Hostname `dfm-signage`, `dfm-data.service` startet. Danach friert der Emulator ein (bekannte Grenzen von QEMU-raspi3b: SD-/SDIO-Emulation) – **kein Nachweis der vollständigen Startkette**. Beobachtung: `RuntimeWatchdogSec` löste im Emulator eine Neustart-Schleife aus → der Watchdog ist **nicht** im Image (nur Vorlage `build/optional/`). |

**Wichtig:** Das hier gebaute Image ist mit einem **Wegwerf-Schlüssel** signiert (nur für diese Sitzung) und liegt nur im Container (ca. 550 MB, kann nicht im Git liegen). Es ist **kein Release**. Für den Einsatz: `build/gen-release-key.sh`, eigenes Logo/Farben eintragen und `build/build-image.sh` ausführen (≈ 40 Minuten auf dem Entwicklungsrechner).

Beim Bau entdeckte und behobene Fehler (nur durch den echten Bau aufgefallen): fehlendes Paket `crda` in Bookworm; pi-gen-Variablen müssen exportiert werden; Loop-Partitionen im Container nicht verfügbar → Zusammenbau jetzt ohne Loop-Geräte (`assemble-image.sh`); Entwicklungswerkzeuge/Firmware/Übersetzungen entfernt (2,57 → 2,01 GB); `sshswitch`/`regenerate_ssh_host_keys` waren aktiv (jetzt maskiert); Journal/`/var/log` und Datenpartition-Erweiterung (online statt Offline-`resize2fs`) korrigiert.


## 5. Entscheidungen, die ich ohne Rückfrage getroffen habe
(Sie hatten Phase 1 nicht ausdrücklich freigegeben und die offenen Punkte nicht beantwortet; ich bin den im Konzept empfohlenen Weg gegangen. Alles ist leicht änderbar.)
1. **Headless-PIN:** letzte 6 Zeichen der Seriennummer; `geraeteinfo.txt` auf der Boot-Partition liefert sie für das Gerätelabel.
2. **Hotspot nur WPA2-PSK** (Pi 3/Zero 2 W können WPA3 nicht zuverlässig).
3. **IP-Adresse wird immer neben `dfm-signage.local` gezeigt** (Android-Chrome löst `.local` teils nicht auf).
4. **Nur Deutsch.**
5. **Image B (armhf-lite) entfällt** (ARMv6 nicht von Debian Stable unterstützt, 512 MB RAM, doppelter Testaufwand).
6. **NetworkManager-Hotspot statt hostapd, nftables statt ufw** (weniger Komponenten, schreibgeschütztes Root).
7. **Fastify statt nginx** für Medien (messen auf Pi 3 – Checkliste D).
8. **Design:** Platzhalter-Logo und -Farben; echte Werte in `assets/dfm-logo.svg` und `assets/dfm-theme.css` eintragen.

## 6. Abweichungen von der Aufgabenstellung (ehrlich)
- **Nicht umgesetzt:** Web-URL-, RSS-, Wetter-Inhalte und E-Mail-Benachrichtigung (nur die – standardmäßig ausgeschalteten – Schalter existieren); SSH-Aktivierung (bewusst: kein Benutzer im Image, siehe `sicherheit.md`); der Hub als *zusätzlicher* Player in der Oberfläche (technisch vorbereitet: `dfm-hub.target` startet den Agenten, wenn `agent.json` existiert); Verschieben der Hub-Daten auf eine USB-SSD; A/B-Update des Betriebssystems (nur App-Updates mit Rollback; Betriebssystem per Neu-Flashen); Screenreader-Prüfung mit echtem Screenreader (nur Beschriftungen, Rollen, Fokus automatisch geprüft).
- **Teilweise:** Kamera-QR-Scan ist an den Einrichtungsdienst angeschlossen und getestet (mit simulierter Kamera), aber nicht mit echter Kamera; WPA2-Enterprise ist in der Einrichtung vorgesehen (PEAP/MSCHAPv2), nicht gegen ein echtes Firmen-WLAN geprüft.
- **Image-Größe, Reproduzierbarkeit:** siehe Abschnitt 4 und `technikhandbuch.md` (funktional, nicht bit-genau reproduzierbar).
- **Pairing-Code und HMAC:** Weil der HMAC den Klartext-Code braucht, liegt der Code (10 Minuten) verschlüsselt (AES-256-GCM, Hub-Master-Schlüssel) in der Datenbank statt nur als Hash.

## 7. Nicht verifiziert (nur auf echten Geräten möglich)
1. **Startzeit** Einschalten → QR-Code (< 90 s auf Pi 3).
2. **Einrichtungsmodus auf Pi 3, Zero 2 W, Pi 4, Pi 5:** Hotspot (WPA2), Captive Portal auf **echtem iPhone und Android**, **Zwei-Phasen-WLAN-Test** (Handy verbindet sich nach dem Test selbst wieder?), 15-min-Timeout, Stromausfall während der Einrichtung.
3. **Chromium-Kiosk unter cage/PAM/tty1** (Dienstdefinitionen sind nach Dokumentation geschrieben, nie auf Hardware gestartet), Screenshot via `grim`, Hardware-Videodecoder, Bildschirm-Aus per CEC/`wlr-randr`.
4. **mpv-Lite** auf Zero 2 W (Dauerbetrieb, RAM-Budget).
5. **Video-Leistung je Modell** (`codec-entscheidung.md`, Annahmen!).
6. WLAN-Energiesparen wirklich aus, Verbindungsstabilität über Tage, mDNS im echten Museumsnetz.
7. **Nutzertest** mit einer Person ohne Technikkenntnisse (`nutzertest.md`).
8. Auf iOS Safari und Android Chrome wurden die Seiten nur mit Chromium (iPhone-Größe/-Kennung) geprüft, **nicht** in den echten Browsern.

## 8. Empfohlene nächste Schritte
1. Eigenen Release-Schlüssel erzeugen (`build/gen-release-key.sh`), Logo/Farben eintragen, Image bauen (`build/build-image.sh`).
2. Auf einem Pi 4 (Hub) und einem Pi 3 / Zero 2 W (Player) die **Hardware-Checkliste** abarbeiten; Fehler/Messwerte zurückmelden.
3. Nutzertest durchführen, Texte anpassen.
4. Sicherheits-Review durch eine zweite Person (Schwerpunkt: Einrichtungsmodus, `privd`, systemd-Härtung).
