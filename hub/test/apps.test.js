// Apps: Auswertung der Daten (Wetter, Fußball, RSS, Öffnungszeiten, Kalender), sicherer Abruf, Rahmen und Rechte – alles mit festen Beispieldaten, ohne Internet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.js';
import { parseIcs, eventsOnDate, zonedToEpoch } from '../lib/apps/ical.js';
import { buildWeather, buildMatchday, parseFeed, buildNews, buildToday, buildProgram } from '../lib/apps/builders.js';
import { checkUrl, fetchText } from '../lib/apps/net.js';
import { createApps, APP_TYPES } from '../lib/apps/index.js';

const at = (date, time) => zonedToEpoch(date, time, 'Europe/Berlin');

// ---------------------------------------------------------------- iCal
const ICS = `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:1\r
DTSTART;TZID=Europe/Berlin:20261009T110000\r
DTEND;TZID=Europe/Berlin:20261009T120000\r
SUMMARY:Führung: Die Geschichte des\r
  Fußballs\r
LOCATION:Foyer\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:2\r
DTSTART:20261009T130000Z\r
DTEND:20261009T140000Z\r
SUMMARY:Vortrag (UTC)\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:3\r
DTSTART;VALUE=DATE:20261009\r
DTEND;VALUE=DATE:20261010\r
SUMMARY:Aktionstag Familien\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:4\r
DTSTART;TZID=Europe/Berlin:20260918T150000\r
DTEND;TZID=Europe/Berlin:20260918T160000\r
RRULE:FREQ=WEEKLY;BYDAY=FR\r
EXDATE;TZID=Europe/Berlin:20261016T150000\r
SUMMARY:Wöchentliche Kinderführung\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:5\r
DTSTART;TZID=Europe/Berlin:20261009T180000\r
DTEND;TZID=Europe/Berlin:20261009T190000\r
STATUS:CANCELLED\r
SUMMARY:Abgesagt\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:6\r
DTSTART;TZID=Europe/Berlin:20260101T100000\r
DTEND;TZID=Europe/Berlin:20260101T110000\r
RRULE:FREQ=MONTHLY;BYDAY=2FR;COUNT=12\r
SUMMARY:Zweiter Freitag\r
END:VEVENT\r
END:VCALENDAR\r
`;
test('iCal: Zeitzonen, UTC, ganztägig, Zeilenumbruch, Wiederholung, Ausnahme, abgesagt', () => {
  const ev = parseIcs(ICS), day = eventsOnDate(ev, '2026-10-09');
  assert.deepEqual(day.map((e) => e.title), ['Aktionstag Familien', 'Zweiter Freitag', 'Führung: Die Geschichte des Fußballs', 'Vortrag (UTC)', 'Wöchentliche Kinderführung'], 'ganztägig zuerst, dann nach Uhrzeit (bei gleicher Zeit nach Titel)');
  const t = Object.fromEntries(day.map((e) => [e.title, e]));
  assert.ok(t['Aktionstag Familien'].allDay, 'ganztägig zuerst'); assert.equal(day[0].title, 'Aktionstag Familien');
  assert.equal(t['Führung: Die Geschichte des Fußballs'].start, at('2026-10-09', '11:00:00')); assert.equal(t['Führung: Die Geschichte des Fußballs'].location, 'Foyer');
  assert.equal(t['Vortrag (UTC)'].start, Date.UTC(2026, 9, 9, 13, 0, 0), 'UTC bleibt UTC (15:00 Uhr Berlin)');
  assert.ok(t['Wöchentliche Kinderführung'], 'freitags'); assert.ok(!day.some((e) => e.title === 'Abgesagt'), 'abgesagt fehlt');
  assert.ok(t['Zweiter Freitag'], '9.10.2026 ist der 2. Freitag im Oktober');
  assert.ok(!eventsOnDate(ev, '2026-10-16').some((e) => e.title === 'Wöchentliche Kinderführung'), 'EXDATE');
  assert.ok(eventsOnDate(ev, '2026-10-23').some((e) => e.title === 'Wöchentliche Kinderführung'));
  assert.ok(!eventsOnDate(ev, '2026-10-10').some((e) => e.title === 'Wöchentliche Kinderführung'), 'nicht samstags');
  assert.ok(eventsOnDate(ev, '2026-12-11').some((e) => e.title === 'Zweiter Freitag'), 'zwölfte und letzte Wiederholung'); assert.ok(!eventsOnDate(ev, '2027-02-12').some((e) => e.title === 'Zweiter Freitag'), 'danach Schluss (COUNT=12)');
});
test('iCal: COUNT begrenzt die Wiederholungen, geänderter Einzeltermin ersetzt das Original, kaputte Datei bricht nicht ab', () => {
  const cnt = parseIcs('BEGIN:VEVENT\nUID:c\nDTSTART:20261001T080000Z\nDTEND:20261001T090000Z\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Drei Tage\nEND:VEVENT');
  assert.equal(eventsOnDate(cnt, '2026-10-03').length, 1); assert.equal(eventsOnDate(cnt, '2026-10-04').length, 0, 'nach COUNT Schluss');
  const ov = parseIcs(`BEGIN:VEVENT\nUID:w\nDTSTART;TZID=Europe/Berlin:20261002T100000\nDTEND;TZID=Europe/Berlin:20261002T110000\nRRULE:FREQ=WEEKLY\nSUMMARY:Serie\nEND:VEVENT
BEGIN:VEVENT\nUID:w\nRECURRENCE-ID;TZID=Europe/Berlin:20261009T100000\nDTSTART;TZID=Europe/Berlin:20261009T140000\nDTEND;TZID=Europe/Berlin:20261009T150000\nSUMMARY:Serie (verschoben)\nEND:VEVENT`);
  const d = eventsOnDate(ov, '2026-10-09'); assert.deepEqual(d.map((e) => e.title), ['Serie (verschoben)']); assert.equal(d[0].start, at('2026-10-09', '14:00:00'));
  assert.deepEqual(parseIcs('kein kalender'), []); assert.deepEqual(parseIcs('BEGIN:VEVENT\nDTSTART:quatsch\nEND:VEVENT'), []);
});
test('iCal: Sommer-/Winterzeit – 11:00 Uhr Berlin bleibt 11:00 Uhr', () => {
  const ev = parseIcs('BEGIN:VEVENT\nUID:s\nDTSTART;TZID=Europe/Berlin:20260601T110000\nDTEND;TZID=Europe/Berlin:20260601T120000\nRRULE:FREQ=WEEKLY;BYDAY=MO\nSUMMARY:Montag\nEND:VEVENT');
  assert.equal(eventsOnDate(ev, '2026-12-07')[0].start, at('2026-12-07', '11:00:00')); assert.equal(eventsOnDate(ev, '2026-06-08')[0].start, at('2026-06-08', '11:00:00'));
});
test('Tagesprogramm: Folie mit Uhrzeit und Ort, Filter nach Ort, leerer Tag, Obergrenze', () => {
  const now = at('2026-10-09', '09:00:00'); const p = buildProgram(ICS, now, { title: 'Heute im Museum' });
  assert.equal(p.title, 'Heute im Museum'); assert.match(p.body, /ganztägig {2}Aktionstag Familien/); assert.match(p.body, /11:00 {2}Führung: Die Geschichte des Fußballs \(Foyer\)/); assert.match(p.body, /15:00 {2}Vortrag/);
  assert.match(buildProgram(ICS, now, { locationFilter: 'foyer' }).body, /Führung/); assert.ok(!/Vortrag/.test(buildProgram(ICS, now, { locationFilter: 'foyer' }).body));
  assert.match(buildProgram(ICS, at('2026-10-10', '09:00:00'), {}).body, /keine besonderen Veranstaltungen/);
  assert.match(buildProgram(ICS, now, { maxEvents: 2 }).body, /und \d+ weitere/);
});

