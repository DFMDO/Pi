-- Meldung bei Ausfall (E-Mail) und Wiedergabe-Nachweis.
-- Einstellungen der Ausfall-Meldung (genau eine Zeile; das E-Mail-Passwort steht verschlüsselt darin, nie im Klartext und nie in „settings“).
CREATE TABLE alert_config(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
-- Merkt sich je Bildschirm, ob für den aktuellen Ausfall schon gemeldet wurde (und wann zuletzt eine Ausfall-Mail ging, gegen Mail-Fluten bei wackelnden Verbindungen).
CREATE TABLE alert_state(device_id TEXT PRIMARY KEY, down_since INTEGER, notified_at INTEGER, last_mail_at INTEGER);
-- Wiedergabe-Nachweis: wie oft und wie lange lief welches Medium auf welchem Bildschirm an welchem Tag (Berliner Datum). Keine personenbezogenen Daten.
CREATE TABLE plays(day TEXT NOT NULL, device_id TEXT NOT NULL, media_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', plays INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, device_id, media_id));
CREATE INDEX idx_plays_day ON plays(day);
