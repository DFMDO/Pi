// Live-Bild (Kamera oder Stream als Folie). Prinzip „lokal“: Erlaubt sind nur Adressen im eigenen Netz – nie das Internet.
// Die Prüfung nutzen der Hub (beim Anlegen) und der Bildschirm (vor dem Abspielen) gleichermaßen.

const PROTOCOLS = new Set(['rtsp:', 'rtsps:', 'http:', 'https:', 'udp:']);
const LOCAL_SUFFIXES = ['.local', '.lan', '.intern', '.internal', '.home.arpa', '.fritz.box'];
export const MAX_STREAM_URL = 300;

const ipv4 = (h) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h); if (!m) return null; const o = m.slice(1).map(Number); return o.every((n) => n <= 255) ? o : null; };
const localV4 = ([a, b]) => a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
const localV6 = (s) => s === '::1' || /^fe[89ab][0-9a-f]:/.test(s) || /^f[cd][0-9a-f]{2}:/.test(s);

/** Liegt dieser Rechnername/diese Adresse im eigenen Netz? (Multicast nur bei udp:) */
export function isLocalHost(host, { multicast = false } = {}) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  const v4 = ipv4(h); if (v4) return localV4(v4) || (multicast && v4[0] >= 224 && v4[0] <= 239);
  if (h.includes(':')) return localV6(h);
  if (/^[0-9]/.test(h) && !h.includes('.')) return false; // „2130706433“ ist eine Zahl-Schreibweise für eine IP-Adresse – nicht erlaubt
  if (!h.includes('.')) return /^[a-z][a-z0-9-]*$/.test(h); // „kamera1“: ein Name im eigenen Netz
  return LOCAL_SUFFIXES.some((s) => h.endsWith(s)) && /^[a-z0-9.-]+$/.test(h);
}

/** Zugangsdaten (Benutzer:Passwort@) in einer Adresse unkenntlich machen – für Listen und Protokolle */
export function maskStreamUrl(url) { return String(url ?? '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1***@'); }

/**
 * Prüft eine Adresse. { ok: true, url } oder { ok: false, error } (Klartext für Menschen).
 */
export function parseStreamUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'Bitte gib die Adresse des Live-Bilds ein.' };
  if (s.length > MAX_STREAM_URL) return { ok: false, error: `Die Adresse ist zu lang (höchstens ${MAX_STREAM_URL} Zeichen).` };
  if (/[\s\u0000-\u001f"'<>\\`]/.test(s)) return { ok: false, error: 'Die Adresse enthält Zeichen, die nicht erlaubt sind (zum Beispiel Leerzeichen).' };
  let u; try { u = new URL(s); } catch { return { ok: false, error: 'Das ist keine gültige Adresse. Sie beginnt zum Beispiel mit rtsp:// oder http://.' }; }
  if (!PROTOCOLS.has(u.protocol)) return { ok: false, error: 'Diese Art von Adresse ist nicht erlaubt. Möglich sind rtsp://, rtsps://, http://, https:// und udp://.' };
  if (!u.hostname) return { ok: false, error: 'In der Adresse fehlt der Name oder die IP-Adresse des Geräts.' };
  if (!isLocalHost(u.hostname, { multicast: u.protocol === 'udp:' })) return { ok: false, error: 'Diese Adresse führt nicht ins Museumsnetz. Aus Sicherheitsgründen sind nur Geräte im eigenen Netz erlaubt (zum Beispiel 192.168… oder 10…).' };
  return { ok: true, url: s };
}
