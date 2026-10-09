// Erweiterung 5: Apps (Wetter, Datum & Öffnungszeiten, Tagesprogramm aus dem Event-Kalender, Nachrichten, Fußball-Spieltag).
import { createApps, APP_TYPES } from './apps/index.js';
import { can } from './permissions.js';

async function extras5Plugin(app, { db, audit, variants, now = () => Date.now(), fetchText }) {
  const apps = createApps({ db, variants, pushAll: () => app.pushAll?.(), now, ...(fetchText ? { fetchText } : {}) });
  app.decorate('apps', apps);
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail });
  const typeSchema = { type: 'object', required: ['type'], properties: { type: { enum: APP_TYPES } } };

  app.get('/api/v1/apps', { config: { perm: 'devices.read' } }, async (req) => apps.list({ revealSecrets: can(req.user.role, 'settings.manage') }));
  app.put('/api/v1/apps/:type', { config: { perm: 'settings.manage' }, schema: { params: typeSchema, body: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' }, config: { type: 'object' } } } } }, async (req, reply) => {
    const config = { ...(req.body.config ?? {}) }; for (const k of ['url']) if (config[k] === '(gesetzt)') delete config[k]; // die Oberfläche zeigt geheime Adressen nur als „(gesetzt)“
    try { apps.save(req.params.type, { enabled: !!req.body.enabled, config }); } catch (e) { return reply.code(e.status ?? 400).send({ error: e.message }); }
    A(req, 'app.gespeichert', req.params.type, { aktiv: !!req.body.enabled });
    return req.body.enabled ? { ok: true, ...(await apps.run(req.params.type)), text: undefined } : { ok: true };
  });
  app.post('/api/v1/apps/:type/run', { config: { perm: 'settings.manage' }, schema: { params: typeSchema } }, async (req, reply) => {
    try { const r = await apps.run(req.params.type); A(req, 'app.aktualisiert', req.params.type, { ok: r.ok }); return { ...r, text: undefined }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  // regelmäßig aktualisieren (jede Minute prüfen, welche App fällig ist); erster Lauf kurz nach dem Start
  let busy = false; const tick = async () => { if (busy) return; busy = true; try { await apps.runDue(); } catch {} finally { busy = false; } };
  const first = setTimeout(tick, 30000), timer = setInterval(tick, 60000); first.unref(); timer.unref();
  app.addHook('onClose', async () => { clearTimeout(first); clearInterval(timer); });
}
extras5Plugin[Symbol.for('skip-override')] = true;
export default extras5Plugin;
