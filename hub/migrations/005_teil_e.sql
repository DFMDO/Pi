-- Teil E (optional, freigegeben): Seitenverhältnisse/Hochkant, gestaffelte Updates, Medien-Lizenz und Ablaufdatum
ALTER TABLE devices ADD COLUMN fit_json TEXT;
ALTER TABLE media ADD COLUMN author TEXT;
ALTER TABLE media ADD COLUMN license TEXT;
ALTER TABLE media ADD COLUMN valid_until TEXT;
CREATE TABLE rollouts(
  id TEXT PRIMARY KEY, version TEXT, from_version TEXT, state TEXT NOT NULL CHECK(state IN ('canary','rolling','done','aborted')), test_device TEXT NOT NULL,
  batch_size INTEGER NOT NULL DEFAULT 2, soak_minutes INTEGER NOT NULL DEFAULT 5, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]', log_json TEXT NOT NULL DEFAULT '[]'
);
