// Erweiterung 6: Aufräumhilfe für Medien (was wird nirgends mehr benutzt?) und Frage-&-Antwort-Folien.
import { randomUUID } from 'node:crypto';

async function extras6Plugin(app, { db, audit, variants, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });

  /** IDs aller Medien, die irgendwo gebraucht werden (Abspiellisten inkl. Entwürfe, Termine, laufende Übersteuerungen, Sondertage, Szenen, Wochenvorlagen, Apps) */
  function usedIds() {
    const used = new Set();
    for (const r of db.prepare('SELECT media_id FROM playlist_items').all()) used.add(r.media_id);
    for (const r of db.prepare("SELECT content_id FROM schedules WHERE content_type='media'").all()) used.add(r.content_id);
    for (const r of db.prepare("SELECT content_id FROM overrides WHERE content_type='media' AND ended_at IS NULL AND until > ?").all(now())) used.add(r.content_id);
    for (const r of db.prepare("SELECT content_id FROM special_days WHERE content_type='media' AND content_id IS NOT NULL").all()) used.add(r.content_id);
    for (const r of db.prepare('SELECT media_id FROM apps WHERE media_id IS NOT NULL').all()) used.add(r.media_id);
    for (const r of db.prepare('SELECT media_id FROM app_slides').all()) used.add(r.media_id);
    const tor = db.prepare("SELECT value FROM settings WHERE key='live.torMediaId'").get()?.value; if (tor) used.add(tor);
    for (const r of db.prepare("SELECT content_id FROM rules WHERE content_type='media'").all()) used.add(r.content_id);
    const blobs = [...db.prepare('SELECT items_json j FROM scenes').all(), ...db.prepare('SELECT items_json j FROM week_templates').all(), ...db.prepare('SELECT fields_json j FROM templates').all()].map((r) => r.j).join('\n');
    return { used, blobs };
  }
  app.get('/api/v1/media/unused', { config: { perm: 'media.write' } }, async () => {
    const { used, blobs } = usedIds(), t = now(), today = new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    const items = db.prepare('SELECT id,name,kind,size,folder,created_at,valid_until FROM media ORDER BY created_at').all()
      .filter((m) => m.folder !== 'Notfall' && !used.has(m.id) && !blobs.includes(m.id)) // Notfall-Texte bleiben immer bereit
      .map((m) => ({ id: m.id, name: m.name, kind: m.kind, size: m.size ?? 0, folder: m.folder, createdAt: m.created_at, ageDays: Math.floor((t - m.created_at) / 86400000), recent: t - m.created_at < 86400000, expired: !!m.valid_until && m.valid_until < today }));
    return { items, totalBytes: items.reduce((s, m) => s + m.size, 0), hint: 'Das sind Bilder, Videos und Folien, die in keiner Abspielliste, keinem Termin, keiner Szene und keiner App mehr vorkommen. Gelöschtes liegt 30 Tage im Papierkorb.' };
  });

  const txt = (min, max) => ({ type: 'string', minLength: min, maxLength: max });
  app.post('/api/v1/media/quiz', { config: { perm: 'media.write' }, schema: { body: { type: 'object', required: ['question', 'answer'], additionalProperties: false, properties: { question: txt(1, 120), answer: txt(1, 300) } } } }, async (req, reply) => {
    const q = req.body.question.trim(), a = req.body.answer.trim(); if (!q || !a) return reply.code(400).send({ error: 'Bitte gib eine Frage und eine Antwort ein.' });
    const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s), idQ = randomUUID(), idA = randomUUID(), ins = db.prepare("INSERT INTO media(id,name,kind,text_json,folder,created_by,created_at) VALUES(?,?,'text',?,'Quiz',?,?)");
    db.transaction(() => {
      ins.run(idQ, `Frage: ${short(q, 50)}`, JSON.stringify({ title: q, body: '', template: 'frage' }), req.user.id, now());
      ins.run(idA, `Antwort: ${short(q, 40)}`, JSON.stringify({ title: 'Antwort', body: a, template: 'antwort' }), req.user.id, now() + 1);
    })();
    variants?.ensureAll(); A(req, 'quiz.angelegt', idQ, { frage: short(q, 60) }); return reply.code(201).send({ ids: [idQ, idA] });
  });
}
extras6Plugin[Symbol.for('skip-override')] = true;
export default extras6Plugin;
