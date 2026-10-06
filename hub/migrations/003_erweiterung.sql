-- Erweiterung Teil A/B: Rolle „Anzeige“ (ersetzt „Betrachter“), Entwurf/Veröffentlicht, Versionsverlauf
CREATE TABLE users_new(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor','anzeige')),
  totp_secret_enc TEXT, recovery_hashes TEXT, failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
INSERT INTO users_new SELECT id,name,pw_hash,CASE role WHEN 'viewer' THEN 'anzeige' ELSE role END,totp_secret_enc,recovery_hashes,failed,locked_until,created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

ALTER TABLE schedules ADD COLUMN state TEXT NOT NULL DEFAULT 'published' CHECK(state IN ('draft','published'));
ALTER TABLE schedules ADD COLUMN draft_of TEXT;
ALTER TABLE schedules ADD COLUMN note TEXT;
ALTER TABLE playlists ADD COLUMN state TEXT NOT NULL DEFAULT 'published' CHECK(state IN ('draft','published'));
ALTER TABLE playlists ADD COLUMN draft_of TEXT;
ALTER TABLE playlists ADD COLUMN note TEXT;
ALTER TABLE playlists ADD COLUMN created_at INTEGER;
-- Versionsverlauf (90 Tage): Stand nach jedem Veröffentlichen
CREATE TABLE versions(id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, label TEXT, payload_json TEXT NOT NULL, ts INTEGER NOT NULL, user_id TEXT, user_name TEXT);
CREATE INDEX idx_versions_ref ON versions(kind, ref_id, ts);
CREATE INDEX idx_sched_state ON schedules(state);
