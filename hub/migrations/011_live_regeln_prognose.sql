-- Version 0.2.24: Live-Spiel mit Tor-Jubel, Wenn-Dann-Regeln, Programmpunkt-Countdown, Gesundheits-Prognose.
-- Strukturierte Ergebnisse einer App (Wetterwerte, Spielstand): Grundlage für Regeln und Tor-Jubel.
ALTER TABLE apps ADD COLUMN state_json TEXT;
-- Apps mit mehreren Folien (zum Beispiel „Nächster Programmpunkt“ je Raum): eine Folie je Schlüssel.
CREATE TABLE app_slides(type TEXT NOT NULL, key TEXT NOT NULL, media_id TEXT NOT NULL, last_hash TEXT, PRIMARY KEY(type, key));
-- Art einer Übersteuerung für die Rangfolge im Plan (Notfall vor Tor-Jubel vor Hand-Übersteuerung vor Regel). Eigene Tabelle, damit die
-- bestehenden Einfügungen in „overrides“ unverändert bleiben. Ohne Eintrag gilt „manual“.
-- prio (0–9) ordnet mehrere Regeln untereinander (höhere Zahl gewinnt).
CREATE TABLE override_kind(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('manual','notfall','tor','regel')), prio INTEGER NOT NULL DEFAULT 0);
-- Tor-Jubel: je Spiel merken, welches Tor schon gemeldet wurde (kein doppelter Jubel, kein Jubel für alte Tore).
CREATE TABLE live_state(match_id TEXT PRIMARY KEY, last_goal_id INTEGER NOT NULL DEFAULT 0, last_jubel_at INTEGER, updated_at INTEGER NOT NULL);
-- Wenn-Dann-Regeln.
CREATE TABLE rules(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 5,
  conditions_json TEXT NOT NULL, content_type TEXT NOT NULL CHECK(content_type IN ('playlist','media')), content_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all','group','device')), target_id TEXT, stable_s INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE rule_state(rule_id TEXT PRIMARY KEY, override_id TEXT, blocked INTEGER NOT NULL DEFAULT 0, true_since INTEGER, false_since INTEGER, started_at INTEGER);
-- Gesundheits-Prognose braucht auch den freien Speicherplatz im Verlauf.
ALTER TABLE metrics ADD COLUMN disk_free REAL;
