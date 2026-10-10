// Geräte: Gruppen, Pairing (Einmalcode + HMAC), Geräte-API, Fernbefehle, WebSocket.
import { randomUUID, createHmac } from 'node:crypto';
import { createReadStream, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomToken, sha256hex, safeEqual, pairingCode, encrypt, decrypt } from './crypto.js';
import { formatFingerprint } from './tls.js';
import { schedulePayload, manifestPayload, PROFILES } from './plan.js';
import { validateMessage, msg, COMMANDS } from '../../shared/protocol.js';
import { parseJson, safeInterval } from '../../shared/guard.js';
import { MAX_WALL } from '../../shared/wall.js';

/** Geräte-Zustand für die Datenbank: Ist er zu groß, werden die größten Einträge weggelassen (abgeschnittenes JSON wäre unlesbar und würde Listen und Warnungen stören) */
export function fitState(o, max = 20000) {
  let j = JSON.stringify(o); if (j.length <= max) return j;
  const rest = { ...o }, size = (k) => JSON.stringify(rest[k]).length;
  for (const k of Object.keys(rest).sort((a, b) => size(b) - size(a))) { delete rest[k]; j = JSON.stringify({ ...rest, gekuerzt: true }); if (j.length <= max) return j; }
  return JSON.stringify({ gekuerzt: true, version: o?.version ?? null });
}
import { createLimiter } from './ratelimit.js';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { ensureTestVideo } from './variants.js';

const CODE_TTL = 10 * 60000, MAX_ATTEMPTS = 5, PENDING_TTL = 3600000;

/** HMAC-Nachricht des Pairing: Hub-Schlüssel-Hash, Geräte-ID, Nonce, Hash des Abholgeheimnisses. */
export const pairMac = (code, spki, deviceId, nonce, secretHash) =>
  createHmac('sha256', code).update([spki, deviceId, nonce, secretHash].join('|')).digest('hex');

export function deviceStatus(d, now = Date.now()) {
  if (d.status === 'pending') return { level: 'pending', icon: '⏳', label: 'Wartet auf Bestätigung' };
  if (d.status === 'blocked') return { level: 'bad', icon: '⛔', label: 'Gesperrt' };
  const age = now - (d.last_seen ?? 0);
  if (age < 65000) return { level: 'ok', icon: '●', label: 'Läuft' };
  if (age < 600000) return { level: 'warn', icon: '▲', label: 'Keine Verbindung' };
  return { level: 'bad', icon: '✖', label: 'Nicht erreichbar' };
}
function summary(d, st) {
  const s = deviceStatus(d);
  const playing = st?.nowPlaying?.name ? `, zeigt gerade „${st.nowPlaying.name}“` : '';
  if (s.level === 'ok') return `${d.name}: läuft${playing}`;
  if (s.level === 'warn') return `${d.name}: keine Verbindung seit ${Math.max(1, Math.round((Date.now() - d.last_seen) / 60000))} Minuten, zeigt gespeicherte Inhalte`;
  if (s.level === 'pending') return `${d.name}: wartet darauf, dass du ihn verbindest`;
  return `${d.name}: ${s.label.toLowerCase()}`;
}

