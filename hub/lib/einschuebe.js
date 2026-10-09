// Einschübe: „Alle 5 Minuten das Sponsor-Logo für 10 Sekunden“ – ohne die Folie in jede Abspielliste einzeln einzubauen.
// Der Hub gibt die Einschübe im Plan mit (Feld „inserts“, nur an Bildschirme ab Version 0.2.26); der Bildschirm mischt sie selbst ein
// (shared/sequencer.js: dueInsert) und arbeitet dabei auch ohne Hub weiter. Einschübe erscheinen nur im normalen Betrieb, nie bei Notfall,
// Tor-Jubel, Hand-Aktionen oder in der Wartung. Jede Einblendung zählt im Wiedergabe-Nachweis mit.
import { randomUUID } from 'node:crypto';
import { INSERTS_MIN_VERSION, verGte } from './plan.js';

const MAX_INSERTS = 20;
const todayBerlin = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

async function einschuebePlugin(app, { db, audit, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });
  const body = { type: 'object', required: ['name', 'mediaId', 'everyMin', 'seconds', 'scope'], additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 }, mediaId: { type: 'string', maxLength: 64 }, everyMin: { type: 'integer', minimum: 1, maximum: 240 }, seconds: { type: 'integer', minimum: 3, maximum: 120 },
    scope: { enum: ['all', 'group', 'device'] }, targetId: { type: 'string', maxLength: 64 }, enabled: { type: 'boolean' },
    validFrom: { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' }, validTo: { type: 'string', pattern: '^(\\d{4}-\\d{2}-\\d{2})?$' } } };
  const idParam = { type: 'object', properties: { id: { type: 'string', maxLength: 64 } } };
  const mayScope = (u, scope, target) => !u?.groups || u.role === 'admin' || (scope === 'group' ? u.groups.includes(target) : scope === 'device' ? u.groups.includes(db.prepare('SELECT group_id FROM devices WHERE id=?').get(target)?.group_id) : false);
  const deny = (reply) => reply.code(403).send({ error: 'Mit deinen Rechten darfst du Einschübe nur für deine eigenen Gruppen und Bildschirme anlegen oder ändern.' });
  const fail = (reply, m) => reply.code(400).send({ error: m });

  function clean(b) {
    const name = b.name.trim(); if (!name) return { error: 'Bitte gib dem Einschub einen Namen.' };
    if (!db.prepare('SELECT 1 FROM media WHERE id=?').get(b.mediaId)) return { error: 'Dieses Bild, Video oder diese Folie gibt es nicht.' };
    if (b.seconds * 2 > b.everyMin * 60) return { error: 'Ein Einschub darf höchstens die Hälfte der Zeit belegen. Wähle weniger Sekunden oder einen größeren Abstand.' };
    const target = b.scope === 'all' ? null : b.targetId ?? null;
    if (b.scope === 'group' && !db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(target)) return { error: 'Bitte wähle eine Gruppe aus.' };
    if (b.scope === 'device' && !db.prepare("SELECT 1 FROM devices WHERE id=? AND status IN ('active','pending')").get(target)) return { error: 'Bitte wähle einen Bildschirm aus.' };
    const from = b.validFrom || null, to = b.validTo || null; if (from && to && to < from) return { error: 'Das Ende liegt vor dem Beginn.' };
    for (const d of [from, to]) if (d && Number.isNaN(Date.parse(`${d}T12:00:00Z`))) return { error: 'Das Datum ist ungültig.' };
    return { v: { name, mediaId: b.mediaId, everyMin: b.everyMin, seconds: b.seconds, scope: b.scope, target, enabled: b.enabled !== false, from, to } };
  }
  function view(i, t = now()) {
    const m = db.prepare('SELECT name,kind FROM media WHERE id=?').get(i.media_id), day = todayBerlin(t);
    const targets = db.prepare("SELECT id,group_id,state_json FROM devices WHERE status='active'").all().filter((d) => i.scope === 'all' || (i.scope === 'device' && d.id === i.target_id) || (i.scope === 'group' && d.group_id === i.target_id));
    const old = targets.filter((d) => { let v = ''; try { v = JSON.parse(d.state_json ?? '{}').version ?? ''; } catch {} return !verGte(v, INSERTS_MIN_VERSION); }).length;
    const status = !i.enabled ? 'aus' : !m ? 'fehler' : i.valid_to && day > i.valid_to ? 'abgelaufen' : i.valid_from && day < i.valid_from ? 'zukunft' : 'aktiv';
    const statusText = { aus: 'Ausgeschaltet.', fehler: 'Das Medium wurde gelöscht. Bitte wähle ein anderes.', abgelaufen: 'Der Zeitraum ist vorbei.', zukunft: `Startet am ${(i.valid_from ?? '').split('-').reverse().join('.')}.`, aktiv: 'Läuft.' }[status];
    return { id: i.id, name: i.name, enabled: !!i.enabled, media: { id: i.media_id, name: m?.name ?? null, kind: m?.kind ?? null }, everyMin: i.every_min, seconds: i.seconds, scope: i.scope, targetId: i.target_id,
      targetName: i.scope === 'all' ? 'alle Bildschirme' : i.scope === 'group' ? `Gruppe „${db.prepare('SELECT name FROM device_groups WHERE id=?').get(i.target_id)?.name ?? '?'}“` : `„${db.prepare('SELECT name FROM devices WHERE id=?').get(i.target_id)?.name ?? '?'}“`,
      validFrom: i.valid_from, validTo: i.valid_to, status, statusText, screens: targets.length, oldScreens: old };
  }
  const push = () => { app.variants?.ensureAll(); app.pushAll?.(); };

  app.get('/api/v1/inserts', { config: { perm: 'schedules.read' } }, async () => ({ inserts: db.prepare('SELECT * FROM inserts ORDER BY created_at, id').all().map((i) => view(i)), max: MAX_INSERTS,
    hint: 'Ein Einschub erscheint nur im normalen Betrieb – nicht während einer Notfall-Meldung, eines Tor-Jubels, einer Hand-Aktion (zum Beispiel Präsentation) oder in der Wartung. Der erste Einschub kommt nach einer vollen Wartezeit; der Abstand ist ungefähr (er wird am Ende des laufenden Elements eingeschoben, ein Video läuft immer zu Ende).' }));
  app.post('/api/v1/inserts', { config: { perm: 'schedules.write' }, schema: { body } }, async (req, reply) => {
    if (db.prepare('SELECT COUNT(*) n FROM inserts').get().n >= MAX_INSERTS) return fail(reply, `Es gibt schon ${MAX_INSERTS} Einschübe. Lösche zuerst einen, den du nicht mehr brauchst.`);
    const c = clean(req.body); if (c.error) return fail(reply, c.error); const v = c.v; if (!mayScope(req.user, v.scope, v.target)) return deny(reply);
    const id = randomUUID(); db.prepare('INSERT INTO inserts(id,name,media_id,every_min,seconds,scope,target_id,enabled,valid_from,valid_to,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, v.name, v.mediaId, v.everyMin, v.seconds, v.scope, v.target, v.enabled ? 1 : 0, v.from, v.to, req.user.id, now());
    A(req, 'einschub.angelegt', id, { name: v.name }); push(); return reply.code(201).send({ id, insert: view(db.prepare('SELECT * FROM inserts WHERE id=?').get(id)) });
  });
  app.put('/api/v1/inserts/:id', { config: { perm: 'schedules.write' }, schema: { params: idParam, body } }, async (req, reply) => {
    const old = db.prepare('SELECT * FROM inserts WHERE id=?').get(req.params.id); if (!old) return reply.code(404).send({ error: 'Diesen Einschub gibt es nicht.' });
    const c = clean(req.body); if (c.error) return fail(reply, c.error); const v = c.v; if (!mayScope(req.user, old.scope, old.target_id) || !mayScope(req.user, v.scope, v.target)) return deny(reply);
    db.prepare('UPDATE inserts SET name=?,media_id=?,every_min=?,seconds=?,scope=?,target_id=?,enabled=?,valid_from=?,valid_to=? WHERE id=?').run(v.name, v.mediaId, v.everyMin, v.seconds, v.scope, v.target, v.enabled ? 1 : 0, v.from, v.to, old.id);
    A(req, 'einschub.geaendert', old.id, { name: v.name, aktiv: v.enabled }); push(); return { ok: true, insert: view(db.prepare('SELECT * FROM inserts WHERE id=?').get(old.id)) };
  });
  app.delete('/api/v1/inserts/:id', { config: { perm: 'schedules.write' }, schema: { params: idParam } }, async (req, reply) => {
    const old = db.prepare('SELECT * FROM inserts WHERE id=?').get(req.params.id); if (!old) return reply.code(404).send({ error: 'Diesen Einschub gibt es nicht.' });
    if (!mayScope(req.user, old.scope, old.target_id)) return deny(reply);
    db.prepare('DELETE FROM inserts WHERE id=?').run(old.id); A(req, 'einschub.geloescht', old.id, { name: old.name }); push(); return { ok: true };
  });
}
einschuebePlugin[Symbol.for('skip-override')] = true;
export default einschuebePlugin;
