// Rollen und Rechte. Jede /api/v1-Route muss ein Recht (config.perm) oder
// config.public / config.device deklarieren – das erzwingt app.js beim Start.
export const PERMS = [
  'users.manage', 'devices.read', 'devices.manage', 'media.read', 'media.write',
  'playlists.read', 'playlists.write', 'schedules.read', 'schedules.write',
  'audit.read', 'audit.export', 'settings.manage', 'backup.manage', 'update.manage', 'system.read',
  'live.read', 'schedules.publish', 'playlists.publish', 'overrides.write', 'scenes.write', 'templates.use', 'templates.manage', 'tickers.write', 'qr.write', 'import.run',
];
export const ROLE_PERMS = {
  admin: new Set(PERMS),
  editor: new Set(['devices.read', 'media.read', 'media.write', 'playlists.read', 'playlists.write',
    'schedules.read', 'schedules.write', 'system.read', 'live.read', 'schedules.publish', 'playlists.publish', 'overrides.write', 'scenes.write', 'templates.use', 'tickers.write', 'qr.write']),
  // „Anzeige“: nur die Live-Ansicht (Personal an Kasse, Info, Aufsicht) – sonst nichts
  anzeige: new Set(['live.read']),
};
export const can = (role, perm) => ROLE_PERMS[role]?.has(perm) ?? false;