// ---------------------------------------------------------------- Wetter, Fußball, RSS, Öffnungszeiten
test('Wetter: Jetzt, Heute, Morgen und Quelle; Regen wird genannt; ohne Daten klare Fehlermeldung', () => {
  const now = at('2026-10-09', '12:40:00'), h = (d, hh, temp, cond, cloud, pr = 0) => ({ timestamp: `${d}T${String(hh).padStart(2, '0')}:00:00+02:00`, temperature: temp, condition: cond, cloud_cover: cloud, precipitation: pr });
  const hourly = [h('2026-10-09', 6, 9, 'dry', 20), h('2026-10-09', 12, 13, 'rain', 90, 1.4), h('2026-10-09', 18, 11, 'rain', 95, 1.8), h('2026-10-10', 12, 14, 'dry', 30)];
  const w = buildWeather({ hourly, current: { temperature: 12.6, condition: 'rain', cloud_cover: 88 }, nowMs: now, place: 'Dortmund' });
  assert.equal(w.title, 'Wetter in Dortmund'); assert.match(w.body, /Jetzt: 13 °C, Regen/); assert.match(w.body, /Heute: 9 bis 13 °C, Regen \(3,2 mm\)/); assert.match(w.body, /Morgen: 14 bis 14 °C, heiter|Morgen: 14 bis 14 °C, klar|Morgen: 14 bis 14 °C, wolkig/); assert.match(w.body, /Quelle: Deutscher Wetterdienst/);
  assert.throws(() => buildWeather({ hourly: [], current: null, nowMs: now, place: 'X' }), /keine Daten/);
});
test('Fußball: Titel mit Spieltag, ★ für den Lieblingsverein, Ergebnis oder Anstoßzeit', () => {
  const m = [{ matchDateTimeUTC: '2026-10-09T18:30:00Z', matchDateTime: '2026-10-09T20:30:00', matchIsFinished: false, matchResults: [], team1: { teamName: 'Borussia Dortmund', shortName: 'Dortmund' }, team2: { teamName: 'SV Werder Bremen', shortName: 'Bremen' }, group: { groupName: '5. Spieltag' } },
    { matchDateTimeUTC: '2026-10-10T13:30:00Z', matchIsFinished: true, matchResults: [{ resultTypeID: 1, pointsTeam1: 0, pointsTeam2: 1 }, { resultTypeID: 2, pointsTeam1: 2, pointsTeam2: 1 }], team1: { teamName: 'FC Bayern München', shortName: 'Bayern' }, team2: { teamName: 'VfB Stuttgart', shortName: 'Stuttgart' }, group: { groupName: '5. Spieltag' } }];
  const r = buildMatchday(m, { league: 'bl1', favorite: 'Dortmund' });
  assert.equal(r.title, 'Bundesliga – 5. Spieltag'); assert.match(r.body, /★ Dortmund – Bremen {3}Fr 20:30/); assert.match(r.body, /Bayern – Stuttgart {3}2:1/); assert.ok(!/★ Bayern/.test(r.body));
  assert.throws(() => buildMatchday([], {}), /keine Spiele/);
});
test('RSS/Atom: Schlagzeilen mit Umlauten, Sonderzeichen und CDATA; leerer Feed → verständlicher Fehler', () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>Seite</title><item><title><![CDATA[Neue Ausstellung &amp; Mehr]]></title></item><item><title>Fu&#223;ball &ouml;ffnet &lt;b&gt;Türen&lt;/b&gt;</title></item></channel></rss>`;
  assert.deepEqual(parseFeed(rss).map((x) => x.title), ['Neue Ausstellung & Mehr', 'Fußball öffnet Türen']);
  assert.deepEqual(parseFeed('<feed><entry><title type="html">Atom-Meldung</title></entry></feed>').map((x) => x.title), ['Atom-Meldung']);
  assert.match(buildNews(rss, { title: 'Neues', maxItems: 1 }).body, /^• Neue Ausstellung/); assert.throws(() => buildNews('<html></html>', {}), /RSS- oder Atom/);
});
test('Datum & Öffnungszeiten: geöffnet mit letztem Einlass, geschlossen (Wochentag leer und Sondertag)', () => {
  const cfg = { hours: { do: '10:00-18:00', fr: '', so: '10:30-17:00' }, closedDates: ['2026-10-09'], lastEntryMin: 60 };
  const thu = buildToday(at('2026-10-08', '12:00:00'), cfg); assert.match(thu.title, /Donnerstag, 8\. Oktober/); assert.match(thu.body, /geöffnet von 10 bis 18 Uhr/); assert.match(thu.body, /Letzter Einlass: 17 Uhr/);
  assert.match(buildToday(at('2026-10-09', '12:00:00'), cfg).body, /geschlossen/, 'Sondertag'); assert.match(buildToday(at('2026-10-11', '12:00:00'), cfg).body, /10:30 bis 17 Uhr/);
  assert.match(buildToday(at('2026-10-10', '12:00:00'), cfg).body, /geschlossen/, 'Samstag ohne Zeiten = geschlossen');
});

