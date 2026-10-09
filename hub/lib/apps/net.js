// Sicherer Abruf von Textseiten (Wetter-, Fußball-, RSS-, Kalender-Daten) – nur der Hub ruft ab, nur http(s), mit Zeitlimit und Größenlimit.
// Schutz: Adressen auf den Hub selbst (Loopback) und Link-Local (z. B. Cloud-Metadaten) sind verboten; Weiterleitungen werden einzeln geprüft (höchstens 3).
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const blockedIp = (ip) => {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 127 || a === 0 || (a === 169 && b === 254); }
  const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fe80:') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:169.254.') || x.startsWith('::ffff:0.');
};
export async function checkUrl(u, lookupFn = lookup) {
  let url; try { url = new URL(String(u)); } catch { throw new Error('Das ist keine gültige Adresse.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Nur Adressen mit http:// oder https:// sind erlaubt.');
  const host = url.hostname.replace(/^\[|\]$/g, ''); if (!host) throw new Error('Das ist keine gültige Adresse.');
  let addrs; try { addrs = net.isIP(host) ? [{ address: host }] : await lookupFn(host, { all: true }); } catch { throw new Error('Der Name dieser Adresse wurde nicht gefunden. Prüfe die Schreibweise und ob der Hub Internet bzw. DNS hat.'); }
  for (const a of addrs) if (blockedIp(a.address)) throw new Error('Diese Adresse ist nicht erlaubt (der Hub selbst oder eine Link-Local-Adresse).');
  return url;
}
const REDIRECTS = [301, 302, 303, 307, 308];
export async function fetchText(u, { timeoutMs = 10000, maxBytes = 2_000_000, accept = '*/*', fetchFn = fetch, lookupFn = lookup } = {}) {
  let next = String(u);
  for (let hop = 0; hop < 4; hop++) {
    const url = await checkUrl(next, lookupFn), headers = { accept, 'user-agent': 'DFM-Signage-Hub' };
    if (url.username) { headers.authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64'); url.username = ''; url.password = ''; }
    let res;
    try { res = await fetchFn(url.toString(), { redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Der Server antwortet nicht rechtzeitig.' : 'Der Server ist nicht erreichbar. Prüfe die Internetverbindung des Hubs und die Firewall.'); }
    if (REDIRECTS.includes(res.status)) { const loc = res.headers.get('location'); if (!loc) throw new Error('Der Server leitet ohne Ziel weiter.'); next = new URL(loc, url).toString(); continue; }
    if (res.status === 401 || res.status === 403) throw new Error('Der Server verlangt eine Anmeldung oder verweigert den Zugriff (Fehler ' + res.status + ').');
    if (!res.ok) throw new Error(`Der Server antwortet mit Fehler ${res.status}.`);
    const chunks = []; let n = 0;
    for await (const c of res.body) { n += c.length; if (n > maxBytes) throw new Error('Die Antwort ist zu groß.'); chunks.push(Buffer.from(c)); }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('Zu viele Weiterleitungen.');
}
