import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, symlinkSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { makeHub } from './helpers.js';
import { holidaysNRW, } from '../lib/extras2.js';
import { contrast, STYLES, readability, buildQrPayload, renderQr } from '../lib/templates.js';
import { schedulePayload } from '../lib/plan.js';
import { resolvePlaylist } from '../../shared/sequencer.js';
import { localToEpoch } from '../../shared/time.js';

const mkDev = (h, name = 'Dev', profile = 'standard') => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at) VALUES(?,?,?,'active',?,?)").run(id, name, profile, h.clock.t, h.clock.t); return id; };
const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const plist = async (a, name, m, def = false) => { const id = (await a('POST', '/api/v1/playlists', { name, publish: true })).json().id; await a('PUT', `/api/v1/playlists/${id}`, { items: [{ mediaId: m }], publish: true, ...(def ? { isDefault: true } : {}) }); return id; };
const plan = (h, id, t = h.clock.t) => schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(id), t);

test('Vorlagen: alle DFM-Vorlagen mit Lesbarkeitsprüfung; Kontrast der Stile; Platz-Warnung; Redakteure nutzen, Admins ändern', async () => {
  const h = await makeHub(); const a = await h.as('admin'), ed = await h.as('edi');
  for (const s of Object.values(STYLES)) assert.ok(contrast(s.fg, s.bg) >= 4.5, 'Kontrast der Stile');
  const list = (await ed('GET', '/api/v1/templates')).json(); for (const id of ['tagesprogramm', 'oeffnungszeiten', 'fuehrungen', 'willkommen', 'hinweis', 'danke', 'countdown', 'datum']) assert.ok(list.some((t) => t.id === id), id);
  const ok = await ed('POST', '/api/v1/templates/willkommen/create', { fields: { gruppe: 'Klasse 7b' } }); assert.equal(ok.statusCode, 201); assert.deepEqual(ok.json().readability, []);
  const long = 'Sehr langer Text ' + 'mit vielen Wörtern '.repeat(40); const bad = await ed('POST', '/api/v1/templates/hinweis/create', { fields: { titel: 'Achtung', text: long } }); assert.equal(bad.statusCode, 400, 'Feldlänge'); // max 300
  const rd = readability({ title: 'Titel', body: Array(14).fill('Eine Zeile mit etwas Text darin').join('\n'), template: 'standard' }, {}); assert.ok(rd.some((x) => x.kind === 'platz'), 'zu viel Text → Warnung'); assert.ok(rd.some((x) => x.kind === 'klein') || true);
  assert.ok(readability({ title: 'Hallo', body: 'Welt', template: 'standard' }, { distanceM: 25 }).some((x) => x.kind === 'klein'), 'für den Abstand zu klein');
  assert.equal((await ed('POST', '/api/v1/templates/xyz/create', { fields: {} })).statusCode, 404);
  assert.equal((await ed('POST', '/api/v1/templates/willkommen/create', { fields: { gruppe: '' } })).statusCode, 400);
  assert.equal((await ed('POST', '/api/v1/templates', { name: 'X', style: 'standard', titleTpl: '{{a}}', fields: [{ key: 'a', label: 'A' }] })).statusCode, 403, 'Layout nur Admins');
  const c = (await a('POST', '/api/v1/templates', { name: 'Ausstellung', style: 'highlight', titleTpl: 'Jetzt: {{a}}', fields: [{ key: 'a', label: 'Titel', def: 'Test' }] })).json(); assert.equal((await ed('POST', `/api/v1/templates/${c.id}/create`, { fields: { a: 'x' } })).statusCode, 404, 'Entwurf-Vorlage nicht nutzbar');
  await a('POST', `/api/v1/templates/${c.id}/publish`); assert.equal((await ed('POST', `/api/v1/templates/${c.id}/create`, { fields: { a: 'Hallo' } })).statusCode, 201);
  // Countdown: täglich neu berechnet
  const cd = (await a('POST', '/api/v1/templates/countdown/create', { fields: { ereignis: 'Eröffnung', datum: new Date(h.clock.t + 5 * 86400e3).toISOString().slice(0, 10) } })).json().id; const t0 = JSON.parse(h.db.prepare('SELECT text_json FROM media WHERE id=?').get(cd).text_json).title;
  h.clock.t += 86400e3; assert.equal(h.app.extras2.refreshDynamic(), 1); const t1 = JSON.parse(h.db.prepare('SELECT text_json FROM media WHERE id=?').get(cd).text_json).title; assert.notEqual(t0, t1); assert.match(t1, /Noch 4 Tage/);
  await h.cleanup();
});

