-- Erweiterung: Geräteprofil/Wartung (Z.3), Schnellaktionen/Szenen (Z.2), Sondertage (Z.6), Vorlagen (Z.5), Inbetriebnahme (Z.14), WLAN-Verlauf (Z.15), Wochenvorlagen (Z.13)
ALTER TABLE devices ADD COLUMN location TEXT;
ALTER TABLE devices ADD COLUMN floor TEXT;
ALTER TABLE devices ADD COLUMN serial TEXT;
ALTER TABLE devices ADD COLUMN mac TEXT;
ALTER TABLE devices ADD COLUMN installed_at TEXT;
ALTER TABLE devices ADD COLUMN notes TEXT;
ALTER TABLE devices ADD COLUMN doc_url TEXT;
ALTER TABLE devices ADD COLUMN maintenance_since INTEGER;
ALTER TABLE devices ADD COLUMN ready INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN layout_json TEXT;
ALTER TABLE devices ADD COLUMN replaced_by TEXT;
CREATE TABLE scenes(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, items_json TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
  note TEXT, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE overrides(
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('all','device','group')), target_id TEXT, content_type TEXT NOT NULL CHECK(content_type IN ('playlist','media')), content_id TEXT NOT NULL,
  scene_id TEXT, label TEXT, created_by TEXT, created_by_name TEXT, created_at INTEGER NOT NULL, until INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX idx_override_active ON overrides(until, ended_at);
CREATE TABLE special_days(
  id TEXT PRIMARY KEY, date TEXT NOT NULL, date_to TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sondertag' CHECK(kind IN ('feiertag','sondertag','ferien','schliesstag')),
  rule TEXT NOT NULL DEFAULT 'playlist' CHECK(rule IN ('playlist','off','notice')), content_type TEXT, content_id TEXT, source TEXT NOT NULL DEFAULT 'custom', created_at INTEGER NOT NULL
);
CREATE INDEX idx_special_date ON special_days(date);
CREATE TABLE templates(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published')),
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE commissioning_reports(
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ts INTEGER NOT NULL, user_name TEXT, result TEXT NOT NULL CHECK(result IN ('ok','warn','fail','skipped')),
  items_json TEXT NOT NULL, device_json TEXT
);
CREATE INDEX idx_commrep_dev ON commissioning_reports(device_id, ts);
CREATE TABLE wifi_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, ts INTEGER NOT NULL, signal_dbm INTEGER, quality TEXT, bssid TEXT, ssid TEXT, channel INTEGER, band TEXT,
  reconnects INTEGER NOT NULL DEFAULT 0, throughput_kbps INTEGER
);
CREATE INDEX idx_wifi_dev ON wifi_history(device_id, ts);
CREATE TABLE device_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
);
CREATE INDEX idx_devev ON device_events(device_id, ts);
CREATE TABLE week_templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, items_json TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE tickers(
  id TEXT PRIMARY KEY, text TEXT NOT NULL, valid_from TEXT, valid_to TEXT, target_type TEXT NOT NULL DEFAULT 'all', target_id TEXT, state TEXT NOT NULL DEFAULT 'published', created_by TEXT, created_at INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN groups_json TEXT;
CREATE TABLE read_tokens(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT, created_at INTEGER NOT NULL, last_used INTEGER);
