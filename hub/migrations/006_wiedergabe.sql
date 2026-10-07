-- Wiedergabe-Art je Bildschirm: auto (Lite → mpv, sonst Browser), browser (Texte, Laufband, Zonen), mpv (Video-optimiert, am flüssigsten)
ALTER TABLE devices ADD COLUMN renderer TEXT NOT NULL DEFAULT 'auto';