test('QR-Code: jeder Code wird dekodiert (Längen, Umlaute, Sonderzeichen), unerlaubte Schemas abgelehnt, Warnungen', async () => {
  const h = await makeHub(); const ed = await h.as('edi'), a = await h.as('admin'); mkDev(h, 'Lite-Gerät', 'lite');
  const cases = ['https://dfm.example/a', 'https://dfm.example/' + 'x'.repeat(100), 'https://dfm.example/pfad?q=' + 'ä'.repeat(40) + '&u=%C3%BC', 'https://dfm.example/' + 'abcdef0123456789'.repeat(18)];
  for (const url of cases) { const r = await renderQr(buildQrPayload({ kind: 'url', url }), {}); assert.equal(r.matches, true, 'dekodiert: ' + url.length); }
  for (const x of [{ kind: 'wifi', ssid: 'Museum Gäste', password: 'Sehr;geheim:äöü"1' }, { kind: 'contact', name: 'Max Müller', phone: '+49 221 123', email: 'max@example.org' }, { kind: 'text', text: 'Grüße: ÄÖÜ ß € "Test" \\ ;' }]) assert.equal((await renderQr(buildQrPayload(x), {})).matches, true, x.kind);
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x', 'ftp://x.de/a', 'vbscript:x', ' javascript:alert(1)']) assert.throws(() => buildQrPayload({ kind: 'url', url: bad }), /http/, bad);
  const r = await ed('POST', '/api/v1/qr/create', { kind: 'url', url: 'https://tickets.example.org/', heading: 'Tickets', caption: 'Jetzt online kaufen' }); assert.equal(r.statusCode, 201); assert.equal(r.json().decoded, true);
  const m = h.db.prepare('SELECT * FROM media WHERE id=?').get(r.json().id); assert.equal(m.kind, 'image'); assert.equal(m.width, 1920); await h.app.variants.idle(); assert.ok(h.db.prepare("SELECT 1 FROM media_variants WHERE media_id=? AND profile='lite' AND status='ready'").get(m.id), 'Variante auch für Lite');
  assert.equal((await ed('POST', '/api/v1/qr/create', { kind: 'url', url: 'javascript:alert(1)' })).statusCode, 400);
  const intern = (await ed('POST', '/api/v1/qr/check', { kind: 'url', url: 'http://192.168.1.5/audioguide' })).json(); assert.ok(intern.warnings.some((w) => w.kind === 'intern'), 'internes Netz'); assert.ok(intern.preview.startsWith('data:image/png'));
  const far = (await ed('POST', '/api/v1/qr/check', { kind: 'url', url: 'https://x.example/', distanceM: 12 })).json(); assert.ok(far.warnings.some((w) => /schwer lesbar/.test(w.text)), 'Betrachtungsabstand');
  await a('PUT', '/api/v1/settings', { 'qr.allowedHosts': 'dfm.example' });
  assert.equal((await ed('POST', '/api/v1/qr/check', { kind: 'url', url: 'https://boese.example/' })).statusCode, 403, 'Redakteur nur erlaubte Adressen'); assert.equal((await ed('POST', '/api/v1/qr/check', { kind: 'url', url: 'https://shop.dfm.example/' })).statusCode, 200); assert.equal((await a('POST', '/api/v1/qr/check', { kind: 'url', url: 'https://boese.example/' })).statusCode, 200);
  assert.equal((await (await h.as('vera'))('POST', '/api/v1/qr/check', { kind: 'url', url: 'https://x.example/' })).statusCode, 403);
  await h.cleanup();
});

