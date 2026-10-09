// Erweiterung 4: Messwerte-Verlauf, Verbindungstest und Grundriss je Etage.
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, unlinkSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { detectKind, LIMITS, SHARP_OPTS } from './variants.js';
import { deviceStatus, sendFile } from './devices.js';
import { HUB, memInfo } from './metrics.js';

const hubAddresses = () => { try { return Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address); } catch { return []; } };
const chronyTracking = () => new Promise((res) => execFile('chronyc', ['-c', 'tracking'], { timeout: 2500 }, (e, so) => { if (e) return res(null); const t = String(so).trim().split(','); res(t.length > 13 ? { refName: t[1], stratum: Number(t[2]), leap: t[13] } : null); }));
const ago = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 90 ? `${m} Minuten` : m < 2880 ? `${Math.round(m / 60)} Stunden` : `${Math.round(m / 1440)} Tagen`; };

async function extras4Plugin(app, { db, audit, mediaDir, metrics, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });
  const dv = () => app.devices;
  const planDir = join(mediaDir, 'plans'); mkdirSync(planDir, { recursive: true });

  // ======================= Messwerte-Verlauf =======================
  try { metrics.recordHub(); } catch {}
  const sampleTimer = setInterval(() => { try { metrics.recordHub(); } catch {} }, 60000); sampleTimer.unref();
  const pruneTimer = setInterval(() => { try { metrics.prune(); } catch {} }, 3600000); pruneTimer.unref();
  app.addHook('onClose', async () => { clearInterval(sampleTimer); clearInterval(pruneTimer); });

  app.get('/api/v1/metrics', { config: { perm: 'devices.read' }, schema: { querystring: { type: 'object', properties: { src: { type: 'string', maxLength: 40 }, hours: { enum: ['6', '24', '168'] } } } } }, async (req, reply) => {
    const src = req.query.src ?? HUB, hours = Number(req.query.hours ?? 24); let name = 'Hub';
    if (src !== HUB) { const d = dv().getDevice(src); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' }); name = d.name; }
    const { from, to, points } = metrics.query(src, hours);
    const vals = (k) => points.map((p) => p[k]).filter((x) => x != null);
    const min = (xs) => (xs.length ? Math.min(...xs) : null), max = (xs) => (xs.length ? Math.max(...xs) : null);
    const memMin = min(vals('memAvailMB')), tempMax = max(vals('tempC')), hints = [];
    if (memMin != null && memMin < 100) hints.push(`Der freie Arbeitsspeicher fiel auf ${Math.round(memMin)} MB. Das ist knapp. Lade dann keine großen Videos hoch und starte das Gerät bei Gelegenheit neu.`);
    if (tempMax != null && tempMax >= 75) hints.push(`Die Temperatur stieg auf ${Math.round(tempMax)} °C. Prüfe Kühlkörper, Gehäuse und Lüftung.`);
    const first = vals('memAvailMB')[0], lastV = vals('memAvailMB').at(-1);
    if (points.length >= 30 && first != null && lastV != null && first - lastV > 150 && lastV < 250) hints.push('Der freie Speicher sinkt über Stunden stetig. Das spricht für ein Speicherleck. Bitte melde das mit dieser Kurve.');
    return { src, name, hours, from, to, points, summary: { memAvailMin: memMin, memAvailNow: lastV ?? null, tempMax, loadMax: max(vals('load1')) }, hints };
  });

  // ======================= Verbindungstest =======================
  app.get('/api/v1/system/connectivity', { config: { perm: 'devices.read' } }, async () => {
    const checks = [], add = (id, level, title, text, hint = null) => checks.push({ id, level, title, text, hint });
    const addrs = hubAddresses();
    if (addrs.length) add('adresse', 'ok', 'Adresse des Hubs', `Der Hub ist erreichbar unter ${addrs.map((a) => 'https://' + a).join(' oder ')}.`, 'Gib diese Adresse bei der Einrichtung eines Bildschirms an. Die IT sollte dem Hub eine feste Adresse geben (Reservierung im DHCP).');
    else add('adresse', 'bad', 'Adresse des Hubs', 'Der Hub hat keine Netzwerkadresse.', 'Prüfe Netzwerkkabel oder WLAN am Hub.');
    add('name', 'info', 'Name im Netz', 'Der Name dfm-signage.local funktioniert nur im selben Netz (nicht über Router, Firewalls oder zwischen WLAN und Kabel).', 'Wenn der Name nicht geht, benutze die Adresse oben oder bitte die IT um einen festen Namen.');
    add('ports', 'info', 'Freigaben in der Firewall', 'Verwaltungs-PCs und Bildschirme brauchen TCP 443 (und 80 für die Weiterleitung) zum Hub. Im Internet muss nichts offen sein.', 'Wenn ein Laptop die Verwaltung nicht öffnen kann, aber andere Geräte schon, blockiert meist eine Firewall zwischen beiden Netzen.');
    const ch = await chronyTracking();
    if (ch) { const ok = ch.stratum < 16 && ch.leap === 'Normal'; add('uhr', ok ? 'ok' : 'warn', 'Uhr des Hubs', ok ? 'Die Uhr des Hubs ist synchronisiert.' : 'Die Uhr des Hubs ist nicht synchronisiert.', ok ? null : 'Termine laufen sonst zur falschen Zeit. Auf der Startseite „Uhr mit diesem Computer abgleichen“ wählen.'); }
    const m = memInfo(); add('speicher', m.availMB < 100 ? 'warn' : 'ok', 'Arbeitsspeicher des Hubs', `${Math.round(m.availMB)} von ${Math.round(m.totalMB)} MB frei.`, m.availMB < 100 ? 'Das ist knapp. Lade gerade keine großen Videos hoch und starte den Hub bei Gelegenheit neu.' : null);
    const devs = db.prepare("SELECT * FROM devices WHERE status IN ('active','blocked','pending') ORDER BY name").all(); const t = now(); let offline = 0, online = 0;
    for (const d of devs) {
      let st = {}; try { st = d.state_json ? JSON.parse(d.state_json) : {}; } catch {}
      if (d.status === 'pending') { add('d:' + d.id, 'info', d.name, 'Wartet darauf, dass du ihn in der Verwaltung bestätigst.'); continue; }
      if (d.status === 'blocked') { add('d:' + d.id, 'info', d.name, 'Gesperrt.'); continue; }
      const s = deviceStatus(d, t), isHubDev = !!db.prepare("SELECT 1 FROM settings WHERE key='hub.deviceId' AND value=?").get(d.id), extra = [st.signalDbm != null ? `WLAN ${st.signalDbm} dBm` : null, st.timeSynced === false ? 'Uhr nicht gestellt' : null].filter(Boolean).join(' · ');
      if (s.level === 'ok') { online++; add('d:' + d.id, st.timeSynced === false ? 'warn' : 'ok', d.name, `Verbunden${isHubDev ? ' (dieses Gerät ist der Hub)' : ''}${extra ? ' · ' + extra : ''}.`, st.timeSynced === false ? 'Die Uhr des Bildschirms ist noch nicht gestellt; er zeigt bis dahin einen Wartebildschirm.' : null); }
      else { offline++; const age = ago(t - (d.last_seen ?? 0)); add('d:' + d.id, s.level === 'warn' ? 'warn' : 'bad', d.name, d.last_seen ? `Meldet sich seit ${age} nicht. Er zeigt weiter die gespeicherten Inhalte.` : 'Hat sich noch nie gemeldet.', 'Prüfe Strom und Netzwerkkabel bzw. WLAN. Wenn mehrere Bildschirme gleichzeitig ausfallen, prüfe Router, Switch und die Firewall (TCP 443 zum Hub).'); }
    }
    if (offline >= 2 && online + offline >= 3) add('gruppe', 'warn', 'Mehrere Bildschirme gleichzeitig offline', `${offline} von ${online + offline} Bildschirmen melden sich nicht.`, 'Das spricht für ein Netzwerkproblem (Switch, Access Point, Firewall) und nicht für einzelne Geräte.');
    return { now: t, host: 'dfm-signage.local', addresses: addrs, worst: checks.some((c) => c.level === 'bad') ? 'bad' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok', checks };
  });

  // ======================= Grundriss je Etage =======================
  const floorRow = (id) => db.prepare('SELECT * FROM floors WHERE id=?').get(id);
  const nameBody = { type: 'string', minLength: 1, maxLength: 60 };
  app.get('/api/v1/floors', { config: { perm: 'devices.read' } }, async () => {
    const t = now(), devs = db.prepare("SELECT * FROM devices WHERE status='active' ORDER BY name").all();
    const view = (d) => ({ id: d.id, name: d.name, x: d.plan_x, y: d.plan_y, status: deviceStatus(d, t), location: d.location ?? null });
    const floors = db.prepare('SELECT * FROM floors ORDER BY sort, name').all().map((f) => ({ id: f.id, name: f.name, sort: f.sort, hasImage: !!f.has_image, devices: devs.filter((d) => d.floor_id === f.id && d.plan_x != null).map(view) }));
    const placed = new Set(floors.flatMap((f) => f.devices.map((d) => d.id)));
    return { floors, unplaced: devs.filter((d) => !placed.has(d.id)).map(view) };
  });
  app.post('/api/v1/floors', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameBody } } } }, async (req, reply) => {
    const id = randomUUID(), sort = (db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM floors').get().n);
    db.prepare('INSERT INTO floors(id,name,sort,created_at) VALUES(?,?,?,?)').run(id, req.body.name.trim(), sort, now()); A(req, 'etage.angelegt', id, { name: req.body.name }); return reply.code(201).send({ id });
  });
  app.patch('/api/v1/floors/:id', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', additionalProperties: false, properties: { name: nameBody, sort: { type: 'integer', minimum: 0, maximum: 999 } } } } }, async (req, reply) => {
    const f = floorRow(req.params.id); if (!f) return reply.code(404).send({ error: 'Diese Etage gibt es nicht.' });
    db.prepare('UPDATE floors SET name=?, sort=? WHERE id=?').run(req.body.name?.trim() ?? f.name, req.body.sort ?? f.sort, f.id); A(req, 'etage.geaendert', f.id, req.body); return { ok: true };
  });
  app.delete('/api/v1/floors/:id', { config: { perm: 'devices.manage' } }, async (req, reply) => {
    const f = floorRow(req.params.id); if (!f) return reply.code(404).send({ error: 'Diese Etage gibt es nicht.' });
    db.transaction(() => { db.prepare('UPDATE devices SET floor_id=NULL, plan_x=NULL, plan_y=NULL WHERE floor_id=?').run(f.id); db.prepare('DELETE FROM floors WHERE id=?').run(f.id); })();
    try { unlinkSync(join(planDir, f.id + '.jpg')); } catch {} A(req, 'etage.geloescht', f.id, { name: f.name }); return { ok: true };
  });
  app.get('/api/v1/floors/:id/image', { config: { perm: 'devices.read' } }, async (req, reply) => {
    const f = floorRow(req.params.id), file = f ? join(planDir, f.id + '.jpg') : null;
    if (!f?.has_image || !existsSync(file)) return reply.code(404).send({ error: 'Für diese Etage ist noch kein Grundriss hochgeladen.' });
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox"); const r = sendFile(req, reply, file); reply.header('Content-Type', 'image/jpeg'); return r;
  });
  app.put('/api/v1/floors/:id/image', { config: { perm: 'devices.manage' } }, async (req, reply) => {
    const f = floorRow(req.params.id); if (!f) return reply.code(404).send({ error: 'Diese Etage gibt es nicht.' });
    const part = await req.file(); if (!part) return reply.code(400).send({ error: 'Bitte wähle ein Bild aus.' });
    const tmp = join(mediaDir, 'incoming', randomUUID()); mkdirSync(join(mediaDir, 'incoming'), { recursive: true });
    try {
      await pipeline(part.file, createWriteStream(tmp));
      const fd = openSync(tmp, 'r'); const head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0); closeSync(fd);
      if (detectKind(head) !== 'image') return reply.code(400).send({ error: 'Das ist kein Bild. Erlaubt sind JPG, PNG und WebP (z. B. ein Foto oder Export des Grundrisses).' });
      if (statSync(tmp).size > LIMITS.image) return reply.code(400).send({ error: 'Das Bild ist zu groß (höchstens 40 MB).' });
      const out = join(planDir, f.id + '.jpg');
      await sharp(tmp, SHARP_OPTS).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toFile(out + '.tmp');
      renameSync(out + '.tmp', out); db.prepare('UPDATE floors SET has_image=1 WHERE id=?').run(f.id); A(req, 'etage.grundriss_hochgeladen', f.id, {}); return { ok: true };
    } catch (e) { return reply.code(400).send({ error: 'Das Bild konnte nicht gelesen werden. Bitte versuche ein anderes.' }); }
    finally { try { unlinkSync(tmp); } catch {} }
  });
  app.put('/api/v1/devices/:id/plan', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['floorId'], additionalProperties: false, properties: { floorId: { type: ['string', 'null'], maxLength: 40 }, x: { type: 'number', minimum: 0, maximum: 100 }, y: { type: 'number', minimum: 0, maximum: 100 } } } } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const { floorId, x, y } = req.body;
    if (floorId === null) db.prepare('UPDATE devices SET floor_id=NULL, plan_x=NULL, plan_y=NULL WHERE id=?').run(d.id);
    else { if (!floorRow(floorId)) return reply.code(400).send({ error: 'Diese Etage gibt es nicht.' }); if (x == null || y == null) return reply.code(400).send({ error: 'Bitte gib die Position auf dem Grundriss an.' });
      db.prepare('UPDATE devices SET floor_id=?, plan_x=?, plan_y=? WHERE id=?').run(floorId, Math.round(x * 10) / 10, Math.round(y * 10) / 10, d.id); }
    A(req, 'bildschirm.position_gesetzt', d.id, req.body); return { ok: true };
  });
}
extras4Plugin[Symbol.for('skip-override')] = true;
export default extras4Plugin;
