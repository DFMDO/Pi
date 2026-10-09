// Meldung bei Ausfall: Einstellungen (Passwort nur verschlüsselt, nie zurückgegeben), Testmail, Wächter (Verzögerung, gebündelt, Ruhezeit, Fehlerpause, Wiederkehr) und Statusadresse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { SmtpError } from '../lib/smtp.js';

const MIN = 60000;
const mkDev = (h, name, over = {}) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,maintenance_since) VALUES(?,?,'standard',?,?,?,?)").run(id, name, over.status ?? 'active', 'lastSeen' in over ? over.lastSeen : h.clock.t, h.clock.t, over.maintenance ?? null); return id; };
const setSeen = (h, id, t) => h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(t, id);
/** Hub mit Attrappe statt echtem Mailversand */
async function hub(extra = {}) {
  const sent = []; let fail = null;
  const mailer = async (opts, mail) => { if (fail) throw fail; sent.push({ opts, ...mail }); return { accepted: opts.to.length }; };
  const h = await makeHub({ mailer, ...extra }); h.clock.t = Date.UTC(2026, 9, 10, 10, 0); // Samstag 10.10.2026, 12:00 Uhr Berliner Zeit
  const a = await h.as('admin');
  return { h, a, sent, failWith: (e) => { fail = e; } };
}
const config = (a, over = {}) => a('PUT', '/api/v1/alerts/config', { enabled: true, host: 'mail.museum.local', port: 587, security: 'starttls', user: 'signage', password: 'Geheim-Passwort-1', from: 'signage@museum.local', to: ['it@museum.local'], delayMin: 10, ...over });

test('Einstellungen: Standard ist aus; Passwort wird verschlüsselt gespeichert und nie zurückgegeben; Prüfungen und Rechte', async () => {
  const { h, a } = await hub();
  const d = (await a('GET', '/api/v1/alerts/config')).json(); assert.equal(d.enabled, false); assert.equal(d.hasPassword, false); assert.ok(!('passEnc' in d) && !('password' in d));
  const r = await config(a); assert.equal(r.statusCode, 200, r.body); const c = r.json(); assert.equal(c.hasPassword, true); assert.ok(!JSON.stringify(c).includes('Geheim-Passwort-1'));
  const raw = h.db.prepare('SELECT json FROM alert_config WHERE id=1').get().json; assert.ok(!raw.includes('Geheim-Passwort-1'), 'in der Datenbank nur verschlüsselt'); assert.ok(!JSON.stringify(h.db.prepare('SELECT key,value FROM settings').all()).includes('Geheim'), 'nicht in den allgemeinen Einstellungen');
  assert.ok(!JSON.stringify((await a('GET', '/api/v1/settings')).json()).includes('mail.museum.local'), 'Alarm-Einstellungen tauchen nicht in /settings auf');
  assert.equal((await a('PUT', '/api/v1/alerts/config', { port: 2525 })).json().hasPassword, true, 'Teil-Änderung lässt das Passwort stehen'); assert.equal((await a('GET', '/api/v1/alerts/config')).json().port, 2525);
  assert.equal((await a('PUT', '/api/v1/alerts/config', { clearPassword: true })).json().hasPassword, false);
  for (const [bad, re] of [[{ from: 'kaputt' }, /Absender/], [{ to: ['ok@museum.local', 'kaputt'] }, /keine gültige/], [{ host: 'mail server' }, /Leerzeichen/], [{ security: 'none', user: 'x' }, /ohne Verschlüsselung/], [{ delayMin: 1 }, null], [{ port: 0 }, null], [{ to: ['a@b.de', 'c@d.de', 'e@f.de', 'g@h.de', 'i@j.de', 'k@l.de'] }, null], [{ quietFrom: '25h' }, null]]) { const x = await a('PUT', '/api/v1/alerts/config', bad); assert.equal(x.statusCode, 400, JSON.stringify(bad)); if (re) assert.match(x.json().error, re); }
  await a('PUT', '/api/v1/alerts/config', { enabled: false, host: '', from: '', to: [], user: '', security: 'starttls' }); assert.equal((await a('PUT', '/api/v1/alerts/config', { enabled: true })).statusCode, 400, 'Einschalten braucht Server, Absender und Empfänger');
  assert.equal((await (await h.as('edi'))('GET', '/api/v1/alerts/config')).statusCode, 403, 'nur Admins'); assert.equal((await (await h.as('edi'))('PUT', '/api/v1/alerts/config', { enabled: false })).statusCode, 403);
  assert.ok(h.db.prepare("SELECT security FROM audit_log WHERE action='meldung.einstellungen_geaendert'").get().security === 1);
  await h.cleanup();
});