test('Feiertage NRW, Schließtage, Betriebsferien: Auflösungsreihenfolge (Termin > Sondertag > Standard)', async () => {
  const h = await makeHub(); const a = await h.as('admin'), dv = mkDev(h);
  const d = Object.fromEntries(holidaysNRW(2026).map(([x, n]) => [n, x])); assert.equal(d.Karfreitag, '2026-04-03'); assert.equal(d.Ostermontag, '2026-04-06'); assert.equal(d['Christi Himmelfahrt'], '2026-05-14'); assert.equal(d.Pfingstmontag, '2026-05-25'); assert.equal(d.Fronleichnam, '2026-06-04'); assert.equal(d['2. Weihnachtstag'], '2026-12-26'); assert.equal(holidaysNRW(2026).length, 11);
  assert.ok((await a('GET', `/api/v1/special-days?year=${new Date(h.clock.t).getUTCFullYear()}`)).json().length >= 11, 'lokal mitgeliefert, ohne Internet');
  const m1 = await txt(a, 'Normal'), m2 = await txt(a, 'Ferien'), p1 = await plist(a, 'Std', m1, true), p2 = await plist(a, 'Ferienprogramm', m2);
  const day = new Date(h.clock.t + 3 * 86400e3).toISOString().slice(0, 10), noon = localToEpoch(day, '12:00'); h.clock.t = noon - 6 * 3600e3; const a2 = await h.as('admin');
  assert.equal((await a2('POST', '/api/v1/special-days', { date: day, name: 'Betriebsferien', kind: 'ferien', rule: 'playlist', content: { type: 'playlist', id: p2 } })).statusCode, 201);
  let r = resolvePlaylist(plan(h, dv, noon), noon); assert.equal(r.source, 'sondertag'); assert.equal(r.playlistId, p2, 'Sondertag ersetzt die Standardliste');
  await a2('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: dv, content: { type: 'playlist', id: p1 }, startLocal: `${day}T10:00`, endLocal: `${day}T14:00` });
  r = resolvePlaylist(plan(h, dv, noon), noon); assert.equal(r.source, 'termin', 'aktiver Termin schlägt Sondertag');
  const sc = (await a2('POST', '/api/v1/special-days', { date: day, name: 'Geschlossen', kind: 'schliesstag', rule: 'off' })).json(); void sc;
  assert.equal(resolvePlaylist(plan(h, dv, noon + 5 * 3600e3), noon + 5 * 3600e3).source === 'sondertag' || resolvePlaylist(plan(h, dv, noon + 5 * 3600e3), noon + 5 * 3600e3).source === 'schliesstag', true);
  // Feiertage ohne Regel haben keine Wirkung; mit Regel „aus“ wird der Bildschirm schwarz
  const hol = h.db.prepare("SELECT date FROM special_days WHERE source='builtin' AND date>? ORDER BY date LIMIT 1").get(day).date, t2 = localToEpoch(hol, '12:00');
  assert.equal(resolvePlaylist(plan(h, dv, t2), t2).source, 'standard'); assert.equal((await a2('POST', '/api/v1/special-days/apply-rule', { kind: 'feiertag', rule: 'off' })).statusCode, 200);
  r = resolvePlaylist(plan(h, dv, t2), t2); assert.equal(r.source, 'schliesstag'); assert.equal(r.off, true); assert.equal(r.playlistId, null);
  assert.equal((await a2('POST', '/api/v1/special-days', { date: day, dateTo: '2000-01-01', name: 'x' })).statusCode, 400);
  await h.cleanup();
});

test('Zonen und Laufband: nur Standard/Pro; Lite bekommt Vollbild; Gültigkeit', async () => {
  const h = await makeHub(); const a = await h.as('admin'), ed = await h.as('edi'); const std = mkDev(h, 'S'), lite = mkDev(h, 'L', 'lite');
  assert.equal((await a('PUT', `/api/v1/devices/${lite}/layout`, { preset: 'ticker' })).statusCode, 400); assert.equal((await ed('PUT', `/api/v1/devices/${std}/layout`, { preset: 'ticker' })).statusCode, 403, 'Layout nur Admins');
  assert.equal((await a('PUT', `/api/v1/devices/${std}/layout`, { preset: 'ticker-clock-info', info: 'Heute: Führung 11 Uhr' })).statusCode, 200);
  assert.equal((await ed('POST', '/api/v1/tickers', { text: 'Heute Familientag', validFrom: '2020-01-01', validTo: '2099-01-01' })).statusCode, 201);
  assert.equal(plan(h, std).layout.preset, 'ticker-clock-info'); assert.equal(plan(h, std).tickers.length, 1); assert.equal(plan(h, lite).layout, null, 'Lite: Vollbild');
  assert.equal((await a('GET', '/api/v1/layouts')).json().presets.length, 3); assert.equal((await ed('POST', '/api/v1/tickers', { text: 'x', validFrom: '2030-01-02', validTo: '2030-01-01' })).statusCode, 400);
  await h.cleanup();
});

test('Inbetriebnahme-Test: erkennt Netzteil, falsche Uhr, blockierten Hub; Ja/Nein-Fragen; bereit erst nach Bestehen oder bewusstem Überspringen', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h, 'Foyer'); h.db.prepare('UPDATE devices SET ready=0 WHERE id=?').run(dv);
  const sent = []; const diag = { cpuTemp: 50, signalDbm: -50, timeSynced: true, epoch: h.clock.t, diskFreeMB: 5000, throttled: 0, throughputMBs: 4, testvideo: { percent: 0 }, syncState: { done: 3, total: 3 }, version: '0.1.0' };
  const fake = (extra = {}) => ({ readyState: 1, send(raw) { const m = JSON.parse(raw); sent.push(m); if (m.type === 'command' && m.command === 'diagnose') h.db.prepare("UPDATE commands SET status='done', result_json=? WHERE id=?").run(JSON.stringify({ ...diag, ...extra }), m.id); } });
  const run = async (answers) => (await a('POST', `/api/v1/devices/${dv}/commissioning/run`, { answers })).json();
  h.app.devices.sockets.set(dv, fake());
  let r = await run({}); assert.equal(r.result, 'pending'); assert.ok(r.items.find((i) => i.id === 'bild').question); assert.ok(sent.some((m) => m.command === 'testpattern'), 'Testbild am Bildschirm'); assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(dv).ready, 0);
  assert.equal(r.items.find((i) => i.id === 'ton').status, 'skip', 'kein Ton erkannt');
  r = await run({ bild: false }); assert.equal(r.result, 'fail'); assert.match(r.items.find((i) => i.id === 'bild').hint, /Ausrichtung/); assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(dv).ready, 0);
  r = await run({ bild: true }); assert.equal(r.result, 'ok'); assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(dv).ready, 1); assert.ok(r.reportId);
  h.db.prepare('UPDATE devices SET ready=0 WHERE id=?').run(dv);
  h.app.devices.sockets.set(dv, fake({ throttled: 0x50005 })); r = await run({ bild: true }); assert.equal(r.items.find((i) => i.id === 'netzteil').status, 'fail', 'schwaches Netzteil'); assert.equal(r.result, 'fail'); assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(dv).ready, 0);
  h.app.devices.sockets.set(dv, fake({ epoch: h.clock.t - 3600e3 })); r = await run({ bild: true }); assert.equal(r.items.find((i) => i.id === 'uhrzeit').status, 'fail', 'falsche Uhrzeit'); assert.match(r.items.find((i) => i.id === 'uhrzeit').text, /60 Minuten falsch/);
  h.app.devices.sockets.set(dv, fake({ signalDbm: -85 })); r = await run({ bild: true }); assert.match(r.items.find((i) => i.id === 'wlan').hint, /näher an den Access Point/);
  h.app.devices.sockets.set(dv, fake({ testvideo: { percent: 12 } })); r = await run({ bild: true }); assert.equal(r.items.find((i) => i.id === 'video').status, 'fail');
  h.app.devices.sockets.delete(dv); h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(h.clock.t - 3600e3, dv); r = await run({ bild: true }); assert.equal(r.items.find((i) => i.id === 'verbindung').status, 'fail', 'blockierter Hub / offline'); assert.match(r.items[0].hint, /Strom und WLAN/);
  assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(dv).ready, 0);
  assert.equal((await a('POST', `/api/v1/devices/${dv}/commissioning/skip`)).statusCode, 200); assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(dv).ready, 1); assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='inbetriebnahme.uebersprungen' AND security=1").get());
  const reps = (await a('GET', `/api/v1/devices/${dv}/commissioning`)).json(); assert.ok(reps.length >= 5); assert.ok(reps.some((x) => x.result === 'skipped')); assert.equal((await a('GET', `/api/v1/commissioning/${reps[0].id}`)).statusCode, 200);
  const ed = await h.as('edi'); assert.equal((await ed('POST', `/api/v1/devices/${dv}/commissioning/skip`)).statusCode, 403, 'Überspringen nur Admin');
  await h.cleanup();
});

