// Pflege-Erinnerungen: Ein Raspberry Pi im Dauerbetrieb braucht ab und zu Zuwendung (Staub, Netzteil, SD-Karte). Der Hub merkt sich je Bildschirm,
// wann die Aufgaben zuletzt erledigt wurden, und erinnert rechtzeitig auf der Startseite. Ohne Eintrag zählt das Einbaudatum, sonst der Tag, an dem der Bildschirm verbunden wurde.
const DAY = 86400000;
export const TASKS = [
  { id: 'reinigung', title: 'Kühlkörper, Gehäuse und Lüftung reinigen', hint: 'Pi vorher vom Strom nehmen, Staub vorsichtig entfernen (weicher Pinsel oder Druckluft), Lüftungsschlitze frei halten.', months: 12 },
  { id: 'netzteil', title: 'Netzteil und Kabel prüfen', hint: 'Original-Netzteil, Stecker fest, Kabel ohne Knick und Wackelkontakt. Meldet der Hub „Unterspannung“, sofort tauschen.', months: 12 },
  { id: 'sd', title: 'SD-Karte tauschen', hint: 'Eine „High Endurance“-Karte (mindestens 32 GB) mit dem aktuellen Image beschreiben. Vorher das Backup und die Einrichtungsdatei bereitlegen.', months: 24 },
];
const addMonths = (ms, n) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };
const dateMs = (s) => (s ? Date.parse(`${s}T12:00:00Z`) : NaN);
const clampMonths = (n, d) => (Number.isInteger(n) && n >= 1 && n <= 60 ? n : d);

/** Aufgaben mit den eingestellten Abständen (Einstellung care.tasks) */
export function taskConfig(db) {
  let st = {}; try { st = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='care.tasks'").get()?.value ?? '{}'); } catch {}
  return TASKS.map((t) => ({ ...t, months: clampMonths(st[t.id]?.months, t.months), enabled: st[t.id]?.enabled !== false }));
}

/** Je aktivem Bildschirm und Aufgabe: Bezugsdatum, fällig am, Zustand (ok | bald = in 30 Tagen | faellig) */
export function careOverview(db, now, mayDevice = () => true) {
  const tasks = taskConfig(db), done = new Map(db.prepare('SELECT * FROM care_done').all().map((r) => [`${r.device_id}|${r.task}`, r]));
  const groups = Object.fromEntries(db.prepare('SELECT id,name FROM device_groups').all().map((g) => [g.id, g.name]));
  const devices = db.prepare("SELECT id,name,group_id,created_at,installed_at,location FROM devices WHERE status='active' ORDER BY name").all().filter(mayDevice).map((d) => ({
    id: d.id, name: d.name, groupName: groups[d.group_id] ?? null, location: d.location ?? null,
    items: tasks.filter((t) => t.enabled).map((t) => {
      const x = done.get(`${d.id}|${t.id}`), inst = dateMs(d.installed_at);
      const base = x ? { at: x.done_at, kind: 'erledigt', by: x.done_by } : Number.isFinite(inst) ? { at: inst, kind: 'eingebaut' } : { at: d.created_at ?? now, kind: 'verbunden' };
      const dueAt = addMonths(base.at, t.months), status = dueAt <= now ? 'faellig' : dueAt - now <= 30 * DAY ? 'bald' : 'ok';
      return { task: t.id, base: base.kind, baseAt: base.at, by: base.by ?? null, dueAt, status };
    }),
  }));
  const count = (s) => devices.reduce((n, d) => n + d.items.filter((i) => i.status === s).length, 0);
  return { tasks, devices, summary: { faellig: count('faellig'), bald: count('bald') } };
}

/** Hinweise für die Startseite: je Aufgabe eine Zeile mit den betroffenen Bildschirmen (überfällig oder in den nächsten 14 Tagen fällig) */
export function careWarnings(db, now) {
  const o = careOverview(db, now), out = [];
  for (const t of o.tasks.filter((x) => x.enabled)) {
    const hit = o.devices.map((d) => ({ d, i: d.items.find((i) => i.task === t.id) })).filter((x) => x.i && (x.i.status === 'faellig' || x.i.dueAt - now <= 14 * DAY));
    if (!hit.length) continue; const late = hit.filter((x) => x.i.status === 'faellig').length;
    const names = hit.slice(0, 4).map((x) => `„${x.d.name}“`).join(', ') + (hit.length > 4 ? ` und ${hit.length - 4} weitere` : '');
    out.push({ kind: 'pflege', ids: hit.map((x) => x.d.id), text: `Pflege: „${t.title}“ ist ${late ? 'fällig' : 'bald fällig'} bei ${names}. Wenn erledigt, hake es unter Betrieb → Pflege ab.` });
  }
  return out;
}

async function pflegePlugin(app, { db, audit, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });
  const mayDevice = (user) => (d) => !user?.groups || user.role === 'admin' || (!!d.group_id && user.groups.includes(d.group_id));
  app.get('/api/v1/care', { config: { perm: 'devices.read' } }, async (req) => ({ ...careOverview(db, now(), mayDevice(req.user)),
    hint: 'Das ist eine Erinnerung, keine Messung: Der Hub weiß nur, wann du etwas abgehakt hast. Ohne Eintrag zählt das Einbaudatum (Bildschirm bearbeiten) oder der Tag, an dem der Bildschirm verbunden wurde.' }));
  app.post('/api/v1/care/done', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['task', 'deviceIds'], additionalProperties: false, properties: {
    task: { enum: TASKS.map((t) => t.id) }, deviceIds: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: 64 } }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } } } }, async (req, reply) => {
    const t = now(); let at = t; if (req.body.date) { at = dateMs(req.body.date); if (!Number.isFinite(at)) return reply.code(400).send({ error: 'Das Datum ist ungültig.' }); if (at > t + DAY) return reply.code(400).send({ error: 'Das Datum liegt in der Zukunft.' }); at = Math.min(at, t); }
    const ids = [...new Set(req.body.deviceIds)], ok = ids.filter((id) => db.prepare("SELECT 1 FROM devices WHERE id=? AND status='active'").get(id)); if (!ok.length) return reply.code(400).send({ error: 'Bitte wähle mindestens einen Bildschirm.' });
    db.transaction(() => { for (const id of ok) db.prepare('INSERT OR REPLACE INTO care_done(device_id,task,done_at,done_by) VALUES(?,?,?,?)').run(id, req.body.task, at, req.user.name); })();
    A(req, 'pflege.erledigt', req.body.task, { anzahl: ok.length }); return { ok: true, count: ok.length };
  });
  app.put('/api/v1/care/tasks', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', required: ['tasks'], additionalProperties: false, properties: { tasks: { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(TASKS.map((t) => [t.id, { type: 'object', additionalProperties: false, properties: { months: { type: 'integer', minimum: 1, maximum: 60 }, enabled: { type: 'boolean' } } }])) } } } } }, async (req) => {
    const cur = Object.fromEntries(taskConfig(db).map((t) => [t.id, { months: t.months, enabled: t.enabled }]));
    for (const [id, v] of Object.entries(req.body.tasks)) cur[id] = { ...cur[id], ...v };
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('care.tasks', JSON.stringify(cur)); A(req, 'pflege.abstaende_geaendert', null, cur); return { ok: true, tasks: taskConfig(db) };
  });
}
pflegePlugin[Symbol.for('skip-override')] = true;
export default pflegePlugin;
