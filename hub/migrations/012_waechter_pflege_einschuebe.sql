-- Version 0.2.26: Bild-Wächter, Pflege-Erinnerungen, Einschübe.
-- Bild-Wächter: je Bildschirm die letzten Bild-Proben (nur Prüfsumme und Helligkeit, KEINE Bilder) und das Ergebnis.
CREATE TABLE watch_state(device_id TEXT PRIMARY KEY, next_due INTEGER, samples_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'unbekannt', note TEXT, since INTEGER, checked_at INTEGER);
-- Pflege: wann wurde welche Aufgabe an welchem Bildschirm zuletzt erledigt?
CREATE TABLE care_done(device_id TEXT NOT NULL, task TEXT NOT NULL, done_at INTEGER NOT NULL, done_by TEXT, PRIMARY KEY(device_id, task));
-- Einschübe: „alle N Minuten diese Folie für S Sekunden zeigen“.
CREATE TABLE inserts(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, media_id TEXT NOT NULL, every_min INTEGER NOT NULL, seconds INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all' CHECK(scope IN ('all','group','device')), target_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT, valid_to TEXT, created_by TEXT, created_at INTEGER NOT NULL
);