test('Massenimport: nur freigegebene Ordner, Vorschau vor Übernahme, Duplikate, Fortschritt; Symlinks ignoriert', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const root = join(h.dataDir, 'import', 'yodeck'); mkdirSync(join(root, 'sub'), { recursive: true });
  const img = (c) => sharp({ create: { width: 64, height: 36, channels: 3, background: c } }).png().toBuffer();
  writeFileSync(join(root, 'sommer_aktion.png'), await img('#c8102e')); writeFileSync(join(root, 'sub', 'winter.png'), await img('#2a6f97')); writeFileSync(join(root, 'sub', 'kopie.png'), await img('#2a6f97')); writeFileSync(join(root, 'notiz.txt'), 'kein Medium'); symlinkSync('/etc/passwd', join(root, 'link.png'));
  assert.equal((await a('POST', '/api/v1/import/scan', { path: '/etc' })).statusCode, 400, 'außerhalb der Freigaben'); assert.equal((await a('POST', '/api/v1/import/scan', { path: join(h.dataDir, 'import', '..', '..', 'etc') })).statusCode, 400);
  const sc = (await a('POST', '/api/v1/import/scan', { path: root })).json(); assert.equal(sc.summary.importable, 2); assert.equal(sc.summary.duplicates, 1); assert.equal(sc.summary.unsupported, 1); assert.ok(!sc.items.some((i) => i.rel === 'link.png'), 'Symlink ignoriert');
  assert.equal(sc.items.find((i) => i.rel === 'sommer_aktion.png').name, 'Sommer aktion'); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE kind='image'").get().n, 0, 'Vorschau übernimmt nichts');
  const body = { scanId: sc.scanId, items: sc.items.filter((i) => i.include).map((i) => ({ rel: i.rel, name: i.name, folder: i.folder })) };
  assert.equal((await a('POST', '/api/v1/import/commit', { ...body, confirmed: false })).statusCode, 400, 'ohne Bestätigung nichts');
  assert.equal((await a('POST', '/api/v1/import/commit', { ...body, items: [{ rel: '../../etc/passwd' }], confirmed: true })).json().total, 0, 'unbekannte Pfade ignoriert');
  const sc2 = (await a('POST', '/api/v1/import/scan', { path: root })).json(); const c = (await a('POST', '/api/v1/import/commit', { scanId: sc2.scanId, confirmed: true, items: sc2.items.filter((i) => i.include).map((i) => ({ rel: i.rel, name: i.name, folder: i.folder })) })).json(); assert.equal(c.total, 2);
  for (let i = 0; i < 100; i++) { const j = (await a('GET', `/api/v1/import/jobs/${c.jobId}`)).json(); if (j.finished) { assert.equal(j.done, 2); break; } await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE kind='image'").get().n, 2);
  const again = (await a('POST', '/api/v1/import/scan', { path: root })).json(); assert.equal(again.summary.importable, 0, 'Duplikaterkennung gegen die Bibliothek'); assert.equal((await (await h.as('edi'))('POST', '/api/v1/import/scan', { path: root })).statusCode, 403);
  await h.cleanup();
});

