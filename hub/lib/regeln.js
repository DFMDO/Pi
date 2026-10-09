// Wenn-Dann-Regeln (Oberfläche und Takt). Die Auswertung selbst steckt in rules.js.
import { randomUUID } from 'node:crypto';
import { createRules, normalizeConditions } from './rules.js';

export const RULE_TEMPLATES = [
  { id: 'regen', icon: '🌧️', name: 'Bei Regen', needs: 'wetter', hint: 'Zeigt zum Beispiel eine Liste mit Indoor-Tipps, sobald es regnet oder in den nächsten 3 Stunden regnen wird.', rule: { name: 'Bei Regen', priority: 5, stableS: 300, conditions: [{ type: 'wetter', is: 'regen_bald' }] } },
  { id: 'spiel', icon: '⚽', name: 'Solange das Spiel läuft', needs: 'livespiel', hint: 'Zeigt zum Beispiel die Folie „Live-Spiel“, solange das Spiel deines Vereins läuft.', rule: { name: 'Spiel läuft', priority: 6, stableS: 0, conditions: [{ type: 'spiel', is: 'laeuft' }] } },
  { id: 'spieltag', icon: '🏟️', name: 'Am Spieltag', needs: 'livespiel', hint: 'Zeigt an Tagen mit einem Spiel deines Vereins ein besonderes Programm.', rule: { name: 'Spieltag', priority: 4, stableS: 0, conditions: [{ type: 'spiel', is: 'heute' }] } },
  { id: 'hitze', icon: '☀️', name: 'Bei Hitze', needs: 'wetter', hint: 'Zeigt zum Beispiel einen Hinweis „Bitte genug trinken“, wenn es heiß ist.', rule: { name: 'Bei Hitze', priority: 4, stableS: 600, conditions: [{ type: 'wetter', is: 'ueber', value: 28 }] } },
  { id: 'wochenende', icon: '📅', name: 'Am Wochenende', needs: null, hint: 'Zeigt samstags und sonntags ein eigenes Programm.', rule: { name: 'Wochenende', priority: 3, stableS: 0, conditions: [{ type: 'zeit', from: '', to: '', days: ['sa', 'so'] }] } },
];
const MAX_RULES = 30;