test('Testmail: nutzt das gespeicherte (entschlüsselte) Passwort, meldet Erfolg oder eine verständliche Ursache, bremst Dauerklicken', async () => {
  const { h, a, sent, failWith } = await hub();
  assert.equal((await a('POST', '/api/v1/alerts/test')).statusCode, 400, 'ohne Einstellungen nicht möglich');
  await config(a, { insecureTls: true }); const ok = await a('POST', '/api/v1/alerts/test'); assert.equal(ok.statusCode, 200, ok.body); assert.match(ok.json().text, /it@museum.local/);
  assert.equal(sent.length, 1); assert.equal(sent[0].opts.pass, 'Geheim-Passwort-1', 'Klartext nur für den Versand'); assert.equal(sent[0].opts.rejectUnauthorized, false); assert.deepEqual(sent[0].opts.to, ['it@museum.local']); assert.match(sent[0].subject, /Test/);
  assert.equal((await a('POST', '/api/v1/alerts/test')).statusCode, 429, 'zu schnell hintereinander'); h.clock.t += 6000;
  failWith(new SmtpError('Anmeldung abgelehnt: 535 falsch', 'auth')); const bad = await a('POST', '/api/v1/alerts/test'); assert.equal(bad.statusCode, 400); assert.match(bad.json().error, /Anmeldung abgelehnt/);
  assert.match((await a('GET', '/api/v1/alerts/config')).json().last.text, /Anmeldung abgelehnt/); assert.equal((await a('GET', '/api/v1/alerts/config')).json().last.ok, false);
  await h.cleanup();
});

