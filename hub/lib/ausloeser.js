// Auslöser-Links: Ein geheimer Link startet (oder beendet) von außen eine Schnellaktion („Szene“) – zum Beispiel per Handy-Kurzbefehl,
// Stream-Deck-Taste oder aus der Haustechnik. Alles bleibt im Museumsnetz; der Hub ruft nichts von selbst auf.
// Sicherheit: Der Link enthält ein langes Zufalls-Geheimnis (nur dessen Prüfsumme wird gespeichert, der Klartext wird einmal gezeigt),
// falsche Versuche werden gebremst, jeder Aufruf steht im Protokoll, und eine laufende Notfall-Meldung wird NIE von einem Auslöser beendet.
import { randomUUID } from 'node:crypto';
import { randomToken, sha256hex } from './crypto.js';
import { createLimiter } from './ratelimit.js';
import { NOTFALL_LABEL } from './notfall.js';

const MIN_GAP_MS = 2000;          // derselbe Link höchstens alle 2 Sekunden (Doppelklick, Wiederholung durch Haustechnik)
const PATH = (token) => `/api/v1/trigger/${token}`;

async function ausloeserPlugin(app, { db, audit, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail, security: true });
  const badLim = createLimiter({ max: 10, baseMs: 30000, now }); // falsche Links je Absender-Adresse
  const lastUse = new Map();
  const sceneOf = (id) => db.prepare('SELECT * FROM scenes WHERE id=?').get(id);
  const view = (t) => {
    const s = sceneOf(t.scene_id);
    return { id: t.id, name: t.name, sceneId: t.scene_id, sceneName: s?.name ?? null, action: t.action, minutes: t.minutes, endOfDay: !!t.end_of_day, allowGet: !!t.allow_get, enabled: !!t.enabled,
      createdAt: t.created_at, createdBy: t.created_by, lastUsed: t.last_used, useCount: t.use_count,
      problem: !s ? 'Die Schnellaktion gibt es nicht mehr.' : s.state !== 'published' ? 'Die Schnellaktion ist noch ein Entwurf – bitte veröffentlichen.' : null };
  };

  const body = { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 }, sceneId: { type: 'string', maxLength: 40 }, action: { enum: ['start', 'stop'] },
    minutes: { type: 'integer', minimum: 5, maximum: 1440 }, endOfDay: { type: 'boolean' }, allowGet: { type: 'boolean' }, enabled: { type: 'boolean' } } };

  app.get('/api/v1/triggers', { config: { perm: 'settings.manage' } }, async () => db.prepare('SELECT * FROM triggers ORDER BY name').all().map(view));

  app.post('/api/v1/triggers', { config: { perm: 'settings.manage' }, schema: { body: { ...body, required: ['name', 'sceneId'] } } }, async (req, reply) => {
    const b = req.body, s = sceneOf(b.sceneId); if (!s) return reply.code(400).send({ error: 'Diese Schnellaktion gibt es nicht.' });
    const id = randomUUID(), token = randomToken(32);
    db.prepare('INSERT INTO triggers(id,name,token_hash,scene_id,action,minutes,end_of_day,allow_get,enabled,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,1,?,?)')
      .run(id, b.name.trim(), sha256hex(token), s.id, b.action ?? 'start', b.minutes ?? 30, b.endOfDay ? 1 : 0, b.allowGet ? 1 : 0, now(), req.user.name);
    A(req, 'ausloeser.angelegt', id, { name: b.name, szene: s.name, aktion: b.action ?? 'start' });
    return reply.code(201).send({ id, token, path: PATH(token), text: 'Der Link wird nur jetzt angezeigt. Bitte kopiere ihn und bewahre ihn sicher auf. Wer ihn kennt, kann die Schnellaktion auslösen.' });
  });

  app.patch('/api/v1/triggers/:id', { config: { perm: 'settings.manage' }, schema: { body } }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM triggers WHERE id=?').get(req.params.id); if (!t) return reply.code(404).send({ error: 'Diesen Auslöser gibt es nicht.' });
    const b = req.body;
    if (b.sceneId && !sceneOf(b.sceneId)) return reply.code(400).send({ error: 'Diese Schnellaktion gibt es nicht.' });
    db.prepare('UPDATE triggers SET name=?, scene_id=?, action=?, minutes=?, end_of_day=?, allow_get=?, enabled=? WHERE id=?').run(b.name?.trim() ?? t.name, b.sceneId ?? t.scene_id, b.action ?? t.action, b.minutes ?? t.minutes,
      'endOfDay' in b ? (b.endOfDay ? 1 : 0) : t.end_of_day, 'allowGet' in b ? (b.allowGet ? 1 : 0) : t.allow_get, 'enabled' in b ? (b.enabled ? 1 : 0) : t.enabled, t.id);
    A(req, 'ausloeser.geaendert', t.id, b); return { ok: true };
  });

  app.post('/api/v1/triggers/:id/regenerate', { config: { perm: 'settings.manage' } }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM triggers WHERE id=?').get(req.params.id); if (!t) return reply.code(404).send({ error: 'Diesen Auslöser gibt es nicht.' });
    const token = randomToken(32); db.prepare('UPDATE triggers SET token_hash=? WHERE id=?').run(sha256hex(token), t.id);
    A(req, 'ausloeser.link_erneuert', t.id); return { id: t.id, token, path: PATH(token), text: 'Der alte Link gilt nicht mehr. Der neue Link wird nur jetzt angezeigt.' };
  });

  app.delete('/api/v1/triggers/:id', { config: { perm: 'settings.manage' } }, async (req, reply) => {
    const r = db.prepare('DELETE FROM triggers WHERE id=?').run(req.params.id); if (!r.changes) return reply.code(404).send({ error: 'Diesen Auslöser gibt es nicht.' });
    A(req, 'ausloeser.geloescht', req.params.id); return { ok: true };
  });

  /** Der Aufruf von außen (ohne Anmeldung – das Geheimnis im Link ist die Berechtigung) */
  function fire(req, reply, viaGet) {
    const ip = req.ip, wait = badLim.wait(ip);
    if (wait) return reply.code(429).header('Retry-After', String(wait)).send({ error: `Zu viele falsche Links. Bitte in ${wait} Sekunden erneut versuchen.` });
    const t = db.prepare('SELECT * FROM triggers WHERE token_hash=?').get(sha256hex(String(req.params.token)));
    if (!t) { badLim.fail(ip); return reply.code(404).send({ error: 'Dieser Link gilt nicht (mehr).' }); }
    if (!t.enabled) return reply.code(403).send({ error: 'Dieser Auslöser ist ausgeschaltet.' });
    if (viaGet && !t.allow_get) return reply.code(405).header('Allow', 'POST').send({ error: 'Dieser Link darf nur per POST aufgerufen werden (in der Verwaltung kann „Auch per GET“ erlaubt werden).' });
    const t0 = now(); if (t0 - (lastUse.get(t.id) ?? 0) < MIN_GAP_MS) return reply.code(429).header('Retry-After', '2').send({ error: 'Bitte einen Moment warten.' });
    const notfall = db.prepare("SELECT 1 FROM overrides WHERE label=? AND ended_at IS NULL AND until>?").get(NOTFALL_LABEL, t0);
    const s = sceneOf(t.scene_id);
    if (!s) return reply.code(410).send({ error: 'Die Schnellaktion zu diesem Link gibt es nicht mehr.' });
    let text;
    if (t.action === 'start') {
      if (notfall) { audit.log({ action: 'ausloeser.abgelehnt_notfall', target: t.id, ip, detail: { name: t.name } , security: true }); return reply.code(423).send({ error: 'Eine Notfall-Meldung läuft. Der Auslöser wurde nicht ausgeführt.' }); }
      const bad = app.scenes.problem(s); if (bad) return reply.code(409).send({ error: bad });
      const until = app.scenes.run({ id: null, name: `Auslöser „${t.name}“` }, s, { minutes: t.minutes, endOfDay: !!t.end_of_day });
      text = `Schnellaktion „${s.name}“ läuft bis ${new Date(until).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr.`;
    } else {
      const n = app.scenes.stop(s.id); text = n ? `Schnellaktion „${s.name}“ ist beendet.` : `Schnellaktion „${s.name}“ lief nicht.`;
    }
    lastUse.set(t.id, t0); badLim.ok(ip);
    db.prepare('UPDATE triggers SET last_used=?, use_count=use_count+1 WHERE id=?').run(t0, t.id);
    audit.log({ action: 'ausloeser.ausgeloest', target: t.id, ip, detail: { name: t.name, aktion: t.action, szene: s.name, per: viaGet ? 'GET' : 'POST' }, security: false });
    app.pushAll(); return { ok: true, text };
  }
  app.post('/api/v1/trigger/:token', { config: { public: true } }, async (req, reply) => fire(req, reply, false));
  app.get('/api/v1/trigger/:token', { config: { public: true } }, async (req, reply) => fire(req, reply, true));
}
ausloeserPlugin[Symbol.for('skip-override')] = true;
export default ausloeserPlugin;