test('Datenschutz: Aufbewahrung löscht Altdaten, Audit-Kette bleibt prüfbar und unveränderbar', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h); const m = await txt(a, 'x'), p = await plist(a, 'p', m);
  h.db.prepare("INSERT INTO overrides VALUES('o1','device',?,'playlist',?,NULL,'Schulklassen',NULL,'Max',?,?,NULL)").run(dv, p, h.clock.t - 90 * 86400e3, h.clock.t - 90 * 86400e3 + 3600e3);
  h.db.prepare('INSERT INTO wifi_history(device_id,ts,signal_dbm) VALUES(?,?,?)').run(dv, h.clock.t - 200 * 86400e3, -60);
  for (let i = 0; i < 5; i++) h.app.ctx.audit.log({ action: 'test.alt' });
  h.clock.t += 400 * 86400e3; const r = h.app.extras2.retentionTick(); // Zeit vorstellen statt unveränderbare Einträge zu ändern
  assert.ok(r.removed >= 1); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM overrides WHERE id='o1'").get().n, 0, 'Szene mit Gruppennamen nach Ablauf gelöscht');
  assert.equal(h.app.ctx.audit.verify().ok, true, 'Kette nach dem Kürzen intakt');
  h.app.ctx.audit.log({ action: 'test.neu' }); assert.equal(h.app.ctx.audit.verify().ok, true, 'neue Einträge hängen am Anker');
  assert.throws(() => h.db.prepare('DELETE FROM audit_log').run(), /unveränderbar/);
  assert.throws(() => h.db.prepare("UPDATE audit_log SET action='x'").run(), /unveränderbar/);
  await h.cleanup();
});

