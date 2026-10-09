-- Apps (Wetter, Datum/Öffnungszeiten, Tagesprogramm, Nachrichten, Fußball): Der Hub holt die Daten und pflegt je App eine Textfolie (Ordner „Apps“).
CREATE TABLE apps(
  type TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', media_id TEXT,
  last_run INTEGER, last_ok INTEGER, last_error TEXT, last_hash TEXT, created_at INTEGER NOT NULL
);
