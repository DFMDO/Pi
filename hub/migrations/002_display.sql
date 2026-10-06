-- Bildschirm zeitgesteuert aus/an: { "off": {"from":"22:00","to":"07:00"}, "days": [..optional] } je Gerät
ALTER TABLE devices ADD COLUMN display_json TEXT;
