// Notfall-Meldung mit einem Klick: ein fertiger Text erscheint sofort auf ALLEN Bildschirmen und übersteuert alles andere
// (Termine, Szenen, Schnellaktionen, geteilte Bildschirme). Beendet wird sie von Hand oder nach der eingestellten Zeit.
// Das ist eine Durchsage am Bildschirm, KEINE Alarmanlage und kein Ersatz für Brandschutz-Technik.
import { randomUUID } from 'node:crypto';
import { epochToLocal, localToEpoch, addDays } from '../../shared/time.js';

export const NOTFALL_LABEL = 'NOTFALL';
const hhmm = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
/** Beispieltexte – das Museum prüft und ändert sie (Admin: „Texte ändern“) */
export const DEFAULT_PRESETS = [
  { id: 'raeumung', title: 'Bitte das Gebäude verlassen', text: 'Bitte verlassen Sie das Gebäude ruhig über die gekennzeichneten Ausgänge. Folgen Sie den Anweisungen unseres Personals.' },
  { id: 'stoerung', title: 'Technische Störung', text: 'Wegen einer technischen Störung ist ein Teil unseres Angebots vorübergehend nicht verfügbar. Wir bitten um Ihr Verständnis.' },
  { id: 'geschlossen', title: 'Heute geschlossen', text: 'Das Museum ist heute leider geschlossen. Bitte beachten Sie die Hinweise am Eingang.' },
  { id: 'warten', title: 'Bitte einen Moment Geduld', text: 'Es geht gleich weiter. Vielen Dank für Ihre Geduld.' },
];
const PRESETS_KEY = 'emergency.presets';
const bodyText = { type: 'string', minLength: 1, maxLength: 300 };

async function notfallPlugin(app, { db, audit, variants, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail, security: true });
  const presets = () => { try { const p = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(PRESETS_KEY)?.value ?? 'null'); return Array.isArray(p) && p.length ? p : DEFAULT_PRESETS; } catch { return DEFAULT_PRESETS; } };
  const active = () => db.prepare("SELECT * FROM overrides WHERE label=? AND ended_at IS NULL AND until>? ORDER BY created_at DESC").get(NOTFALL_LABEL, now());
  const view = (o) => !o ? null : { id: o.id, by: o.created_by_name, since: o.created_at, until: o.until, title: JSON.parse(db.prepare('SELECT text_json FROM media WHERE id=?').get(o.content_id)?.text_json ?? '{}').title ?? '' };

  app.get('/api/v1/emergency', { config: { perm: 'overrides.write' } }, async () => ({ presets: presets(), active: view(active()), isDefault: presets() === DEFAULT_PRESETS }));

  app.put('/api/v1/emergency/presets', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', required: ['presets'], additionalProperties: false, properties: { presets: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', required: ['title', 'text'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 60 }, text: bodyText } } } } } } }, async (req, reply) => {
    const list = req.body.presets.map((p, i) => ({ id: `p${i + 1}`, title: p.title.trim(), text: p.text.trim() })).filter((p) => p.title && p.text);
    if (!list.length) return reply.code(400).send({ error: 'Bitte gib mindestens einen Text mit Überschrift ein.' });
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(PRESETS_KEY, JSON.stringify(list)); audit.log({ user: req.user, action: 'notfall.texte_geaendert', ip: req.ip }); return { ok: true, presets: list };
  });

  app.post('/api/v1/emergency/start', { config: { perm: 'overrides.write' }, schema: { body: { type: 'object', additionalProperties: false, properties: { presetId: { type: 'string', maxLength: 20 }, title: { type: 'string', maxLength: 60 }, text: bodyText, minutes: { type: 'integer', minimum: 5, maximum: 1440 }, endOfDay: { type: 'boolean' }, confirm: { type: 'boolean' } } } } }, async (req, reply) => {
    const b = req.body ?? {}; let title, text;
    if (b.presetId) { const p = presets().find((x) => x.id === b.presetId); if (!p) return reply.code(400).send({ error: 'Diesen Text gibt es nicht.' }); ({ title, text } = p); }
    else { text = (b.text ?? '').trim(); title = (b.title ?? '').trim() || 'Wichtige Mitteilung'; if (!text) return reply.code(400).send({ error: 'Bitte wähle einen Text oder schreibe einen eigenen.' }); }
    if (!b.confirm) return reply.code(409).send({ error: `Das zeigt „${title}“ SOFORT auf ALLEN Bildschirmen und überschreibt alles andere. Bitte bestätige.`, needsConfirm: true });
    const t = now(), until = b.endOfDay ? localToEpoch(addDays(epochToLocal(t).date, 1), '00:00') : t + (b.minutes ?? 60) * 60000;
    const json = JSON.stringify({ title, body: text, template: 'notfall' });
    let m = db.prepare("SELECT id FROM media WHERE folder='Notfall' AND text_json=?").get(json)?.id; // gleicher Text: dieselbe Folie wiederverwenden
    if (!m) { m = randomUUID(); db.prepare("INSERT INTO media(id,name,kind,text_json,folder,created_by,created_at) VALUES(?,?,'text',?,'Notfall',?,?)").run(m, `Notfall: ${title}`.slice(0, 100), json, req.user.id, t); }
    const id = randomUUID();
    db.transaction(() => {
      db.prepare('UPDATE overrides SET ended_at=? WHERE ended_at IS NULL AND until>?').run(t, t); // alles andere (auch Szenen) endet
      db.prepare('INSERT INTO overrides VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(id, 'all', null, 'media', m, null, NOTFALL_LABEL, req.user.id, req.user.name, t, until);
    })();
    app.share?.stopAll?.('Notfall-Meldung'); // geteilte Bildschirme enden: die Meldung darf nie verdeckt werden
    variants?.ensureAll(); A(req, 'notfall.gestartet', id, { text: title, bis: new Date(until).toISOString() }); app.pushAll();
    return reply.code(201).send({ id, until, text: `Die Meldung „${title}“ läuft auf allen Bildschirmen, bis ${hhmm(until)} Uhr oder bis du sie beendest.` });
  });

  app.post('/api/v1/emergency/stop', { config: { perm: 'overrides.write' } }, async (req, reply) => {
    const n = db.prepare('UPDATE overrides SET ended_at=? WHERE label=? AND ended_at IS NULL').run(now(), NOTFALL_LABEL).changes;
    if (!n) return reply.code(404).send({ error: 'Es läuft gerade keine Notfall-Meldung.' });
    A(req, 'notfall.beendet', null); app.pushAll(); return { ok: true, text: 'Die Meldung ist beendet. Die Bildschirme zeigen wieder den normalen Plan.' };
  });
}
notfallPlugin[Symbol.for('skip-override')] = true;
export default notfallPlugin;
