// Hub-Anwendung: baut den Fastify-Server (ohne Netzwerk-Bindung, daher testbar).
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { loadOrCreateKey, hashPassword, checkPasswordPolicy, randomToken, sha256hex, safeEqual } from './lib/crypto.js';
import { createAudit } from './lib/audit.js';
import authPlugin from './lib/auth.js';
import devicesPlugin from './lib/devices.js';
import contentPlugin from './lib/content.js';
import extrasPlugin from './lib/extras.js';
import extras2Plugin from './lib/extras2.js';
import extras3Plugin from './lib/extras3.js';
import extras4Plugin from './lib/extras4.js';
import extras5Plugin from './lib/extras5.js';
import extras6Plugin from './lib/extras6.js';
import { createMetrics } from './lib/metrics.js';
import systemPlugin from './lib/system.js';
import { createVariantQueue } from './lib/variants.js';
import { createLimiter } from './lib/ratelimit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** Statische Dateien: vorab gelistet (kein Path Traversal möglich), Brotli/Gzip wenn vorhanden. */
function indexStatic(root) {
  const map = new Map();
  const walk = (d, rel = '') => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) {
    const r = rel + '/' + e.name; if (e.isDirectory()) walk(join(d, e.name), r);
    else if (!/\.(br|gz)$/.test(e.name)) map.set(r, { file: join(d, e.name), type: TYPES[extname(e.name)] ?? 'application/octet-stream', br: existsSync(join(d, e.name) + '.br') && join(d, e.name) + '.br', gz: existsSync(join(d, e.name) + '.gz') && join(d, e.name) + '.gz' }); } };
  walk(root); return map;
}