test('Wächter: meldet erst nach der eingestellten Zeit, nur einmal, gebündelt, und die Wiederkehr; Wartung, Neue und Gesperrte zählen nicht', async () => {
  const { h, a, sent } = await hub(); const foyer = mkDev(h, 'Foyer'), shop = mkDev(h, 'Shop-Screen'), ok = mkDev(h, 'Kasse'); mkDev(h, 'Wartung', { maintenance: Date.now() }); const neu = mkDev(h, 'Neu', { lastSeen: null }); mkDev(h, 'Gesperrt', { status: 'blocked' });
  assert.deepEqual(await h.app.alerts.alertTick(), { skipped: 'aus' }, 'standardmäßig aus'); await config(a);
  const t0 = h.clock.t; for (const id of [foyer, shop, ok]) setSeen(h, id, t0);
  h.clock.t = t0 + 5 * MIN; setSeen(h, ok, h.clock.t); await h.app.alerts.alertTick(); assert.equal(sent.length, 0, 'nach 5 Minuten noch keine Mail (Einstellung: 10)');
  h.clock.t = t0 + 11 * MIN; setSeen(h, ok, h.clock.t); const r = await h.app.alerts.alertTick(); assert.deepEqual(r.down.sort(), ['Foyer', 'Shop-Screen']); assert.equal(sent.length, 1, 'eine gebündelte Mail für beide');
  assert.match(sent[0].subject, /2 Bildschirme/); assert.match(sent[0].text, /Foyer \(seit/); assert.match(sent[0].text, /Shop-Screen \(seit/); assert.ok(!/Kasse|Wartung|Neu|Gesperrt/.test(sent[0].text), 'nur die wirklich Ausgefallenen'); assert.match(sent[0].text, /Firewall/);
  h.clock.t += 5 * MIN; setSeen(h, ok, h.clock.t); await h.app.alerts.alertTick(); assert.equal(sent.length, 1, 'derselbe Ausfall wird nicht noch einmal gemeldet');
  h.clock.t += MIN; setSeen(h, foyer, h.clock.t); setSeen(h, ok, h.clock.t); const up = await h.app.alerts.alertTick(); assert.deepEqual(up.up, ['Foyer']); assert.equal(sent.length, 2); assert.match(sent[1].subject, /„Foyer“ ist wieder erreichbar/); assert.match(sent[1].text, /Ausfall von .* bis /);
  h.clock.t += MIN; setSeen(h, foyer, h.clock.t); setSeen(h, ok, h.clock.t); await h.app.alerts.alertTick(); assert.equal(sent.length, 2, 'Wiederkehr nur einmal'); assert.ok(neu);
  await h.cleanup();
});

test('Wächter: Ruhezeit über Mitternacht (Mail wird danach nachgeholt), Fehlerpause bei kaputtem Mailserver, Mail-Flut-Schutz bei wackelnder Verbindung, Wiederkehr-Mail abschaltbar', async () => {
  const { h, a, sent, failWith } = await hub(); const d = mkDev(h, 'Foyer'); await config(a, { quietFrom: '22:00', quietTo: '07:00' });
  const T = (day, hh, mm) => Date.UTC(2026, 9, day, hh - 2, mm); // Berliner Ortszeit (Sommerzeit, UTC+2)
  setSeen(h, d, T(10, 21, 0)); h.clock.t = T(10, 23, 30); await h.app.alerts.alertTick(); assert.equal(sent.length, 0, 'nachts keine Mail');
  h.clock.t = T(11, 6, 59); await h.app.alerts.alertTick(); assert.equal(sent.length, 0, 'bis 07:00 weiter Ruhe'); h.clock.t = T(11, 7, 1); await h.app.alerts.alertTick(); assert.equal(sent.length, 1, 'nach der Ruhezeit nachgeholt'); assert.match(sent[0].text, /seit 10\.10\. 21:00 Uhr/);

  // Fehlerpause: Mailserver kaputt → nach dem Fehler 5 Minuten Ruhe, dann neuer Versuch; der Ausfall bleibt „ungemeldet“, bis es klappt
  const d2 = mkDev(h, 'Shop-Screen'); setSeen(h, d2, h.clock.t - 20 * MIN); failWith(new SmtpError('Der Mailserver antwortet nicht.', 'timeout'));
  const e1 = await h.app.alerts.alertTick(); assert.match(e1.error, /antwortet nicht/); assert.match(JSON.parse(h.db.prepare('SELECT json FROM alert_config WHERE id=1').get().json).last.text, /antwortet nicht/); // (die Uhr springt in diesem Test um Stunden: Anmeldesitzungen laufen dabei ab, deshalb direkt aus der Datenbank)
  failWith(null); h.clock.t += 2 * MIN; assert.deepEqual(await h.app.alerts.alertTick(), { skipped: 'Pause nach Fehler' }); h.clock.t += 4 * MIN; const e2 = await h.app.alerts.alertTick(); assert.deepEqual(e2.down, ['Shop-Screen']);

  // wackelnde Verbindung: Ausfall → Wiederkehr → erneuter Ausfall binnen 30 Minuten löst keine zweite Ausfall-Mail aus
  const d3 = mkDev(h, 'Kasse'); h.clock.t = T(12, 12, 0); setSeen(h, d3, T(12, 11, 0)); setSeen(h, d, h.clock.t); setSeen(h, d2, h.clock.t); const n0 = sent.length; await h.app.alerts.alertTick(); assert.equal(sent.length, n0 + 2, 'zwei Mails im selben Durchgang: Ausfall von Kasse und Wiederkehr von Foyer/Shop-Screen'); assert.match(sent[n0].subject, /„Kasse“ ist nicht erreichbar/); assert.match(sent[n0 + 1].subject, /2 Bildschirme sind wieder erreichbar/);
  const base = sent.length; h.clock.t += MIN; for (const x of [d, d2, d3]) setSeen(h, x, h.clock.t); await h.app.alerts.alertTick(); assert.equal(sent.length, base + 1, 'Wiederkehr gemeldet'); const afterUp = sent.length;
  h.clock.t += MIN; for (const x of [d, d2]) setSeen(h, x, h.clock.t); setSeen(h, d3, h.clock.t - 11 * MIN); await h.app.alerts.alertTick(); assert.equal(sent.length, afterUp, 'zweiter Ausfall kurz danach: keine neue Mail');
  h.clock.t += 31 * MIN; for (const x of [d, d2]) setSeen(h, x, h.clock.t); await h.app.alerts.alertTick(); assert.equal(sent.length, afterUp + 1, 'dauert er länger als 30 Minuten seit der letzten Mail, kommt sie doch');

  const a2 = await h.as('admin'); await a2('PUT', '/api/v1/alerts/config', { recovery: false }); const d4 = mkDev(h, 'Eingang'); h.clock.t += 60 * MIN; setSeen(h, d, h.clock.t); setSeen(h, d2, h.clock.t); setSeen(h, d3, h.clock.t); setSeen(h, d4, h.clock.t - 15 * MIN); await h.app.alerts.alertTick(); const before = sent.length;
  h.clock.t += MIN; for (const x of [d, d2, d3, d4]) setSeen(h, x, h.clock.t); await h.app.alerts.alertTick(); assert.equal(sent.length, before, 'ohne „Wiederkehr melden“ keine Mail'); assert.equal(h.db.prepare('SELECT down_since FROM alert_state WHERE device_id=?').get(d4).down_since, null, 'Zustand trotzdem zurückgesetzt');
  await h.cleanup();
});

test('Statusadresse: 200 bei „alles gut“, 503 bei Ausfall, Klartext, Lese-Token für die IT-Überwachung (kein Zugriff ohne Anmeldung, Token nur lesend)', async () => {
  const { h, a } = await hub(); const t = h.clock.t; const foyer = mkDev(h, 'Foyer'), shop = mkDev(h, 'Shop-Screen'); mkDev(h, 'Wartung', { lastSeen: t - 3 * 3600e3, maintenance: t });
  const r = await a('GET', '/api/v1/status'); assert.equal(r.statusCode, 200); assert.equal(r.json().status, 'ok'); assert.equal(r.json().summary.total, 3); assert.match(r.json().text, /^OK: alle 3 Bildschirme/); assert.equal(r.headers['cache-control'], 'no-store');
  setSeen(h, shop, t - 3 * MIN); const w = await a('GET', '/api/v1/status'); assert.equal(w.statusCode, 200, 'nur „Keine Verbindung“: Warnung, aber 200'); assert.equal(w.json().status, 'warn'); assert.equal((await a('GET', '/api/v1/status?strict=1')).statusCode, 503, 'strenge Überwachung meldet auch Warnungen');
  setSeen(h, foyer, t - 30 * MIN); const b = await a('GET', '/api/v1/status'); assert.equal(b.statusCode, 503); assert.equal(b.json().status, 'bad'); assert.match(b.json().text, /^FEHLER: Foyer nicht erreichbar; Shop-Screen ohne Verbindung/); assert.deepEqual(b.json().summary, { total: 3, ok: 0, warn: 1, bad: 1 }, 'Gerät in Wartung zählt nicht als Ausfall');
  const txt = await a('GET', '/api/v1/status?format=text'); assert.equal(txt.statusCode, 503); assert.match(txt.headers['content-type'], /text\/plain/); assert.match(txt.body, /^FEHLER:/);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/status' })).statusCode, 401, 'ohne Anmeldung kein Zugriff');
  const tok = (await a('POST', '/api/v1/live-tokens', { name: 'IT-Überwachung' })).json().token; const viaToken = await h.app.inject({ method: 'GET', url: '/api/v1/status', headers: { 'x-live-token': tok } }); assert.equal(viaToken.statusCode, 503); assert.equal(viaToken.json().status, 'bad', 'Lese-Token genügt');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/alerts/config', headers: { 'x-live-token': tok } })).statusCode, 401, 'das Token öffnet nichts anderes');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/status', headers: { 'x-live-token': 'falsch' } })).statusCode, 401);
  assert.equal((await (await h.as('vera'))('GET', '/api/v1/status')).statusCode, 503, 'auch die Anzeige-Rolle darf lesen');
  await h.cleanup();
});