async function regelnPlugin(app, { db, audit, now = () => Date.now() }) {
  const engine = createRules({ db, apps: app.apps, audit, pushAll: () => app.pushAll?.(), now });
  app.decorate('rules', engine);
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });
  const body = { type: 'object', required: ['name', 'conditions', 'content', 'scope'], additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 }, enabled: { type: 'boolean' }, priority: { type: 'integer', minimum: 1, maximum: 9 }, conditions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object' } },
    content: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { enum: ['playlist', 'media'] }, id: { type: 'string', maxLength: 60 } } },
    scope: { enum: ['all', 'group', 'device'] }, targetId: { type: 'string', maxLength: 60 }, stableS: { type: 'integer', minimum: 0, maximum: 3600 } } };
  const idParam = { type: 'object', properties: { id: { type: 'string', maxLength: 60 } } };

  /** Eingabe prüfen → Datenbankwerte; wirft einen Klartext-Fehler (Status 400) */
  function clean(b) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 }), name = b.name.trim(); if (!name) throw bad('Bitte gib der Regel einen Namen.');
    let conditions; try { conditions = normalizeConditions(b.conditions); } catch (e) { throw bad(e.message); }
    if (b.content.type === 'playlist') { const p = db.prepare('SELECT state FROM playlists WHERE id=?').get(b.content.id); if (!p) throw bad('Diese Abspielliste gibt es nicht.'); if (p.state !== 'published') throw bad('Diese Abspielliste ist noch ein Entwurf. Bitte veröffentliche sie zuerst.'); }
    else if (!db.prepare('SELECT 1 FROM media WHERE id=?').get(b.content.id)) throw bad('Dieses Bild oder Video gibt es nicht.');
    const target = b.scope === 'all' ? null : b.targetId ?? null;
    if (b.scope === 'group' && !db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(target)) throw bad('Bitte wähle eine Gruppe aus.');
    if (b.scope === 'device' && !db.prepare("SELECT 1 FROM devices WHERE id=? AND status IN ('active','pending')").get(target)) throw bad('Bitte wähle einen Bildschirm aus.');
    return { name, conditions, content: b.content, scope: b.scope, target, priority: b.priority ?? 5, stableS: b.stableS ?? 0, enabled: b.enabled !== false };
  }
  const fail = (reply, e) => reply.code(e.status ?? 400).send({ error: e.message });
  // Konten mit Gruppen-Beschränkung: Regeln nur für die eigenen Gruppen und Bildschirme (nicht „alle“)
  const mayScope = (u, scope, target) => !u?.groups || u.role === 'admin' || (scope === 'group' ? u.groups.includes(target) : scope === 'device' ? u.groups.includes(db.prepare('SELECT group_id FROM devices WHERE id=?').get(target)?.group_id) : false);
  const deny = (reply) => reply.code(403).send({ error: 'Mit deinen Rechten darfst du Regeln nur für deine eigenen Gruppen und Bildschirme anlegen oder ändern.' });

  app.get('/api/v1/rules', { config: { perm: 'schedules.read' } }, async () => {
    const wet = app.apps.stateOf('wetter'), liv = app.apps.stateOf('livespiel');
    return { rules: engine.view(), templates: RULE_TEMPLATES, apps: { wetter: wet.enabled, livespiel: liv.enabled }, max: MAX_RULES,
      hint: 'Regeln wirken nur, solange Notfall-Meldung, Tor-Jubel und Hand-Aktionen nichts anderes zeigen. Fällt der Hub aus, enden sie nach spätestens 15 Minuten von selbst.' };
  });
  app.post('/api/v1/rules/preview', { config: { perm: 'schedules.read' }, schema: { body: { type: 'object', required: ['conditions'], additionalProperties: false, properties: { conditions: body.properties.conditions } } } }, async (req, reply) => {
    try { return engine.evalRule(normalizeConditions(req.body.conditions)); } catch (e) { return fail(reply, e); }
  });
  app.post('/api/v1/rules', { config: { perm: 'scenes.write' }, schema: { body } }, async (req, reply) => {
    if (db.prepare('SELECT COUNT(*) n FROM rules').get().n >= MAX_RULES) return reply.code(400).send({ error: `Es gibt schon ${MAX_RULES} Regeln. Lösche zuerst eine, die du nicht mehr brauchst.` });
    let v; try { v = clean(req.body); } catch (e) { return fail(reply, e); }
    if (!mayScope(req.user, v.scope, v.target)) return deny(reply);
    const id = randomUUID();
    db.prepare('INSERT INTO rules(id,name,enabled,priority,conditions_json,content_type,content_id,scope,target_id,stable_s,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, v.name, v.enabled ? 1 : 0, v.priority, JSON.stringify(v.conditions), v.content.type, v.content.id, v.scope, v.target, v.stableS, req.user.id, now());
    A(req, 'regel.angelegt', id, { name: v.name }); engine.tick(); app.variants?.ensureAll(); app.pushAll?.();
    return reply.code(201).send({ id, rule: engine.view().find((r) => r.id === id) });
  });
  app.put('/api/v1/rules/:id', { config: { perm: 'scenes.write' }, schema: { params: idParam, body } }, async (req, reply) => {
    const old = db.prepare('SELECT scope,target_id FROM rules WHERE id=?').get(req.params.id); if (!old) return reply.code(404).send({ error: 'Diese Regel gibt es nicht.' });
    let v; try { v = clean(req.body); } catch (e) { return fail(reply, e); }
    if (!mayScope(req.user, old.scope, old.target_id) || !mayScope(req.user, v.scope, v.target)) return deny(reply);
    engine.stop(req.params.id); // eine geänderte Regel startet frisch (und räumt ihre alte Anzeige weg)
    db.prepare('UPDATE rules SET name=?,enabled=?,priority=?,conditions_json=?,content_type=?,content_id=?,scope=?,target_id=?,stable_s=? WHERE id=?').run(v.name, v.enabled ? 1 : 0, v.priority, JSON.stringify(v.conditions), v.content.type, v.content.id, v.scope, v.target, v.stableS, req.params.id);
    A(req, 'regel.geaendert', req.params.id, { name: v.name, aktiv: v.enabled }); engine.tick(); app.variants?.ensureAll(); app.pushAll?.();
    return { ok: true, rule: engine.view().find((r) => r.id === req.params.id) };
  });
  app.delete('/api/v1/rules/:id', { config: { perm: 'scenes.write' }, schema: { params: idParam } }, async (req, reply) => {
    const r = db.prepare('SELECT name,scope,target_id FROM rules WHERE id=?').get(req.params.id); if (!r) return reply.code(404).send({ error: 'Diese Regel gibt es nicht.' });
    if (!mayScope(req.user, r.scope, r.target_id)) return deny(reply);
    engine.stop(req.params.id); db.prepare('DELETE FROM rule_state WHERE rule_id=?').run(req.params.id); db.prepare('DELETE FROM rules WHERE id=?').run(req.params.id);
    A(req, 'regel.geloescht', req.params.id, { name: r.name }); return { ok: true };
  });
  app.post('/api/v1/rules/:id/resume', { config: { perm: 'scenes.write' }, schema: { params: idParam } }, async (req, reply) => {
    const r = db.prepare('SELECT scope,target_id FROM rules WHERE id=?').get(req.params.id); if (!r) return reply.code(404).send({ error: 'Diese Regel gibt es nicht.' });
    if (!mayScope(req.user, r.scope, r.target_id)) return deny(reply);
    engine.resume(req.params.id); A(req, 'regel.fortgesetzt', req.params.id); return { ok: true, rule: engine.view().find((r) => r.id === req.params.id) };
  });

  // Takt: jede Minute auswerten (zusätzlich nach jedem Abruf der Wetter-/Live-App und bei jeder Änderung)
  const tick = () => { try { engine.tick(); } catch (e) { app.log?.warn?.({ err: e }, 'Regeln: Auswertung fehlgeschlagen'); } };
  const first = setTimeout(tick, 15000), timer = setInterval(tick, 60000); first.unref(); timer.unref();
  app.addHook('onClose', async () => { clearTimeout(first); clearInterval(timer); });
}
regelnPlugin[Symbol.for('skip-override')] = true;
export default regelnPlugin;
