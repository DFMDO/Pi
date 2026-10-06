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
import { loadSchedules, rowToSchedule, warnings, summarizeSchedule, DAY } from './plan.js';
import { expand, buildTimeline, currentSegment, findConflicts } from '../../shared/schedule.js';
import { can } from './permissions.js';
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

  app.get('/api/v1/media/:id/file', { config: { perm: 'live.read' } }, async (req, reply) => {
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

  // ---------- Entwurf / Veröffentlicht (Z.13) ----------
  // Neues und Änderungen entstehen als ENTWURF. Player, Live-Ansicht und der 14-Tage-Plan kennen nur veröffentlichte Stände.
  const mayPublish = (req, kind) => can(req.user.role, kind + '.publish') && (req.user.role === 'admin' || app.settings()['publish.editor'] !== 'false');
  const snapshot = (req, kind, refId, label, payload) => db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), kind, refId, label, JSON.stringify(payload), now(), req.user.id, req.user.name);
  const noPublish = (reply) => reply.code(403).send({ error: 'Du darfst Änderungen anlegen, aber nicht veröffentlichen. Bitte einen Admin, den Entwurf zu veröffentlichen.' });
  const draftCount = () => ({ schedules: db.prepare("SELECT COUNT(*) n FROM schedules WHERE state='draft'").get().n, playlists: db.prepare("SELECT COUNT(*) n FROM playlists WHERE state='draft'").get().n,
    old: db.prepare("SELECT 'schedule' kind, id FROM schedules WHERE state='draft' AND created_at < ? UNION SELECT 'playlist', id FROM playlists WHERE state='draft' AND COALESCE(created_at,0) < ?").all(now() - 30 * DAY, now() - 30 * DAY).length });
  app.get('/api/v1/drafts', { config: { perm: 'schedules.read' } }, async (req) => ({ ...draftCount(), canPublish: mayPublish(req, 'schedules') }));

  // ---------- Abspiellisten ----------
  const itemsOf = (id) => db.prepare('SELECT id,media_id AS mediaId,duration_s AS duration,transition,valid_from AS validFrom,valid_to AS validTo FROM playlist_items WHERE playlist_id=? ORDER BY pos').all(id);
  app.get('/api/v1/playlists', { config: { perm: 'playlists.read' } }, async () =>
    db.prepare('SELECT * FROM playlists ORDER BY name').all().map((p) => ({ id: p.id, name: p.name, isDefault: !!p.is_default, state: p.state, draftOf: p.draft_of, note: p.note, hasDraft: p.state === 'published' && !!db.prepare('SELECT 1 FROM playlists WHERE draft_of=?').get(p.id), items: itemsOf(p.id) })));
  app.post('/api/v1/playlists', { config: { perm: 'playlists.write' }, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, publish: { type: 'boolean' } } } } }, async (req, reply) => {
    if (req.body.publish && !mayPublish(req, 'playlists')) return noPublish(reply);
    const id = randomUUID(); db.prepare('INSERT INTO playlists(id,name,state,created_at) VALUES(?,?,?,?)').run(id, req.body.name, req.body.publish ? 'published' : 'draft', now()); A(req, 'liste.angelegt', req.body.name); return reply.code(201).send({ id });
  });
  const itemSchema = { type: 'object', required: ['mediaId'], additionalProperties: false, properties: { mediaId: { type: 'string', maxLength: 40 }, duration: { type: 'integer', minimum: 1, maximum: 3600 },
    transition: { enum: ['fade', 'cut'] }, validFrom: { type: ['string', 'null'], pattern: DATE }, validTo: { type: ['string', 'null'], pattern: DATE } } };
  function publishPlaylist(req, id) {
    const d = db.prepare('SELECT * FROM playlists WHERE id=?').get(id); const target = d.draft_of ?? d.id;
    db.transaction(() => {
      if (d.draft_of) {
        db.prepare('UPDATE playlists SET name=?, note=? WHERE id=?').run(d.name, d.note, target);
        db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(target);
        for (const i of db.prepare('SELECT * FROM playlist_items WHERE playlist_id=? ORDER BY pos').all(d.id)) db.prepare('INSERT INTO playlist_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), target, i.media_id, i.pos, i.duration_s, i.transition, i.valid_from, i.valid_to);
        db.prepare('DELETE FROM playlists WHERE id=?').run(d.id);
      } else db.prepare("UPDATE playlists SET state='published' WHERE id=?").run(d.id);
      if (d.is_default) { db.prepare('UPDATE playlists SET is_default=0').run(); db.prepare('UPDATE playlists SET is_default=1 WHERE id=?').run(target); }
      const p = db.prepare('SELECT * FROM playlists WHERE id=?').get(target); snapshot(req, 'playlist', target, p.name, { name: p.name, isDefault: !!p.is_default, items: itemsOf(target) });
    })();
    A(req, 'liste.veroeffentlicht', target); app.pushAll(); return target;
  }
  app.put('/api/v1/playlists/:id', { config: { perm: 'playlists.write' }, schema: { body: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 }, isDefault: { type: 'boolean' }, note: { type: 'string', maxLength: 300 }, publish: { type: 'boolean' }, items: { type: 'array', maxItems: 200, items: itemSchema } } } } }, async (req, reply) => {
    let p = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id); if (!p) return reply.code(404).send({ error: 'Abspielliste nicht gefunden.' });
    const b = req.body;
    for (const it of b.items ?? []) if (!db.prepare('SELECT 1 FROM media WHERE id=?').get(it.mediaId)) return reply.code(400).send({ error: 'Ein Medium in der Liste gibt es nicht mehr.' });
    if (b.publish && !mayPublish(req, 'playlists')) return noPublish(reply);
    if (p.state === 'published') { // Änderung an Veröffentlichtem → Entwurfsversion; die veröffentlichte Liste läuft unverändert weiter
      let d = db.prepare('SELECT * FROM playlists WHERE draft_of=?').get(p.id);
      if (!d) { const id = randomUUID(); db.prepare("INSERT INTO playlists(id,name,is_default,state,draft_of,created_at) VALUES(?,?,?,'draft',?,?)").run(id, p.name, p.is_default, p.id, now());
        for (const i of itemsOf(p.id).entries()) db.prepare('INSERT INTO playlist_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), id, i[1].mediaId, i[0], i[1].duration, i[1].transition, i[1].validFrom, i[1].validTo); d = db.prepare('SELECT * FROM playlists WHERE id=?').get(id); }
      p = d;
    }
    db.transaction(() => {
      if (b.name) db.prepare('UPDATE playlists SET name=? WHERE id=?').run(b.name, p.id);
      if (b.note !== undefined) db.prepare('UPDATE playlists SET note=? WHERE id=?').run(b.note, p.id);
      if (b.isDefault !== undefined) db.prepare('UPDATE playlists SET is_default=? WHERE id=?').run(b.isDefault ? 1 : 0, p.id);
      if (b.items) { db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(p.id);
        b.items.forEach((it, i) => db.prepare('INSERT INTO playlist_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), p.id, it.mediaId, i, it.duration ?? 10, it.transition ?? 'fade', it.validFrom ?? null, it.validTo ?? null)); }
    })();
    A(req, 'liste.entwurf_gespeichert', p.id);
    if (b.publish) { const id = publishPlaylist(req, p.id); return { ok: true, id, published: true }; }
    return { ok: true, draftId: p.id, published: false };
  });
  app.post('/api/v1/playlists/:id/publish', { config: { perm: 'playlists.write' } }, async (req, reply) => {
    if (!mayPublish(req, 'playlists')) return noPublish(reply);
    const d = db.prepare("SELECT * FROM playlists WHERE id=? AND state='draft'").get(req.params.id); if (!d) return reply.code(404).send({ error: 'Es gibt keinen Entwurf zum Veröffentlichen.' });
    if (!db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id=?').get(d.id) && d.is_default) return reply.code(400).send({ error: 'Die Standard-Abspielliste darf nicht leer sein.' });
    return { ok: true, id: publishPlaylist(req, d.id) };
  });
  app.post('/api/v1/playlists/:id/discard', { config: { perm: 'playlists.write' } }, async (req, reply) => {
    const r = db.prepare("DELETE FROM playlists WHERE id=? AND state='draft'").run(req.params.id); if (!r.changes) return reply.code(404).send({ error: 'Es gibt keinen Entwurf.' });
    A(req, 'liste.entwurf_verworfen', req.params.id); return { ok: true };
  });
  app.delete('/api/v1/playlists/:id', { config: { perm: 'playlists.write' } }, async (req, reply) => {
    const p = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id); if (!p) return reply.code(404).send({ error: 'Abspielliste nicht gefunden.' });
    if (p.is_default && p.state === 'published') return reply.code(400).send({ error: 'Die Standard-Abspielliste kann nicht gelöscht werden. Lege zuerst eine andere als Standard fest.' });
    const dep = db.prepare("SELECT COUNT(*) n FROM schedules WHERE content_type='playlist' AND content_id=?").get(p.id).n;
    if (dep && req.query.force !== '1') return reply.code(409).send({ error: `Diese Abspielliste wird in ${dep} Termin(en) verwendet. Wenn du sie löschst, werden diese Termine ebenfalls entfernt.`, needsConfirm: true });
    toTrash(req, 'playlist', p.id, { playlist: p, items: db.prepare('SELECT * FROM playlist_items WHERE playlist_id=?').all(p.id), schedules: db.prepare("SELECT * FROM schedules WHERE content_type='playlist' AND content_id=?").all(p.id) });
    db.prepare("DELETE FROM schedules WHERE content_type='playlist' AND content_id=?").run(p.id); db.prepare('DELETE FROM playlists WHERE draft_of=?').run(p.id); db.prepare('DELETE FROM playlists WHERE id=?').run(p.id);
    A(req, 'liste.geloescht', p.name); app.pushAll(); return { ok: true };
  });

  // ---------- Termine ----------
  const schedSchema = { type: 'object', required: ['targetType', 'targetId', 'content', 'startLocal', 'endLocal'], additionalProperties: false, properties: {
    targetType: { enum: ['device', 'group'] }, targetId: { type: 'string', maxLength: 40 },
    content: { type: 'object', required: ['type', 'id'], additionalProperties: false, properties: { type: { enum: ['playlist', 'media'] }, id: { type: 'string', maxLength: 40 } } },
    startLocal: { type: 'string', pattern: LOCAL_DT }, endLocal: { type: 'string', pattern: LOCAL_DT }, rrule: { type: ['string', 'null'], maxLength: 200, pattern: '^[A-Z0-9=;,]*$' },
    exdates: { type: 'array', maxItems: 400, items: { type: 'string', pattern: DATE } }, priority: { type: 'integer', minimum: 1, maximum: 10 }, note: { type: 'string', maxLength: 300 }, publish: { type: 'boolean' },
    validFrom: { type: ['string', 'null'], pattern: DATE }, validTo: { type: ['string', 'null'], pattern: DATE } } };

  function checkSchedule(s) {
    const tbl = s.targetType === 'device' ? 'devices' : 'device_groups';
    if (!db.prepare(`SELECT 1 FROM ${tbl} WHERE id=?`).get(s.targetId)) return 'Dieser Bildschirm oder diese Gruppe existiert nicht.';
    if (!db.prepare(`SELECT 1 FROM ${s.content.type === 'playlist' ? 'playlists' : 'media'} WHERE id=?`).get(s.content.id)) return 'Diesen Inhalt gibt es nicht.';
    try { expand({ ...s, id: 'check' }, 0, DAY); } catch (e) { return e.message.includes('Ende') ? 'Das Ende liegt vor dem Start.' : 'Die Wiederholung ist ungültig: ' + e.message; }
    return null;
  }
  const schedRow = (s, id, req, state = 'draft', draftOf = null) => [id, s.targetType, s.targetId, s.content.type, s.content.id, s.startLocal, s.endLocal, s.rrule ?? null, JSON.stringify(s.exdates ?? []), s.priority ?? 5, s.validFrom ?? null, s.validTo ?? null, req.user.id, now(), state, draftOf, s.note ?? null];
  const INS = 'INSERT INTO schedules(id,target_type,target_id,content_type,content_id,start_local,end_local,rrule,exdates,priority,valid_from,valid_to,created_by,created_at,state,draft_of,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const conflictInfo = (id) => warnings(db, now()).filter((w) => w.kind === 'konflikt' && w.ids.includes(id));

  /** Prüft vor dem Veröffentlichen: Inhalt veröffentlicht? Konflikte? Medien vorbereitet? */
  function publishCheck(id) {
    const d = db.prepare('SELECT * FROM schedules WHERE id=?').get(id); if (!d) return null;
    const s = rowToSchedule(d); const problems = [];
    if (s.content.type === 'playlist') { const pl = db.prepare('SELECT state,name FROM playlists WHERE id=?').get(s.content.id); if (pl?.state !== 'published') problems.push(`Die Abspielliste „${pl?.name ?? '?'}“ ist noch ein Entwurf. Bitte veröffentliche zuerst die Liste.`); }
    const dev = s.targetType === 'device' ? [s.targetId] : db.prepare('SELECT id FROM devices WHERE group_id=?').all(s.targetId).map((r) => r.id);
    const notReady = dev.filter((x) => { const st = db.prepare('SELECT state_json FROM devices WHERE id=?').get(x)?.state_json; const ss = st ? JSON.parse(st).syncState : null; return ss && ss.done < ss.total; });
    // Konflikte testweise mit dem Entwurf als veröffentlicht berechnen
    const all = loadSchedules(db).filter((x) => x.id !== (d.draft_of ?? d.id)).concat([{ ...s, id: d.draft_of ?? d.id }]);
    const conflicts = findConflicts(all, now(), now() + 14 * DAY).filter((c) => [c.a, c.b].includes(d.draft_of ?? d.id));
    return { s, summary: summarizeSchedule(db, s), problems, conflicts: conflicts.length ? [`Dieser Termin überschneidet sich mit einem anderen mit gleicher Wichtigkeit. Der später gestartete gewinnt. Gib einem der Termine eine höhere Wichtigkeit, wenn du das ändern willst.`] : [], notLoaded: notReady.length ? `${notReady.length} Bildschirm(e) laden noch Medien – der Termin greift dort erst danach.` : null, draft: d };
  }
  function publishSchedule(req, id) {
    const c = publishCheck(id); const d = c.draft; const target = d.draft_of ?? d.id;
    db.transaction(() => {
      if (d.draft_of) { db.prepare('DELETE FROM schedules WHERE id=?').run(target); db.prepare(INS).run(...schedRow(c.s, target, req, 'published', null)); db.prepare('DELETE FROM schedules WHERE id=?').run(d.id); }
      else db.prepare("UPDATE schedules SET state='published' WHERE id=?").run(d.id);
      snapshot(req, 'schedule', target, c.summary, { schedule: { ...c.s, id: target, state: 'published', draftOf: null } });
    })();
    A(req, 'termin.veroeffentlicht', target, { zusammenfassung: c.summary }); app.pushAll(); return target;
  }
  app.get('/api/v1/schedules', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', properties: { drafts: { type: 'string' } } } } }, async (req) => loadSchedules(db, { drafts: req.query.drafts === '1' }));
  app.post('/api/v1/schedules', { config: { perm: 'schedules.write' }, schema: { body: schedSchema } }, async (req, reply) => {
    const bad = checkSchedule(req.body); if (bad) return reply.code(400).send({ error: bad });
    if (req.body.publish && !mayPublish(req, 'schedules')) return noPublish(reply);
    const id = randomUUID(); db.prepare(INS).run(...schedRow(req.body, id, req)); A(req, 'termin.entwurf_angelegt', id);
    if (req.body.publish) { const c = publishCheck(id); if (c.problems.length) { db.prepare('DELETE FROM schedules WHERE id=?').run(id); return reply.code(400).send({ error: c.problems[0] }); } publishSchedule(req, id); return reply.code(201).send({ id, published: true, summary: c.summary, conflicts: conflictInfo(id) }); }
    return reply.code(201).send({ id, published: false });
  });
  app.put('/api/v1/schedules/:id', { config: { perm: 'schedules.write' }, schema: { body: schedSchema } }, async (req, reply) => {
    const cur = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id); if (!cur) return reply.code(404).send({ error: 'Termin nicht gefunden.' });
    const bad = checkSchedule(req.body); if (bad) return reply.code(400).send({ error: bad });
    if (req.body.publish && !mayPublish(req, 'schedules')) return noPublish(reply);
    let targetId = cur.id;
    if (cur.state === 'published') { // Änderung an einem veröffentlichten Termin → Entwurfsversion, der Termin läuft unverändert weiter
      const ex = db.prepare('SELECT id FROM schedules WHERE draft_of=?').get(cur.id); db.prepare('DELETE FROM schedules WHERE draft_of=?').run(cur.id); void ex;
      targetId = randomUUID(); db.prepare(INS).run(...schedRow(req.body, targetId, req, 'draft', cur.id));
    } else { db.prepare('DELETE FROM schedules WHERE id=?').run(cur.id); db.prepare(INS).run(...schedRow(req.body, cur.id, req, 'draft', cur.draft_of)); }
    A(req, 'termin.entwurf_gespeichert', targetId);
    if (req.body.publish) { const c = publishCheck(targetId); if (c.problems.length) return reply.code(400).send({ error: c.problems[0], draftId: targetId }); publishSchedule(req, targetId); return { ok: true, published: true, summary: c.summary, conflicts: conflictInfo(cur.state === 'published' ? cur.id : (cur.draft_of ?? cur.id)) }; }
    return { ok: true, published: false, draftId: targetId };
  });
  app.get('/api/v1/schedules/:id/publish-check', { config: { perm: 'schedules.read' } }, async (req, reply) => {
    const c = publishCheck(req.params.id); if (!c) return reply.code(404).send({ error: 'Termin nicht gefunden.' }); const { draft, s, ...out } = c; return out;
  });
  app.post('/api/v1/schedules/:id/publish', { config: { perm: 'schedules.write' } }, async (req, reply) => {
    if (!mayPublish(req, 'schedules')) return noPublish(reply);
    const d = db.prepare("SELECT id FROM schedules WHERE id=? AND state='draft'").get(req.params.id); if (!d) return reply.code(404).send({ error: 'Es gibt keinen Entwurf zum Veröffentlichen.' });
    const c = publishCheck(d.id); if (c.problems.length) return reply.code(400).send({ error: c.problems[0] });
    const id = publishSchedule(req, d.id); return { ok: true, id, summary: c.summary, conflicts: conflictInfo(id) };
  });
  app.post('/api/v1/schedules/:id/discard', { config: { perm: 'schedules.write' } }, async (req, reply) => {
    const r = db.prepare("DELETE FROM schedules WHERE id=? AND state='draft'").run(req.params.id); if (!r.changes) return reply.code(404).send({ error: 'Es gibt keinen Entwurf.' });
    A(req, 'termin.entwurf_verworfen', req.params.id); return { ok: true };
  });
  app.delete('/api/v1/schedules/:id', { config: { perm: 'schedules.write' } }, async (req, reply) => {
    const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id); if (!s) return reply.code(404).send({ error: 'Termin nicht gefunden.' });
    if (s.state === 'draft') { db.prepare('DELETE FROM schedules WHERE id=?').run(s.id); A(req, 'termin.entwurf_verworfen', s.id); return { ok: true }; }
    toTrash(req, 'schedule', s.id, { schedule: s }); db.prepare('DELETE FROM schedules WHERE draft_of=?').run(s.id); db.prepare('DELETE FROM schedules WHERE id=?').run(s.id); A(req, 'termin.geloescht', s.id); app.pushAll(); return { ok: true };
  });
  // Versionsverlauf (90 Tage): Stand wiederherstellen = neuer Entwurf mit altem Inhalt
  app.get('/api/v1/versions', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', required: ['kind', 'refId'], properties: { kind: { enum: ['schedule', 'playlist'] }, refId: { type: 'string' } } } } }, async (req) => {
    db.prepare('DELETE FROM versions WHERE ts<?').run(now() - 90 * DAY);
    return db.prepare('SELECT id,label,ts,user_name AS user FROM versions WHERE kind=? AND ref_id=? ORDER BY ts DESC LIMIT 50').all(req.query.kind, req.query.refId);
  });
  app.post('/api/v1/versions/:id/restore', { config: { perm: 'schedules.write' } }, async (req, reply) => {
    const v = db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.id); if (!v) return reply.code(404).send({ error: 'Diese Version gibt es nicht mehr.' }); const p = JSON.parse(v.payload_json);
    if (v.kind === 'schedule') { const s = p.schedule; const bad = checkSchedule(s); if (bad) return reply.code(400).send({ error: 'Diese Version kann nicht wiederhergestellt werden: ' + bad });
      db.prepare('DELETE FROM schedules WHERE draft_of=?').run(v.ref_id); const id = randomUUID(); const exists = db.prepare('SELECT 1 FROM schedules WHERE id=?').get(v.ref_id);
      db.prepare(INS).run(...schedRow(s, exists ? id : v.ref_id, req, 'draft', exists ? v.ref_id : null)); A(req, 'version.wiederhergestellt', v.ref_id); return { ok: true, draftId: exists ? id : v.ref_id }; }
    const exists = db.prepare('SELECT * FROM playlists WHERE id=?').get(v.ref_id); if (!exists) return reply.code(400).send({ error: 'Die Abspielliste gibt es nicht mehr.' });
    db.prepare('DELETE FROM playlists WHERE draft_of=?').run(v.ref_id); const id = randomUUID(); db.prepare("INSERT INTO playlists(id,name,is_default,state,draft_of,created_at) VALUES(?,?,?,'draft',?,?)").run(id, p.name, p.isDefault ? 1 : 0, v.ref_id, now());
    p.items.filter((i) => db.prepare('SELECT 1 FROM media WHERE id=?').get(i.mediaId)).forEach((i, n) => db.prepare('INSERT INTO playlist_items VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), id, i.mediaId, n, i.duration, i.transition, i.validFrom, i.validTo));
    A(req, 'version.wiederhergestellt', v.ref_id); return { ok: true, draftId: id };
  });
  /** Termine als konkrete Fenster für den Kalender; Entwürfe nur auf Wunsch (gestrichelt dargestellt) */
  app.get('/api/v1/calendar', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE }, drafts: { type: 'string' } } } } }, async (req) => {
    const f = localToEpoch(req.query.from, '00:00'), t = localToEpoch(req.query.to, '23:59');
    return loadSchedules(db, { drafts: req.query.drafts === '1' }).flatMap((s) => expand(s, f, t).map((w) => ({ scheduleId: s.id, state: s.state, draftOf: s.draftOf, start: w.start, end: w.end, targetType: s.targetType, targetId: s.targetId, content: s.content, priority: s.priority })));
  });
  /** Vorschau: „So sieht der Bildschirm am Dienstag um 10:00 Uhr aus“ – mit drafts=1 inkl. Entwürfen („Probelauf“) */
  app.get('/api/v1/preview', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', required: ['deviceId', 'date', 'time'], properties: { deviceId: { type: 'string' }, date: { type: 'string', pattern: DATE }, time: { type: 'string', pattern: '^\\d{2}:\\d{2}$' }, drafts: { type: 'string' } } } } }, async (req, reply) => {
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.query.deviceId); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const t = localToEpoch(req.query.date, req.query.time);
    const seg = currentSegment(buildTimeline(loadSchedules(db, { drafts: req.query.drafts === '1' }), { deviceId: d.id, groupId: d.group_id }, t - DAY, t + DAY), t);
    let playlistId = seg?.source?.content.type === 'playlist' ? seg.source.content.id : null, mediaIds = [];
    if (seg?.source?.content.type === 'media') mediaIds = [seg.source.content.id];
    else { playlistId ??= db.prepare("SELECT id FROM playlists WHERE is_default=1 AND state='published'").get()?.id; if (playlistId) mediaIds = db.prepare('SELECT media_id FROM playlist_items WHERE playlist_id=? ORDER BY pos').all(playlistId).map((r) => r.media_id); }
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
  const DEFAULTS = { 'site.name': 'Deutsches Fußballmuseum', 'feature.weburl': 'false', 'feature.rss': 'false', 'feature.weather': 'false', 'mail.enabled': 'false', 'ssh.enabled': 'false', 'sync.window': '', 'sync.bandwidthKbps': '0', 'demo.enabled': 'true', 'backup.extraDir': '', 'wizard.done': 'false', 'publish.editor': 'true' };
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
