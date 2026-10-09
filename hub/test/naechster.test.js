// „Nächster Programmpunkt“ (0.2.24): Countdown aus dem Event-Kalender, je Raum eine Folie; Rahmen für Apps mit mehreren Folien.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.js';
import { zonedToEpoch } from '../lib/apps/ical.js';
import { buildNext, parseRooms } from '../lib/apps/builders.js';
import { createApps } from '../lib/apps/index.js';

const MIN = 60000, at = (date, time) => zonedToEpoch(date, time, 'Europe/Berlin');
const ev = (uid, day, from, to, title, loc, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=Europe/Berlin:${day}T${from}00\r\nDTEND;TZID=Europe/Berlin:${day}T${to}00\r\nSUMMARY:${title}\r\n${loc ? `LOCATION:${loc}\r\n` : ''}${extra}END:VEVENT\r\n`;
const ICS = `BEGIN:VCALENDAR\r\n${[
  ev(1, '20261009', '1100', '1200', 'Führung Geschichte', 'Foyer'), ev(2, '20261009', '1300', '1400', 'Vortrag Taktik', 'Saal A'), ev(3, '20261009', '1500', '1600', 'Kinderführung', 'Foyer'),
  ev(4, '20261010', '1000', '1100', 'Workshop Torwart', 'Foyer'), ev(5, '20261009', '1700', '1800', 'Abgesagt', 'Foyer', 'STATUS:CANCELLED\r\n'),
  'BEGIN:VEVENT\r\nUID:6\r\nDTSTART;VALUE=DATE:20261009\r\nDTEND;VALUE=DATE:20261010\r\nSUMMARY:Aktionstag\r\nEND:VEVENT\r\n'].join('')}END:VCALENDAR\r\n`;

test('Nächster Programmpunkt: ohne Raum eine Folie mit Countdown und den folgenden Punkten; ganztägige und abgesagte Termine fehlen', () => {
  const r = buildNext(ICS, at('2026-10-09', '10:40:00'), { title: 'Als Nächstes', maxItems: 3 }); assert.equal(r.slides.length, 1); const s = r.slides[0];
  assert.equal(s.key, ''); assert.equal(s.title, 'Als Nächstes');
  assert.equal(s.body, 'Als Nächstes in 20 Min.:\n11:00 Uhr  Führung Geschichte (Foyer)\n\nDanach:\n13:00 Uhr  Vortrag Taktik (Saal A)\n15:00 Uhr  Kinderführung (Foyer)');
  assert.ok(!/Abgesagt|Aktionstag/.test(s.body));
  assert.equal(buildNext(ICS, at('2026-10-09', '10:40:00'), { maxItems: 1 }).slides[0].body.includes('Danach'), false, 'maxItems 1: nur der nächste Punkt');
});

test('Nächster Programmpunkt: je Raum eine Folie, „läuft gerade“, Morgen, nichts mehr – und der Text ändert sich nicht jede Minute', () => {
  const t = at('2026-10-09', '10:40:00'), r = buildNext(ICS, t, { rooms: 'Foyer, Saal A', maxItems: 3 }); assert.deepEqual(r.slides.map((s) => s.key), ['Foyer', 'Saal A']); assert.deepEqual(r.slides.map((s) => s.title), ['Als Nächstes · Foyer', 'Als Nächstes · Saal A']);
  assert.equal(r.slides[0].body, 'Als Nächstes in 20 Min.:\n11:00 Uhr  Führung Geschichte\n\nDanach:\n15:00 Uhr  Kinderführung', 'Foyer: ohne Ortsangabe, nur Foyer-Termine'); assert.equal(r.slides[1].body, 'Als Nächstes in 2 Std. 20 Min.:\n13:00 Uhr  Vortrag Taktik');
  assert.match(buildNext(ICS, at('2026-10-09', '11:30:00'), { rooms: 'Foyer' }).slides[0].body, /^Läuft gerade \(noch 30 Min\.\):\n11:00 Uhr  Führung Geschichte\n\nAls Nächstes in 3 Std. 30 Min\.:\n15:00 Uhr  Kinderführung/);
  assert.match(buildNext(ICS, at('2026-10-09', '11:59:30'), { rooms: 'Foyer' }).slides[0].body, /^Läuft gerade \(noch 1 Min\.\)/);
  assert.equal(buildNext(ICS, at('2026-10-09', '17:00:00'), { rooms: 'Foyer' }).slides[0].body, 'Als Nächstes morgen um 10:00 Uhr:\nWorkshop Torwart');
  assert.equal(buildNext(ICS, at('2026-10-09', '17:00:00'), { rooms: 'Saal A' }).slides[0].body, 'Heute gibt es hier keine weiteren Programmpunkte.');
  assert.equal(buildNext(ICS, at('2026-10-09', '10:41:00'), { rooms: 'Foyer' }).slides[0].body, buildNext(ICS, at('2026-10-09', '10:44:00'), { rooms: 'Foyer' }).slides[0].body, 'gleicher Text innerhalb derselben Fünf-Minuten-Stufe → keine Verteilung an die Bildschirme');
  assert.notEqual(buildNext(ICS, at('2026-10-09', '10:41:00'), { rooms: 'Foyer' }).slides[0].body, buildNext(ICS, at('2026-10-09', '10:50:00'), { rooms: 'Foyer' }).slides[0].body);
  assert.deepEqual(parseRooms(' Foyer ;Saal A\nFoyer, , Café '), ['Foyer', 'Saal A', 'Café']);
});

const mkApps = async () => {
  const h = await makeHub({}); let t = at('2026-10-09', '10:40:00'), calls = 0, pushes = 0, body = ICS;
  const apps = createApps({ db: h.db, variants: h.app.variants, pushAll: () => { pushes++; }, fetchText: async () => { calls++; return body; }, now: () => t });
  return { h, apps, tick: (ms) => { t += ms; }, set: (x) => { t = x; }, calls: () => calls, pushes: () => pushes, setBody: (b) => { body = b; } };
};
const slideText = (h, type, key) => JSON.parse(h.db.prepare('SELECT m.text_json j FROM app_slides s JOIN media m ON m.id=s.media_id WHERE s.type=? AND s.key=?').get(type, key).j);

test('Apps mit mehreren Folien: Folien je Raum, nur bei Änderung neu schreiben, Kalender höchstens alle 5 Minuten holen, entfernte Räume werden neutral', async () => {
  const { h, apps, tick, calls, pushes, set } = await mkApps();
  assert.throws(() => apps.save('naechster', { enabled: true, config: { url: 'kaputt' } }), /http/);
  apps.save('naechster', { enabled: true, config: { url: 'https://example.org/k.ics', rooms: 'Foyer, Saal A' } });
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE name LIKE 'App: Nächster%'").get().n, 0, 'vor dem ersten Abruf keine Platzhalter-Folie');
  const r1 = await apps.run('naechster'); assert.equal(r1.ok, true); assert.equal(r1.changed, true); assert.equal(pushes(), 1);
  assert.deepEqual(h.db.prepare("SELECT name,folder FROM media WHERE name LIKE 'App: Nächster%' ORDER BY name").all(), [{ name: 'App: Nächster Programmpunkt – Foyer', folder: 'Apps' }, { name: 'App: Nächster Programmpunkt – Saal A', folder: 'Apps' }]);
  assert.match(slideText(h, 'naechster', 'Foyer').body, /Als Nächstes in 20 Min/); assert.equal(slideText(h, 'naechster', 'Saal A').title, 'Als Nächstes · Saal A');
  const l = apps.list().find((x) => x.type === 'naechster'); assert.deepEqual(l.slides.map((s) => s.key), ['Foyer', 'Saal A']); assert.deepEqual(l.hosts, ['example.org']); assert.equal(l.config.url, '(gesetzt)');
  tick(MIN); assert.equal((await apps.run('naechster')).changed, false, 'gleicher Text → nichts neu schreiben'); assert.equal(pushes(), 1); assert.equal(calls(), 1, 'Kalender aus dem Zwischenspeicher');
  tick(5 * MIN); const r3 = await apps.run('naechster'); assert.equal(calls(), 2, 'nach 5 Minuten wieder vom Server'); assert.equal(r3.changed, true, '11 Minuten vor Beginn: anderer Text'); assert.equal(pushes(), 2);
  // Raum entfernt → die Folie sagt es ehrlich
  apps.save('naechster', { enabled: true, config: { rooms: 'Foyer' } }); await apps.run('naechster'); assert.match(slideText(h, 'naechster', 'Saal A').body, /nicht mehr eingerichtet/); assert.match(slideText(h, 'naechster', 'Foyer').body, /Als Nächstes/);
  // Ohne Räume: eine Hauptfolie; die Raum-Folien werden neutral
  apps.save('naechster', { enabled: true, config: { rooms: '' } }); const r5 = await apps.run('naechster'); assert.equal(r5.changed, true);
  const main = h.db.prepare("SELECT m.text_json j FROM apps a JOIN media m ON m.id=a.media_id WHERE a.type='naechster'").get(); assert.equal(JSON.parse(main.j).title, 'Als Nächstes'); assert.match(slideText(h, 'naechster', 'Foyer').body, /nicht mehr eingerichtet/);
  // wieder mit Räumen: die Hauptfolie wird neutral
  apps.save('naechster', { enabled: true, config: { rooms: 'Foyer' } }); await apps.run('naechster'); assert.match(JSON.parse(h.db.prepare("SELECT m.text_json j FROM apps a JOIN media m ON m.id=a.media_id WHERE a.type='naechster'").get().j).body, /nicht mehr eingerichtet/);
  // Fehler: alte Folien bleiben, Meldung sichtbar, nach einer Minute erneut versuchen
  const bad = createApps({ db: h.db, fetchText: async () => { throw new Error('Der Server ist nicht erreichbar.'); }, now: () => at('2026-10-09', '12:00:00') }); set(at('2026-10-09', '12:00:00'));
  assert.equal((await bad.run('naechster')).ok, false); assert.match(bad.list().find((x) => x.type === 'naechster').lastError, /nicht erreichbar/); assert.match(slideText(h, 'naechster', 'Foyer').body, /Als Nächstes/, 'alte Folie bleibt');
  await h.cleanup();
});

test('Nächster Programmpunkt: ohne eigene Adresse gilt die Adresse des Tagesprogramms; ohne beides gibt es eine verständliche Meldung; Abruf jede Minute und nach Mitternacht', async () => {
  const { h, apps, tick, set, calls } = await mkApps();
  apps.save('naechster', { enabled: true, config: {} }); const r0 = await apps.run('naechster'); assert.equal(r0.ok, false); assert.match(r0.error, /Kalender-Adresse/);
  apps.save('tagesprogramm', { enabled: true, config: { url: 'https://kalender.example/museum.ics' } });
  assert.deepEqual(apps.list().find((x) => x.type === 'naechster').hosts, ['kalender.example'], 'zeigt den mitbenutzten Server an');
  const r1 = await apps.run('naechster'); assert.equal(r1.ok, true, r1.error); assert.match(r1.text.body, /Als Nächstes in 20 Min/); assert.equal(calls(), 1);
  assert.equal((await apps.runDue()).filter(([ty]) => ty === 'naechster').length, 0, 'gerade erst gelaufen'); tick(61000); assert.equal((await apps.runDue()).filter(([ty]) => ty === 'naechster').length, 1, 'nach über einer Minute fällig');
  set(at('2026-10-09', '23:59:30')); await apps.run('naechster'); set(at('2026-10-10', '00:00:10')); assert.equal((await apps.runDue()).filter(([ty]) => ty === 'naechster').length, 1, 'Tageswechsel');
  await h.cleanup();
});

test('Nächster Programmpunkt: nur Admin schaltet ein, Redakteur sieht die Folien ohne geheime Adresse', async () => {
  const h = await makeHub({ fetchText: async () => ICS }); const a = await h.as('admin'), e = await h.as('edi');
  const put = await a('PUT', '/api/v1/apps/naechster', { enabled: true, config: { url: 'https://example.org/k.ics', rooms: 'Foyer' } }); assert.equal(put.statusCode, 200, put.body); assert.equal(put.json().ok, true);
  assert.equal((await e('PUT', '/api/v1/apps/naechster', { enabled: false })).statusCode, 403);
  const le = (await e('GET', '/api/v1/apps')).json().find((x) => x.type === 'naechster'); assert.equal(le.config.url, '(gesetzt)'); assert.equal(le.slides[0].name, 'App: Nächster Programmpunkt – Foyer'); assert.equal(le.enabled, true);
  await h.cleanup();
});