// ---------------------------------------------------------------- sicherer Abruf
test('Abruf: nur http(s), Loopback/Link-Local verboten, Weiterleitungen werden einzeln geprüft, Größen- und Fehlerbehandlung', async () => {
  const lk = async (h) => [{ address: h === 'intern.local' ? '10.1.2.3' : h === 'boese.example' ? '169.254.169.254' : '93.184.216.34' }];
  await assert.rejects(checkUrl('ftp://x', lk), /http/); await assert.rejects(checkUrl('http://127.0.0.1/x', lk), /nicht erlaubt/); await assert.rejects(checkUrl('http://localhost/x', async () => [{ address: '::1' }]), /nicht erlaubt/);
  await assert.rejects(checkUrl('http://boese.example/', lk), /nicht erlaubt/); assert.equal((await checkUrl('http://intern.local/kal.ics', lk)).hostname, 'intern.local', 'private Adressen im Haus sind erlaubt');
  const body = (t) => ({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(t); } });
  const seq = [{ status: 302, headers: new Headers({ location: 'http://boese.example/steal' }) }]; await assert.rejects(fetchText('https://a.example/', { lookupFn: lk, fetchFn: async () => seq[0] }), /nicht erlaubt/, 'Weiterleitung auf verbotene Adresse');
  assert.equal(await fetchText('https://a.example/', { lookupFn: lk, fetchFn: async () => ({ status: 200, ok: true, headers: new Headers(), body: body('hallo') }) }), 'hallo');
  await assert.rejects(fetchText('https://a.example/', { lookupFn: lk, maxBytes: 3, fetchFn: async () => ({ status: 200, ok: true, headers: new Headers(), body: body('zu lang') }) }), /zu groß/);
  await assert.rejects(fetchText('https://a.example/', { lookupFn: lk, fetchFn: async () => ({ status: 403, ok: false, headers: new Headers() }) }), /Anmeldung|verweigert/);
  await assert.rejects(fetchText('https://a.example/', { lookupFn: lk, fetchFn: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } }), /nicht rechtzeitig/);
  let sentAuth = null; await fetchText('https://user:pw@a.example/k.ics', { lookupFn: lk, fetchFn: async (u, o) => { sentAuth = o.headers.authorization; assert.ok(!u.includes('pw'), 'Passwort steht nicht in der Adresse'); return { status: 200, ok: true, headers: new Headers(), body: body('x') }; } });
  assert.match(sentAuth, /^Basic /);
});

