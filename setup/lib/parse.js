// Parser für alle Wege, die Einrichtung zu füllen: WLAN-QR, dfm-setup.txt/json, Startkarte.
import { ssidOk, wpaOk, normalizeHubAddress, codeOk, fpOk, nameOk } from './validate.js';

/** WIFI:T:WPA;S:<SSID>;P:<Passwort>;H:true;; mit Escapes \; \, \: \\ \" */
export function parseWifiQr(text) {
  if (typeof text !== 'string' || !text.startsWith('WIFI:') || text.length > 400) return null;
  const body = text.slice(5), f = {}; let i = 0;
  while (i < body.length) {
    const c = body.indexOf(':', i); if (c < 0) break; const key = body.slice(i, c); let val = '', j = c + 1;
    for (; j < body.length; j++) { if (body[j] === '\\' && j + 1 < body.length) { val += body[++j]; continue; } if (body[j] === ';') break; val += body[j]; }
    f[key] = val; i = j + 1;
  }
  if (!ssidOk(f.S)) return null;
  const open = !f.T || f.T === 'nopass'; const pw = f.P ?? '';
  if (!open && !wpaOk(pw)) return null;
  return { ssid: f.S, password: open ? '' : pw, hidden: f.H === 'true' };
}
export const wifiQr = ({ ssid, password }) => { const esc = (s) => s.replace(/([\\;,:"])/g, '\\$1'); return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`; };

/** Startkarte: http://10.42.0.1/#c=<base64url(JSON)> */
export function parseCard(text) {
  try {
    const m = /#c=([A-Za-z0-9_-]+)$/.exec(text); const j = JSON.parse(Buffer.from(m ? m[1] : text, 'base64url').toString('utf8'));
    if (j.v !== 1) return null; const out = {};
    if (j.s) { if (!ssidOk(j.s) || (j.p && !wpaOk(j.p))) return null; out.wifi = { ssid: j.s, password: j.p ?? '' }; }
    if (j.h) { out.hubAddress = normalizeHubAddress(j.h); if (!out.hubAddress) return null; }
    if (j.f) { if (!fpOk(j.f)) return null; out.fingerprint = j.f; }
    if (j.c) { if (!codeOk(j.c)) return null; out.pairCode = j.c; }
    return out;
  } catch { return null; }
}

/** dfm-setup.txt:  schluessel = wert   (# Kommentare). Auch dfm-setup.json. Gibt {config, errors} zurück. */
const KEYS = { wlan_name: 'ssid', wlan_passwort: 'password', rolle: 'role', geraetename: 'name', hub_adresse: 'hubAddress', einrichtungscode: 'pairCode', hub_fingerabdruck: 'fingerprint',
  admin_name: 'adminName', admin_passwort: 'adminPassword', standort: 'site', wlan_versteckt: 'hidden' };
export function parseSetupFile(text, isJson = false) {
  let raw = {}; const errors = [];
  if (isJson) { try { raw = JSON.parse(text); } catch { return { config: null, errors: ['Die Datei dfm-setup.json ist kein gültiges JSON.'] }; } }
  else for (const [n, line] of text.split(/\r?\n/).entries()) {
    const l = line.trim(); if (!l || l.startsWith('#')) continue; const eq = l.indexOf('=');
    if (eq < 1) { errors.push(`Zeile ${n + 1}: „${l.slice(0, 30)}“ hat kein „=“.`); continue; }
    const k = l.slice(0, eq).trim().toLowerCase(), v = l.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!(k in KEYS)) { errors.push(`Zeile ${n + 1}: Unbekannter Eintrag „${k}“.`); continue; } raw[k] = v;
  }
  const g = {}; for (const [k, v] of Object.entries(raw)) if (k in KEYS && v !== '') g[KEYS[k]] = typeof v === 'string' ? v : String(v);
  if (g.role && !['hub', 'player'].includes(g.role)) errors.push('rolle muss „hub“ oder „player“ sein.');
  if (g.ssid && !ssidOk(g.ssid)) errors.push('wlan_name ist ungültig.');
  if (g.password && !wpaOk(g.password)) errors.push('wlan_passwort muss 8–63 Zeichen lang sein.');
  if (g.hubAddress && !normalizeHubAddress(g.hubAddress)) errors.push('hub_adresse ist ungültig.');
  if (g.pairCode && !codeOk(g.pairCode)) errors.push('einrichtungscode ist ungültig.');
  if (g.fingerprint && !fpOk(g.fingerprint)) errors.push('hub_fingerabdruck ist ungültig.');
  if (g.name && !nameOk(g.name)) errors.push('geraetename ist ungültig.');
  return { config: errors.length ? null : { wifi: g.ssid ? { ssid: g.ssid, password: g.password ?? '', hidden: g.hidden === 'true' } : null, role: g.role, name: g.name, hubAddress: g.hubAddress ? normalizeHubAddress(g.hubAddress) : undefined,
    pairCode: g.pairCode, fingerprint: g.fingerprint, admin: g.adminName ? { name: g.adminName, password: g.adminPassword } : undefined, site: g.site }, errors };
}
