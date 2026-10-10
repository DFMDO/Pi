// Wiedergabe-Nachweis: Wie oft und wie lange lief welches Medium auf welchem Bildschirm? Die Bildschirme melden Zähler (keine Besucherdaten),
// der Hub summiert sie je Tag und stellt Auswertung und CSV (für Excel) bereit. Gedacht z. B. für Nachweise gegenüber Sponsoren.
import { epochToLocal } from '../../shared/time.js';

const DAYRE = /^\d{4}-\d{2}-\d{2}$/, IDRE = /^[0-9a-f-]{36}$/, DAY = 86400000;
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; };
const dayMs = (d) => Date.parse(d + 'T00:00:00Z');

/** Nimmt die Meldungen der Bildschirme entgegen (streng geprüft, doppelte Zustellung wird erkannt) */
export function createPlays({ db, now = () => Date.now() }) {
  const last = new Map(); let purged = '';
  const up = db.prepare('INSERT INTO plays(day,device_id,media_id,name,kind,plays,seconds) VALUES(?,?,?,?,?,?,?) ON CONFLICT(day,device_id,media_id) DO UPDATE SET plays=plays+excluded.plays, seconds=seconds+excluded.seconds, name=excluded.name, kind=excluded.kind');
  const clampInt = (x, max) => (Number.isFinite(x) ? Math.max(0, Math.min(max, Math.round(x))) : 0);
  /** @returns {{dup?:boolean, rows:number}} */
  function ingest(deviceId, m) {
    if ((last.get(deviceId) ?? -1) >= m.id) return { dup: true, rows: 0 }; // schon verarbeitet (Bestätigung ging unterwegs verloren)
    const today = epochToLocal(now()).date, oldest = dayMs(today) - 400 * DAY; let rows = 0;
    db.transaction(() => {
      for (const [day, medias] of Object.entries(m.days).slice(0, 70)) {
        if (!DAYRE.test(day) || dayMs(day) > dayMs(today) + DAY || dayMs(day) < oldest || !medias || typeof medias !== 'object') continue;
        for (const [id, e] of Object.entries(medias).slice(0, 300)) {
          if (!IDRE.test(id) || !e || typeof e !== 'object') continue;
          const n = clampInt(e.n, 20000), s = clampInt(e.s, 86400 * 2); if (!n && !s) continue;
          up.run(day, deviceId, id, String(e.name ?? '').slice(0, 120), String(e.kind ?? '').slice(0, 12), n, s); rows++;
        }
      }
    })();
    last.set(deviceId, m.id);
    if (purged !== today) { purged = today; try { db.prepare('DELETE FROM plays WHERE day < ?').run(new Date(oldest).toISOString().slice(0, 10)); } catch {} } // Aufbewahrung: 400 Tage
    return { rows };
  }
  return { ingest };
}

