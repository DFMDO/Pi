-- Videoformat und Bildrate merken: Damit kann die Oberfläche schon beim Hochladen warnen, wenn der Hub das Video neu berechnen müsste (dauert auf dem Pi 3 sehr lange).
ALTER TABLE media ADD COLUMN codec TEXT;
ALTER TABLE media ADD COLUMN fps REAL;
