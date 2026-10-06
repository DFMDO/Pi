// Erweiterungen (Phase 9): Live-Ansicht, Schnellaktionen/Szenen, Gesundheit & Wartung, Gerät austauschen, WLAN-Empfang, Geräteliste als CSV.
import { randomUUID } from 'node:crypto';
import { resolvePlaylist } from '../../shared/sequencer.js';
import { epochToLocal, localToEpoch, addDays } from '../../shared/time.js';
import { schedulePayload, DAY } from './plan.js';
import { sha256hex, randomToken } from './crypto.js';
import { deviceWarnings, signalQuality } from './health.js';
import { deviceStatus } from './devices.js';
import { can } from './permissions.js';

const hhmm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; };

async function extrasPlugin(app, { db, audit, now = () => Date.now() }) {
  const A = (req, action, target, detail, security = false) => audit.log({ user: req.user, action, target, ip: req.ip, detail, security });
  const dv = () => app.devices;
  const settings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
  /** Gruppenbeschränkung (A2): Konten können auf einzelne Bildschirmgruppen eingeschränkt sein; Admins sehen alles */
  const mayDevice = (user, d) => !user?.groups || user.role === 'admin' || (!!d.group_id && user.groups.includes(d.group_id));
  const activeDevices = (user) => db.prepare("SELECT * FROM devices WHERE status='active' ORDER BY name").all().filter((d) => mayDevice(user, d));
  const stOf = (d) => { try { return d.state_json ? JSON.parse(d.state_json) : null; } catch { return null; } };
  const nameOf = (type, id) => (type === 'playlist' ? db.prepare('SELECT name FROM playlists WHERE id=?').get(id)?.name : db.prepare('SELECT name FROM media WHERE id=?').get(id)?.name) ?? 'Inhalt';

  // ======================= Übersteuerung, Schnellaktionen, Szenen (Z.2) =======================
  const contentSchema = { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { enum: ['playlist', 'media'] }, id: { type: 'string', maxLength: 40 } } };
  const untilOf = (b, t) => {
    if (b.endOfDay) return localToEpoch(addDays(epochToLocal(t).date, 1), '00:00');
    return t + (b.minutes ?? 30) * 60000;
  };
  function contentOk(c) {
    if (c.type === 'playlist') { const p = db.prepare('SELECT state FROM playlists WHERE id=?').get(c.id); if (!p) return 'Diese Abspielliste gibt es nicht.'; if (p.state !== 'published') return 'Diese Abspielliste ist noch ein Entwurf. Bitte veröffentliche sie zuerst.'; }
    else if (!db.prepare('SELECT 1 FROM media WHERE id=?').get(c.id)) return 'Dieses Bild oder Video gibt es nicht.';
    return null;
  }
  const endOverrides = (scope, targetId, t) => db.prepare('UPDATE overrides SET ended_at=? WHERE ended_at IS NULL AND until>? AND scope=? AND COALESCE(target_id,\'\')=?').run(t, t, scope, targetId ?? '');
  function startOverride(req, { scope, targetId, content, until, label, sceneId }) {
    const t = now(), id = randomUUID();
    endOverrides(scope, targetId, t);
    db.prepare('INSERT INTO overrides VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(id, scope, scope === 'all' ? null : targetId, content.type, content.id, sceneId ?? null, label ?? null, req.user.id, req.user.name, t, until);
    return id;
  }
  const targetName = (o) => o.scope === 'all' ? 'alle Bildschirme' : o.scope === 'group' ? `Gruppe „${db.prepare('SELECT name FROM device_groups WHERE id=?').get(o.target_id)?.name ?? '?'}“` : `„${db.prepare('SELECT name FROM devices WHERE id=?').get(o.target_id)?.name ?? '?'}“`;
  const overrideView = (o) => ({ id: o.id, scope: o.scope, targetId: o.target_id, targetName: targetName(o), content: { type: o.content_type, id: o.content_id }, contentName: nameOf(o.content_type, o.content_id), sceneId: o.scene_id, label: o.label, by: o.created_by_name, createdAt: o.created_at, until: o.until,
    text: `${o.scene_id ? `Szene „${o.label}“` : 'Schnellaktion'} von ${o.created_by_name} auf ${targetName(o)}, bis ${hhmm(o.until)} Uhr` });
  const activeOverrides = () => db.prepare('SELECT * FROM overrides WHERE ended_at IS NULL AND until>? ORDER BY created_at DESC').all(now());

  app.get('/api/v1/overrides', { config: { perm: 'live.read' } }, async (req) => activeOverrides().filter((o) => o.scope === 'all' || !req.user.groups || req.user.role === 'admin'
    || (o.scope === 'device' ? mayDevice(req.user, db.prepare('SELECT * FROM devices WHERE id=?').get(o.target_id) ?? {}) : req.user.groups.includes(o.target_id))).map(overrideView));
  app.post('/api/v1/overrides', { config: { perm: 'overrides.write' }, schema: { body: { type: 'object', required: ['scope', 'content'], additionalProperties: false, properties: {
    scope: { enum: ['all', 'device', 'group'] }, targetId: { type: 'string', maxLength: 40 }, content: contentSchema, minutes: { type: 'integer', minimum: 5, maximum: 1440 }, endOfDay: { type: 'boolean' }, confirm: { type: 'boolean' } } } } }, async (req, reply) => {
    const b = req.body, bad = contentOk(b.content); if (bad) return reply.code(400).send({ error: bad });
    if (b.scope !== 'all') { const ok = b.scope === 'device' ? db.prepare('SELECT * FROM devices WHERE id=?').get(b.targetId) : db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(b.targetId); if (!ok) return reply.code(400).send({ error: 'Diesen Bildschirm oder diese Gruppe gibt es nicht.' });
      if (b.scope === 'device' && !mayDevice(req.user, ok)) return reply.code(403).send({ error: 'Diesen Bildschirm darfst du nicht steuern.' }); }
    if (b.scope === 'all' && !b.confirm) return reply.code(409).send({ error: `Das ändert JETZT alle Bildschirme auf „${nameOf(b.content.type, b.content.id)}“ und überschreibt alle Termine. Bitte bestätige.`, needsConfirm: true });
    const until = untilOf(b, now()), id = startOverride(req, { ...b, until, label: null });
    A(req, 'uebersteuerung.gestartet', id, { ziel: b.scope === 'all' ? 'alle' : b.targetId, inhalt: nameOf(b.content.type, b.content.id), bis: new Date(until).toISOString() }, false);
    app.pushAll(); return reply.code(201).send({ id, until, text: `Zeigt bis ${hhmm(until)} Uhr „${nameOf(b.content.type, b.content.id)}“. Danach läuft der normale Plan weiter.` });
  });
  app.delete('/api/v1/overrides/:id', { config: { perm: 'overrides.write' } }, async (req, reply) => {
    const r = db.prepare('UPDATE overrides SET ended_at=? WHERE id=? AND ended_at IS NULL').run(now(), req.params.id); if (!r.changes) return reply.code(404).send({ error: 'Diese Übersteuerung läuft nicht mehr.' });
    A(req, 'uebersteuerung.beendet', req.params.id); app.pushAll(); return { ok: true, text: 'Zurück zum normalen Plan.' };
  });
  app.post('/api/v1/overrides/end-all', { config: { perm: 'overrides.write' } }, async (req) => {
    const n = db.prepare('UPDATE overrides SET ended_at=? WHERE ended_at IS NULL AND until>?').run(now(), now()).changes; A(req, 'uebersteuerung.alle_beendet', null, { anzahl: n }); app.pushAll(); return { ok: true, ended: n };
  });

  // Szenen: mehrere Bildschirme/Gruppen → Inhalt; Start/Stopp mit einem Klick. Szenen haben Entwurf/Veröffentlicht wie Termine.
  const sceneItem = { type: 'object', required: ['scope', 'content'], additionalProperties: false, properties: { scope: { enum: ['all', 'device', 'group'] }, targetId: { type: 'string', maxLength: 40 }, content: contentSchema } };
  const sceneView = (s) => ({ id: s.id, name: s.name, state: s.state, note: s.note, items: JSON.parse(s.items_json).map((i) => ({ ...i, targetName: i.scope === 'all' ? 'Alle Bildschirme' : targetName({ scope: i.scope, target_id: i.targetId }), contentName: nameOf(i.content.type, i.content.id) })),
    active: !!db.prepare('SELECT 1 FROM overrides WHERE scene_id=? AND ended_at IS NULL AND until>?').get(s.id, now()) });
  const mayPublishScene = (req) => can(req.user.role, 'schedules.publish') && (req.user.role === 'admin' || settings()['publish.editor'] !== 'false');
  app.get('/api/v1/scenes', { config: { perm: 'live.read' } }, async (req) => (req.user.role === 'anzeige' ? [] : db.prepare('SELECT * FROM scenes ORDER BY name').all().map(sceneView)));
  const sceneBody = { type: 'object', required: ['name', 'items'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, note: { type: 'string', maxLength: 300 }, publish: { type: 'boolean' }, items: { type: 'array', minItems: 1, maxItems: 100, items: sceneItem } } };
  function checkScene(b) { for (const i of b.items) { if (i.scope !== 'all' && !i.targetId) return 'Jede Zeile braucht einen Bildschirm oder eine Gruppe.'; const bad = i.scope === 'all' ? null : (db.prepare(`SELECT 1 FROM ${i.scope === 'device' ? 'devices' : 'device_groups'} WHERE id=?`).get(i.targetId) ? null : 'Ein Bildschirm oder eine Gruppe der Szene gibt es nicht mehr.'); if (bad) return bad; } return null; }
  app.post('/api/v1/scenes', { config: { perm: 'scenes.write' }, schema: { body: sceneBody } }, async (req, reply) => {
    const bad = checkScene(req.body); if (bad) return reply.code(400).send({ error: bad }); if (req.body.publish && !mayPublishScene(req)) return reply.code(403).send({ error: 'Du darfst Szenen anlegen, aber nicht veröffentlichen.' });
    const id = randomUUID(); db.prepare('INSERT INTO scenes VALUES(?,?,?,?,?,?,?)').run(id, req.body.name, JSON.stringify(req.body.items), req.body.publish ? 'published' : 'draft', req.body.note ?? null, req.user.id, now()); A(req, 'szene.angelegt', req.body.name); return reply.code(201).send({ id });
  });
  app.put('/api/v1/scenes/:id', { config: { perm: 'scenes.write' }, schema: { body: sceneBody } }, async (req, reply) => {
    const s = db.prepare('SELECT * FROM scenes WHERE id=?').get(req.params.id); if (!s) return reply.code(404).send({ error: 'Szene nicht gefunden.' });
    const bad = checkScene(req.body); if (bad) return reply.code(400).send({ error: bad }); if (req.body.publish && !mayPublishScene(req)) return reply.code(403).send({ error: 'Du darfst Szenen anlegen, aber nicht veröffentlichen.' });
    db.prepare('UPDATE scenes SET name=?, items_json=?, note=?, state=? WHERE id=?').run(req.body.name, JSON.stringify(req.body.items), req.body.note ?? null, req.body.publish ? 'published' : (s.state === 'published' ? 'published' : 'draft'), s.id); A(req, 'szene.geaendert', req.body.name); return { ok: true };
  });
  app.post('/api/v1/scenes/:id/publish', { config: { perm: 'scenes.write' } }, async (req, reply) => {
    if (!mayPublishScene(req)) return reply.code(403).send({ error: 'Du darfst Szenen nicht veröffentlichen.' });
    const r = db.prepare("UPDATE scenes SET state='published' WHERE id=?").run(req.params.id); if (!r.changes) return reply.code(404).send({ error: 'Szene nicht gefunden.' }); A(req, 'szene.veroeffentlicht', req.params.id); return { ok: true };
  });
  app.delete('/api/v1/scenes/:id', { config: { perm: 'scenes.write' } }, async (req, reply) => {
    db.prepare('UPDATE overrides SET ended_at=? WHERE scene_id=? AND ended_at IS NULL').run(now(), req.params.id);
    const r = db.prepare('DELETE FROM scenes WHERE id=?').run(req.params.id); if (!r.changes) return reply.code(404).send({ error: 'Szene nicht gefunden.' }); A(req, 'szene.geloescht', req.params.id); app.pushAll(); return { ok: true };
  });
  app.post('/api/v1/scenes/:id/start', { config: { perm: 'overrides.write' }, schema: { body: { type: 'object', additionalProperties: false, properties: { minutes: { type: 'integer', minimum: 5, maximum: 1440 }, endOfDay: { type: 'boolean' }, confirm: { type: 'boolean' } } } } }, async (req, reply) => {
    const s = db.prepare('SELECT * FROM scenes WHERE id=?').get(req.params.id); if (!s) return reply.code(404).send({ error: 'Szene nicht gefunden.' }); if (s.state !== 'published') return reply.code(400).send({ error: 'Diese Szene ist noch ein Entwurf. Bitte veröffentliche sie zuerst.' });
    const items = JSON.parse(s.items_json); for (const i of items) { const bad = contentOk(i.content); if (bad) return reply.code(400).send({ error: `In der Szene „${s.name}“: ${bad}` }); }
    if (!req.body?.confirm) return reply.code(409).send({ error: `Die Szene „${s.name}“ übernimmt jetzt ${items.length} Bildschirm(e)/Gruppe(n). Bitte bestätige.`, needsConfirm: true });
    const until = untilOf(req.body ?? {}, now()); db.prepare('UPDATE overrides SET ended_at=? WHERE scene_id=? AND ended_at IS NULL').run(now(), s.id);
    for (const i of items) startOverride(req, { scope: i.scope, targetId: i.targetId, content: i.content, until, label: s.name, sceneId: s.id });
    A(req, 'szene.gestartet', s.name, { bis: new Date(until).toISOString() }); app.pushAll(); return { ok: true, until, text: `Szene „${s.name}“ läuft bis ${hhmm(until)} Uhr.` };
  });
  app.post('/api/v1/scenes/:id/stop', { config: { perm: 'overrides.write' } }, async (req) => {
    const n = db.prepare('UPDATE overrides SET ended_at=? WHERE scene_id=? AND ended_at IS NULL').run(now(), req.params.id).changes; A(req, 'szene.beendet', req.params.id); app.pushAll(); return { ok: true, ended: n };
  });

  // ======================= Live-Ansicht (Z.1) =======================
  /** Herkunft des gerade Laufenden in Klartext */
  function origin(plan, r) {
    if (r.source === 'uebersteuerung') { const o = r.override; return o.label ? `Szene „${o.label}“ von ${o.by}, bis ${hhmm(o.until)} Uhr` : o.scope === 'all' ? `Schnellaktion für alle Bildschirme von ${o.by}, bis ${hhmm(o.until)} Uhr` : `Schnellaktion von ${o.by}, bis ${hhmm(o.until)} Uhr`; }
    if (r.source === 'termin') return `Termin „${plan.playlists?.[r.playlistId]?.name ?? 'Inhalt'}“`;
    if (r.source === 'sondertag') return `Sondertag „${r.specialDay?.name ?? ''}“`;
    if (r.source === 'schliesstag') return `Schließtag „${r.specialDay?.name ?? ''}“ – Bildschirm aus`;
    if (r.source === 'wartung') return 'Wartungsmodus';
    if (r.source === 'nicht_bereit') return 'Noch nicht geprüft (nur Standby-Bild)';
    return r.source === 'standard' ? 'Standard-Abspielliste' : 'Nichts geplant';
  }
  function liveRow(d, t, detail) {
    const st = stOf(d) ?? {}, status = deviceStatus(d, t), plan = schedulePayload(db, d, t), r = resolvePlaylist(plan, t), pl = r.playlistId ? plan.playlists?.[r.playlistId] : null, ist = st.playerStatus ?? null;
    const g = d.group_id ? db.prepare('SELECT name FROM device_groups WHERE id=?').get(d.group_id) : null;
    const mediaName = (id) => db.prepare('SELECT name FROM media WHERE id=?').get(id)?.name ?? '';
    const soll = { playlist: pl?.name ?? null, source: r.source, origin: origin(plan, r), scheduleId: r.scheduleId, mediaIds: pl?.items?.map((i) => i.mediaId) ?? [], override: r.override ? { id: r.override.id, until: r.override.until, by: r.override.by, label: r.override.label, scope: r.override.scope } : null };
    const online = status.level === 'ok', held = ['wartung', 'nicht_bereit', 'schliesstag'].includes(r.source);
    const mismatch = online && !held && !!ist?.current && soll.mediaIds.length > 0 && !soll.mediaIds.includes(ist.current.mediaId);
    const nextSeg = plan.segments.find((s) => s.start > t && s.source); const warns = deviceWarnings(d, st, t, { warnDbm: Number(settings()['wifi.warnDbm'] ?? -72) });
    if (!online && d.last_seen && !d.maintenance_since) warns.unshift({ kind: 'offline', level: 'bad', text: `Offline seit ${Math.max(1, Math.round((t - d.last_seen) / 60000))} Minuten, zeigt den zwischengespeicherten Inhalt.` });
    const cur = ist?.current, endsIn = cur?.since && cur?.duration ? Math.max(0, Math.round((cur.since + cur.duration * 1000 - t) / 1000)) : null;
    const row = { id: d.id, name: d.name, location: [d.floor, d.location].filter(Boolean).join(' · ') || null, groupId: d.group_id, groupName: g?.name ?? null, profile: d.profile, status, lastSeen: d.last_seen, soll, ist, endsInS: endsIn,
      next: nextSeg ? { at: nextSeg.start, atText: hhmm(nextSeg.start), name: plan.playlists?.[nextSeg.source.content.id]?.name ?? 'Inhalt' } : null, mismatch,
      mismatchText: mismatch ? `Laut Plan sollte jetzt „${soll.playlist ?? '?'}“ laufen, der Bildschirm zeigt aber „${cur.name || 'etwas anderes'}“.` : null, maintenance: !!d.maintenance_since, ready: d.ready !== 0, warnings: warns,
      displayOff: st.displayPower === 'off' || r.off === true, shotAt: dv().shots.get(d.id)?.ts ?? null, stale: dv().shots.get(d.id) ? t - dv().shots.get(d.id).ts > 120000 : false, simplified: dv().reduced(d, st), signal: signalQuality(st.signalDbm) };
    if (detail) { // nächste 5 Elemente der laufenden Abspielliste
      const items = pl?.items ?? []; const i0 = Math.max(0, items.findIndex((i) => i.mediaId === cur?.mediaId));
      row.upcoming = items.length ? Array.from({ length: Math.min(5, items.length) }, (_, k) => { const it = items[(i0 + 1 + k) % items.length]; return { mediaId: it.mediaId, name: mediaName(it.mediaId), duration: it.duration }; }) : [];
      row.overrides = activeOverrides().filter((o) => o.scope === 'all' || (o.scope === 'device' && o.target_id === d.id) || (o.scope === 'group' && o.target_id === d.group_id)).map(overrideView);
    }
    return row;
  }
  app.get('/api/v1/live', { config: { perm: 'live.read' } }, async (req) => { dv().viewers.tile = now(); return activeDevices(req.user).map((d) => liveRow(d, now())); });
  app.get('/api/v1/live/:id', { config: { perm: 'live.read' } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d || d.status !== 'active' || !mayDevice(req.user, d)) return reply.code(404).send({ error: 'Diesen Bildschirm gibt es nicht oder du darfst ihn nicht sehen.' });
    dv().viewers.detail.set(d.id, now()); return liveRow(d, now(), true);
  });
  app.get('/api/v1/live/:id/media', { config: { perm: 'live.read' } }, async (req, reply) => { // Vorschau-Info (Stufe 1)
    const d = dv().getDevice(req.params.id); if (!d || !mayDevice(req.user, d)) return reply.code(404).send({ error: 'Nicht gefunden.' });
    return { ok: true };
  });
  // Wandmodus: eigenes Lese-Token (nur Live-Ansicht, kein Ablauf)
  app.get('/api/v1/live-tokens', { config: { perm: 'users.manage' } }, async () => db.prepare('SELECT id,name,created_at AS createdAt,last_used AS lastUsed FROM read_tokens ORDER BY created_at').all());
  app.post('/api/v1/live-tokens', { config: { perm: 'users.manage' }, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 60 } } } } }, async (req, reply) => {
    const token = randomToken(32), id = randomUUID(); db.prepare('INSERT INTO read_tokens VALUES(?,?,?,?,?,NULL)').run(id, req.body.name, sha256hex(token), req.user.id, now());
    A(req, 'wandmodus.token_erzeugt', req.body.name, null, true); return reply.code(201).send({ id, token, text: 'Dieses Zugangs-Token wird nur jetzt angezeigt. Es erlaubt ausschließlich die Live-Ansicht.' });
  });
  app.delete('/api/v1/live-tokens/:id', { config: { perm: 'users.manage' } }, async (req, reply) => {
    if (!db.prepare('DELETE FROM read_tokens WHERE id=?').run(req.params.id).changes) return reply.code(404).send({ error: 'Token nicht gefunden.' }); A(req, 'wandmodus.token_widerrufen', req.params.id, null, true); return { ok: true };
  });
  app.post('/api/v1/live/wall-login', { config: { public: true }, schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 100 } } } } }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM read_tokens WHERE token_hash=?').get(sha256hex(req.body.token));
    if (!t) { audit.log({ action: 'wandmodus.token_falsch', ip: req.ip, security: true }); return reply.code(401).send({ error: 'Dieses Zugangs-Token stimmt nicht.' }); }
    db.prepare('UPDATE read_tokens SET last_used=? WHERE id=?').run(now(), t.id);
    reply.header('Set-Cookie', `__Host-dfm_wall=${req.body.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`); return { ok: true, name: t.name };
  });

  // ======================= Gerätedaten, Gesundheit, Wartung (Z.3) =======================
  const profileSchema = { type: 'object', additionalProperties: false, properties: { location: { type: ['string', 'null'], maxLength: 100 }, floor: { type: ['string', 'null'], maxLength: 40 }, serial: { type: ['string', 'null'], maxLength: 40 }, mac: { type: ['string', 'null'], maxLength: 20 },
    installedAt: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, notes: { type: ['string', 'null'], maxLength: 2000 }, docUrl: { type: ['string', 'null'], maxLength: 300, pattern: '^https?://' } } };
  app.put('/api/v1/devices/:id/profile', { config: { perm: 'devices.manage' }, schema: { body: profileSchema } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' }); const b = req.body;
    db.prepare('UPDATE devices SET location=COALESCE(?,location), floor=COALESCE(?,floor), serial=COALESCE(?,serial), mac=COALESCE(?,mac), installed_at=COALESCE(?,installed_at), notes=COALESCE(?,notes), doc_url=COALESCE(?,doc_url) WHERE id=?')
      .run(b.location ?? null, b.floor ?? null, b.serial ?? null, b.mac ?? null, b.installedAt ?? null, b.notes ?? null, b.docUrl ?? null, d.id); A(req, 'bildschirm.profil_geaendert', d.id); return { ok: true };
  });
  app.get('/api/v1/devices/:id/profile', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const hw = d.hw_json ? JSON.parse(d.hw_json) : {};
    return { id: d.id, name: d.name, location: d.location, floor: d.floor, serial: d.serial ?? hw.serial ?? null, mac: d.mac ?? hw.mac ?? null, installedAt: d.installed_at ?? new Date(d.created_at).toISOString().slice(0, 10), notes: d.notes, docUrl: d.doc_url, model: d.model, version: stOf(d)?.version ?? null,
      maintenance: d.maintenance_since, ready: d.ready !== 0, layout: d.layout_json ? JSON.parse(d.layout_json) : null };
  });
  app.post('/api/v1/devices/:id/maintenance', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['on'], additionalProperties: false, properties: { on: { type: 'boolean' } } } } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    db.prepare('UPDATE devices SET maintenance_since=? WHERE id=?').run(req.body.on ? now() : null, d.id); A(req, req.body.on ? 'wartungsmodus.an' : 'wartungsmodus.aus', d.id); dv().pushPlan(dv().getDevice(d.id));
    return { ok: true, text: req.body.on ? 'Wartungsmodus an: der Bildschirm zeigt ein neutrales Bild, Warnungen sind stumm.' : 'Wartungsmodus aus.' };
  });
  app.get('/api/v1/health', { config: { perm: 'devices.read' } }, async (req) => activeDevices(req.user).map((d) => {
    const st = stOf(d), status = deviceStatus(d, now()), w = deviceWarnings(d, st, now(), { warnDbm: Number(settings()['wifi.warnDbm'] ?? -72) });
    return { id: d.id, name: d.name, status, warnings: w, level: w.some((x) => x.level === 'bad') || status.level === 'bad' ? 'bad' : w.length || status.level === 'warn' ? 'warn' : 'ok', maintenance: !!d.maintenance_since,
      metrics: st && { tempC: st.cpuTemp, ramFreeMB: st.ramTotalMB ? st.ramTotalMB - st.ramUsedMB : null, diskFreeMB: st.diskFreeMB ?? null, signalDbm: st.signalDbm ?? null, throttled: st.throttled ?? null, uptimeS: st.uptimeS, sdErrors: st.sdErrors ?? 0, version: st.version } };
  }));
  // Verfügbarkeitsverlauf: Ereignisse „offline/online“ je Gerät, Wartungszeiten zählen nicht als Ausfall
  const availability = (d, days, t = now()) => {
    const from = Math.max(t - days * DAY, d.created_at ?? 0), ev = db.prepare("SELECT ts,kind,detail FROM device_events WHERE device_id=? AND kind IN ('offline','online') AND ts>=? ORDER BY ts").all(d.id, from - 30 * DAY);
    let off = null; const outages = [];
    for (const e of ev) { if (e.kind === 'offline') { if (off == null) off = e; } else if (off != null) { if (off.detail !== 'wartung') outages.push({ from: Math.max(off.ts, from), to: e.ts }); off = null; } }
    if (off != null && off.detail !== 'wartung') outages.push({ from: Math.max(off.ts, from), to: t, ongoing: true });
    const down = outages.filter((o) => o.to > from).reduce((a, o) => a + (o.to - o.from), 0), total = Math.max(1, t - from);
    return { days, from, to: t, uptimePercent: Math.round((1 - down / total) * 1000) / 10, outages: outages.filter((o) => o.to > from).map((o) => ({ ...o, durationS: Math.round((o.to - o.from) / 1000) })).reverse(),
      reboots: db.prepare("SELECT COUNT(*) n FROM device_events WHERE device_id=? AND kind='reboot' AND ts>=?").get(d.id, from).n };
  };
  app.get('/api/v1/devices/:id/availability', { config: { perm: 'devices.read' }, schema: { querystring: { type: 'object', properties: { days: { enum: ['30', '90', '7'] } } } } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' }); return availability(d, Number(req.query.days ?? 30));
  });
  app.get('/api/v1/report/weekly', { config: { perm: 'devices.read' } }, async (req) => {
    const t = now(), ds = activeDevices(req.user), site = settings()['site.name'] ?? '';
    return { generatedAt: t, from: t - 7 * DAY, to: t, site, devices: ds.map((d) => { const a = availability(d, 7), st = stOf(d), w = deviceWarnings(d, st, t); return { id: d.id, name: d.name, uptimePercent: a.uptimePercent, outages: a.outages.length, longestOutageS: Math.max(0, ...a.outages.map((o) => o.durationS)), reboots: a.reboots,
      warnings: w.map((x) => x.text), diskFreeMB: st?.diskFreeMB ?? null }; }),
      storage: db.prepare('SELECT COALESCE(SUM(size),0) s FROM media').get().s };
  });
  // Ereignis-Wächter: Ausfälle/Neustarts erfassen, WLAN-Verlauf alle 5 Minuten, Datenpflege (Z.11)
  const lastLevel = new Map(), lastUp = new Map(), lastWifi = new Map();
  function eventTick() {
    const t = now();
    for (const d of db.prepare("SELECT * FROM devices WHERE status='active'").all()) {
      const st = stOf(d), online = deviceStatus(d, t).level === 'ok', prev = lastLevel.get(d.id) ?? (d.last_seen && online ? 'online' : (db.prepare("SELECT kind FROM device_events WHERE device_id=? AND kind IN ('online','offline') ORDER BY ts DESC LIMIT 1").get(d.id)?.kind ?? 'online'));
      const cur = online ? 'online' : 'offline';
      if (cur !== prev) db.prepare('INSERT INTO device_events(device_id,ts,kind,detail) VALUES(?,?,?,?)').run(d.id, t, cur, d.maintenance_since ? 'wartung' : null);
      lastLevel.set(d.id, cur);
      if (st?.uptimeS != null) { const u = lastUp.get(d.id); if (u != null && st.uptimeS + 5 < u) db.prepare('INSERT INTO device_events(device_id,ts,kind,detail) VALUES(?,?,?,?)').run(d.id, t, 'reboot', null); lastUp.set(d.id, st.uptimeS); }
      if (online && st && t - (lastWifi.get(d.id) ?? 0) >= 300000) {
        lastWifi.set(d.id, t); const w = st.wifi ?? {}, last = db.prepare('SELECT bssid FROM wifi_history WHERE device_id=? ORDER BY ts DESC LIMIT 1').get(d.id);
        if (st.signalDbm != null || w.bssid) { db.prepare('INSERT INTO wifi_history(device_id,ts,signal_dbm,quality,bssid,ssid,channel,band,reconnects,throughput_kbps) VALUES(?,?,?,?,?,?,?,?,?,?)').run(d.id, t, st.signalDbm ?? null, signalQuality(st.signalDbm).level, w.bssid ?? null, w.ssid ?? null, w.channel ?? null, w.band ?? null, st.reconnects ?? 0, null);
          if (last?.bssid && w.bssid && last.bssid !== w.bssid) db.prepare('INSERT INTO device_events(device_id,ts,kind,detail) VALUES(?,?,?,?)').run(d.id, t, 'ap_wechsel', `${last.bssid} → ${w.bssid}`); }
      }
    }
  }
  app.decorate('extras', { eventTick, availability });
  const evTimer = setInterval(() => { try { eventTick(); } catch {} }, 15000); evTimer.unref(); app.addHook('onClose', async () => clearInterval(evTimer));

  // ======================= WLAN-Signal und Empfangsübersicht (Z.15) =======================
  const watchUntil = new Map();
  app.post('/api/v1/devices/:id/signal-watch', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d || d.status !== 'active') return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    watchUntil.set(d.id, now() + 15 * 60000); dv().sendTo(d.id, 'command', { id: 'sig-' + randomUUID(), command: 'signal_watch', args: { seconds: 900 } });
    return { ok: true, expiresAt: now() + 15 * 60000, text: 'Der Aufstellmodus läuft 15 Minuten. Das Signal wird alle 2 Sekunden angezeigt.' };
  });
  app.get('/api/v1/devices/:id/signal', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const s = dv().signals.get(d.id), until = watchUntil.get(d.id) ?? 0, st = stOf(d), dbm = s && now() - s.ts < 6000 ? s.dbm : st?.signalDbm ?? null, q = signalQuality(dbm);
    return { active: until > now(), expiresAt: until, dbm, ...q, ageS: s ? Math.round((now() - s.ts) / 1000) : null, text: `${q.label}${q.level === 'schwach' || q.level === 'zu_schwach' ? ' – bitte den Bildschirm näher an den Access Point stellen' : ''}`, wifi: s?.wifi ?? st?.wifi ?? null };
  });
  app.get('/api/v1/reception', { config: { perm: 'devices.read' }, schema: { querystring: { type: 'object', properties: { range: { enum: ['24h', '7d'] } } } } }, async (req) => {
    const t = now(), range = req.query.range === '7d' ? 7 * DAY : DAY, bucket = range === DAY ? 3600000 : 6 * 3600000, warnDbm = Number(settings()['wifi.warnDbm'] ?? -72), out = [];
    for (const d of activeDevices(req.user)) {
      const rows = db.prepare('SELECT * FROM wifi_history WHERE device_id=? AND ts>=? ORDER BY ts').all(d.id, t - range), st = stOf(d), cur = rows[rows.length - 1];
      const series = []; for (let b = t - range; b < t; b += bucket) { const r = rows.filter((x) => x.ts >= b && x.ts < b + bucket && x.signal_dbm != null); series.push({ ts: b, dbm: r.length ? Math.round(r.reduce((a, x) => a + x.signal_dbm, 0) / r.length) : null }); }
      const apChanges = db.prepare("SELECT ts,detail FROM device_events WHERE device_id=? AND kind='ap_wechsel' AND ts>=? ORDER BY ts").all(d.id, t - range);
      const today = db.prepare("SELECT COUNT(*) n FROM device_events WHERE device_id=? AND kind='offline' AND ts>=?").get(d.id, localToEpoch(epochToLocal(t).date, '00:00')).n;
      const dbm = st?.signalDbm ?? cur?.signal_dbm ?? null; let weakSince = null; for (let i = rows.length - 1; i >= 0 && rows[i].signal_dbm != null && rows[i].signal_dbm < warnDbm; i--) weakSince = rows[i].ts;
      const reconnects = rows.length ? (rows[rows.length - 1].reconnects ?? 0) - (rows[0].reconnects ?? 0) : 0;
      const q = signalQuality(dbm), w = st?.wifi ?? {}; const place = [d.floor, d.location].filter(Boolean).join(' ');
      const warn = q.level === 'zu_schwach' || q.level === 'schwach' ? `${d.name}${place ? ` (${place})` : ''}: Empfang ${q.label.toLowerCase()}${weakSince ? ` seit ${weakSince < t - DAY ? Math.round((t - weakSince) / DAY) + ' Tagen' : Math.max(1, Math.round((t - weakSince) / 3600000)) + ' Std.'}` : ''}${today ? `, ${today} Aussetzer heute` : ''}.` : null;
      out.push({ id: d.id, name: d.name, location: place || null, signalDbm: dbm, quality: q, series, apChanges, reconnects, dropoutsToday: today, bssid: w.bssid ?? cur?.bssid ?? null, ssid: w.ssid ?? cur?.ssid ?? null, channel: w.channel ?? cur?.channel ?? null, band: w.band ?? cur?.band ?? null,
        throughputKbps: db.prepare('SELECT throughput_kbps t FROM wifi_history WHERE device_id=? AND throughput_kbps IS NOT NULL ORDER BY ts DESC LIMIT 1').get(d.id)?.t ?? null, warning: warn, online: deviceStatus(d, t).level === 'ok' });
    }
    out.sort((a, b) => (a.signalDbm ?? 0) - (b.signalDbm ?? 0) || a.name.localeCompare(b.name, 'de')); // schlechtester Empfang zuerst
    const crowded = (() => { const ch = out.filter((x) => x.band === '2,4 GHz' && x.channel).map((x) => x.channel); return ch.length >= 2 && new Set(ch).size < ch.length ? 'Mehrere Bildschirme nutzen denselben 2,4-GHz-Kanal. Wenn der Empfang schwankt, hilft oft ein Wechsel auf 5 GHz.' : null; })();
    return { range: req.query.range ?? '24h', devices: out, hint: crowded, explain: 'Das ist eine Übersicht aus den Meldungen der Bildschirme, keine Funkmessung.' };
  });

  // ======================= Gerät austauschen (Z.4), Einstellungen kopieren, CSV (A6) =======================
  app.post('/api/v1/devices/:id/copy-settings', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 40 } } } } } }, async (req, reply) => {
    const s = dv().getDevice(req.params.id); if (!s) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' }); let n = 0;
    for (const id of req.body.to) { if (id === s.id || !dv().getDevice(id)) continue; db.prepare('UPDATE devices SET orientation=?, display_json=?, layout_json=? WHERE id=?').run(s.orientation, s.display_json, s.layout_json, id); dv().sendTo(id, 'command', { id: 'cp-' + randomUUID(), command: 'rotate', args: { degrees: s.orientation } }); dv().pushPlan(dv().getDevice(id)); n++; }
    A(req, 'bildschirm.einstellungen_kopiert', s.id, { anzahl: n }); return { ok: true, copied: n };
  });
  app.get('/api/v1/devices.csv', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const rows = [['Name', 'Modell', 'Seriennummer', 'MAC', 'Standort', 'Etage', 'Gruppe', 'Einbaudatum', 'Version', 'Status']];
    for (const d of activeDevices(req.user)) { const hw = d.hw_json ? JSON.parse(d.hw_json) : {}, st = stOf(d), g = d.group_id ? db.prepare('SELECT name FROM device_groups WHERE id=?').get(d.group_id)?.name : '';
      rows.push([d.name, d.model ?? '', d.serial ?? hw.serial ?? '', d.mac ?? hw.mac ?? '', d.location ?? '', d.floor ?? '', g ?? '', d.installed_at ?? new Date(d.created_at).toISOString().slice(0, 10), st?.version ?? '', deviceStatus(d, now()).label]); }
    audit.log({ user: req.user, action: 'geraeteliste.exportiert', ip: req.ip });
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="bildschirme.csv"').send('﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n'); // Semikolon + BOM: öffnet in Excel direkt
  });
}

extrasPlugin[Symbol.for('skip-override')] = true;
export default extrasPlugin;