async function nachweisPlugin(app, { db, now = () => Date.now() }) {
  const range = (q) => { const to = DAYRE.test(q.to ?? '') ? q.to : epochToLocal(now()).date, from = DAYRE.test(q.from ?? '') ? q.from : new Date(dayMs(to) - 29 * DAY).toISOString().slice(0, 10);
    if (from > to) return { error: 'Das Von-Datum liegt nach dem Bis-Datum.' }; if (dayMs(to) - dayMs(from) > 400 * DAY) return { error: 'Der Zeitraum darf höchstens 400 Tage lang sein.' }; return { from, to }; };
  /** Konten mit Gruppen-Beschränkung sehen nur ihre Bildschirme (wie überall) */
  const allowed = (user) => { if (!user?.groups || user.role === 'admin') return null; const ids = db.prepare("SELECT id,group_id FROM devices WHERE status='active'").all().filter((d) => d.group_id && user.groups.includes(d.group_id)).map((d) => d.id); return new Set(ids); };
  function rows(req, q, r) {
    const al = allowed(req.user); let list = db.prepare('SELECT p.*, d.name AS device FROM plays p LEFT JOIN devices d ON d.id=p.device_id WHERE p.day BETWEEN ? AND ? ORDER BY p.day, d.name, p.name').all(r.from, r.to);
    if (q.deviceId) list = list.filter((x) => x.device_id === q.deviceId); if (al) list = list.filter((x) => al.has(x.device_id));
    return list;
  }
  const schema = { querystring: { type: 'object', additionalProperties: true, properties: { from: { type: 'string', maxLength: 10 }, to: { type: 'string', maxLength: 10 }, deviceId: { type: 'string', maxLength: 40 }, group: { enum: ['media', 'device', 'day'] } } } };

  app.get('/api/v1/reports/plays', { config: { perm: 'system.read' }, schema }, async (req, reply) => {
    const r = range(req.query); if (r.error) return reply.code(400).send({ error: r.error });
    const list = rows(req, req.query, r), group = req.query.group ?? 'media', acc = new Map();
    const names = Object.fromEntries(db.prepare('SELECT id,name FROM media').all().map((m) => [m.id, m.name]));
    for (const x of list) {
      const key = group === 'media' ? x.media_id : group === 'device' ? x.device_id : x.day;
      const e = acc.get(key) ?? { key, plays: 0, seconds: 0, devices: new Set(), name: '', kind: '', removed: false };
      e.plays += x.plays; e.seconds += x.seconds; e.devices.add(x.device_id);
      if (group === 'media') { e.name = names[x.media_id] ?? x.name; e.kind = x.kind; e.removed = !(x.media_id in names); } else if (group === 'device') e.name = x.device ?? 'Gelöschter Bildschirm';
      acc.set(key, e);
    }
    const out = [...acc.values()].map((e) => ({ ...(group === 'media' ? { mediaId: e.key, name: e.name, kind: e.kind, removed: e.removed } : group === 'device' ? { deviceId: e.key, name: e.name } : { day: e.key }), plays: e.plays, seconds: e.seconds, devices: e.devices.size }));
    out.sort((a, b) => (group === 'day' ? a.day.localeCompare(b.day) : b.plays - a.plays));
    return { from: r.from, to: r.to, group, rows: out, totals: { plays: out.reduce((s, x) => s + x.plays, 0), seconds: out.reduce((s, x) => s + x.seconds, 0) },
      devices: db.prepare("SELECT id,name FROM devices WHERE status='active' ORDER BY name").all().filter((d) => !allowed(req.user) || allowed(req.user).has(d.id)),
      hint: 'Gezählt wird jede Einblendung auf einem Bildschirm. Die Zahlen können bei Stromausfall um wenige Minuten abweichen. Bildschirme, die gerade keine Verbindung haben, melden nach.' };
  });

  app.get('/api/v1/reports/plays.csv', { config: { perm: 'system.read' }, schema }, async (req, reply) => {
    const r = range(req.query); if (r.error) return reply.code(400).send({ error: r.error });
    const names = Object.fromEntries(db.prepare('SELECT id,name FROM media').all().map((m) => [m.id, m.name]));
    const head = ['Datum', 'Bildschirm', 'Medium', 'Art', 'Einblendungen', 'Sekunden', 'Minuten'];
    const body = rows(req, req.query, r).map((x) => [x.day, x.device ?? 'Gelöschter Bildschirm', names[x.media_id] ?? x.name, ({ image: 'Bild', video: 'Video', text: 'Text', pdfpage: 'PDF-Seite', stream: 'Live-Bild' })[x.kind] ?? x.kind, x.plays, x.seconds, (x.seconds / 60).toFixed(1).replace('.', ',')].map(csvCell).join(';'));
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="dfm-wiedergabe-${r.from}-bis-${r.to}.csv"`).send('﻿' + [head.join(';'), ...body].join('\r\n') + '\r\n');
  });
}
nachweisPlugin[Symbol.for('skip-override')] = true;
export default nachweisPlugin;
