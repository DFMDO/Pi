// Startpunkt des Hubs: HTTPS auf 443, HTTP auf 80 (nur Weiterleitung).
import { createServer as createHttp } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { ensureCertificate } from './lib/tls.js';
import { bootGuard, markHealthy } from './lib/update.js';

const dataDir = process.env.DFM_DATA ?? '/data';
const httpsPort = Number(process.env.DFM_HTTPS_PORT ?? 443), httpPort = Number(process.env.DFM_HTTP_PORT ?? 80);
const appDir = join(dataDir, 'app');
const guard = bootGuard(appDir); if (guard === 'rolled-back') { console.error('Update fehlgeschlagen, Rollback'); process.exit(75); }

// Die Abfrage darf den Start nie verhindern (z. B. wenn das System Netlink-Zugriff sperrt): dann ohne IP-Adressen im Zertifikat weiter.
let ifaces = {}; try { ifaces = networkInterfaces(); } catch (e) { console.error('Netzwerkadressen nicht lesbar:', e.message); }
const ips = Object.values(ifaces).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address);
const sans = ['DNS:dfm-signage.local', `DNS:${hostname()}`, 'DNS:localhost', ...ips.map((i) => `IP:${i}`), 'IP:127.0.0.1'];
const tls = ensureCertificate(join(dataDir, 'tls'), sans);
const pubKeyFile = process.env.DFM_UPDATE_KEY ?? '/etc/dfm/update-key.pub';

const app = await buildApp({ dataDir, tls, useTls: true, appDir, baseDir: process.env.DFM_BASE ?? '/opt/dfm', updateKeyPem: existsSync(pubKeyFile) ? readFileSync(pubKeyFile, 'utf8') : '',
  hubInfo: () => ({ host: 'dfm-signage.local', ips }), onRestart: () => process.exit(75), /* 75 statt 0: dfm-hub.service startet nur nach einem "Fehler" neu (Restart=on-failure), sonst käme der Hub nach einem Update nicht zurück */ logger: { level: 'warn', redact: ['req.headers.authorization', 'req.headers.cookie'] } });

await app.listen({ port: httpsPort, host: '0.0.0.0' });
// Port 80: nur Weiterleitung auf HTTPS (Host wird nicht ungeprüft übernommen)
createHttp((req, res) => {
  const host = String(req.headers.host ?? 'dfm-signage.local').replace(/[^a-zA-Z0-9.\-:]/g, '').replace(/:\d+$/, '');
  res.writeHead(301, { Location: `https://${host}${httpsPort === 443 ? '' : ':' + httpsPort}/` }).end();
}).listen(httpPort, '0.0.0.0');

// Nach 60 s ohne Absturz gilt eine Version als gesund (Update-Rollback-Schutz)
setTimeout(() => markHealthy(appDir), 60000).unref();
// Täglich Backup (nur wenn Verschlüsselung eingerichtet), stündlich prüfen
setInterval(() => { try { app.runBackup(app.settings()['backup.extraDir']); } catch (e) { console.error('Backup fehlgeschlagen:', e.message); } }, 3600000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.close().then(() => process.exit(0)));
