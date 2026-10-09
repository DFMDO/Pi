-- Messwerte-Verlauf (Hub und Bildschirme, ca. 1 Messung pro Minute, 14 Tage) und Grundriss je Etage.
CREATE TABLE metrics(ts INTEGER NOT NULL, src TEXT NOT NULL, mem_avail REAL, mem_total REAL, swap_used REAL, load1 REAL, temp REAL);
CREATE INDEX metrics_src_ts ON metrics(src, ts);
CREATE TABLE floors(id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, has_image INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
ALTER TABLE devices ADD COLUMN floor_id TEXT;
ALTER TABLE devices ADD COLUMN plan_x REAL;
ALTER TABLE devices ADD COLUMN plan_y REAL;
