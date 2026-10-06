# Sicherheitskonzept (ehrlich)

## Schutzziele und Reihenfolge
1. **Lokal** – nichts verlässt das Museumsnetz: keine Cloud, keine Telemetrie, keine Update-Anfragen, keine externen Schriften/CDNs. Chromium wird mit `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` und einer Enterprise-Richtlinie (`URLBlocklist: *`) gestartet: der Browser *kann* keine fremden Hosts erreichen. Ein Test (`tests/e2e-ui.test.js`) lädt Admin-Oberfläche, Einrichtungsseite und Playerseite bei gesperrtem Internet und scheitert bei jeder Anfrage nach außen.
2. **Sicher** – siehe unten.
3. **Einfach**, 4. **Robust** – siehe Handbücher.

## Transport: Zertifikats-Pinning statt eigener CA
- Der Hub erzeugt beim ersten Start ein selbstsigniertes ECDSA-P-256-Zertifikat (5 Jahre; SAN: `dfm-signage.local`, Hostname, IPs). Der private Schlüssel liegt nur auf dem Hub (`0600`, eigener Systembenutzer).
- Player pinnen den **SHA-256-Hash des öffentlichen Schlüssels (SPKI)**. Ein fremder Schlüssel wird abgelehnt – **bevor ein Byte gesendet wird** (die Prüfung läuft im `createConnection`-Callback; Token und Pairing-Code erreichen einen falschen Server nie). Es gibt keine Ausnahme-Schaltfläche.
- Erneuert der Hub sein Zertifikat (z. B. neue IP), bleibt der Schlüssel – der Pin bleibt gültig.
- Der Browser des Admins zeigt die übliche Warnung für selbstsignierte Zertifikate. Der Einrichtungsassistent erklärt mit dem Fingerabdruck (Vierergruppen), wie man sie einmalig sicher bestätigt; das Zertifikat ist für die IT herunterladbar.
- TLS ≥ 1.2, HSTS, `Secure`-Cookies.

**Ehrliche Einschränkung:** Der erste Browser-Besuch ist „Trust on first use“ des Menschen. Wer den Fingerabdruck nicht mit der Anzeige am Hub vergleicht, kann auf einen Angreifer im selben Netz hereinfallen. Der Player ist besser geschützt: Mit Startkarte/Konfigurationsdatei kommt der Fingerabdruck *mit* und **muss** übereinstimmen.

## Pairing
Einmalcode (8 Zeichen ohne Verwechslungsbuchstaben, 10 Minuten, 5 Fehlversuche, genau ein aktiver Code). Der Player sendet `HMAC-SHA256(Code, SPKI | Geräte-ID | Nonce | Hash(Abholgeheimnis))`. Ein Man-in-the-Middle sieht einen anderen SPKI → falscher HMAC → Ablehnung + **Sicherheitsereignis** im Audit-Log. Der Admin bestätigt jedes Gerät mit „Ist das dein Bildschirm?“. Erst dann entsteht ein 256-Bit-Token (nur als Hash gespeichert). Sperren/Entfernen macht das Token sofort ungültig und beendet die WebSocket-Verbindung.

## Einrichtungsmodus (Hotspot)
- Eigenes WLAN `DFM-Setup-<4 Zeichen>`, **WPA2-PSK/CCMP** (Pi 3/Zero 2 W unterstützen WPA3 nicht zuverlässig), 12 zufällige Zeichen ohne Verwechsler, pro Start neu, nur im Einrichtungsmodus.
- Zusätzlich **6-stellige PIN**, nur auf dem Bildschirm (Loopback-Server `127.0.0.1:8081` – das Handy erreicht ihn nicht). 5 Fehlversuche → neue PIN, alle Sitzungen ungültig.
- 15 Minuten ohne Aktivität → neuer Start mit neuem Passwort und neuer PIN. Nach Abschluss: Hotspot aus.
- HTTP ist hier erlaubt, weil die Seite nur im abgeschotteten Setup-WLAN erreichbar ist. Strenge Validierung: SSID 1–32 Byte, WPA-Passwort 8–63 ASCII/64 Hex, Hub-Adresse nur lokal (private IPv4, `*.local`, einfacher Hostname → **SSRF-Schutz**). **Kein Wert gelangt je in eine Shell**: `nmcli` wird ausschließlich über `execFile` mit Argumentliste aufgerufen (Test mit `$(reboot)`, Backticks, Anführungszeichen).
- **Headless-Geräte (ohne Bildschirm):** PIN = letzte 6 Zeichen der Seriennummer (steht in `geraeteinfo.txt` auf der SD-Karte und auf dem Gerätelabel). *Restrisiko:* Seriennummern sind nicht geheim; der Schutz beruht auf dem 15-Minuten-Fenster, 5 Versuchen und dem physischen Zugang zum Label. Alternativen ohne Hotspot: Konfigurationsdatei oder LAN-Kabel.

