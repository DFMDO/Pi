// Startpunkt des Hubs: HTTPS auf 443, HTTP auf 80 (nur Weiterleitung).
import { createServer as createHttp } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { ensureCertificate } from './lib/tls.js';
import { bootGuard, markHealthy } from './lib/update.js';
import { installProcessGuards } from '../shared/guard.js';

// Nicht abgefangene Fehler in Hintergrundaufgaben werden protokolliert statt den Hub zu beenden; bei Dauerfehlern oder einem schweren Fehler startet er sauber neu (Code 75).
installProcessGuards({ name: 'Hub', log: (...a) => console.error(...a) });

const dataDir = process.env.DFM_DATA ?? '/data';
const httpsPort = Number(process.env.DFM_HTTPS_PORT ?? 443), httpPort = Number(process.env.DFM_HTTP_PORT ?? 80);
const appDir = join(dataDir, 'app');
const guard = bootGuard(appDir); if (guard === 'rolled-back') { console.error('Update fehlgeschlagen, Rollback'); process.exit(75); }

// Die Abfrage darf den Start nie verhindern (z. B. wenn das System Netlink-Zugriff sperrt): dann ohne IP-Adressen im Zertifikat weiter.
let ifaces = {}; try { ifaces = networkInterfaces(); } catch (e) { console.error('Netzwerkadressen nicht lesbar:', e.message); }
const ips = Object.values(ifaces).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
// Docker: Die Adressen im Container sind nur intern. DFM_HOST_IPS = Adresse(n) des Docker-Rechners (kommen ins Zertifikat und auf die Startkarten), DFM_EXTRA_SANS = weitere Namen.
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const san = (v) => (/^[0-9.]+$/.test(v) || v.includes(':') ? `IP:${v}` : `DNS:${v}`);
const hostIps = list(process.env.DFM_HOST_IPS), shownIps = hostIps.length ? hostIps : ips, hubHost = process.env.DFM_HUB_HOST ?? hostIps.find((x) => !/^[0-9.]+$/.test(x) && !x.includes(':')) ?? 'dfm-signage.local';
const sans = [...new Set(['DNS:dfm-signage.local', `DNS:${hostname()}`, 'DNS:localhost', ...ips.map((i) => `IP:${i}`), 'IP:127.0.0.1', ...hostIps.map(san), ...list(process.env.DFM_EXTRA_SANS).map(san)])];
const tls = ensureCertificate(join(dataDir, 'tls'), sans);
const pubKeyFile = process.env.DFM_UPDATE_KEY ?? '/etc/dfm/update-key.pub';

const app = await buildApp({ dataDir, tls, useTls: true, appDir, baseDir: process.env.DFM_BASE ?? '/opt/dfm', updateKeyPem: existsSync(pubKeyFile) ? readFileSync(pubKeyFile, 'utf8') : '',
  hubInfo: () => ({ host: hubHost, ips: shownIps }), onRestart: () => process.exit(75), /* 75 statt 0: dfm-hub.service startet nur nach einem "Fehler" neu (Restart=on-failure), sonst käme der Hub nach einem Update nicht zurück */ logger: { level: 'warn', redact: ['req.headers.authorization', 'req.headers.cookie'], serializers: { req: (r) => ({ method: r.method, url: String(r.url ?? '').replace(/(\/trigger\/)[^/?#\s]+/, '$1***'), hostname: r.hostname, remoteAddress: r.ip }) } } });

await app.listen({ port: httpsPort, host: '0.0.0.0' });
// Docker: Es gibt keinen Bildschirm am Hub – der Einrichtungscode für das erste Konto steht darum im Protokoll des Containers.
if (process.env.DFM_CONTAINER === '1') { try { const f = join(dataDir, 'keys', 'setup-code.txt'); if (existsSync(f)) console.log(`
=== DFM Signage Hub: Einrichtungscode: ${readFileSync(f, 'utf8').trim()} ===
    Öffne die Verwaltung im Browser und lege das erste Konto an.
`); } catch {} }
// Port 80: nur Weiterleitung auf HTTPS (Host wird nicht ungeprüft übernommen)
createHttp((req, res) => {
  const host = String(req.headers.host ?? 'dfm-signage.local').replace(/[^a-zA-Z0-9.\-:]/g, '').replace(/:\d+$/, '');
  const pub = Number(process.env.DFM_PUBLIC_HTTPS_PORT ?? httpsPort); // hinter einer Port-Weiterleitung (Docker) zählt die nach außen sichtbare Nummer
  res.writeHead(301, { Location: `https://${host}${pub === 443 ? '' : ':' + pub}/` }).end();
}).on('error', (e) => console.error('Port 80 (nur Weiterleitung) nicht verfügbar:', e.message)).listen(httpPort, '0.0.0.0'); // ohne Port 80 läuft der Hub trotzdem

// Nach 60 s ohne Absturz gilt eine Version als gesund (Update-Rollback-Schutz)
setTimeout(() => markHealthy(appDir), 60000).unref();
// Täglich Backup (nur wenn Verschlüsselung eingerichtet), stündlich prüfen
setInterval(() => { try { app.runBackup(app.settings()['backup.extraDir']); } catch (e) { console.error('Backup fehlgeschlagen:', e.message); } }, 3600000).unref();
// Sauber beenden (Datenbank schließen), aber nie länger als 8 Sekunden warten: Ein hängender Abschluss darf das Herunterfahren oder den Neustart nicht blockieren.
let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (closing) return; closing = true; const hard = setTimeout(() => process.exit(0), 8000); app.close().catch((e) => console.error('Beenden:', e?.message ?? e)).finally(() => { clearTimeout(hard); process.exit(0); }); });
