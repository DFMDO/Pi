# WebSocket-Protokoll (Version 1)

Jeder Player hält **eine** Verbindung zum Hub: `wss://<hub>/api/v1/ws` mit Header `Authorization: Bearer <Geräte-Token>`.
Die Verbindung läuft nur über TLS und wird vom Player per **SPKI-Pinning** geprüft (siehe `sicherheit.md`).

Alle Nachrichten sind JSON mit `{ "v": 1, "type": "<typ>", … }`. Unbekannte Felder, falsche Typen oder
eine falsche Version beenden die Verbindung (Code 1008). Hub und Player nutzen dieselbe Prüfung
(`shared/protocol.js`).

| Richtung | `type` | Inhalt |
|---|---|---|
| Player → Hub | `hello` | `version`, `profile?`, `model?`, `hw?` – sofort nach dem Verbinden |
| Player → Hub | `heartbeat` | `state{…}` alle 30 s: Temperatur, RAM, WLAN-Signal (dBm), Sync-Stand, „zeigt gerade“, Zeit synchron |
| Hub → Player | `schedule_update` | `generatedAt, from, to, segments[], playlists{}, defaultPlaylistId, orientation` – **Zeitplan der nächsten 14 Tage als fertige Zeitfenster** |
| Hub → Player | `media_manifest` | `generatedAt, items[]` – nur Medien der Variante des Geräteprofils (id, sha256, size, url) |
| Hub → Player | `command` | `id, command, args?` – `reload, reboot, screenshot, rotate, wifi_change, reconnect, update, factory_reset` |
| Player → Hub | `command_result` | `id, ok, result?, error?` |
| Player → Hub | `screenshot` | `png` (Base64, höchstens 4 MB) |

## Verhalten
- **Heartbeat** 30 s. Der Hub wertet ein Gerät als *läuft* bei Meldung < 90 s, *keine Verbindung* < 10 min, danach *nicht erreichbar*.
- **Polling-Fallback:** Ist WSS nicht erreichbar, holt der Player alle 60 s `GET /api/v1/device/schedule` und `/manifest` (gepinntes HTTPS).
- **Wiederverbindung:** Backoff 1 s … 60 s mit Jitter. Reihenfolge der Adressen: gespeicherte URL → aufgelöster Name → zuletzt bekannte IP → mDNS (`_dfm-signage._tcp`).
- **Sperre:** Der Hub schließt die Verbindung mit Code `4001`, das Token ist sofort ungültig; der Player löscht sein Token und wechselt in die Einrichtung.
- **Befehle** werden bei Offline-Geräten in `commands` gespeichert und beim nächsten `hello` zugestellt. `wifi_change` enthält ein Passwort: es wird verschlüsselt gespeichert und nach der Zustellung aus der Datenbank entfernt; im Audit-Log steht nur der Netzwerkname.
- **Medien-Download:** `GET /api/v1/device/media/<id>` mit HTTP-Range (fortsetzbar), SHA-256 je Datei; höchstens 2 parallele Downloads je Player.

## Pairing-Ablauf (HTTPS, ohne Token)
1. `POST /api/v1/pair/challenge` → `{ nonce }` (60 s gültig, einmalig)
2. `POST /api/v1/pair/request` mit `deviceId, name, model, profile, hw, secretHash, hmac` — `hmac = HMAC-SHA256(Code, SPKI | deviceId | nonce | secretHash)`; der Code selbst geht nie über das Netz
3. Admin bestätigt im Hub → `POST /api/v1/pair/status {deviceId, secret}` liefert **einmalig** das Geräte-Token (nur als SHA-256 im Hub gespeichert)
