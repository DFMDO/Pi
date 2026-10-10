// Teil E (freigegeben): Hochkant/Seitenverhältnisse, gestaffelte Updates, Medien-Lizenz und Ablaufdatum.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SHARP_OPTS } from './variants.js';
import { deviceStatus } from './devices.js';
import { parseJson } from '../../shared/guard.js';

/** Zielgröße eines Bildschirms (Hochkant bei 90°/270°) */
export const targetSize = (orientation) => (orientation === 90 || orientation === 270 ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 });
/** Wie wirkt Einpassen („contain“) bzw. Füllen („cover“)? crop = abgeschnittener Anteil, bars = ungenutzter Anteil (schwarze Ränder) */
export function fitInfo(mw, mh, tw, th, fit = 'contain', safe = 0) {
  const ew = tw * (1 - 2 * safe / 100), eh = th * (1 - 2 * safe / 100), ma = mw / mh, ta = ew / eh;
  const ratio = Math.min(ma, ta) / Math.max(ma, ta); // 1 = gleiches Seitenverhältnis
  const crop = fit === 'cover' ? 1 - ratio : 0, used = fit === 'cover' ? 1 : ratio, bars = fit === 'cover' ? 0 : 1 - ratio;
  const text = fit === 'cover' && crop > 0.2 ? `Beim Füllen werden etwa ${Math.round(crop * 100)} % des Bildes abgeschnitten. Wichtiges am Rand könnte fehlen.` : fit === 'contain' && bars > 0.5 ? `Das Bild füllt nur etwa ${Math.round(used * 100)} % des Bildschirms (schwarze Ränder).` : null;
  return { crop: Math.round(crop * 100), bars: Math.round(bars * 100), warn: !!text, text };
}

