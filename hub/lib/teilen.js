// Bildschirm teilen: Ein angemeldeter Nutzer überträgt seinen PC-Bildschirm (Browser-Aufnahme, als einzelne JPEG-Bilder) über den Hub auf einen oder mehrere
// Museumsbildschirme, zum Beispiel für eine Präsentation. Alles bleibt im Haus (Browser → Hub → Bildschirm), kein Cloud-Dienst.
// Browser-Bildschirme zeigen etwa 5 Bilder pro Sekunde, Bildschirme mit mpv („Video-optimiert“) höchstens eines pro Sekunde (einfache Darstellung).
// Die Übertragung endet von Hand, nach der eingestellten Zeit, ohne Bilder (20 s) oder wenn eine Notfall-Meldung startet.
import { randomUUID } from 'node:crypto';
import { rendererOf } from './plan.js';

const MAX_FRAME = 2.5 * 1024 * 1024, IDLE_MS = 20000, MPV_MIN_GAP_MS = 900;

async function teilenPlugin(app, { db, audit, now = () => Date.now() }) {
  const shares = new Map(), lastRelay = new Map();
  const dv = () => app.devices;
  const mayDevice = (user, d) => !user?.groups || user.role === 'admin' || (!!d.group_id && user.groups.includes(d.group_id));
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const notfallAktiv = () => !!db.prepare("SELECT 1 FROM overrides WHERE label='NOTFALL' AND ended_at IS NULL AND until>?").get(now());
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: MAX_FRAME + 1024 }, (_r, b, d) => d(null, b));

  function stop(s, reason) {
    if (!shares.has(s.id)) return; shares.delete(s.id);
    for (const id of s.devices) dv().sendTo(id, 'share_stop', { id: s.id });
    audit.log({ user: { id: s.userId, name: s.userName }, action: 'teilen.beendet', target: s.id, detail: { grund: reason, bilder: s.frames, minuten: Math.round((now() - s.startedAt) / 60000) } });
  }
  function relay(s, buf) {
    const b64 = buf.toString('base64'), t = now(); let sent = 0;
    for (const id of s.devices) {
      const d = dv().getDevice(id); if (!d) continue;
      if (rendererOf(d) === 'mpv' && t - (lastRelay.get(id) ?? 0) < MPV_MIN_GAP_MS) continue; // mpv lädt jedes Bild als Datei: höchstens ca. eins pro Sekunde
      if (dv().sendTo(id, 'share_frame', { id: s.id, jpg: b64 })) { lastRelay.set(id, t); sent++; }
    }
    return sent;
  }
  /** Abgelaufene (Höchstzeit) oder verwaiste (keine Bilder mehr) Übertragungen beenden */
  const expire = () => { const t = now(); for (const s of [...shares.values()]) { if (t > s.until) stop(s, 'Zeit abgelaufen'); else if (t - s.lastFrame > IDLE_MS) stop(s, 'keine Bilder mehr (Browser geschlossen?)'); } };
  app.decorate('share', { stopAll: (reason) => { for (const s of [...shares.values()]) stop(s, reason); }, active: () => [...shares.values()], expire });
  const timer = setInterval(expire, 5000); timer.unref(); app.addHook('onClose', async () => clearInterval(timer));

  const view = (s, user) => ({ id: s.id, by: s.userName, mine: s.userId === user.id, since: s.startedAt, until: s.until, devices: s.names });

  app.get('/api/v1/share', { config: { perm: 'overrides.write' } }, async (req) => [...shares.values()].map((s) => view(s, req.user)));

  app.post('/api/v1/share', { config: { perm: 'overrides.write' }, schema: { body: { type: 'object', additionalProperties: false, properties: { deviceIds: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 40 } }, all: { type: 'boolean' }, minutes: { type: 'integer', minimum: 5, maximum: 240 } } } } }, async (req, reply) => {
    const b = req.body ?? {}; if (!b.all && !b.deviceIds?.length) return reply.code(400).send({ error: 'Bitte wähle mindestens einen Bildschirm aus.' });
    if (notfallAktiv()) return reply.code(409).send({ error: 'Gerade läuft eine Notfall-Meldung. Solange sie läuft, kann kein Bildschirm geteilt werden.' });
    for (const s of [...shares.values()]) if (s.userId === req.user.id) stop(s, 'neu gestartet'); // pro Person eine Übertragung
    const cand = b.all ? db.prepare("SELECT * FROM devices WHERE status='active' ORDER BY name").all() : b.deviceIds.map((id) => dv().getDevice(id) ?? { id, missing: true });
    const ok = [], skipped = [];
    for (const d of cand) {
      if (d.missing || d.status !== 'active') { skipped.push({ name: d.name ?? 'unbekannt', reason: 'Diesen Bildschirm gibt es nicht.' }); continue; }
      if (!mayDevice(req.user, d)) { skipped.push({ name: d.name, reason: 'Diesen Bildschirm darfst du nicht steuern.' }); continue; }
      if (!dv().sockets.has(d.id)) { skipped.push({ name: d.name, reason: 'Der Bildschirm hat gerade keine Verbindung zum Hub.' }); continue; }
      const other = [...shares.values()].find((s) => s.devices.includes(d.id)); if (other) { skipped.push({ name: d.name, reason: `Wird gerade von ${other.userName} geteilt.` }); continue; }
      ok.push(d);
    }
    if (!ok.length) return reply.code(409).send({ error: skipped.length ? `Kein ausgewählter Bildschirm ist verfügbar: ${skipped.map((s) => `${s.name} (${s.reason})`).join(' ')}` : 'Kein Bildschirm ausgewählt.', skipped });
    const t = now(), s = { id: randomUUID(), userId: req.user.id, userName: req.user.name, devices: ok.map((d) => d.id), names: ok.map((d) => d.name), startedAt: t, until: t + (b.minutes ?? 60) * 60000, lastFrame: t, frames: 0 };
    shares.set(s.id, s); for (const d of ok) dv().sendTo(d.id, 'share_start', { id: s.id });
    audit.log({ user: req.user, action: 'teilen.gestartet', target: s.id, ip: req.ip, detail: { bildschirme: s.names, bis: new Date(s.until).toISOString() } });
    return reply.code(201).send({ id: s.id, until: s.until, text: `Dein Bildschirm wird auf ${s.names.length === 1 ? `„${s.names[0]}“` : `${s.names.length} Bildschirme`} übertragen, höchstens bis ${hhmm(s.until)} Uhr.`,
      devices: ok.map((d) => ({ id: d.id, name: d.name, mode: rendererOf(d) })), skipped, fps: { browser: 5, mpv: 1 }, maxWidth: 1920 });
  });

  app.post('/api/v1/share/:id/frame', { config: { perm: 'overrides.write' }, bodyLimit: MAX_FRAME + 1024 }, async (req, reply) => {
    const s = shares.get(req.params.id); if (!s || (s.userId !== req.user.id && req.user.role !== 'admin')) return reply.code(410).send({ error: 'Die Übertragung ist beendet.' });
    const buf = req.body; if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.length > MAX_FRAME || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return reply.code(400).send({ error: 'Das ist kein gültiges JPEG-Bild.' });
    s.lastFrame = now(); s.frames++; relay(s, buf); return reply.code(204).send();
  });

  app.delete('/api/v1/share/:id', { config: { perm: 'overrides.write' } }, async (req, reply) => {
    const s = shares.get(req.params.id); if (!s) return reply.code(404).send({ error: 'Diese Übertragung läuft nicht mehr.' });
    if (s.userId !== req.user.id && req.user.role !== 'admin') return reply.code(403).send({ error: 'Nur die Person, die teilt, oder ein Admin kann die Übertragung beenden.' });
    stop(s, req.user.id === s.userId ? 'beendet' : `beendet von ${req.user.name}`); return { ok: true, text: 'Die Übertragung ist beendet. Die Bildschirme zeigen wieder den normalen Plan.' };
  });
}
teilenPlugin[Symbol.for('skip-override')] = true;
export default teilenPlugin;