## Anmeldung und Rechte
argon2id (19 MiB, t=2), Passwort ≥ 12 Zeichen mit lokaler Liste häufiger Passwörter, identische Fehlermeldung für falschen Benutzer/falsches Passwort (konstante Rechenzeit über Dummy-Hash), Rate-Limit pro IP **und** Benutzer mit steigender Sperre, serverseitige Sitzungen (`__Host-dfm_sid; HttpOnly; Secure; SameSite=Strict`), CSRF-Token, Abmeldung nach 30 Minuten, optional TOTP mit Wiederherstellungscodes (lokal). Rollen Admin/Redakteur/Betrachter; **jede** API-Route deklariert ihr Recht – der Server startet nicht, wenn eine fehlt (Test prüft zusätzlich jede Route gegen jede Rolle).

## Härtung
- Strenge CSP (`default-src 'self'`, keine Inline-Skripte/-Styles), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy`.
- Uploads: Typ nach **Magic Bytes** (nicht Dateiname), UUID-Namen, Größenlimits, Bilder serverseitig neu kodiert (EXIF/GPS entfernt), PDFs nur als gerenderte Bilder, Auslieferung mit `CSP: sandbox`.
- SQL ausschließlich parametrisiert; Statische Dateien nur aus einer vorab indizierten Liste (kein Path Traversal); Medien nur über UUID.
- systemd: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `RestrictAddressFamilies`, minimale Capabilities, `MemoryMax`. Nur `dfm-setup` darf (kurzzeitig, nur im Einrichtungsmodus) das Netzwerk umkonfigurieren.
- **Privilegientrennung:** Hub und Agent laufen unprivilegiert. Reboot, WLAN-Änderung, Werksreset, Uhr stellen erledigt ein kleiner Root-Dienst (`dfm-privd`) aus einer **festen Whitelist** mit streng geprüften Argumenten, ohne Shell.
- Firewall (nftables): Hub 443, 80 (nur Weiterleitung), 123/UDP, 5353/UDP; Player und Einrichtungsmodus nur das Nötigste; Standard „eingehend verboten“.
- Audit-Log: hash-verkettet (Manipulation erkennbar), per Datenbank-Trigger nicht änderbar; Geheimnisse maskiert; CSV-Export gegen CSV-Injection geschützt.
- Backups: AES-256-GCM, Schlüsselableitung scrypt; **Passphrase wird nie gespeichert**. Täglich/wöchentlich automatisch möglich, weil nur ein X25519-Schlüssel auf dem Gerät liegt (ECIES); zum Wiederherstellen ist die Passphrase nötig.
- Updates: Ed25519-signiertes Paket (öffentlicher Schlüssel im Image), Signatur und SHA-256 Pflicht, Rollback nach 3 Fehlstarts; nie aus dem Internet.

## Keine Geheimnisse im Image
TLS-Schlüssel, Hub-Master-Schlüssel, Geräte-ID, Hostname, machine-id, Hotspot-Passwort/PIN und Tokens entstehen **pro Gerät beim ersten Start**. `build/check-image.js` prüft jedes gebaute Image (kein `pi`-Benutzer, kein Passwort-Hash, SSH aus und maskiert, keine Hostschlüssel, `machine-id` leer, keine privaten Schlüssel, keine WLAN-Profile, Datenpartition leer, fstab/cmdline). `tests/image-and-release.test.js` belegt, dass zwei Karten unterschiedliche Schlüssel, IDs, Hostnamen und Hotspot-Passwörter haben.

## Bewusst nicht abgedeckt
- Physischer Zugriff auf Pi oder SD-Karte (Schlüssel liegen unverschlüsselt auf der Datenpartition; WLAN-Passwörter ebenfalls).
- Kompromittierte Admin-Browser/-Rechner.
- Angreifer, die während der 15-minütigen Einrichtung im Funkbereich sind und PIN, QR-Code und Setup-Passwort auf dem Bildschirm sehen können.
- Das **Löschen der Konfigurationsdatei** auf der FAT-Boot-Partition ist wegen Wear-Leveling der SD-Karte nicht forensisch sicher (Datei wird überschrieben und gelöscht). Deshalb: Einmalcode läuft nach 10 Minuten ab; für das WLAN ein eigenes Signage-Netz ohne Internet verwenden.
- Die Startkarte (QR) enthält – wenn so gewählt – das WLAN-Passwort im Klartext; Karte nach Gebrauch vernichten.
- Zeit: Der Hub hat keine Batterieuhr. Ohne richtige Zeit starten Termine zur falschen Stunde. Die Oberfläche warnt und bietet „Uhr mit diesem Computer abgleichen“ an; ein IT-NTP-Server oder ein Pi 5 mit RTC-Batterie ist besser.