// ---------------------------------------------------------------- Rahmen und Routen
test('Rahmen: Folie anlegen, nur bei Änderung neu schreiben und Bildschirme benachrichtigen; Fehler lässt die alte Folie stehen; fällige Apps', async () => {
  const h = await makeHub({}); let t = at('2026-10-09', '09:00:00'), pushes = 0, calls = 0;
  const feed = async () => { calls++; return `<rss><item><title>Meldung ${calls > 2 ? 'B' : 'A'}</title></item></rss>`; };
  const apps = createApps({ db: h.db, variants: h.app.variants, pushAll: () => { pushes++; }, fetchText: feed, now: () => t });
  assert.throws(() => apps.save('rss', { enabled: true, config: { url: 'kein-link' } }), /http/); assert.throws(() => apps.save('gibtsnicht', {}), /gibt es nicht/);
  apps.save('rss', { enabled: true, config: { url: 'https://example.org/feed.xml', title: 'News' } });
  const r1 = await apps.run('rss'); assert.equal(r1.ok, true); assert.equal(r1.changed, true); assert.equal(pushes, 1);
  const media = h.db.prepare("SELECT * FROM media WHERE name='App: Nachrichten (RSS)'").get(); assert.ok(media); assert.equal(media.folder, 'Apps'); assert.match(media.text_json, /Meldung A/);
  assert.equal((await apps.run('rss')).changed, false, 'gleicher Inhalt → nichts neu schreiben'); assert.equal(pushes, 1);
  assert.equal((await apps.run('rss')).changed, true, 'neue Schlagzeile → geändert'); assert.match(h.db.prepare('SELECT text_json FROM media WHERE id=?').get(media.id).text_json, /Meldung B/);
  const bad = createApps({ db: h.db, fetchText: async () => { throw new Error('Der Server ist nicht erreichbar.'); }, now: () => t }); const r3 = await bad.run('rss');
  assert.equal(r3.ok, false); assert.match(h.db.prepare('SELECT text_json FROM media WHERE id=?').get(media.id).text_json, /Meldung B/, 'alte Folie bleibt'); assert.match(bad.list().find((x) => x.type === 'rss').lastError, /nicht erreichbar/);
  calls = 0; t += 60000; assert.equal((await apps.runDue()).length, 0, 'noch nicht fällig (Fehlerzustand: erst nach 5 Min)'); t += 6 * 60000; assert.equal((await bad.runDue()).length, 1, 'nach einem Fehler früher erneut');
  const l = apps.list({ revealSecrets: false }).find((x) => x.type === 'rss'); assert.equal(l.config.url, '(gesetzt)', 'geheime Adresse wird maskiert'); assert.deepEqual(l.hosts, ['example.org']);
  assert.equal(apps.list().length, APP_TYPES.length); await h.cleanup();
});
test('Routen: nur Admin ändert, Redakteur sieht (ohne geheime Adresse), Anzeige nichts; Einschalten holt sofort Daten', async () => {
  const feed = async () => '<rss><item><title>Hallo Museum</title></item></rss>';
  const h = await makeHub({ fetchText: feed }); const a = await h.as('admin'), e = await h.as('edi'), v = await h.as('vera');
  const put = await a('PUT', '/api/v1/apps/rss', { enabled: true, config: { url: 'https://example.org/feed.xml' } }); assert.equal(put.statusCode, 200, put.body); assert.equal(put.json().ok, true); assert.equal(put.json().changed, true);
  assert.equal((await a('PUT', '/api/v1/apps/rss', { enabled: true, config: { url: 'kaputt' } })).statusCode, 400);
  assert.equal((await e('PUT', '/api/v1/apps/rss', { enabled: false })).statusCode, 403); assert.equal((await e('POST', '/api/v1/apps/rss/run')).statusCode, 403); assert.equal((await v('GET', '/api/v1/apps')).statusCode, 403);
  const la = (await a('GET', '/api/v1/apps')).json().find((x) => x.type === 'rss'), le = (await e('GET', '/api/v1/apps')).json().find((x) => x.type === 'rss');
  assert.equal(la.config.url, 'https://example.org/feed.xml'); assert.equal(le.config.url, '(gesetzt)'); assert.match(la.preview.body, /Hallo Museum/);
  assert.equal((await a('PUT', '/api/v1/apps/rss', { enabled: true, config: { url: '(gesetzt)', title: 'Neu' } })).statusCode, 200, 'maskierte Adresse bleibt erhalten');
  assert.equal((await a('PUT', '/api/v1/apps/ufo', { enabled: true })).statusCode, 400); await h.cleanup();
});
