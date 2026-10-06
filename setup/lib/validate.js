// Strenge Eingabeprüfung für die Einrichtungsseite. Nichts davon landet je in einer Shell:
// alle Werte gehen später nur als einzelne Argumente an execFile (kein Interpolieren).
export const ssidOk = (s) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 32 && !/[\x00-\x1f\x7f]/.test(s);
export const wpaOk = (p) => typeof p === 'string' && ((p.length >= 8 && p.length <= 63 && /^[\x20-\x7e]+$/.test(p)) || /^[0-9a-fA-F]{64}$/.test(p));
export const nameOk = (n) => typeof n === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,59}$/u.test(n.trim());
export const userOk = (u) => typeof u === 'string' && u.length > 0 && u.length <= 64 && !/[\x00-\x1f\x7f]/.test(u);
export const pinOk = (p) => typeof p === 'string' && /^\d{6}$/.test(p);
export const codeOk = (c) => typeof c === 'string' && /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(c);
export const fpOk = (f) => typeof f === 'string' && /^([0-9a-fA-F]{4}[ :-]?){15}[0-9a-fA-F]{4}$/.test(f.trim());

const isPrivateV4 = (h) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h); if (!m) return false; const [a, b] = [+m[1], +m[2]];
  if (m.slice(1).some((x) => +x > 255)) return false; return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); };
/**
 * Hub-Adresse → normalisierte https-URL oder null.
 * Nur lokale Ziele (SSRF-Schutz): private IPv4, *.local oder einfacher Hostname ohne Punkt.
 */
export function normalizeHubAddress(input) {
  if (typeof input !== 'string') return null;
  const m = /^(?:https?:\/\/)?([A-Za-z0-9.\-]{1,100})(?::(\d{1,5}))?\/?$/.exec(input.trim()); if (!m) return null;
  const [, host, port] = m; if (port && (+port < 1 || +port > 65535)) return null;
  const local = isPrivateV4(host) || /^[a-z0-9-]+\.local$/i.test(host) || /^[a-z0-9-]+$/i.test(host);
  if (!local || /^\d+\.\d+\.\d+\.\d+$/.test(host) && !isPrivateV4(host)) return null;
  return `https://${host.toLowerCase()}${port && port !== '443' ? ':' + port : ''}`;
}

/** Fehler als Liste verständlicher Sätze (leer = alles gut). */
export function validateDraft(d, { adminPolicy = () => null } = {}) {
  const e = [];
  const w = d.wifi;
  if (w?.skip) { /* Netzwerkkabel: WLAN wird später in der Oberfläche nachgetragen */ }
  else if (!w) e.push('Bitte wähle zuerst ein WLAN.');
  else {
    if (!ssidOk(w.ssid)) e.push('Der WLAN-Name ist ungültig (1–32 Zeichen).');
    if (w.enterprise) { if (!userOk(w.enterprise.user)) e.push('Bitte gib den Benutzernamen für das Firmen-WLAN ein.'); if (typeof w.enterprise.password !== 'string' || !w.enterprise.password || w.enterprise.password.length > 200) e.push('Bitte gib das Passwort für das Firmen-WLAN ein.'); }
    else if (w.password !== '' && w.password !== undefined && !wpaOk(w.password)) e.push('Das WLAN-Passwort muss 8 bis 63 Zeichen lang sein.');
  }
  if (!['hub', 'player'].includes(d.role)) e.push('Bitte wähle, ob dies der Hub oder ein Bildschirm ist.');
  if (d.role === 'hub') {
    if (!nameOk(d.admin?.name ?? '')) e.push('Bitte gib einen Namen für das Admin-Konto ein.');
    const bad = adminPolicy(d.admin?.password, d.admin?.name); if (bad) e.push(bad);
    if (!d.site || d.site.length > 100) e.push('Bitte gib den Namen deines Museums oder Standorts ein.');
  }
  if (d.role === 'player') {
    if (!nameOk(d.name ?? '')) e.push('Bitte gib dem Bildschirm einen Namen, z. B. „Shop-Screen“.');
    if (!normalizeHubAddress(d.hubAddress ?? '')) e.push('Die Hub-Adresse ist ungültig. Sie sieht z. B. so aus: dfm-signage.local');
    if (!codeOk(d.pairCode ?? '')) e.push('Der Einrichtungscode hat 8 Zeichen, z. B. K7M4-X9RD.');
    if (d.fingerprint && !fpOk(d.fingerprint)) e.push('Der Fingerabdruck des Hubs ist ungültig.');
  }
  return e;
}