async function devicesPlugin(app, { db, key, audit, tls, dataDir, mediaDir, hubInfo, metrics = null, plays = null, now = () => Date.now() }) {
  const sockets = new Map(); // deviceId -> ws
  const challenges = new Map(); // nonce -> expires
  const pairLim = createLimiter({ max: 20, baseMs: 60000, now });
  const shotDir = join(dataDir, 'screenshots'); mkdirSync(shotDir, { recursive: true });

  const getDevice = (id) => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const sendTo = (id, type, body) => { const s = sockets.get(id); if (s?.readyState === 1) { s.send(msg(type, body)); return true; } return false; };
  const pushPlan = (d) => { sendTo(d.id, 'schedule_update', schedulePayload(db, d, now())); sendTo(d.id, 'media_manifest', manifestPayload(db, d, now())); };
  const pushAll = () => { for (const id of sockets.keys()) { const d = getDevice(id); if (d?.status === 'active') pushPlan(d); } };
  app.decorate('pushAll', pushAll);
  /**
   * Live-Ansicht Stufe 2 (Z.1): Screenshots nur, wenn jemand zuschaut – Kacheln alle 30 s, Einzelansicht alle 5 s, 60 s ohne Betrachter = Stopp.
   * Bilder (JPEG ca. 640 px) liegen nur im Arbeitsspeicher; Lite und überlastete Geräte bleiben bei Stufe 1 (reiner Status).
   */
  const viewers = { tile: 0, detail: new Map() }, shots = new Map(), lastReq = new Map(), signals = new Map();
  const watching = (t = now()) => ({ tile: t - viewers.tile < 60000, detail: (id) => t - (viewers.detail.get(id) ?? 0) < 60000 });
  const reduced = (d, st) => d.profile === 'lite' || (st?.cpuTemp ?? 0) > 78 || (st?.ramTotalMB && st.ramTotalMB - (st.ramUsedMB ?? 0) < 100);
  function screenshotTick() {
    const t = now(), w = watching(t); let n = 0;
    for (const id of sockets.keys()) {
      const interval = w.detail(id) ? 5000 : w.tile ? 30000 : 0; if (!interval || t - (lastReq.get(id) ?? 0) < interval - 200) continue;
      const d = getDevice(id); if (!d || d.status !== 'active' || reduced(d, parseJson(d.state_json, null))) continue;
      lastReq.set(id, t); if (sendTo(id, 'command', { id: 'auto-' + randomUUID(), command: 'screenshot' })) n++;
    }
    return n;
  }
  const shotTimer = safeInterval(screenshotTick, 5000, console.error, 'Vorschau'); app.addHook('onClose', async () => clearInterval(shotTimer));
  app.decorate('devices', { sockets, sendTo, deliverQueued, pushPlan, screenshotTick, viewers, shots, signals, getDevice, reduced, watching });


  const present = (d) => {
    const st = parseJson(d.state_json, null);
    const g = d.group_id ? db.prepare('SELECT name FROM device_groups WHERE id=?').get(d.group_id) : null;
    return { id: d.id, display: parseJson(d.display_json, null), name: d.name, groupId: d.group_id, groupName: g?.name ?? null, model: d.model, profile: d.profile, renderer: d.renderer ?? 'auto', orientation: d.orientation,
      status: deviceStatus(d), summary: summary(d, st), location: d.location ?? null, escapeMediaId: d.escape_media_id ?? null, wallCol: d.wall_col ?? null, wallRow: d.wall_row ?? null, lastSeen: d.last_seen, state: st, hw: parseJson(d.hw_json, null),
      spki: d.spki_seen ? formatFingerprint(d.spki_seen) : null, online: sockets.has(d.id), isHub: isHubDevice(d.id) };
  };

  // ---------- Verwaltung ----------
  app.get('/api/v1/devices', { config: { perm: 'devices.read' } }, async () => {
    db.prepare("DELETE FROM devices WHERE status='pending' AND created_at < ?").run(now() - PENDING_TTL);
    return db.prepare('SELECT * FROM devices ORDER BY name').all().map(present);
  });
  app.get('/api/v1/devices/:id', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const d = getDevice(req.params.id); return d ? present(d) : reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
  });
  app.patch('/api/v1/devices/:id', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, groupId: { type: ['string', 'null'] }, profile: { enum: PROFILES }, orientation: { enum: [0, 90, 180, 270] }, escapeMediaId: { type: ['string', 'null'], maxLength: 40 }, wallCol: { type: ['integer', 'null'], minimum: 0, maximum: MAX_WALL - 1 }, wallRow: { type: ['integer', 'null'], minimum: 0, maximum: MAX_WALL - 1 },
      display: { type: ['object', 'null'], additionalProperties: false, properties: { off: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }, to: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } } } } } } } } }, async (req, reply) => {
    const d = getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const b = req.body;
    if (b.groupId && !db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(b.groupId)) return reply.code(400).send({ error: 'Diese Gruppe gibt es nicht.' });
    if (b.escapeMediaId) { const m = db.prepare('SELECT kind FROM media WHERE id=?').get(b.escapeMediaId); if (!m) return reply.code(400).send({ error: 'Dieses Bild gibt es nicht.' }); if (m.kind !== 'image' && m.kind !== 'pdfpage') return reply.code(400).send({ error: 'Als Fluchtweg-Plan geht nur ein Bild (oder eine PDF-Seite).' }); }
    db.prepare('UPDATE devices SET name=?, group_id=?, profile=?, orientation=?, display_json=? WHERE id=?').run(b.name ?? d.name,
      'groupId' in b ? b.groupId : d.group_id, b.profile ?? d.profile, b.orientation ?? d.orientation, 'display' in b ? (b.display ? JSON.stringify(b.display) : null) : d.display_json, d.id);
    if ('escapeMediaId' in b) db.prepare('UPDATE devices SET escape_media_id=? WHERE id=?').run(b.escapeMediaId || null, d.id);
    if ('wallCol' in b || 'wallRow' in b) db.prepare('UPDATE devices SET wall_col=?, wall_row=? WHERE id=?').run('wallCol' in b ? b.wallCol : d.wall_col, 'wallRow' in b ? b.wallRow : d.wall_row, d.id);
    else if ('groupId' in b && b.groupId !== d.group_id) { db.prepare('UPDATE devices SET wall_col=NULL, wall_row=NULL WHERE id=?').run(d.id); autoAssignWall(b.groupId); } // neue Gruppe: alter Platz gilt nicht mehr
    if (b.profile && b.profile !== d.profile) app.variants?.ensureAll(); // neues Profil → fehlende Medienvarianten erzeugen
    audit.log({ user: req.user, action: 'bildschirm.geaendert', target: d.id, ip: req.ip, detail: b });
    pushPlan(getDevice(d.id)); return { ok: true };
  });
  // Sperren / Entfernen: Token sofort ungültig, WebSocket beendet.
  const revoke = (id) => { sockets.get(id)?.close(4001, 'revoked'); sockets.delete(id); };
  const isHubDevice = (id) => db.prepare("SELECT 1 FROM settings WHERE key='hub.deviceId' AND value=?").get(id) !== undefined;
  const HUB_MSG = 'Dieser Bildschirm ist gleichzeitig der Hub. Wenn Sie ihn sperren oder entfernen, fällt das ganze System aus.';
  app.post('/api/v1/devices/:id/block', { config: { perm: 'devices.manage' } }, async (req, reply) => {
    if (isHubDevice(req.params.id)) return reply.code(409).send({ error: HUB_MSG });
    const r = db.prepare("UPDATE devices SET status='blocked', token_hash=NULL WHERE id=?").run(req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    revoke(req.params.id); audit.log({ user: req.user, action: 'bildschirm.gesperrt', target: req.params.id, ip: req.ip, security: true });
    return { ok: true };
  });
  app.delete('/api/v1/devices/:id', { config: { perm: 'devices.manage' } }, async (req, reply) => {
    if (isHubDevice(req.params.id)) return reply.code(409).send({ error: HUB_MSG });
    revoke(req.params.id);
    const r = db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    audit.log({ user: req.user, action: 'bildschirm.entfernt', target: req.params.id, ip: req.ip, security: true });
    return { ok: true };
  });
  /** Videowand: Bildschirme ohne gültigen Platz bekommen der Reihe nach (zeilenweise) einen freien Platz */
  function autoAssignWall(groupId) {
    const g = groupId && db.prepare("SELECT * FROM device_groups WHERE id=? AND sync_mode='videowand'").get(groupId); if (!g) return;
    const members = db.prepare("SELECT * FROM devices WHERE group_id=? AND status='active' ORDER BY name").all(g.id), taken = new Set();
    const valid = (d) => Number.isInteger(d.wall_col) && Number.isInteger(d.wall_row) && d.wall_col < g.wall_cols && d.wall_row < g.wall_rows;
    for (const d of members) if (valid(d)) taken.add(d.wall_col + ',' + d.wall_row);
    for (const d of members.filter((x) => !valid(x))) {
      for (let r = 0; r < g.wall_rows; r++) for (let c = 0; c < g.wall_cols; c++) {
        if (taken.has(c + ',' + r) || valid(getDevice(d.id))) continue;
        db.prepare('UPDATE devices SET wall_col=?, wall_row=? WHERE id=?').run(c, r, d.id); taken.add(c + ',' + r);
      }
    }
  }
  const groupView = (g) => ({ ...g, syncMode: g.sync_mode, cols: g.wall_cols, rows: g.wall_rows, members: db.prepare("SELECT COUNT(*) n FROM devices WHERE group_id=? AND status='active'").get(g.id).n });
  app.get('/api/v1/groups', { config: { perm: 'devices.read' } }, async () => db.prepare('SELECT * FROM device_groups ORDER BY name').all().map(groupView));
  // Gleichtakt: alle Bildschirme der Gruppe zeigen zur selben Zeit dasselbe. Videowand: ein Bild verteilt sich auf ein Raster (Spalten × Zeilen).
  app.patch('/api/v1/groups/:id', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 }, location: { type: ['string', 'null'], maxLength: 100 }, syncMode: { enum: ['off', 'gleichtakt', 'videowand'] },
    cols: { type: 'integer', minimum: 1, maximum: MAX_WALL }, rows: { type: 'integer', minimum: 1, maximum: MAX_WALL } } } } }, async (req, reply) => {
    const g = db.prepare('SELECT * FROM device_groups WHERE id=?').get(req.params.id); if (!g) return reply.code(404).send({ error: 'Diese Gruppe gibt es nicht.' });
    const b = req.body, mode = b.syncMode ?? g.sync_mode, cols = b.cols ?? g.wall_cols, rows = b.rows ?? g.wall_rows;
    if (mode === 'videowand' && cols * rows < 2) return reply.code(400).send({ error: 'Eine Videowand braucht mindestens zwei Kacheln (Spalten × Zeilen).' });
    const epoch = mode === 'off' ? null : (g.sync_epoch ?? Math.floor(now() / 86400000) * 86400000);
    db.prepare('UPDATE device_groups SET name=?, location=?, sync_mode=?, wall_cols=?, wall_rows=?, sync_epoch=? WHERE id=?').run(b.name ?? g.name, 'location' in b ? b.location : g.location, mode, cols, rows, epoch, g.id);
    if (mode === 'videowand') autoAssignWall(g.id);
    audit.log({ user: req.user, action: 'gruppe.geaendert', target: g.name, ip: req.ip, detail: b });
    for (const d of db.prepare("SELECT id FROM devices WHERE group_id=? AND status='active'").all(g.id)) { const dd = getDevice(d.id); if (dd) pushPlan(dd); }
    app.variants?.ensureAll(); // mpv braucht für Text-Folien die Bildfassung
    return { ok: true };
  });
  app.post('/api/v1/groups', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['name'], additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, location: { type: 'string', maxLength: 100 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } } } } }, async (req, reply) => {
    const id = randomUUID(); db.prepare('INSERT INTO device_groups(id,name,location,color) VALUES(?,?,?,?)').run(id, req.body.name, req.body.location ?? null, req.body.color ?? '#c8102e');
    audit.log({ user: req.user, action: 'gruppe.angelegt', target: req.body.name, ip: req.ip }); return reply.code(201).send({ id });
  });

  // QR-Code als SVG (lokal erzeugt, keine externe Bibliothek im Browser nötig)
  app.post('/api/v1/qr', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 1200 } } } } },
    async (req, reply) => reply.header('Content-Type', 'image/svg+xml').send(await QRCode.toString(req.body.text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })));

  // ---------- Pairing (Admin-Seite) ----------
  app.post('/api/v1/pairing', { config: { perm: 'devices.manage' }, schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: { wifi: { type: 'object', required: ['ssid'], additionalProperties: false,
    properties: { ssid: { type: 'string', minLength: 1, maxLength: 32 }, password: { type: 'string', maxLength: 64 } } } } } } }, async (req) => {
    db.prepare('DELETE FROM pairing_codes').run(); // genau ein aktiver Code
    const code = pairingCode(8), id = randomUUID(), host = hubInfo().host;
    db.prepare('INSERT INTO pairing_codes(id,code_enc,expires_at,created_by) VALUES(?,?,?,?)').run(id, encrypt(key, code), now() + CODE_TTL, req.user.id);
    audit.log({ user: req.user, action: 'pairing.code_erzeugt', ip: req.ip });
    // Startkarte: Link mit allen Angaben. Das Handy ist dabei schon im Setup-WLAN des neuen Bildschirms (Schritt 1).
    const w = req.body?.wifi, card = { v: 1, h: host, f: tls.spki, c: code, ...(w ? { s: w.ssid, p: w.password ?? '' } : {}) };
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: now() + CODE_TTL, fingerprint: formatFingerprint(tls.spki), fingerprintRaw: tls.spki, hub: hubInfo(),
      card: 'http://10.42.0.1/#c=' + Buffer.from(JSON.stringify(card)).toString('base64url'), cardHasWifi: !!w };
  });
  app.post('/api/v1/devices/:id/approve', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, groupId: { type: ['string', 'null'] }, replaces: { type: 'string', maxLength: 40 } } } } }, async (req, reply) => {
    const d = getDevice(req.params.id);
    if (!d || d.status !== 'pending') return reply.code(404).send({ error: 'Dieser Bildschirm wartet nicht auf Bestätigung.' });
    const token = randomToken(32);
    const old = req.body?.replaces ? getDevice(req.body.replaces) : null;
    if (req.body?.replaces && (!old || old.status === 'pending' || old.id === d.id)) return reply.code(400).send({ error: 'Der zu ersetzende Bildschirm wurde nicht gefunden.' });
    if (old && isHubDevice(old.id)) return reply.code(409).send({ error: HUB_MSG });
    const required = !old && db.prepare("SELECT value FROM settings WHERE key='commissioning.required'").get()?.value !== 'false';
    db.prepare("UPDATE devices SET status='active', token_hash=?, name=?, group_id=?, ready=? WHERE id=?").run(sha256hex(token), old?.name ?? req.body?.name ?? d.name, old ? old.group_id : req.body?.groupId ?? null, required ? 0 : 1, d.id);
    if (old) { // Austausch (Z.4): Name, Gruppe, Zeitplan und Einstellungen wandern zum neuen Gerät; der alte Token wird gesperrt
      db.transaction(() => {
        db.prepare('UPDATE devices SET orientation=?, display_json=?, layout_json=?, location=?, floor=?, notes=?, doc_url=?, installed_at=?, serial=NULL, mac=NULL WHERE id=?').run(old.orientation, old.display_json, old.layout_json, old.location, old.floor, old.notes, old.doc_url, new Date(now()).toISOString().slice(0, 10), d.id);
        db.prepare('UPDATE devices SET escape_media_id=?, wall_col=?, wall_row=? WHERE id=?').run(old.escape_media_id, old.wall_col, old.wall_row, d.id); // Fluchtweg-Plan und Platz in der Videowand wandern mit
        db.prepare("UPDATE schedules SET target_id=? WHERE target_type='device' AND target_id=?").run(d.id, old.id);
        db.prepare("UPDATE overrides SET target_id=? WHERE scope='device' AND target_id=?").run(d.id, old.id);
        db.prepare("UPDATE rules SET target_id=? WHERE scope='device' AND target_id=?").run(d.id, old.id);
        db.prepare("UPDATE devices SET status='blocked', token_hash=NULL, name=?, replaced_by=?, group_id=NULL WHERE id=?").run(`${old.name} (ersetzt)`, d.id, old.id);
      })();
      sockets.get(old.id)?.close(4001, 'revoked'); audit.log({ user: req.user, action: 'bildschirm.ersetzt', target: d.id, ip: req.ip, security: true, detail: { alt: old.id } });
    }
    db.prepare('INSERT OR REPLACE INTO setup_state VALUES(?,?)').run('pairtoken:' + d.id, encrypt(key, token));
    audit.log({ user: req.user, action: 'bildschirm.verbunden', target: d.id, ip: req.ip, detail: { model: d.model } });
    return { ok: true };
  });

  // ---------- Pairing (Player-Seite, öffentlich, begrenzt) ----------
  const pubCfg = { config: { public: true } };
  app.post('/api/v1/pair/challenge', pubCfg, async (req, reply) => {
    const w = pairLim.wait(req.ip); if (w) return reply.code(429).send({ error: 'Bitte warte kurz.' });
    const c = db.prepare('SELECT * FROM pairing_codes WHERE used=0 AND expires_at>? AND attempts<?').get(now(), MAX_ATTEMPTS);
    if (!c) { pairLim.fail(req.ip); return reply.code(404).send({ error: 'Es ist kein Verbindungscode aktiv. Starte ihn im Hub unter „Neuen Bildschirm verbinden“.' }); }
    const nonce = randomToken(16); challenges.set(nonce, now() + 60000);
    for (const [n, e] of challenges) if (e < now()) challenges.delete(n);
    return { nonce };
  });
  const reqSchema = { body: { type: 'object', required: ['nonce', 'deviceId', 'name', 'secretHash', 'hmac'], additionalProperties: false, properties: {
    nonce: { type: 'string', maxLength: 64 }, deviceId: { type: 'string', pattern: '^[0-9a-f-]{36}$' }, name: { type: 'string', minLength: 1, maxLength: 60 },
    model: { type: 'string', maxLength: 100 }, profile: { enum: PROFILES }, hw: { type: 'object' }, secretHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    hmac: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } };
  app.post('/api/v1/pair/request', { ...pubCfg, schema: reqSchema }, async (req, reply) => {
    const b = req.body;
    if (!(challenges.get(b.nonce) > now())) return reply.code(400).send({ error: 'Die Anfrage ist abgelaufen. Bitte versuche es noch einmal.' });
    challenges.delete(b.nonce);
    const c = db.prepare('SELECT * FROM pairing_codes WHERE used=0 AND expires_at>? AND attempts<?').get(now(), MAX_ATTEMPTS);
    if (!c) return reply.code(404).send({ error: 'Der Verbindungscode ist abgelaufen oder gesperrt.' });
    const expect = pairMac(decrypt(key, c.code_enc), tls.spki, b.deviceId, b.nonce, b.secretHash);
    if (!safeEqual(expect, b.hmac)) {
      db.prepare('UPDATE pairing_codes SET attempts=attempts+1 WHERE id=?').run(c.id); pairLim.fail(req.ip);
      audit.log({ action: 'pairing.fehlgeschlagen', target: b.deviceId, ip: req.ip, security: true,
        detail: { grund: 'Code oder Fingerabdruck stimmen nicht (möglicher Abfangversuch)', versuche: c.attempts + 1 } });
      return reply.code(403).send({ error: 'Der Code stimmt nicht oder die Verbindung ist nicht sicher.' });
    }
    if (getDevice(b.deviceId)) return reply.code(409).send({ error: 'Dieser Bildschirm ist schon bekannt.' });
    db.prepare("INSERT INTO devices(id,name,model,profile,status,spki_seen,hw_json,created_at) VALUES(?,?,?,?, 'pending',?,?,?)")
      .run(b.deviceId, b.name, b.model ?? null, b.profile ?? 'standard', tls.spki, JSON.stringify(b.hw ?? {}), now());
    db.prepare('INSERT OR REPLACE INTO setup_state VALUES(?,?)').run('pairsecret:' + b.deviceId, b.secretHash);
    db.prepare('UPDATE pairing_codes SET used=1 WHERE id=?').run(c.id);
    audit.log({ action: 'pairing.angefragt', target: b.deviceId, ip: req.ip, detail: { name: b.name, model: b.model } });
    return { status: 'pending' };
  });
  app.post('/api/v1/pair/status', { ...pubCfg, schema: { body: { type: 'object', required: ['deviceId', 'secret'], additionalProperties: false,
    properties: { deviceId: { type: 'string', maxLength: 40 }, secret: { type: 'string', maxLength: 128 } } } } }, async (req, reply) => {
    if (pairLim.wait(req.ip)) return reply.code(429).send({ error: 'Bitte warte kurz.' });
    const s = db.prepare('SELECT value FROM setup_state WHERE key=?').get('pairsecret:' + req.body.deviceId);
    if (!s || !safeEqual(sha256hex(req.body.secret), s.value)) { pairLim.fail(req.ip); return reply.code(404).send({ error: 'Unbekannt.' }); }
    const d = getDevice(req.body.deviceId);
    if (!d) return { status: 'rejected' };
    if (d.status === 'pending') return { status: 'pending' };
    if (d.status === 'blocked') return { status: 'rejected' };
    const t = db.prepare('SELECT value FROM setup_state WHERE key=?').get('pairtoken:' + d.id);
    if (!t) return reply.code(410).send({ error: 'Das Gerätetoken wurde schon abgeholt.' });
    db.prepare('DELETE FROM setup_state WHERE key IN (?,?)').run('pairtoken:' + d.id, 'pairsecret:' + d.id);
    return { status: 'approved', token: decrypt(key, t.value), spki: tls.spki };
  });

  // ---------- Geräte-API (Bearer-Token) ----------
  const dev = { config: { device: true } };
  app.get('/api/v1/device/schedule', dev, async (req) => ({ v: 1, type: 'schedule_update', ...schedulePayload(db, req.device, now()) }));
  app.get('/api/v1/device/manifest', dev, async (req) => ({ v: 1, type: 'media_manifest', ...manifestPayload(db, req.device, now()) }));
  let activeDownloads = 0; const MAX_DOWNLOADS = 4; // Hub schont sich: höchstens 4 gleichzeitige Medien-Downloads
  app.get('/api/v1/device/media/:id', dev, async (req, reply) => {
    if (activeDownloads >= MAX_DOWNLOADS) return reply.code(503).header('Retry-After', String(5 + Math.floor(Math.random() * 10))).send({ error: 'Der Hub ist gerade ausgelastet. Bitte später erneut versuchen.' });
    const v = db.prepare("SELECT v.path, m.kind FROM media_variants v JOIN media m ON m.id=v.media_id WHERE v.media_id=? AND v.profile=? AND v.status='ready'").get(req.params.id, req.device.profile);
    if (!v) return reply.code(404).send({ error: 'Medium nicht gefunden.' });
    activeDownloads++; let freed = false; const free = () => { if (!freed) { freed = true; activeDownloads--; } };
    reply.raw.once('close', free); reply.raw.once('finish', free);
    return sendFile(req, reply, join(mediaDir, 'variants', v.path));
  });
  // Diagnose: Durchsatz messen (8 MB) und Testvideo im Profil des Geräts
  app.get('/api/v1/device/speedtest', dev, async (req, reply) => reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-store').send(Buffer.alloc(Math.min(8192, Math.max(64, Number(req.query?.kb) || 8192)) * 1024, 0x55))); // kurz und begrenzt: der Test darf andere Bildschirme nicht ausbremsen
  app.get('/api/v1/device/testvideo', dev, async (req, reply) => { try { return sendFile(req, reply, await ensureTestVideo(mediaDir, req.device.profile)); } catch { return reply.code(500).send({ error: 'Das Testvideo konnte nicht erstellt werden.' }); } });
  app.get('/api/v1/device/update/current', dev, async (req, reply) => {
    const f = join(dataDir, 'updates', 'current.dfmpkg');
    return existsSync(f) ? sendFile(req, reply, f) : reply.code(404).send({ error: 'Kein Update vorhanden.' });
  });

  // ---------- Fernbefehle ----------
  app.post('/api/v1/devices/:id/commands', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['command'], additionalProperties: false,
    properties: { command: { enum: COMMANDS }, args: { type: 'object' } } } } }, async (req, reply) => {
    const d = getDevice(req.params.id); if (!d || d.status !== 'active') return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const { command, args = {} } = req.body;
    if (command === 'factory_reset' && isHubDevice(d.id)) return reply.code(409).send({ error: 'Dieser Bildschirm ist gleichzeitig der Hub. Beim Zurücksetzen gehen alle Inhalte und Einstellungen verloren.' });
    if (command === 'rotate' && ![0, 90, 180, 270].includes(args.degrees)) return reply.code(400).send({ error: 'Bitte wähle 0, 90, 180 oder 270 Grad.' });
    if (command === 'wifi_change' && !(typeof args.ssid === 'string' && args.ssid.length >= 1 && Buffer.byteLength(args.ssid) <= 32 && typeof args.password === 'string')) return reply.code(400).send({ error: 'Bitte gib Netzwerkname und Passwort an.' });
    if (command === 'rotate' && !args.rollback) db.prepare('UPDATE devices SET orientation=? WHERE id=?').run(args.degrees, d.id); // mit Rückfall erst nach Bestätigung (confirm_display)
    if (command === 'confirm_display' && [0, 90, 180, 270].includes(args.degrees)) db.prepare('UPDATE devices SET orientation=? WHERE id=?').run(args.degrees, d.id);
    const id = randomUUID();
    db.prepare('INSERT INTO commands(id,device_id,type,args_json,created_at) VALUES(?,?,?,?,?)')
      .run(id, d.id, command, command === 'wifi_change' ? encrypt(key, JSON.stringify(args)) : JSON.stringify(args), now());
    audit.log({ user: req.user, action: 'befehl.' + command, target: d.id, ip: req.ip, security: command === 'factory_reset' || command === 'wifi_change', detail: command === 'wifi_change' ? { ssid: args.ssid } : args });
    deliverQueued(d.id);
    return reply.code(202).send({ id });
  });
  app.get('/api/v1/devices/:id/commands', { config: { perm: 'devices.read' } }, async (req) =>
    db.prepare('SELECT id,type,status,result_json,created_at FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 20').all(req.params.id));
  app.get('/api/v1/devices/:id/screenshot', { config: { perm: 'live.read' } }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(400).send({ error: 'Ungültig.' });
    const sh = shots.get(req.params.id); if (!sh) return reply.code(404).send({ error: 'Es gibt noch keine Vorschau.' });
    viewers.detail.set(req.params.id, now()); // wer ein Einzelbild abruft, schaut gerade zu
    return reply.header('Content-Type', sh.mime).header('Cache-Control', 'no-store').header('X-Shot-Time', String(sh.ts)).send(sh.buf);
  });
  /** „Bild speichern“: nur durch Admins, bewusst; sonst werden Bilder nie dauerhaft abgelegt (Datenschutz) */
  app.post('/api/v1/devices/:id/screenshot/save', { config: { perm: 'devices.manage' } }, async (req, reply) => {
    const sh = shots.get(req.params.id); if (!sh) return reply.code(404).send({ error: 'Es gibt noch kein Bild.' });
    const f = join(shotDir, `${req.params.id}-${now()}.jpg`); writeFileSync(f, sh.buf); audit.log({ user: req.user, action: 'bild.gespeichert', target: req.params.id, ip: req.ip }); return { ok: true };
  });

  function deliverQueued(id) {
    for (const c of db.prepare("SELECT * FROM commands WHERE device_id=? AND status='queued' ORDER BY created_at").all(id)) {
      let args; try { args = c.type === 'wifi_change' ? JSON.parse(decrypt(key, c.args_json)) : JSON.parse(c.args_json || '{}'); } catch { db.prepare("UPDATE commands SET status='failed', result_json=? WHERE id=?").run(JSON.stringify({ error: 'Der Befehl war beschädigt.' }), c.id); continue; } // ein kaputter Befehl darf die übrigen nicht blockieren
      if (sendTo(id, 'command', { id: c.id, command: c.type, args })) {
        db.prepare("UPDATE commands SET status='sent', args_json=? WHERE id=?").run(c.type === 'wifi_change' ? '{}' : c.args_json, c.id); // WLAN-Passwort nach Zustellung löschen
      }
    }
  }

  /** Befehl für ein Gerät einreihen und zustellen (auch für interne Abläufe wie gestaffelte Updates) */
  const queueCommand = (deviceId, command, args = {}) => { const id = randomUUID(); db.prepare('INSERT INTO commands(id,device_id,type,args_json,created_at) VALUES(?,?,?,?,?)').run(id, deviceId, command, JSON.stringify(args), now()); deliverQueued(deviceId); return id; };
  app.devices.queueCommand = queueCommand;

  // ---------- WebSocket (ein Socket je Player) ----------
  app.get('/api/v1/ws', { ...dev, websocket: true }, (socket, req) => {
    const d = req.device; let alive = true;
    sockets.get(d.id)?.close(4000, 'replaced'); sockets.set(d.id, socket);
    db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), d.id);
    socket.on('pong', () => { alive = true; });
    const timer = safeInterval(() => { if (!alive) return socket.terminate(); alive = false; socket.ping(); }, 45000, console.error, 'WebSocket-Takt');
    const handle = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return socket.close(1007, 'json'); }
      const err = validateMessage(m); if (err) return socket.close(1008, err);
      const cur = getDevice(d.id); if (!cur || cur.status !== 'active') return socket.close(4001, 'revoked');
      db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), d.id);
      if (m.type === 'hello') {
        db.prepare('UPDATE devices SET model=COALESCE(?,model), hw_json=COALESCE(?,hw_json) WHERE id=?').run(m.model ?? null, m.hw ? JSON.stringify(m.hw) : null, d.id);
        try { const st = JSON.parse(cur.state_json ?? '{}'); if (m.version && st.version !== m.version) db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(fitState({ ...st, version: m.version }), d.id); } catch {} // Version sofort übernehmen: Der Plan hängt davon ab, was der Bildschirm versteht (z. B. Einschübe ab 0.2.26)
        pushPlan(getDevice(d.id)); deliverQueued(d.id);
        sendTo(d.id, 'plays_ack', { id: 0 }); // Fähigkeits-Meldung: dieser Hub versteht „plays“. Ein alter Hub würde die Nachricht ablehnen und die Verbindung trennen, deshalb senden neue Bildschirme erst nach diesem Signal.
      } else if (m.type === 'heartbeat') {
        let keep = {}; if (m.state.playerStatus === undefined) { try { keep = { playerStatus: JSON.parse(getDevice(d.id).state_json ?? '{}').playerStatus }; } catch {} } // „Ist“ aus der letzten status-Meldung bleibt erhalten
        db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(fitState({ ...keep, ...m.state }), d.id);
        try { metrics?.recordDevice(d.id, m.state); } catch {} // Verlauf (Speicher/Temperatur/Last) – darf den Heartbeat nie stören
      } else if (m.type === 'status') {
        let st = {}; try { st = JSON.parse(getDevice(d.id).state_json ?? '{}'); } catch {}
        db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(fitState({ ...st, playerStatus: { current: m.current, next: m.next ?? null, source: m.source ?? null, scheduleId: m.scheduleId ?? null, ts: now() } }), d.id);
      } else if (m.type === 'command_result') {
        db.prepare("UPDATE commands SET status=?, result_json=? WHERE id=? AND device_id=?").run(m.ok ? 'done' : 'failed', JSON.stringify(m.result ?? { error: m.error }), m.id, d.id);
      } else if (m.type === 'plays') { // Wiedergabe-Nachweis: Zähler des Bildschirms aufnehmen und bestätigen (auch Doppeltes wird bestätigt, aber nicht doppelt gezählt)
        try { plays?.ingest(d.id, m); } catch {} sendTo(d.id, 'plays_ack', { id: m.id });
      } else if (m.type === 'signal') {
        signals.set(d.id, { dbm: m.dbm, wifi: m.wifi ?? null, ts: now() });
      } else if (m.type === 'screenshot') {
        const buf = Buffer.from(m.png, 'base64');
        if (buf.subarray(0, 4).toString('hex') === '89504e47' || buf.subarray(0, 2).toString('hex') === 'ffd8') {
          sharp(buf).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer().then((j) => shots.set(d.id, { buf: j, mime: 'image/jpeg', ts: now() })).catch(() => {});
          try { app.waechter?.ingest(d.id, buf).catch(() => {}); } catch {} // Bild-Wächter (nur Prüfsumme und Helligkeit, das Bild wird nicht aufgehoben)
        }
      }
    };
    // Ein Fehler bei einer einzelnen Nachricht (z. B. eine kurz gesperrte Datenbank) beendet nur diese Verbindung – der Bildschirm verbindet sich von selbst neu –, nie den Hub.
    socket.on('message', (raw) => { try { handle(raw); } catch (e) { req.log.error({ err: e }, 'WebSocket-Nachricht fehlgeschlagen'); try { socket.close(1011, 'intern'); } catch {} } });
    socket.on('error', (e) => req.log.warn({ err: e }, 'WebSocket-Fehler'));
    socket.on('close', () => { clearInterval(timer); if (sockets.get(d.id) === socket) sockets.delete(d.id); });
  });
}

/** Datei mit Range-Unterstützung (fortsetzbare Downloads). */
export function sendFile(req, reply, file) {
  let st; try { st = statSync(file); } catch { return reply.code(404).send({ error: 'Datei nicht gefunden.' }); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'application/octet-stream').header('X-Content-Type-Options', 'nosniff');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (start > end || start >= st.size) return reply.code(416).header('Content-Range', `bytes */${st.size}`).send();
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${st.size}`).header('Content-Length', end - start + 1).send(createReadStream(file, { start, end }));
  }
  return reply.header('Content-Length', st.size).send(createReadStream(file));
}

devicesPlugin[Symbol.for('skip-override')] = true; // Hooks und Decorators global (wie fastify-plugin)
export default devicesPlugin;