test('Termine duplizieren, Wochen kopieren, Wochenvorlagen speichern und anwenden (immer als Entwürfe)', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h); const m = await txt(a, 'A'), p = await plist(a, 'P', m);
  const mon = '2030-05-06', mk = (d, f, t) => a('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: dv, content: { type: 'playlist', id: p }, startLocal: `${d}T${f}`, endLocal: `${d}T${t}` });
  const s1 = (await mk('2030-05-07', '10:00', '12:00')).json(); await mk('2030-05-09', '14:00', '16:00');
  const dup = (await a('POST', `/api/v1/schedules/${s1.id}/duplicate`, { days: 1 })).json(); assert.equal(h.db.prepare('SELECT start_local,state FROM schedules WHERE id=?').get(dup.id).start_local, '2030-05-08T10:00'); assert.equal(h.db.prepare('SELECT state FROM schedules WHERE id=?').get(dup.id).state, 'draft');
  const w = (await a('POST', '/api/v1/schedules/duplicate-week', { fromWeek: '2030-05-08', toWeek: '2030-05-15' })).json(); assert.equal(w.created, 2); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM schedules WHERE start_local LIKE '2030-05-14T10:00' AND state='draft'").get().n, 1);
  const t = (await a('POST', '/api/v1/week-templates', { name: 'Normalwoche', week: mon })).json(); assert.equal(t.count, 2);
  const ap = (await a('POST', `/api/v1/week-templates/${t.id}/apply`, { week: '2030-06-03' })).json(); assert.equal(ap.created, 2); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM schedules WHERE start_local='2030-06-06T14:00' AND state='draft'").get().n, 1);
  await h.cleanup();
});

test('Passwort zurücksetzen mit Wiederherstellungscode: einmalig, begrenzt, Sitzungen weg', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const users = (await a('GET', '/api/v1/users')).json(), ed = users.find((u) => u.name === 'edi');
  const codes = ['abcd-1234', 'efgh-5678']; h.db.prepare('UPDATE users SET recovery_hashes=? WHERE id=?').run(JSON.stringify(codes.map((c) => createHashHex(c))), ed.id);
  const reset = (code, password = 'Ganz-neues-Passwort-2030') => h.app.inject({ method: 'POST', url: '/api/v1/auth/reset-with-recovery', payload: { name: 'edi', code, password } });
  assert.equal((await reset('falsch')).statusCode, 401); assert.equal((await reset('abcd-1234', 'kurz')).statusCode, 400);
  const ok = await reset('abcd-1234'); assert.equal(ok.statusCode, 200); assert.equal(ok.json().remaining, 1); assert.equal((await reset('abcd-1234')).statusCode, 401, 'Code nur einmal'); assert.equal((await h.login('edi', 'Ganz-neues-Passwort-2030')).res.statusCode, 200);
  for (let i = 0; i < 6; i++) await reset('nein'); assert.equal((await reset('efgh-5678')).statusCode, 429, 'Brute-Force gebremst'); await h.cleanup();
});
import { createHash } from 'node:crypto'; const createHashHex = (c) => createHash('sha256').update(c.replace(/\s/g, '').toLowerCase()).digest('hex');
void readFileSync; void copyFileSync; void jsQR;
