CREATE TABLE users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
  totp_secret_enc TEXT, recovery_hashes TEXT, failed INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE sessions(
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT
);
CREATE TABLE roles(name TEXT PRIMARY KEY);
CREATE TABLE permissions(role TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY(role,permission));
CREATE TABLE device_groups(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT, color TEXT NOT NULL DEFAULT '#c8102e'
);
CREATE TABLE devices(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
  model TEXT, profile TEXT NOT NULL DEFAULT 'standard', token_hash TEXT, spki_seen TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','blocked')),
  last_seen INTEGER, hw_json TEXT, state_json TEXT, orientation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE media(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','video','text','pdfpage')),
  original_path TEXT, sha256 TEXT, size INTEGER NOT NULL DEFAULT 0, duration_s REAL,
  width INTEGER, height INTEGER, tags TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '',
  text_json TEXT, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE media_variants(
  id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  profile TEXT NOT NULL, path TEXT, sha256 TEXT, size INTEGER, status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','running','ready','failed')), error TEXT, UNIQUE(media_id,profile)
);
CREATE TABLE playlists(id TEXT PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE playlist_items(
  id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id), pos INTEGER NOT NULL, duration_s INTEGER NOT NULL DEFAULT 10,
  transition TEXT NOT NULL DEFAULT 'fade', valid_from TEXT, valid_to TEXT
);
CREATE TABLE schedules(
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL CHECK(target_type IN ('device','group')), target_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('playlist','media')), content_id TEXT NOT NULL,
  start_local TEXT NOT NULL, end_local TEXT NOT NULL, rrule TEXT, exdates TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 1 AND 10), valid_from TEXT, valid_to TEXT,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE setup_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, user_name TEXT,
  action TEXT NOT NULL, target TEXT, ip TEXT, security INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
-- Unveränderbar: kein UPDATE, kein DELETE (auch nicht für Admins über die App)
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log ist unveränderbar'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log ist unveränderbar'); END;
CREATE TABLE pairing_codes(
  id TEXT PRIMARY KEY, code_enc TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0, created_by TEXT, challenge TEXT, device_id TEXT
);
CREATE TABLE commands(
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, type TEXT NOT NULL,
  args_json TEXT, status TEXT NOT NULL DEFAULT 'queued', result_json TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE trash(id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  deleted_at INTEGER NOT NULL, deleted_by TEXT);
CREATE INDEX idx_sched_target ON schedules(target_type,target_id);
CREATE INDEX idx_audit_ts ON audit_log(ts);
