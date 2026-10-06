// Medien, Abspiellisten, Termine, Papierkorb, Audit-Abfragen, Einstellungen.
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, unlinkSync, openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectKind, LIMITS, probeVideo, mediaHints, SHARP_OPTS } from './variants.js';
import { sendFile } from './devices.js';
import { sha256hex } from './crypto.js';
import { loadSchedules, rowToSchedule, warnings, DAY } from './plan.js';
import { expand, buildTimeline, currentSegment } from '../../shared/schedule.js';
import { localToEpoch } from '../../shared/time.js';

const pexec = promisify(execFile);
const LOCAL_DT = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$', DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const TRASH_DAYS = 30;

async function contentPlugin(app, { db, audit, mediaDir, variants, now = () => Date.now() }) {
  await app.register(multipart, { limits: { fileSize: LIMITS.video, files: 1, fields: 5, parts: 8 } });
  mkdirSync(join(mediaDir, 'original'), { recursive: true }); mkdirSync(join(mediaDir, 'incoming'), { recursive: true });
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });
  const toTrash = (req, kind, ref, payload) => db.prepare('INSERT INTO trash VALUES(?,?,?,?,?,?)').run(randomUUID(), kind, ref, JSON.stringify(payload), now(), req.user.id);

  // ---------- Medien ----------
  const present = (m) => ({ id: m.id, name: m.name, kind: m.kind, size: m.size, durationS: m.duration_s, width: m.width, height: m.height,
    tags: m.tags ? m.tags.split(',') : [], folder: m.folder, createdAt: m.created_at, text: m.text_json ? JSON.parse(m.text_json) : undefined,
    variants: db.prepare('SELECT profile,status,error FROM media_variants WHERE media_id=?').all(m.id),
    hints: mediaHints(m.kind, m.width, m.height) });

  app.get('/api/v1/media', { config: { perm: 'media.read' } }, async () => db.prepare('SELECT * FROM media ORDER BY created_at DESC').all().map(present));

  app.post('/api/v1/media', { config: { perm: 'media.write' } }, async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'Bitte wähle eine Datei aus.' });
    const tmp = join(mediaDir, 'incoming', randomUUID());
    try {
      await pipeline(part.file, createWriteStream(tmp));
      if (part.file.truncated) throw Object.assign(new Error('too big'), { friendly: 'Die Datei ist zu groß.' });
      const fd = openSync(tmp, 'r'); const head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0); closeSync(fd);
      const kind = detectKind(head);
      if (!kind) throw Object.assign(new Error('type'), { friendly: 'Dieses Dateiformat wird nicht unterstützt. Erlaubt sind Bilder (JPG, PNG, WebP), Videos (MP4, MOV, MKV) und PDF.' });
      const size = statSync(tmp).size;
      if (size > LIMITS[kind]) throw Object.assign(new Error('size'), { friendly: `Die Datei ist zu groß (maximal ${Math.round(LIMITS[kind] / 1048576)} MB für diesen Typ).` });
      const folder = String(part.fields?.folder?.value ?? '').slice(0, 60), name = String(part.filename ?? 'Datei').replace(/[\x00-\x1f/\\]/g, '').slice(0, 100) || 'Datei';
      const ids = [];
      const addMedia = (k, path, nm, w, h, dur) => {
        const id = randomUUID();
        db.prepare('INSERT INTO media(id,name,kind,original_path,size,duration_s,width,height,folder,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, nm, k, path, statSync(join(mediaDir, 'original', path)).size, dur ?? null, w ?? null, h ?? null, folder, req.user.id, now()); ids.push(id); return id;
      };
      if (kind === 'image') {
        let meta; try { meta = await sharp(tmp, SHARP_OPTS).metadata(); if (meta.width * meta.height > 80_000_000) throw new Error('zu groß'); } catch (e) { throw Object.assign(new Error('img'), { friendly: /zu groß|pixel/i.test(e.message) ? 'Das Bild ist zu groß (mehr als 80 Megapixel). Bitte verkleinere es.' : 'Das Bild ist beschädigt oder kann nicht gelesen werden.' }); }
        const p = randomUUID(); renameSync(tmp, join(mediaDir, 'original', p)); addMedia('image', p, name, meta.width, meta.height);
      } else if (kind === 'video') {
        let pr; try { pr = await probeVideo(tmp); } catch { throw Object.assign(new Error('vid'), { friendly: 'Das Video kann nicht gelesen werden. Bitte versuche ein anderes Format (MP4).' }); }
        const p = randomUUID(); renameSync(tmp, join(mediaDir, 'original', p)); addMedia('video', p, name, pr.width, pr.height, pr.duration);
      } else { // PDF nur als gerenderte Bilder
        const outdir = join(mediaDir, 'incoming', randomUUID()); mkdirSync(outdir);
        try { await pexec('pdftoppm', ['-scale-to', '1920', '-png', '-l', '60', tmp, join(outdir, 'p')], { timeout: 120000 }); }
        catch { throw Object.assign(new Error('pdf'), { friendly: 'Das PDF konnte nicht umgewandelt werden. Ist es passwortgeschützt oder beschädigt?' }); }
        const { readdirSync } = await import('node:fs');
        for (const [i, f] of readdirSync(outdir).sort().entries()) {
          const p = randomUUID(); renameSync(join(outdir, f), join(mediaDir, 'original', p));
          const meta = await sharp(join(mediaDir, 'original', p), SHARP_OPTS).metadata();
          addMedia('pdfpage', p, `${name.replace(/\.pdf$/i, '')} – Seite ${i + 1}`, meta.width, meta.height);
        }
        unlinkSync(tmp); (await import('node:fs')).rmSync(outdir, { recursive: true, force: true });
      }
      variants.ensureAll();
      A(req, 'medium.hochgeladen', name, { kind, size });
      return reply.code(201).send({ ids, items: ids.map((id) => present(db.prepare('SELECT * FROM media WHERE id=?').get(id))) });
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      if (e.friendly) return reply.code(400).send({ error: e.friendly });
      if (e.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'Die Datei ist zu groß.' });
      throw e;
    }
  });

  app.post('/api/v1/media/text', { config: { perm: 'media.write' }, schema: { body: { type: 'object', required: ['name', 'title'], additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 }, title: { type: 'string', minLength: 1, maxLength: 120 }, body: { type: 'string', maxLength: 1000 },
    template: { enum: ['standard', 'hinweis', 'highlight'] } } } } }, async (req, reply) => {
    const id = randomUUID(), t = { title: req.body.title, body: req.body.body ?? '', template: req.body.template ?? 'standard' };
    db.prepare("INSERT INTO media(id,name,kind,text_json,created_by,created_at) VALUES(?,?,'text',?,?,?)").run(id, req.body.name, JSON.stringify(t), req.user.id, now());
    variants.ensureAll(); A(req, 'text.angelegt', req.body.name); return reply.code(201).send({ id });
  });

  app.patch('/api/v1/media/:id', { config: { perm: 'media.write' }, schema: { body: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 }, tags: { type: 'array', items: { type: 'string', maxLength: 30, pattern: '^[^,]+$' }, maxItems: 20 }, folder: { type: 'string', maxLength: 60 } } } } }, async (req, reply) => {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id); if (!m) return reply.code(404).send({ error: 'Medium nicht gefunden.' });
    db.prepare('UPDATE media SET name=?, tags=?, folder=? WHERE id=?').run(req.body.name ?? m.name, req.body.tags ? req.body.tags.join(',') : m.tags, req.body.folder ?? m.folder, m.id);
    A(req, 'medium.geaendert', m.id); return { ok: true };
  });

  app.get('/api/v1/media/:id/file', { config: { perm: 'media.read' } }, async (req, reply) => {
    const v = db.prepare("SELECT path FROM media_variants WHERE media_id=? AND status='ready' ORDER BY CASE profile WHEN 'standard' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END LIMIT 1").get(req.params.id);
    if (!v) return reply.code(404).send({ error: 'Die Vorschau wird noch erstellt.' });
    const type = v.path.endsWith('.mp4') ? 'video/mp4' : v.path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    const r = sendFile(req, reply, join(mediaDir, 'variants', v.path)); reply.header('Content-Type', type); return r;
  });

  app.delete('/api/v1/media/:id', { config: { perm: 'media.write' } }, async (req, reply) => {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id); if (!m) return reply.code(404).send({ error: 'Medium nicht gefunden.' });
    const used = db.prepare('SELECT p.name FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id WHERE i.media_id=? GROUP BY p.id').all(m.id);
    const direct = db.prepare("SELECT 1 FROM schedules WHERE content_type='media' AND content_id=?").get(m.id);
    if ((used.length || direct) && req.query.force !== '1') return reply.code(409).send({ error: `„${m.name}“ wird noch verwendet${used.length ? ` (Abspielliste: ${used.map((u) => u.name).join(', ')})` : ''}. Wenn du es löscht, verschwindet es dort ebenfalls. Du kannst es 30 Tage lang aus dem Papierkorb zurückholen.`, needsConfirm: true });
    const items = db.prepare('SELECT * FROM playlist_items WHERE media_id=?').all(m.id);
    toTrash(req, 'media', m.id, { media: m, items, variants: db.prepare('SELECT * FROM media_variants WHERE media_id=?').all(m.id) });
    db.prepare('DELETE FROM playlist_items WHERE media_id=?').run(m.id); db.prepare("DELETE FROM schedules WHERE content_type='media' AND content_id=?").run(m.id);
    db.prepare('DELETE FROM media WHERE id=?').run(m.id); A(req, 'medium.geloescht', m.name); app.pushAll(); return { ok: true };
  });

  // ---------- Abspiellisten ----------
  app.get('/api/v1/playlists', { config: { perm: 'playlists.read' } }, async () =>
    db.prepare('SELECT * FROM playlists ORDER BY name').all().map((p) => ({ id: p.id, name: p.name, isDefault: !!p.is_default,
      items: db.prepare('SELECT id,media_id AS mediaId,duration_s AS duration,transition,valid_from AS validFrom,valid_to AS validTo FROM playlist_items WHERE playlist_id=? ORDER BY pos').all(p.id) })));
  app.post('/api/v1/playlists', { config: { perm: 'playlists.write' }, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } } } }, async (req, reply) => {
    const id = randomUUID(); db.prepare('INSERT INTO playlists(id,name) VALUES(?,?)').run(id, req.body.name); A(req, 'liste.angelegt', req.body.name); return reply.code(201).send({ id });
  });
  const itemSchema = { type: 'object', required: ['mediaId'], additionalProperties: false, properties: { mediaId: { type: 'string', maxLength: 40 }, duration: { type: 'integer', minimum: 1, maximum: 3600 },
    transition: { enum: ['fade', 'cut'] }, validFrom: { type: ['string', 'null'], pattern: DATE }, validTo: { type: ['string', 'null'], pattern: DATE } } };
  app.put('/api/v1/playlists/:id', { config: { perm: 'playlists.write' }, schema: { body: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 }, isDefault: { type: 'boolean' }, items: { type: 'array', maxItems: 200, items: itemSchema } } } } }, async (req, reply) => {
    const p = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id); if (!p) return reply.code(404).send({ error: 'Abspielliste nicht gefunden.' });
    const b = req.body;
    for (const it of b.items ?? []) if (!db.prepare('SELECT 1 FROM media WHERE id=?').get(it.mediaId)) return reply.code(400).send({ error: 'Ein Medium in der Liste gibt es nicht mehr.' });
    db.transaction(() => {
      if (b.name) db.prepare('UPDATE playlists SET name=? WHERE id=?').run(b.name, p.id);
      if (b.isDefault) { db.prepare('UPDATE playlists SET is_default=0').run(); db.prepare('UPDATE playlists SET is_default=1 WHERE id=?').run(p.id); }
      if (b.items) { db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(p.id);
        b.items.forEach((it, i) => db.prepare('INSERT INTO playlist_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), p.id, it.mediaId, i, it.duration ?? 10, it.transition ?? 'fade', it.validFrom ?? null, it.validTo ?? null)); }
    })();
    A(req, 'liste.geaendert', p.id); app.pushAll(); return { ok: true };
  });
  app.delete('/api/v1/playlists/:id', { config: { perm: 'playlists.write' } }, async (req, reply) => {
    const p = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id); if (!p) return reply.code(404).send({ error: 'Abspielliste nicht gefunden.' });
    if (p.is_default) return reply.code(400).send({ error: 'Die Standard-Abspielliste kann nicht gelöscht werden. Lege zuerst eine andere als Standard fest.' });
    const dep = db.prepare("SELECT COUNT(*) n FROM schedules WHERE content_type='playlist' AND content_id=?").get(p.id).n;
    if (dep && req.query.force !== '1') return reply.code(409).send({ error: `Diese Abspielliste wird in ${dep} Termin(en) verwendet. Wenn du sie löschst, werden diese Termine ebenfalls entfernt.`, needsConfirm: true });
    toTrash(req, 'playlist', p.id, { playlist: p, items: db.prepare('SELECT * FROM playlist_items WHERE playlist_id=?').all(p.id), schedules: db.prepare("SELECT * FROM schedules WHERE content_type='playlist' AND content_id=?").all(p.id) });
    db.prepare("DELETE FROM schedules WHERE content_type='playlist' AND content_id=?").run(p.id); db.prepare('DELETE FROM playlists WHERE id=?').run(p.id);
    A(req, 'liste.geloescht', p.name); app.pushAll(); return { ok: true };
  });

  // ---------- Termine ----------
  const schedSchema = { type: 'object', required: ['targetType', 'targetId', 'content', 'startLocal', 'endLocal'], additionalProperties: false, properties: {
    targetType: { enum: ['device', 'group'] }, targetId: { type: 'string', maxLength: 40 },
    content: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { enum: ['playlist', 'media'] }, id: { type: 'string', maxLength: 40 } } },
    startLocal: { type: 'string', pattern: LOCAL_DT }, endLocal: { type: 'string', pattern: LOCAL_DT }, rrule: { type: ['string', 'null'], maxLength: 200, pattern: '^[A-Z0-9=;,]*$' },
    exdates: { type: 'array', maxItems: 400, items: { type: 'string', pattern: DATE } }, priority: { type: 'integer', minimum: 1, maximum: 10 },
    validFrom: { type: ['string', 'null'], pattern: DATE }, validTo: { type: ['string', 'null'], pattern: DATE } } };

  function checkSchedule(s) {
    const tbl = s.targetType === 'device' ? 'devices' : 'device_groups';
    if (!db.prepare(`SELECT 1 FROM ${tbl} WHERE id=?`).get(s.targetId)) return 'Dieser Bildschirm oder diese Gruppe existiert nicht.';
    if (!db.prepare(`SELECT 1 FROM ${s.content.type === 'playlist' ? 'playlists' : 'media'} WHERE id=?`).get(s.content.id)) return 'Diesen Inhalt gibt es nicht.';
    try { expand({ ...s, id: 'check' }, 0, DAY); } catch (e) { return e.message.includes('Ende') ? 'Das Ende liegt vor dem Start.' : 'Die Wiederholung ist ungültig: ' + e.message; }
    return null;
  }
  const schedRow = (s, id, req) => [id, s.targetType, s.targetId, s.content.type, s.content.id, s.startLocal, s.endLocal, s.rrule ?? null, JSON.stringify(s.exdates ?? []), s.priority ?? 5, s.validFrom ?? null, s.validTo ?? null, req.user.id, now()];
  const conflictInfo = (id) => { const t = now(); return warnings(db, t).filter((w) => w.kind === 'konflikt' && w.ids.includes(id)); };

  app.get('/api/v1/schedules', { config: { perm: 'schedules.read' } }, async () => loadSchedules(db));
  app.post('/api/v1/schedules', { config: { perm: 'schedules.write' }, schema: { body: schedSchema } }, async (req, reply) => {
    const bad = checkSchedule(req.body); if (bad) return reply.code(400).send({ error: bad });
    const id = randomUUID(); db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...schedRow(req.body, id, req));
    A(req, 'termin.angelegt', id); app.pushAll(); return reply.code(201).send({ id, conflicts: conflictInfo(id) });
  });
  app.put('/api/v1/schedules/:id', { config: { perm: 'schedules.write' }, schema: { body: schedSchema } }, async (req, reply) => {
    if (!db.prepare('SELECT 1 FROM schedules WHERE id=?').get(req.params.id)) return reply.code(404).send({ error: 'Termin nicht gefunden.' });
    const bad = checkSchedule(req.body); if (bad) return reply.code(400).send({ error: bad });
    db.prepare('DELETE FROM schedules WHERE id=?').run(req.params.id); db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...schedRow(req.body, req.params.id, req));
    A(req, 'termin.geaendert', req.params.id); app.pushAll(); return { ok: true, conflicts: conflictInfo(req.params.id) };
  });
  app.delete('/api/v1/schedules/:id', { config: { perm: 'schedules.write' } }, async (req, reply) => {
    const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id); if (!s) return reply.code(404).send({ error: 'Termin nicht gefunden.' });
    toTrash(req, 'schedule', s.id, { schedule: s }); db.prepare('DELETE FROM schedules WHERE id=?').run(s.id); A(req, 'termin.geloescht', s.id); app.pushAll(); return { ok: true };
  });
  /** Termine als konkrete Fenster für den Kalender (Tag/Woche/Monat). */
  app.get('/api/v1/calendar', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE } } } } }, async (req) => {
    const f = localToEpoch(req.query.from, '00:00'), t = localToEpoch(req.query.to, '23:59');
    return loadSchedules(db).flatMap((s) => expand(s, f, t).map((w) => ({ scheduleId: s.id, start: w.start, end: w.end, targetType: s.targetType, targetId: s.targetId, content: s.content, priority: s.priority })));
  });
  /** Vorschau: „So sieht der Bildschirm am Dienstag um 10:00 Uhr aus“ */
  app.get('/api/v1/preview', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', required: ['deviceId', 'date', 'time'], properties: { deviceId: { type: 'string' }, date: { type: 'string', pattern: DATE }, time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' } } } } }, async (req, reply) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.query.deviceId); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const t = localToEpoch(req.query.date, req.query.time);
    const seg = currentSegment(buildTimeline(loadSchedules(db), { deviceId: d.id, groupId: d.group_id }, t - DAY, t + DAY), t);
    let playlistId = seg?.source?.content.type === 'playlist' ? seg.source.content.id : null, mediaIds = [];
    if (seg?.source?.content.type === 'media') mediaIds = [seg.source.content.id];
    else { playlistId ??= db.prepare('SELECT id FROM playlists WHERE is_default=1').get()?.id; if (playlistId) mediaIds = db.prepare('SELECT media_id FROM playlist_items WHERE playlist_id=? ORDER BY pos').all(playlistId).map((r) => r.media_id); }
    return { source: seg?.source ? 'termin' : mediaIds.length ? 'standard' : 'standby', scheduleId: seg?.source?.scheduleId ?? null, playlistId, mediaIds,
      text: seg?.source ? 'Ein Termin legt fest, was gezeigt wird.' : mediaIds.length ? 'Es läuft die Standard-Abspielliste.' : 'Es gibt nichts zu zeigen. Der Bildschirm zeigt das DFM-Standby-Bild.' };
  });
  app.get('/api/v1/warnings', { config: { perm: 'devices.read' } }, async () => warnings(db, now()));

  // ---------- Papierkorb ----------
  app.get('/api/v1/trash', { config: { perm: 'media.read' } }, async () => {
    db.prepare('DELETE FROM trash WHERE deleted_at<?').run(now() - TRASH_DAYS * DAY);
    return db.prepare('SELECT id,kind,ref_id,deleted_at,payload_json FROM trash ORDER BY deleted_at DESC').all().map((t) => {
      const p = JSON.parse(t.payload_json); return { id: t.id, kind: t.kind, deletedAt: t.deleted_at, name: p.media?.name ?? p.playlist?.name ?? 'Termin', purgeAt: t.deleted_at + TRASH_DAYS * DAY };
    });
  });
  app.post('/api/v1/trash/:id/restore', { config: { perm: 'media.write' } }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM trash WHERE id=?').get(req.params.id); if (!t) return reply.code(404).send({ error: 'Nicht im Papierkorb gefunden.' });
    const p = JSON.parse(t.payload_json);
    const ins = (table, row) => { const cols = Object.keys(row); db.prepare(`INSERT OR IGNORE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(row)); };
    db.transaction(() => {
      if (t.kind === 'media') { ins('media', p.media); p.variants.forEach((v) => ins('media_variants', v)); p.items.forEach((i) => db.prepare('SELECT 1 FROM playlists WHERE id=?').get(i.playlist_id) && ins('playlist_items', i)); }
      else if (t.kind === 'playlist') { ins('playlists', p.playlist); p.items.forEach((i) => db.prepare('SELECT 1 FROM media WHERE id=?').get(i.media_id) && ins('playlist_items', i)); p.schedules.forEach((s) => ins('schedules', s)); }
      else if (t.kind === 'schedule') ins('schedules', p.schedule);
      db.prepare('DELETE FROM trash WHERE id=?').run(t.id);
    })();
    A(req, 'papierkorb.wiederhergestellt', t.ref_id); variants.ensureAll(); app.pushAll(); return { ok: true };
  });

  // ---------- Audit ----------
  app.get('/api/v1/audit', { config: { perm: 'audit.read' }, schema: { querystring: { type: 'object', properties: { security: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, before: { type: 'integer' } } } } }, async (req) =>
    db.prepare(`SELECT id,ts,user_name AS user,action,target,ip,security,detail_json FROM audit_log WHERE (? IS NULL OR id<?) ${req.query.security === '1' ? 'AND security=1' : ''} ORDER BY id DESC LIMIT ?`).all(req.query.before ?? null, req.query.before ?? null, req.query.limit ?? 100));
  app.get('/api/v1/audit.csv', { config: { perm: 'audit.export' } }, async (req, reply) => {
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }; // CSV-Injection verhindern
    const rows = db.prepare('SELECT ts,user_name,action,target,ip,security,detail_json FROM audit_log ORDER BY id').all();
    audit.log({ user: req.user, action: 'audit.export', ip: req.ip });
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="protokoll.csv"');
    return '﻿Zeit;Benutzer;Aktion;Ziel;Adresse;Sicherheit;Details\n' + rows.map((r) => [new Date(r.ts).toISOString(), r.user_name, r.action, r.target, r.ip, r.security ? 'ja' : 'nein', r.detail_json].map(cell).join(';')).join('\n');
  });

  // ---------- Einstellungen ----------
  const DEFAULTS = { 'site.name': 'Deutsches Fußballmuseum', 'feature.weburl': 'false', 'feature.rss': 'false', 'feature.weather': 'false', 'mail.enabled': 'false', 'ssh.enabled': 'false', 'sync.window': '', 'sync.bandwidthKbps': '0', 'demo.enabled': 'true', 'backup.extraDir': '', 'wizard.done': 'false' };
  const getSettings = () => ({ ...DEFAULTS, ...Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value])) });
  app.decorate('settings', getSettings);
  app.get('/api/v1/settings', { config: { perm: 'settings.manage' } }, async () => getSettings());
  app.put('/api/v1/settings', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, { type: 'string', maxLength: 200 }])) } } }, async (req) => {
    for (const [k, v] of Object.entries(req.body)) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, v);
    audit.log({ user: req.user, action: 'einstellungen.geaendert', ip: req.ip, detail: req.body }); return getSettings();
  });
}

contentPlugin[Symbol.for('skip-override')] = true; // Hooks und Decorators global (wie fastify-plugin)
export default contentPlugin;
