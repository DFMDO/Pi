// System: Speicher, Diagnose, Backup, Update, Hub-Info.
import { statfsSync, readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg, totalmem, freemem, uptime, networkInterfaces } from 'node:os';
import { setupBackupKey, encryptBackup, decryptBackup, createArchive, runScheduledBackup } from './backup.js';
import { stage, activate, rollback } from './update.js';
import { request as privRequest } from '../../player/agent/lib/privd.js';
import { formatFingerprint } from './tls.js';
import { memInfo } from './metrics.js';

const DAY = 86400000;
const dirSize = (d) => { let n = 0; try { for (const f of readdirSync(d, { withFileTypes: true })) n += f.isDirectory() ? dirSize(join(d, f.name)) : statSync(join(d, f.name)).size; } catch {} return n; };

async function systemPlugin(app, { db, audit, dataDir, mediaDir, tls, updateKeyPem, appDir, baseDir, onRestart = () => {} }) {
  const keyFile = join(dataDir, 'keys', 'backup.json');
  const keyInfo = () => (existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : null);
  app.decorate('backupKey', keyInfo);

  app.get('/api/v1/system/storage', { config: { perm: 'system.read' } }, async () => {
    const s = statfsSync(dataDir), total = s.blocks * s.bsize, free = s.bavail * s.bsize, media = dirSize(mediaDir);
    const pct = total ? Math.round(((total - free) / total) * 100) : 0;
    return { total, free, mediaBytes: media, usedPercent: pct, warn: pct >= 80, text: pct >= 80 ? `Der Speicher ist zu ${pct} % voll. Lösche nicht mehr benötigte Medien, bevor er voll läuft.` : null };
  });
  // Arbeitsspeicher-Wächter: Warnung nur, wenn der freie Speicher DAUERHAFT knapp ist (5 Messungen im Abstand von 1 Minute), nicht beim kurzen Start-Peak.
  const MEM_WARN_MB = 100, memSamples = [];
  const sampleMem = () => { memSamples.push(memInfo().availMB); if (memSamples.length > 5) memSamples.shift(); };
  sampleMem(); const memTimer = setInterval(sampleMem, 60000); memTimer.unref(); app.addHook('onClose', async () => clearInterval(memTimer));
  app.get('/api/v1/system/memory', { config: { perm: 'system.read' } }, async () => {
    const m = memInfo(), low = memSamples.length >= 5 && memSamples.every((x) => x < MEM_WARN_MB), swapFull = m.swapTotalMB > 0 && m.swapUsedMB / m.swapTotalMB > 0.8;
    const warn = low || swapFull;
    return { totalMB: Math.round(m.totalMB), availMB: Math.round(m.availMB), swapUsedMB: Math.round(m.swapUsedMB), warn,
      text: warn ? `Der Hub hat dauerhaft wenig Arbeitsspeicher (${Math.round(m.availMB)} MB frei). Lade gerade keine großen Videos hoch und starte den Hub bei Gelegenheit neu. Hilft das nicht, sollte das Gerät nur als Hub ohne eigenen Bildschirm laufen.` : null };
  });
  app.get('/api/v1/system/diagnose', { config: { perm: 'system.read' } }, async () => {
    const temp = (() => { try { return parseInt(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8'), 10) / 1000; } catch { return null; } })();
    return { load: loadavg(), ramTotalMB: Math.round(totalmem() / 1048576), ramFreeMB: Math.round(freemem() / 1048576), uptimeS: Math.round(uptime()),
      tempC: temp, node: process.version, rssMB: Math.round(process.memoryUsage().rss / 1048576), db: db.pragma('journal_mode', { simple: true }) };
  });
  app.get('/api/v1/system/hub', { config: { perm: 'devices.read' } }, async () => ({ fingerprint: formatFingerprint(tls.spki), host: 'dfm-signage.local',
    addresses: Object.values((() => { try { return networkInterfaces(); } catch { return {}; } })()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => ({ ip: i.address, mac: i.mac })),
    tip: 'Bitte die IT, dieser Hardware-Adresse (MAC) immer dieselbe IP-Adresse zu geben.' }));
  // Uhr: Der Pi hat keine Batterieuhr und im Museumsnetz oft kein Internet. Der Admin-Browser kennt die richtige Zeit.
  app.get('/api/v1/system/time', { config: { perm: 'devices.read' } }, async () => ({ now: Date.now() }));
  app.post('/api/v1/system/time', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', required: ['epoch'], additionalProperties: false, properties: { epoch: { type: 'integer' } } } } }, async (req, reply) => {
    if (Math.abs(req.body.epoch - Date.now()) > 7 * 86400000 * 365) return reply.code(400).send({ error: 'Diese Uhrzeit ist nicht plausibel.' });
    try { privRequest(process.env.DFM_PRIVD_DIR ?? '/run/dfm/privd', 'set-time', { epoch: Math.floor(req.body.epoch / 1000) }); } catch { return reply.code(500).send({ error: 'Die Uhr konnte nicht gestellt werden.' }); }
    audit.log({ user: req.user, action: 'uhr.gestellt', ip: req.ip, security: true, detail: { epoch: req.body.epoch } }); return { ok: true };
  });
  // WLAN des Hubs nachtragen (z. B. wenn er per Kabel eingerichtet wurde)
  app.post('/api/v1/system/wifi', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', required: ['ssid', 'password'], additionalProperties: false, properties: { ssid: { type: 'string', minLength: 1, maxLength: 32 }, password: { type: 'string', minLength: 8, maxLength: 64 } } } } }, async (req, reply) => {
    try { privRequest(process.env.DFM_PRIVD_DIR ?? '/run/dfm/privd', 'wifi-switch', { ssid: req.body.ssid, password: req.body.password }); } catch (e) { return reply.code(400).send({ error: 'Diese WLAN-Angaben sind ungültig.' }); }
    audit.log({ user: req.user, action: 'hub.wlan_geaendert', ip: req.ip, security: true, detail: { ssid: req.body.ssid } }); return { ok: true };
  });
  app.get('/api/v1/system/certificate', { config: { perm: 'settings.manage' } }, async (_req, reply) =>
    reply.header('Content-Type', 'application/x-pem-file').header('Content-Disposition', 'attachment; filename="dfm-signage-hub.crt"').send(tls.cert));
  app.get('/api/v1/system/audit-verify', { config: { perm: 'audit.read' } }, async () => audit.verify());

  // Backup
  app.get('/api/v1/backup/status', { config: { perm: 'backup.manage' } }, async () => ({ configured: !!keyInfo(),
    files: existsSync(join(dataDir, 'backups')) ? readdirSync(join(dataDir, 'backups')).sort().reverse() : [] }));
  app.post('/api/v1/backup/setup', { config: { perm: 'backup.manage' }, schema: { body: { type: 'object', required: ['passphrase'], additionalProperties: false, properties: { passphrase: { type: 'string', minLength: 12, maxLength: 200 } } } } }, async (req, reply) => {
    if (keyInfo()) return reply.code(409).send({ error: 'Die Backup-Verschlüsselung ist schon eingerichtet.' });
    const k = setupBackupKey(req.body.passphrase); mkdirSync(join(dataDir, 'keys'), { recursive: true });
    writeFileSync(keyFile, JSON.stringify(k), { mode: 0o600 }); audit.log({ user: req.user, action: 'backup.eingerichtet', ip: req.ip });
    return { ok: true, text: 'Merke dir die Passphrase gut. Ohne sie kann kein Backup wiederhergestellt werden – sie wird nirgends gespeichert.' };
  });
  app.post('/api/v1/backup/run', { config: { perm: 'backup.manage' } }, async (req, reply) => {
    const k = keyInfo(); if (!k) return reply.code(400).send({ error: 'Bitte richte zuerst die Backup-Verschlüsselung ein.' });
    audit.log({ user: req.user, action: 'backup.erstellt', ip: req.ip });
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', 'attachment; filename="dfm-backup.dfmbak"').send(encryptBackup(createArchive(dataDir, db), k));
  });
  app.decorate('runBackup', (extraDir) => runScheduledBackup({ dataDir, db, keyInfo: keyInfo(), extraDir }));

  // Update (Paket hochladen → Signatur prüfen → einspielen → verteilen)
  app.post('/api/v1/update/upload', { config: { perm: 'update.manage' }, bodyLimit: 96 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body; if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'Bitte lade eine Update-Datei hoch.' });
    mkdirSync(join(dataDir, 'updates'), { recursive: true });
    const tmp = join(dataDir, 'updates', 'incoming.dfmpkg'); writeFileSync(tmp, body);
    try {
      const m = stage(tmp, appDir, updateKeyPem, baseDir);
      writeFileSync(join(dataDir, 'updates', 'current.dfmpkg'), body); // Verteilung an Player über den Hub
      activate(appDir, m.version); audit.log({ user: req.user, action: 'update.eingespielt', ip: req.ip, security: true, detail: { version: m.version } });
      setTimeout(onRestart, 1500); return { ok: true, version: m.version, text: 'Das Update wurde installiert. Der Hub startet in wenigen Sekunden neu.' };
    } catch (e) {
      audit.log({ user: req.user, action: 'update.abgelehnt', ip: req.ip, security: true, detail: { grund: e.message } });
      return reply.code(400).send({ error: e.message });
    }
  });
  app.post('/api/v1/update/rollback', { config: { perm: 'update.manage' } }, async (req, reply) => {
    if (!rollback(appDir)) return reply.code(400).send({ error: 'Es gibt keine ältere Version, zu der zurückgegangen werden kann.' });
    audit.log({ user: req.user, action: 'update.zurueckgerollt', ip: req.ip, security: true }); setTimeout(onRestart, 1500); return { ok: true };
  });
}

systemPlugin[Symbol.for('skip-override')] = true; // Hooks und Decorators global (wie fastify-plugin)
export default systemPlugin;
