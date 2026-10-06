// WebSocket-Nachrichten (Version 1). Hub und Player nutzen dieselbe Prüfung.
// Jede Nachricht: { v: 1, type, ... }. Unbekannte Felder werden abgelehnt.
export const PROTOCOL_VERSION = 1;
const str = (max) => (x) => typeof x === 'string' && x.length <= max;
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const opt = (f) => (x) => x === undefined || f(x);

export const COMMANDS = ['rollback', 'identify', 'testpattern', 'signal_watch', 'confirm_display', 'reload', 'reboot', 'screenshot', 'rotate', 'wifi_change', 'reconnect', 'update', 'factory_reset', 'diagnose'];

const SCHEMAS = {
  hello: { profile: opt(str(20)), version: str(40), model: opt(str(100)), hw: opt(obj) },
  heartbeat: { state: obj },
  schedule_update: { generatedAt: num, from: num, to: num, segments: Array.isArray, playlists: obj,
    defaultPlaylistId: (x) => x === null || typeof x === 'string', orientation: opt(num), display: opt((x) => x === null || obj(x)), sync: opt(obj),
    fit: opt((x) => x === null || obj(x)), overrides: opt(Array.isArray), specialDays: opt(Array.isArray), hold: opt((x) => x === null || str(20)(x)), tickers: opt(Array.isArray), layout: opt((x) => x === null || obj(x)), maintenance: opt(obj) },
  media_manifest: { generatedAt: num, items: Array.isArray },
  command: { id: str(64), command: (x) => COMMANDS.includes(x), args: opt(obj) },
  command_result: { id: str(64), ok: (x) => typeof x === 'boolean', result: opt(obj), error: opt(str(500)) },
  status: { current: obj, next: opt((x) => x === null || obj(x)), source: opt(str(20)), scheduleId: opt((x) => x === null || str(64)(x)) },
  signal: { dbm: (x) => x === null || num(x), wifi: opt((x) => x === null || obj(x)) },
  screenshot: { png: str(4 * 1024 * 1024), mime: opt(str(20)) }, // base64
};

/** @returns {string|null} Fehlertext oder null wenn gültig */
export function validateMessage(m) {
  if (!obj(m) || m.v !== PROTOCOL_VERSION) return 'Protokollversion unbekannt';
  const s = SCHEMAS[m.type];
  if (!s) return 'Nachrichtentyp unbekannt';
  for (const k of Object.keys(m)) if (k !== 'v' && k !== 'type' && !(k in s)) return `Feld nicht erlaubt: ${k}`;
  for (const [k, f] of Object.entries(s)) if (!f(m[k])) return `Feld ungültig: ${k}`;
  return null;
}
export const msg = (type, body = {}) => JSON.stringify({ v: PROTOCOL_VERSION, type, ...body });
