-- Version 0.2.29: Verschachtelte Listen, Auslöser-Links, Fluchtweg-Pläne, Gleichtakt/Videowand.
-- (Das Live-Bild braucht keine Änderung: Es ist ein Text-Medium mit dem Feld „stream“ in text_json.)

-- Verschachtelte Listen: Eine Abspielliste kann andere (veröffentlichte) Listen enthalten. Die Reihenfolge teilt sich pos mit playlist_items.
-- Der Hub macht daraus beim Erstellen des Plans eine flache Liste – der Player merkt nichts davon.
CREATE TABLE playlist_includes(
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  pos INTEGER NOT NULL, valid_from TEXT, valid_to TEXT
);
CREATE INDEX idx_playlist_includes ON playlist_includes(playlist_id);
CREATE INDEX idx_playlist_includes_sub ON playlist_includes(sub_id);

-- Auslöser-Links: ein geheimer Link startet von außen (Handy-Kurzbefehl, Stream-Deck, Haustechnik) eine Schnellaktion.
-- Gespeichert wird nur der Hash des Links (wie bei Anmelde-Sitzungen); der Klartext wird einmal beim Anlegen gezeigt.
CREATE TABLE triggers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scene_id TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'start' CHECK(action IN ('start','stop')), minutes INTEGER NOT NULL DEFAULT 30, end_of_day INTEGER NOT NULL DEFAULT 0,
  allow_get INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, created_by TEXT, last_used INTEGER, use_count INTEGER NOT NULL DEFAULT 0
);

-- Fluchtweg-Plan je Bildschirm: Ein Bild (Medium), das bei einer Notfall-Meldung nach dem Meldungstext auf genau diesem Bildschirm folgt.
ALTER TABLE devices ADD COLUMN escape_media_id TEXT;

-- Gleichtakt und Videowand: Gruppen können alle Bildschirme zur selben Zeit dasselbe zeigen lassen oder ein Bild über ein Raster verteilen.
ALTER TABLE device_groups ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'off' CHECK(sync_mode IN ('off','gleichtakt','videowand'));
ALTER TABLE device_groups ADD COLUMN wall_cols INTEGER NOT NULL DEFAULT 1;
ALTER TABLE device_groups ADD COLUMN wall_rows INTEGER NOT NULL DEFAULT 1;
ALTER TABLE device_groups ADD COLUMN sync_epoch INTEGER;
ALTER TABLE devices ADD COLUMN wall_col INTEGER;
ALTER TABLE devices ADD COLUMN wall_row INTEGER;