async function extras3Plugin(app, { db, audit, mediaDir, now = () => Date.now() }) {
  const A = (req, action, target, detail, security = false) => audit.log({ user: req.user, action, target, ip: req.ip, detail, security });
  const dv = () => app.devices;

  // ======================= Hochkant und Seitenverhältnisse =======================
  app.put('/api/v1/devices/:id/fit', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['fit'], additionalProperties: false, properties: { fit: { enum: ['contain', 'cover'] }, safe: { type: 'integer', minimum: 0, maximum: 10 } } } } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    db.prepare('UPDATE devices SET fit_json=? WHERE id=?').run(JSON.stringify({ fit: req.body.fit, safe: req.body.safe ?? 0 }), d.id); dv().pushPlan(dv().getDevice(d.id)); A(req, 'bildschirm.darstellung_geaendert', d.id, req.body); return { ok: true };
  });
  app.get('/api/v1/devices/:id/fit-check', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' }); const { w, h } = targetSize(d.orientation), f = d.fit_json ? JSON.parse(d.fit_json) : { fit: 'contain', safe: 0 };
    const items = db.prepare("SELECT DISTINCT m.id,m.name,m.width,m.height FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id AND p.state='published' JOIN media m ON m.id=i.media_id WHERE m.width IS NOT NULL").all();
    const out = items.map((m) => ({ id: m.id, name: m.name, ...fitInfo(m.width, m.height, w, h, f.fit, f.safe) }));
    return { orientation: d.orientation, portrait: h > w, target: { w, h }, fit: f.fit, safe: f.safe, warnings: out.filter((x) => x.warn), checked: out.length,
      text: h > w ? 'Der Bildschirm steht hochkant. Querformat-Inhalte erscheinen mit Rändern oder werden beschnitten.' : null };
  });
  /** Vorschau „So sieht es auf Hochkant aus“ – JPEG im Seitenverhältnis des Bildschirms mit Sicherheitsrand */
  app.get('/api/v1/media/:id/preview', { config: { perm: 'media.read' }, schema: { querystring: { type: 'object', required: ['deviceId'], properties: { deviceId: { type: 'string' }, fit: { enum: ['contain', 'cover'] }, safe: { type: 'string', pattern: '^\\d{1,2}$' } } } } }, async (req, reply) => {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id), d = dv().getDevice(req.query.deviceId); if (!m || !d) return reply.code(404).send({ error: 'Nicht gefunden.' });
    const f = d.fit_json ? JSON.parse(d.fit_json) : { fit: 'contain', safe: 0 }, fit = req.query.fit ?? f.fit, safe = req.query.safe != null ? Number(req.query.safe) : f.safe, { w, h } = targetSize(d.orientation), pw = 480, ph = Math.round(pw * h / w), pad = Math.round(pw * safe / 100);
    let src; if (m.original_path && existsSync(join(mediaDir, 'original', m.original_path)) && ['image', 'pdfpage'].includes(m.kind)) src = join(mediaDir, 'original', m.original_path); else return reply.code(400).send({ error: 'Für diese Art von Medium gibt es keine Vorschau.' });
    const inner = await sharp(src, SHARP_OPTS).resize({ width: pw - 2 * pad, height: ph - 2 * pad, fit: fit === 'cover' ? 'cover' : 'contain', background: '#000' }).toBuffer();
    const img = await sharp({ create: { width: pw, height: ph, channels: 3, background: '#000' } }).composite([{ input: inner, left: pad, top: pad }]).jpeg({ quality: 70 }).toBuffer();
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(img);
  });

  // ======================= Gestaffelte Updates =======================
  const log = (r, text) => { const l = parseJson(r.log_json, []); l.push({ ts: now(), text }); return JSON.stringify(l.slice(-100)); };
  const view = (r) => ({ id: r.id, version: r.version, fromVersion: r.from_version, state: r.state, testDevice: r.test_device, batchSize: r.batch_size, soakMinutes: r.soak_minutes, createdAt: r.created_at, updatedAt: r.updated_at,
    steps: parseJson(r.steps_json, []).map((s) => ({ ...s, name: db.prepare('SELECT name FROM devices WHERE id=?').get(s.deviceId)?.name ?? '?' })), log: parseJson(r.log_json, []) });
  const verOf = (id) => { try { return JSON.parse(db.prepare('SELECT state_json FROM devices WHERE id=?').get(id)?.state_json ?? '{}').version ?? null; } catch { return null; } };
  app.get('/api/v1/rollouts', { config: { perm: 'update.manage' } }, async () => db.prepare('SELECT * FROM rollouts ORDER BY created_at DESC LIMIT 20').all().map(view));
  app.post('/api/v1/rollouts', { config: { perm: 'update.manage' }, schema: { body: { type: 'object', required: ['testDevice'], additionalProperties: false, properties: { testDevice: { type: 'string', maxLength: 40 }, batchSize: { type: 'integer', minimum: 1, maximum: 50 }, soakMinutes: { type: 'integer', minimum: 1, maximum: 120 } } } } }, async (req, reply) => {
    if (db.prepare("SELECT 1 FROM rollouts WHERE state IN ('canary','rolling')").get()) return reply.code(409).send({ error: 'Es läuft schon ein gestaffeltes Update.' });
    const t = dv().getDevice(req.body.testDevice); if (!t || t.status !== 'active') return reply.code(400).send({ error: 'Der Test-Bildschirm wurde nicht gefunden.' });
    if (deviceStatus(t, now()).level !== 'ok') return reply.code(400).send({ error: 'Der Test-Bildschirm ist gerade nicht erreichbar. Bitte wähle einen, der läuft.' });
    if (!existsSync(join(app.ctx.dataDir, 'updates', 'current.dfmpkg'))) return reply.code(400).send({ error: 'Es liegt kein Update-Paket im Hub. Bitte spiele zuerst eine Update-Datei ein.' });
    const others = db.prepare("SELECT id FROM devices WHERE status='active' AND id<>? ORDER BY name").all(t.id).map((x) => ({ deviceId: x.id, state: 'pending' })); const id = randomUUID();
    const steps = [{ deviceId: t.id, state: 'sent', sentAt: now(), canary: true }, ...others];
    db.prepare("INSERT INTO rollouts VALUES(?,?,?,'canary',?,?,?,?,?,?,?,?)").run(id, null, verOf(t.id), t.id, req.body.batchSize ?? 2, req.body.soakMinutes ?? 5, req.user.id, now(), now(), JSON.stringify(steps), JSON.stringify([{ ts: now(), text: `Update startet zuerst auf „${t.name}“.` }]));
    steps[0].cmdId = dv().queueCommand(t.id, 'update'); db.prepare('UPDATE rollouts SET steps_json=? WHERE id=?').run(JSON.stringify(steps), id); A(req, 'rollout.gestartet', id, { test: t.name }, true); return reply.code(201).send({ id });
  });
  app.post('/api/v1/rollouts/:id/abort', { config: { perm: 'update.manage' } }, async (req, reply) => {
    const r = db.prepare("SELECT * FROM rollouts WHERE id=? AND state IN ('canary','rolling')").get(req.params.id); if (!r) return reply.code(404).send({ error: 'Dieses Update läuft nicht mehr.' }); abort(r, 'Von einem Admin abgebrochen.'); A(req, 'rollout.abgebrochen', r.id, null, true); return { ok: true };
  });
  function abort(r, why) { // automatischer Rückfall: alle schon aktualisierten Bildschirme gehen zur vorherigen Version zurück
    const steps = parseJson(r.steps_json, []); for (const s of steps) if (['sent', 'ok'].includes(s.state)) { dv().queueCommand(s.deviceId, 'rollback'); s.state = 'rolled_back'; }
    db.prepare("UPDATE rollouts SET state='aborted', steps_json=?, log_json=?, updated_at=? WHERE id=?").run(JSON.stringify(steps), log(r, `Abgebrochen: ${why} Alle aktualisierten Bildschirme gehen zur vorherigen Version zurück.`), now(), r.id); audit.log({ action: 'rollout.rueckfall', target: r.id, security: true, detail: { grund: why } });
  }
  /** Fortschritt prüfen (alle 20 s). Test-Bildschirm zuerst; nach Erfolg und Beobachtungszeit schrittweise die übrigen. */
  function tick() {
    for (const r of db.prepare("SELECT * FROM rollouts WHERE state IN ('canary','rolling')").all()) {
      const steps = parseJson(r.steps_json, []), t = now(); let changed = false, logText = null;
      const check = (s) => { // Ergebnis des Update-Befehls und Zustand des Bildschirms prüfen
        const c = s.cmdId ? db.prepare('SELECT status,result_json FROM commands WHERE id=?').get(s.cmdId) : null, d = dv().getDevice(s.deviceId), online = d && deviceStatus(d, t).level === 'ok';
        if (c?.status === 'failed') return 'failed';
        if (t - s.sentAt > 15 * 60000 && !(c?.status === 'done' && online)) return 'failed'; // nach 15 Minuten nicht wieder da
        if (c?.status === 'done' && online) { const v = verOf(s.deviceId); const newV = JSON.parse(c.result_json ?? '{}').version; if ((newV && v === newV) || (!newV && v && v !== r.from_version)) return t - (s.doneAt ??= t) >= (s.canary ? r.soak_minutes : 0) * 60000 ? 'ok' : 'soak'; }
        return 'wait';
      };
      if (r.state === 'canary') {
        const s = steps[0], res = check(s); changed = true; if (res === 'failed') { abort({ ...r, steps_json: JSON.stringify(steps) }, 'Der Test-Bildschirm hat das Update nicht geschafft.'); continue; }
        if (res === 'ok') { s.state = 'ok'; const nv = verOf(s.deviceId); db.prepare("UPDATE rollouts SET state='rolling', version=?, steps_json=?, log_json=?, updated_at=? WHERE id=?").run(nv, JSON.stringify(steps), log(r, `Der Test-Bildschirm läuft stabil mit ${nv ?? 'der neuen Version'}. Jetzt folgen die übrigen Bildschirme.`), t, r.id); continue; }
        db.prepare('UPDATE rollouts SET steps_json=?, updated_at=? WHERE id=?').run(JSON.stringify(steps), t, r.id); continue;
      }
      // rolling: laufende Schritte prüfen, dann die nächste Gruppe starten
      for (const s of steps.filter((x) => x.state === 'sent')) { const res = check(s); if (res === 'failed') { abort({ ...r, steps_json: JSON.stringify(steps) }, `„${db.prepare('SELECT name FROM devices WHERE id=?').get(s.deviceId)?.name}“ hat das Update nicht geschafft.`); steps.length = 0; break; } if (res === 'ok') { s.state = 'ok'; changed = true; } }
      if (!steps.length) continue;
      if (!steps.some((x) => x.state === 'sent')) {
        const next = steps.filter((x) => x.state === 'pending').slice(0, r.batch_size);
        if (next.length) { for (const s of next) { s.state = 'sent'; s.sentAt = t; s.cmdId = dv().queueCommand(s.deviceId, 'update'); } changed = true; logText = `Nächste Gruppe: ${next.length} Bildschirm(e).`; }
        else { db.prepare("UPDATE rollouts SET state='done', steps_json=?, log_json=?, updated_at=? WHERE id=?").run(JSON.stringify(steps), log(r, 'Alle Bildschirme sind aktualisiert.'), t, r.id); audit.log({ action: 'rollout.fertig', target: r.id }); continue; }
      }
      if (changed) db.prepare('UPDATE rollouts SET steps_json=?, log_json=?, updated_at=? WHERE id=?').run(JSON.stringify(steps), logText ? log(r, logText) : r.log_json, t, r.id);
    }
  }
  app.decorate('rollouts', { tick });
  const timer = setInterval(() => { try { tick(); } catch {} }, 20000); timer.unref(); app.addHook('onClose', async () => clearInterval(timer));
}
extras3Plugin[Symbol.for('skip-override')] = true;
export default extras3Plugin;
