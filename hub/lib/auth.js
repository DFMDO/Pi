// Anmeldung, Sitzungen (serverseitig), CSRF, Rechteprüfung, Gerätetoken.
import { randomUUID } from 'node:crypto';
import { randomToken, sha256hex, hashPassword, verifyPassword, checkPasswordPolicy, safeEqual,
  verifyTotp, newTotpSecret, newRecoveryCodes, encrypt, decrypt } from './crypto.js';
import { can } from './permissions.js';
import { createLimiter } from './ratelimit.js';

export const COOKIE = '__Host-dfm_sid';
const IDLE_MS = 30 * 60000;
const FAIL_MSG = 'Benutzername oder Passwort stimmt nicht.';
const DUMMY = await hashPassword('dummy-passwort-fuer-konstante-zeit');

export function parseCookies(h = '') {
  const o = {};
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}

async function authPlugin(app, { db, key, audit, now = () => Date.now() }) {
  const ipLim = createLimiter({ max: 10, baseMs: 15000, now }), userLim = createLimiter({ max: 5, baseMs: 30000, now });
  const q = {
    user: db.prepare('SELECT * FROM users WHERE name = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    sess: db.prepare('SELECT * FROM sessions WHERE id_hash = ?'),
    touch: db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id_hash = ?'),
    dev: db.prepare("SELECT * FROM devices WHERE token_hash = ? AND status = 'active'"),
  };

  app.decorateRequest('user', null); app.decorateRequest('session', null); app.decorateRequest('device', null);

  // Jede API-Route muss ihre Rechte deklarieren (sonst startet der Server nicht).
  const apiRoutes = []; app.decorate('apiRoutes', apiRoutes);
  app.addHook('onRoute', (r) => {
    if (!r.url.startsWith('/api/v1/')) return;
    const c = r.config ?? {};
    apiRoutes.push({ method: [].concat(r.method), url: r.url, config: c, schema: r.schema });
    if (!c.perm && !c.public && !c.device && !c.authenticated) throw new Error(`Route ohne Rechte: ${r.method} ${r.url}`);
  });

  app.addHook('onRequest', async (req, reply) => {
    const c = req.routeOptions.config ?? {};
    if (!req.url.startsWith('/api/v1/') || c.public) return;
    if (c.device) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      const d = m && q.dev.get(sha256hex(m[1]));
      if (!d) return reply.code(401).send({ error: 'Dieses Gerät ist nicht (mehr) verbunden.' });
      req.device = d; return;
    }
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid && q.sess.get(sha256hex(sid));
    if (!s || s.last_seen + IDLE_MS < now() || s.expires_at < now()) {
      if (s) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(s.id_hash);
      return reply.code(401).send({ error: 'Bitte melde dich an.', code: 'login' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && !safeEqual(req.headers['x-csrf-token'] ?? '', s.csrf)) {
      return reply.code(403).send({ error: 'Die Sitzung ist abgelaufen oder ungültig. Bitte lade die Seite neu.' });
    }
    const u = q.byId.get(s.user_id);
    if (!u) return reply.code(401).send({ error: 'Bitte melde dich an.', code: 'login' });
    if (c.perm && !can(u.role, c.perm)) {
      audit.log({ user: u, action: 'zugriff.verweigert', target: req.url, ip: req.ip, security: true });
      return reply.code(403).send({ error: 'Dafür fehlt dir die Berechtigung.' });
    }
    req.user = u; req.session = s;
    q.touch.run(now(), now() + 12 * 3600000, s.id_hash);
  });

  function startSession(u, ip, reply) {
    const sid = randomToken(), csrf = randomToken(16);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(sha256hex(sid), u.id, csrf, now() + 12 * 3600000, now(), ip);
    reply.header('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
    return csrf;
  }

  const bodyLogin = { type: 'object', required: ['name', 'password'], additionalProperties: false,
    properties: { name: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 300 }, totp: { type: 'string', maxLength: 20 } } };

  app.post('/api/v1/auth/login', { config: { public: true }, schema: { body: bodyLogin } }, async (req, reply) => {
    const { name, password, totp } = req.body, nameKey = 'u:' + name.toLowerCase();
    const w = Math.max(ipLim.wait(req.ip), userLim.wait(nameKey));
    if (w) return reply.code(429).header('Retry-After', w).send({ error: `Zu viele Versuche. Bitte warte ${w} Sekunden.` });
    const u = q.user.get(name);
    const okPw = await verifyPassword(u?.pw_hash ?? DUMMY, password);
    let ok = !!u && okPw;
    if (ok && u.totp_secret_enc) {
      const secret = decrypt(key, u.totp_secret_enc);
      if (!totp) return reply.code(401).send({ error: 'Bitte gib den Code aus deiner Authenticator-App ein.', code: 'totp' });
      let rec = JSON.parse(u.recovery_hashes ?? '[]');
      const h = sha256hex(String(totp).replace(/\s/g, '').toLowerCase());
      if (verifyTotp(secret, totp)) ok = true;
      else if (rec.includes(h)) { rec = rec.filter((x) => x !== h); db.prepare('UPDATE users SET recovery_hashes=? WHERE id=?').run(JSON.stringify(rec), u.id); }
      else ok = false;
    }
    if (!ok) {
      ipLim.fail(req.ip); userLim.fail(nameKey);
      audit.log({ user: u ? { id: u.id, name: u.name } : null, action: 'login.fehlgeschlagen', target: name.slice(0, 50), ip: req.ip, security: true });
      return reply.code(401).send({ error: FAIL_MSG }); // gleiche Meldung: Benutzer unbekannt / Passwort falsch
    }
    ipLim.ok(req.ip); userLim.ok(nameKey);
    const csrf = startSession(u, req.ip, reply);
    audit.log({ user: u, action: 'login', ip: req.ip });
    return { csrf, user: { id: u.id, name: u.name, role: u.role, totp: !!u.totp_secret_enc } };
  });

  app.post('/api/v1/auth/logout', { config: { authenticated: true } }, async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.session.id_hash);
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    audit.log({ user: req.user, action: 'logout', ip: req.ip });
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { config: { authenticated: true } }, async (req) =>
    ({ csrf: req.session.csrf, user: { id: req.user.id, name: req.user.name, role: req.user.role, totp: !!req.user.totp_secret_enc } }));

  app.post('/api/v1/auth/password', { config: { authenticated: true }, schema: { body: { type: 'object', required: ['old', 'new'],
    additionalProperties: false, properties: { old: { type: 'string', maxLength: 300 }, new: { type: 'string', maxLength: 300 } } } } }, async (req, reply) => {
    if (!(await verifyPassword(req.user.pw_hash, req.body.old))) return reply.code(400).send({ error: 'Das alte Passwort stimmt nicht.' });
    const bad = checkPasswordPolicy(req.body.new, req.user.name);
    if (bad) return reply.code(400).send({ error: bad });
    db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(await hashPassword(req.body.new), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND id_hash<>?').run(req.user.id, req.session.id_hash);
    audit.log({ user: req.user, action: 'passwort.geaendert', ip: req.ip });
    return { ok: true };
  });

  // TOTP: erst Geheimnis erzeugen, dann mit einem gültigen Code bestätigen.
  app.post('/api/v1/auth/totp/start', { config: { authenticated: true } }, async (req) => {
    const secret = newTotpSecret();
    db.prepare("INSERT OR REPLACE INTO setup_state VALUES(?,?)").run('totp_pending:' + req.user.id, encrypt(key, secret));
    return { secret, uri: `otpauth://totp/DFM%20Signage:${encodeURIComponent(req.user.name)}?secret=${secret}&issuer=DFM%20Signage` };
  });
  app.post('/api/v1/auth/totp/enable', { config: { authenticated: true }, schema: { body: { type: 'object', required: ['code'],
    properties: { code: { type: 'string', maxLength: 10 } } } } }, async (req, reply) => {
    const p = db.prepare('SELECT value FROM setup_state WHERE key=?').get('totp_pending:' + req.user.id);
    if (!p) return reply.code(400).send({ error: 'Bitte starte die Einrichtung erneut.' });
    const secret = decrypt(key, p.value);
    if (!verifyTotp(secret, req.body.code)) return reply.code(400).send({ error: 'Der Code stimmt nicht. Bitte versuche es noch einmal.' });
    const rec = newRecoveryCodes();
    db.prepare('UPDATE users SET totp_secret_enc=?, recovery_hashes=? WHERE id=?')
      .run(encrypt(key, secret), JSON.stringify(rec.map((c) => sha256hex(c.toLowerCase()))), req.user.id);
    db.prepare('DELETE FROM setup_state WHERE key=?').run('totp_pending:' + req.user.id);
    audit.log({ user: req.user, action: 'totp.aktiviert', ip: req.ip });
    return { recoveryCodes: rec };
  });

  // Benutzerverwaltung (nur Admin)
  app.get('/api/v1/users', { config: { perm: 'users.manage' } }, async () =>
    db.prepare('SELECT id,name,role,totp_secret_enc IS NOT NULL AS totp,created_at FROM users ORDER BY name').all());
  app.post('/api/v1/users', { config: { perm: 'users.manage' }, schema: { body: { type: 'object', required: ['name', 'password', 'role'],
    additionalProperties: false, properties: { name: { type: 'string', minLength: 2, maxLength: 60 }, password: { type: 'string', maxLength: 300 },
      role: { enum: ['admin', 'editor', 'viewer'] } } } } }, async (req, reply) => {
    const { name, password, role } = req.body;
    const bad = checkPasswordPolicy(password, name);
    if (bad) return reply.code(400).send({ error: bad });
    if (q.user.get(name)) return reply.code(409).send({ error: 'Diesen Namen gibt es schon.' });
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,name,pw_hash,role,created_at) VALUES(?,?,?,?,?)').run(id, name, await hashPassword(password), role, now());
    audit.log({ user: req.user, action: 'benutzer.angelegt', target: name, ip: req.ip, detail: { role } });
    return reply.code(201).send({ id });
  });
  app.delete('/api/v1/users/:id', { config: { perm: 'users.manage' } }, async (req, reply) => {
    if (req.params.id === req.user.id) return reply.code(400).send({ error: 'Du kannst dich nicht selbst löschen.' });
    const r = db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
    if (!r.changes) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' });
    audit.log({ user: req.user, action: 'benutzer.geloescht', target: req.params.id, ip: req.ip });
    return { ok: true };
  });
}

authPlugin[Symbol.for('skip-override')] = true; // Hooks und Decorators global (wie fastify-plugin)
export default authPlugin;