export async function buildApp({ dataDir, tls, uiDir = join(HERE, '..', 'admin-ui', 'dist'), updateKeyPem = '', appDir, baseDir, now = () => Date.now(), hubInfo, onRestart, logger = false, useTls = false, fetchText, importRoots, usbDir }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const mediaDir = join(dataDir, 'media'); mkdirSync(mediaDir, { recursive: true });
  const db = openDb(join(dataDir, 'hub.db'));
  const key = loadOrCreateKey(join(dataDir, 'keys', 'master.key'));
  const audit = createAudit(db);
  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024, trustProxy: false,
    ...(useTls ? { https: { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', honorCipherOrder: true } } : {}) });
  app.decorate('ctx', { db, key, audit, dataDir, mediaDir, tls });

  app.addHook('onSend', async (_req, reply) => { for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v); });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 96 * 1024 * 1024 }, (_r, b, d) => d(null, b));
  // Fehler ohne Stacktrace/Codes an Nutzer
  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'Die Eingabe ist ungültig. Bitte prüfe deine Angaben.', details: err.validation.map((v) => `${v.instancePath || 'Eingabe'} ${v.message}`).slice(0, 5) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.statusCode === 413 ? 'Die Datei ist zu groß.' : 'Die Anfrage konnte nicht verarbeitet werden.' });
    req.log.error(err); return reply.code(500).send({ error: 'Es ist ein Fehler aufgetreten. Bitte versuche es später noch einmal.' });
  });

  await app.register(websocket, { options: { maxPayload: 6 * 1024 * 1024 } });
  await app.register(authPlugin, { db, key, audit, now });
  const variants = createVariantQueue({ db, mediaDir, onChange: () => app.pushAll?.() });
  app.decorate('variants', variants);
  const metrics = createMetrics({ db, now });
  await app.register(devicesPlugin, { db, key, audit, tls, dataDir, mediaDir, hubInfo: hubInfo ?? (() => ({ host: 'dfm-signage.local' })), metrics, now });
  await app.register(contentPlugin, { db, audit, mediaDir, variants, now });
  await app.register(extrasPlugin, { db, audit, now });
  await app.register(extras2Plugin, { db, audit, mediaDir, dataDir, variants, now, importRoots, ...(usbDir ? { usbDir } : {}) });
  await app.register(extras3Plugin, { db, audit, mediaDir, now });
  await app.register(extras4Plugin, { db, audit, mediaDir, metrics, now });
  await app.register(extras5Plugin, { db, audit, variants, now, fetchText });
  await app.register(extras6Plugin, { db, audit, variants, now });
  await app.register(systemPlugin, { db, audit, dataDir, mediaDir, tls, updateKeyPem, appDir: appDir ?? join(dataDir, 'app'), baseDir, onRestart });

  // ---------- Ersteinrichtung des Hubs ----------
  const codeFile = join(dataDir, 'keys', 'setup-code.txt'), setupLim = createLimiter({ max: 5, baseMs: 60000, now });
  const hasUsers = () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const importBootstrap = async () => { // vom dfm-setup-Dienst geschrieben: Admin-Konto, bereits mit argon2id gehasht
    const f = join(dataDir, 'hub-bootstrap.json'); if (!existsSync(f) || hasUsers()) return;
    const b = JSON.parse(readFileSync(f, 'utf8'));
    db.prepare("INSERT INTO users(id,name,pw_hash,role,created_at) VALUES(?,?,?,'admin',?)").run(randomUUID(), b.admin.name, b.admin.pwHash, now());
    if (b.site) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('site.name', b.site);
    writeFileSync(f, Buffer.alloc(statSync(f).size)); unlinkSync(f); audit.log({ action: 'hub.admin_angelegt', detail: { quelle: 'Einrichtung am Handy' } });
  };
  await importBootstrap();
  // Hub + Bildschirm in einem Gerät: den eigenen Bildschirm anlegen (Token kommt aus der Einrichtung, hier liegt nur der Hash)
  const importLocalPlayer = () => {
    const f = join(dataDir, 'local-player.json'); if (!existsSync(f)) return;
    const p = JSON.parse(readFileSync(f, 'utf8'));
    if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(p.deviceId)) {
      db.prepare("INSERT INTO devices(id,name,profile,status,token_hash,model,created_at,ready,notes) VALUES(?,?,?,'active',?,?,?,1,?)").run(p.deviceId, p.name, ['lite', 'standard', 'pro'].includes(p.profile) ? p.profile : 'standard', p.tokenHash, p.model ?? null, now(), 'Dieser Bildschirm ist gleichzeitig der Hub.');
      db.prepare("UPDATE devices SET renderer='mpv' WHERE id=?").run(p.deviceId); // Hub-Gerät: schlanker Player (mpv) statt Browser; im Hub unter Bildschirm → Wiedergabe änderbar
      audit.log({ action: 'bildschirm.hub_bildschirm_angelegt', target: p.deviceId, detail: { name: p.name } });
    }
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('hub.deviceId', p.deviceId); // Markierung: dieser Bildschirm ist der Hub (gegen Sperren/Entfernen geschützt)
    unlinkSync(f);
  };
  importLocalPlayer();
  if (!hasUsers() && !existsSync(codeFile)) { mkdirSync(dirname(codeFile), { recursive: true }); writeFileSync(codeFile, randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase(), { mode: 0o600 }); }
  app.get('/api/v1/setup/state', { config: { public: true } }, async () => ({ needsAdmin: !hasUsers() }));
  app.post('/api/v1/setup/admin', { config: { public: true }, schema: { body: { type: 'object', required: ['code', 'name', 'password'], additionalProperties: false,
    properties: { code: { type: 'string', maxLength: 20 }, name: { type: 'string', minLength: 2, maxLength: 60 }, password: { type: 'string', maxLength: 300 }, site: { type: 'string', maxLength: 100 } } } } }, async (req, reply) => {
    if (hasUsers()) return reply.code(409).send({ error: 'Die Einrichtung ist schon abgeschlossen.' });
    const w = setupLim.wait(req.ip); if (w) return reply.code(429).send({ error: `Zu viele Versuche. Bitte warte ${w} Sekunden.` });
    if (!existsSync(codeFile) || !safeEqual(readFileSync(codeFile, 'utf8').trim(), req.body.code.trim().toUpperCase())) {
      setupLim.fail(req.ip); audit.log({ action: 'setup.falscher_code', ip: req.ip, security: true });
      return reply.code(403).send({ error: 'Der Einrichtungscode stimmt nicht. Du findest ihn auf dem Bildschirm des Hubs.' });
    }
    const bad = checkPasswordPolicy(req.body.password, req.body.name); if (bad) return reply.code(400).send({ error: bad });
    db.prepare("INSERT INTO users(id,name,pw_hash,role,created_at) VALUES(?,?,?,'admin',?)").run(randomUUID(), req.body.name, await hashPassword(req.body.password), now());
    if (req.body.site) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('site.name', req.body.site);
    unlinkSync(codeFile); audit.log({ action: 'hub.admin_angelegt', ip: req.ip, detail: { quelle: 'Browser' } });
    return reply.code(201).send({ ok: true });
  });

  // ---------- Demo-Inhalte (abschaltbar) ----------
  const seedDemo = () => {
    if (db.prepare('SELECT 1 FROM playlists').get()) return;
    const pid = randomUUID(); db.prepare("INSERT INTO playlists(id,name,is_default) VALUES(?,?,1)").run(pid, 'Standard');
    if (app.settings()['demo.enabled'] !== 'true') return;
    [['Willkommen', 'Willkommen im Deutschen Fußballmuseum', 'Schön, dass du da bist!', 'standard'], ['Hinweis', 'Bitte Tickets bereithalten', 'Der Einlass erfolgt am Haupteingang.', 'hinweis']].forEach(([n, t, b, tpl], i) => {
      const id = randomUUID(); db.prepare("INSERT INTO media(id,name,kind,text_json,folder,created_at) VALUES(?,?, 'text',?, 'Demo',?)").run(id, n, JSON.stringify({ title: t, body: b, template: tpl }), now());
      db.prepare('INSERT INTO playlist_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), pid, id, i, 10, 'fade', null, null);
    });
  };
  seedDemo();
  app.post('/api/v1/demo/remove', { config: { perm: 'media.write' } }, async (req) => {
    const ids = db.prepare("SELECT id FROM media WHERE folder='Demo'").all().map((r) => r.id);
    for (const id of ids) { db.prepare('DELETE FROM playlist_items WHERE media_id=?').run(id); db.prepare('DELETE FROM media WHERE id=?').run(id); }
    db.prepare("INSERT OR REPLACE INTO settings VALUES('demo.enabled','false')").run(); audit.log({ user: req.user, action: 'demo.entfernt', ip: req.ip }); app.pushAll(); return { removed: ids.length };
  });

  // ---------- Admin-Oberfläche (statisch) ----------
  const files = indexStatic(uiDir);
  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Nicht gefunden.' });
    const path = req.url.split('?')[0]; let e = files.get(path === '/' ? '/index.html' : path);
    if (!e && !extname(path)) e = files.get('/index.html'); // SPA
    if (!e) return reply.code(404).send('Nicht gefunden');
    const ae = String(req.headers['accept-encoding'] ?? '');
    reply.header('Content-Type', e.type).header('Vary', 'Accept-Encoding').header('Cache-Control', /\.html$/.test(e.file) ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (e.br && /\bbr\b/.test(ae)) return reply.header('Content-Encoding', 'br').send(readFileSync(e.br));
    if (e.gz && /\bgzip\b/.test(ae)) return reply.header('Content-Encoding', 'gzip').send(readFileSync(e.gz));
    return reply.send(readFileSync(e.file));
  });

  // Aufräumen: abgelaufene Sitzungen / Papierkorb
  const janitor = setInterval(() => { db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now()); db.prepare('DELETE FROM trash WHERE deleted_at<?').run(now() - 30 * 86400000); db.prepare('DELETE FROM pairing_codes WHERE expires_at<?').run(now()); }, 600000).unref();
  app.addHook('onClose', async () => { clearInterval(janitor); await variants.close(); db.close(); });
  variants.ensureAll();
  return app;
}
