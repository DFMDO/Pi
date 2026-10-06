// Hub finden: (1) gespeicherte Adresse, (2) mDNS (dfm-signage.local / _dfm-signage._tcp), (3) manuell.
import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';

/** Ausgabe von `avahi-browse -rtp _dfm-signage._tcp` → [{host, ip, port}] */
export function parseAvahi(out) {
  const res = [];
  for (const line of out.split('\n')) {
    const p = line.split(';'); if (p[0] !== '=' || p[2] !== 'IPv4') continue;
    res.push({ name: p[3], host: p[6], ip: p[7], port: Number(p[8]) });
  }
  return res;
}

export async function browseMdns(run = (c, a) => new Promise((res, rej) => execFile(c, a, { timeout: 8000 }, (e, so) => (e ? rej(e) : res(so))))) {
  try { return parseAvahi(await run('avahi-browse', ['-rtp', '_dfm-signage._tcp'])); } catch { return []; }
}

/** Kandidaten-URLs in Reihenfolge: gespeicherte URL, zuletzt bekannte IP, .local-Name, mDNS-Treffer. */
export async function hubCandidates({ hubUrl, lastIp, browse = browseMdns, lookup = (h) => dns.lookup(h, 4) }) {
  const out = [hubUrl];
  const u = new URL(hubUrl);
  try { const { address } = await lookup(u.hostname); if (address) out.push(`https://${address}${u.port ? ':' + u.port : ''}`); } catch {}
  if (lastIp) out.push(`https://${lastIp}${u.port ? ':' + u.port : ''}`);
  for (const h of await browse()) out.push(`https://${h.ip}${h.port && h.port !== 443 ? ':' + h.port : ''}`);
  return [...new Set(out)];
}
