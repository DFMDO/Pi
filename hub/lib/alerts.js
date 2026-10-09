// Meldung bei Ausfall: Fällt ein Bildschirm aus (und bleibt es länger als eine einstellbare Zeit), geht eine E-Mail über den internen Mailserver des Museums.
// Dazu eine Statusadresse für die IT-Überwachung. Fällt der HUB selbst aus, kann er nichts melden: dafür ist die Statusadresse gedacht (die Überwachung fragt sie ab).
import { epochToLocal } from '../../shared/time.js';
import { encrypt, decrypt } from './crypto.js';
import { sendMail, validEmail, explain } from './smtp.js';
import { deviceStatus } from './devices.js';

export const ALERT_DEFAULT = { enabled: false, host: '', port: 587, security: 'starttls', user: '', passEnc: '', from: '', to: [], delayMin: 10, quietFrom: '', quietTo: '', recovery: true, insecureTls: false, last: null };
const HHMM = '^(\\d{2}:\\d{2})?$';
const clock = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
const stamp = (ms) => `${new Date(ms).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' })} ${clock(ms)} Uhr`;
const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 120 ? `${m} Minuten` : `${Math.round(m / 60)} Stunden`; };
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** Ruhezeit (z. B. 22:00–07:00, auch über Mitternacht): in dieser Zeit gehen keine Mails raus, sie werden danach nachgeholt */
export function inQuiet(cfg, t) {
  if (!cfg.quietFrom || !cfg.quietTo || cfg.quietFrom === cfg.quietTo) return false;
  const n = toMin(epochToLocal(t).time), a = toMin(cfg.quietFrom), b = toMin(cfg.quietTo);
  return a < b ? n >= a && n < b : n >= a || n < b;
}
export function downMail(list, cfg, t) {
  const one = list.length === 1;
  return { subject: one ? `DFM Signage: „${list[0].d.name}“ ist nicht erreichbar` : `DFM Signage: ${list.length} Bildschirme sind nicht erreichbar`,
    text: `${one ? 'Dieser Bildschirm meldet' : 'Diese Bildschirme melden'} sich seit mindestens ${cfg.delayMin} Minuten nicht mehr beim Hub:\n\n${list.map(({ d, st }) => ` - ${d.name} (seit ${stamp(st.down_since)}, jetzt ${mins(t - st.down_since)})`).join('\n')}\n\nDie Bildschirme zeigen weiter ihre gespeicherten Inhalte, Besucher merken zunächst nichts.\nBitte Strom und Netzwerk bzw. WLAN prüfen. Fallen mehrere gleichzeitig aus: Router, Switch, WLAN und die Firewall (Port 443 zum Hub) prüfen.\n\nDiese Nachricht kommt automatisch vom DFM-Signage-Hub.\n` };
}
export function upMail(list, t) {
  const one = list.length === 1;
  return { subject: one ? `DFM Signage: „${list[0].d.name}“ ist wieder erreichbar` : `DFM Signage: ${list.length} Bildschirme sind wieder erreichbar`,
    text: `${one ? 'Dieser Bildschirm ist' : 'Diese Bildschirme sind'} wieder erreichbar:\n\n${list.map(({ d, st }) => ` - ${d.name} (Ausfall von ${stamp(st.down_since)} bis ${clock(d.last_seen ?? t)} Uhr, ${mins((d.last_seen ?? t) - st.down_since)})`).join('\n')}\n\nDiese Nachricht kommt automatisch vom DFM-Signage-Hub.\n` };
}

async function alertsPlugin(app, { db, key, audit, mailer = sendMail, now = () => Date.now() }) {
  const A = (req, action, target, detail) => audit.log({ user: req.user, action, target, ip: req.ip, detail, security: true });
  const load = () => { try { return { ...ALERT_DEFAULT, ...JSON.parse(db.prepare('SELECT json FROM alert_config WHERE id=1').get()?.json ?? '{}') }; } catch { return { ...ALERT_DEFAULT }; } };
  const save = (c) => db.prepare('INSERT OR REPLACE INTO alert_config VALUES(1,?)').run(JSON.stringify(c));
  const pub = (c) => { const { passEnc, ...rest } = c; return { ...rest, hasPassword: !!passEnc }; };
  const mailOpts = (c) => { let pass = ''; try { pass = c.passEnc ? decrypt(key, c.passEnc) : ''; } catch { pass = ''; } return { host: c.host, port: c.port, security: c.security, user: c.user, pass, from: c.from, to: c.to, rejectUnauthorized: !c.insecureTls }; };
  const remember = (ok, text) => { const c = load(); c.last = { ts: now(), ok, text: String(text).slice(0, 300) }; save(c); };

  app.get('/api/v1/alerts/config', { config: { perm: 'settings.manage' } }, async () => pub(load()));
  app.put('/api/v1/alerts/config', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', additionalProperties: false, properties: {
    enabled: { type: 'boolean' }, host: { type: 'string', maxLength: 200 }, port: { type: 'integer', minimum: 1, maximum: 65535 }, security: { enum: ['tls', 'starttls', 'none'] }, user: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 200 }, clearPassword: { type: 'boolean' },
    from: { type: 'string', maxLength: 200 }, to: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } }, delayMin: { type: 'integer', minimum: 5, maximum: 1440 }, quietFrom: { type: 'string', pattern: HHMM }, quietTo: { type: 'string', pattern: HHMM }, recovery: { type: 'boolean' }, insecureTls: { type: 'boolean' } } } } }, async (req, reply) => {
    const b = req.body, c = load();
    for (const k of ['enabled', 'port', 'security', 'delayMin', 'quietFrom', 'quietTo', 'recovery', 'insecureTls']) if (b[k] !== undefined) c[k] = b[k];
    for (const k of ['host', 'user', 'from']) if (b[k] !== undefined) c[k] = b[k].trim();
    if (b.to !== undefined) c.to = b.to.map((x) => x.trim()).filter(Boolean);
    if (b.clearPassword) c.passEnc = ''; else if (b.password) c.passEnc = encrypt(key, b.password);
    if (/[\s/\\]/.test(c.host)) return reply.code(400).send({ error: 'Der Name des Mailservers darf keine Leerzeichen oder Schrägstriche enthalten (nur z. B. mail.museum.local).' });
    if (c.from && !validEmail(c.from)) return reply.code(400).send({ error: 'Die Absender-Adresse ist keine gültige E-Mail-Adresse.' });
    const badTo = c.to.find((x) => !validEmail(x)); if (badTo) return reply.code(400).send({ error: `„${badTo.slice(0, 60)}“ ist keine gültige E-Mail-Adresse.` });
    if (c.user && c.security === 'none') return reply.code(400).send({ error: 'Anmeldung ohne Verschlüsselung ist nicht erlaubt. Bitte „TLS“ oder „STARTTLS“ wählen.' });
    if (c.enabled && (!c.host || !c.from || !c.to.length)) return reply.code(400).send({ error: 'Zum Einschalten fehlen Mailserver, Absender oder Empfänger.' });
    save(c); A(req, 'meldung.einstellungen_geaendert', null, { eingeschaltet: c.enabled, host: c.host }); return pub(c);
  });
  let lastTest = 0;
  app.post('/api/v1/alerts/test', { config: { perm: 'settings.manage' } }, async (req, reply) => {
    const c = load(); if (!c.host || !c.from || !c.to.length) return reply.code(400).send({ error: 'Bitte trage zuerst Mailserver, Absender und Empfänger ein und speichere.' });
    if (now() - lastTest < 5000) return reply.code(429).send({ error: 'Bitte warte einen Moment und versuche es dann noch einmal.' }); lastTest = now();
    try { await mailer(mailOpts(c), { subject: 'DFM Signage: Test der Ausfall-Meldung', text: `Das ist eine Test-Nachricht vom DFM-Signage-Hub.\nWenn du sie liest, funktioniert die Meldung bei Ausfall.\n\nGesendet ${stamp(now())}.\n` }); remember(true, 'Test-E-Mail gesendet'); A(req, 'meldung.test', null, null); return { ok: true, text: `Die Test-E-Mail wurde an ${c.to.join(', ')} gesendet. Bitte prüfe das Postfach (auch den Spam-Ordner).` }; }
    catch (e) { const x = explain(e); remember(false, x.message); return reply.code(400).send({ error: x.message }); }
  });

  // ---- Wächter: alle 30 s prüfen, ob ein Bildschirm zu lange weg ist ----
  let running = false;
  async function alertTick() {
    if (running) return { skipped: 'läuft' }; running = true;
    try {
      const c = load(); if (!c.enabled || !c.host || !c.to.length) return { skipped: 'aus' };
      const t = now(), delay = c.delayMin * 60000, quiet = inQuiet(c, t), downNew = [], upNew = [];
      for (const d of db.prepare("SELECT * FROM devices WHERE status='active'").all()) {
        let st = db.prepare('SELECT * FROM alert_state WHERE device_id=?').get(d.id); const age = d.last_seen ? t - d.last_seen : null;
        if (age != null && age > delay && !d.maintenance_since) { // Ausfall
          if (!st || st.down_since == null) { st = { device_id: d.id, down_since: d.last_seen, notified_at: null, last_mail_at: st?.last_mail_at ?? null }; db.prepare('INSERT OR REPLACE INTO alert_state VALUES(?,?,?,?)').run(st.device_id, st.down_since, null, st.last_mail_at); }
          if (st.notified_at == null && !quiet && (st.last_mail_at == null || t - st.last_mail_at > 30 * 60000)) downNew.push({ d, st });
        } else if (age != null && age < 90000 && st?.down_since != null) { // wieder da
          if (st.notified_at == null || !c.recovery) db.prepare('UPDATE alert_state SET down_since=NULL, notified_at=NULL WHERE device_id=?').run(d.id);
          else if (!quiet) upNew.push({ d, st });
        }
      }
      if (c.last && !c.last.ok && t - c.last.ts < 5 * 60000) return { skipped: 'Pause nach Fehler' }; // Mailserver kaputt: nicht alle 30 s neu versuchen
      const out = { down: [], up: [] };
      if (downNew.length) {
        try { await mailer(mailOpts(c), downMail(downNew, c, t)); for (const { d } of downNew) db.prepare('UPDATE alert_state SET notified_at=?, last_mail_at=? WHERE device_id=?').run(t, t, d.id); out.down = downNew.map(({ d }) => d.name); remember(true, `Ausfall gemeldet: ${out.down.join(', ')}`); }
        catch (e) { remember(false, explain(e).message); return { ...out, error: explain(e).message }; }
      }
      if (upNew.length) {
        try { await mailer(mailOpts(c), upMail(upNew, t)); for (const { d } of upNew) db.prepare('UPDATE alert_state SET down_since=NULL, notified_at=NULL WHERE device_id=?').run(d.id); out.up = upNew.map(({ d }) => d.name); remember(true, `Wieder erreichbar gemeldet: ${out.up.join(', ')}`); }
        catch (e) { remember(false, explain(e).message); return { ...out, error: explain(e).message }; }
      }
      return out;
    } finally { running = false; }
  }
  app.decorate('alerts', { alertTick, load });
  const timer = setInterval(() => { alertTick().catch(() => {}); }, 30000); timer.unref(); app.addHook('onClose', async () => clearInterval(timer));

  // ---- Statusadresse für die IT-Überwachung (Anmeldung wie im Wandmodus: Lese-Token im Header X-Live-Token) ----
  app.get('/api/v1/status', { config: { perm: 'live.read' }, schema: { querystring: { type: 'object', properties: { strict: { type: 'string' }, format: { type: 'string' } } } } }, async (req, reply) => {
    const t = now(), devs = db.prepare("SELECT id,name,last_seen,status,maintenance_since FROM devices WHERE status='active' ORDER BY name").all().map((d) => ({ name: d.name, ...deviceStatus(d, t), lastSeen: d.last_seen ?? null, maintenance: !!d.maintenance_since }));
    const bad = devs.filter((d) => d.level === 'bad' && !d.maintenance), warn = devs.filter((d) => d.level === 'warn' && !d.maintenance);
    const status = bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
    const text = status === 'ok' ? `OK: alle ${devs.length} Bildschirme melden sich.` : `${status === 'bad' ? 'FEHLER' : 'WARNUNG'}: ${[...bad.map((d) => `${d.name} nicht erreichbar`), ...warn.map((d) => `${d.name} ohne Verbindung`)].join('; ')}`;
    const code = status === 'bad' || (status === 'warn' && req.query.strict === '1') ? 503 : 200;
    reply.code(code).header('Cache-Control', 'no-store');
    if (req.query.format === 'text') return reply.type('text/plain; charset=utf-8').send(text + '\n');
    return { status, text, summary: { total: devs.length, ok: devs.filter((d) => d.level === 'ok').length, warn: warn.length, bad: bad.length }, devices: devs.map(({ name, level, label, lastSeen, maintenance }) => ({ name, level, label, lastSeen, maintenance })), time: t };
  });
}
alertsPlugin[Symbol.for('skip-override')] = true;
export default alertsPlugin;
