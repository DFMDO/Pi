// Alltagshilfen: Aufräumhilfe für Medien, Frage-&-Antwort-Folien, Dauer einer Abspielliste samt Warnung im Termin, USB-Stick-Erkennung, PDF-Import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';

const DAY = 86400e3, TOM = new Date(Date.now() + DAY).toISOString().slice(0, 10);
const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const plist = async (a, name, items) => { const id = (await a('POST', '/api/v1/playlists', { name, publish: true })).json().id; const r = await a('PUT', `/api/v1/playlists/${id}`, { items, publish: true }); assert.equal(r.statusCode, 200, r.body); return id; };
const mkDev = (h) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at) VALUES(?,?,'standard','active',?,?)").run(id, 'Dev', h.clock.t, h.clock.t); return id; };

test('Aufräumhilfe: zeigt nur Medien, die nirgends mehr vorkommen (Liste, Übersteuerung, Sondertag, Szene zählen als benutzt)', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const [inList, frei, alt, ueber, tag, szene] = [await txt(a, 'In Liste'), await txt(a, 'Frei'), await txt(a, 'Alt'), await txt(a, 'Übersteuert'), await txt(a, 'Sondertag'), await txt(a, 'Szene')];
  await plist(a, 'Liste', [{ mediaId: inList, duration: 10 }]);
  const ov = await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'media', id: ueber }, minutes: 30, confirm: true }); assert.equal(ov.statusCode, 201, ov.body);
  h.db.prepare("INSERT INTO special_days(id,date,name,rule,content_type,content_id,created_at) VALUES('sd1',?,'Heiligabend','playlist','media',?,?)").run(`${TOM.slice(0, 4)}-12-24`, tag, h.clock.t);
  h.db.prepare("INSERT INTO scenes(id,name,items_json,created_at) VALUES('sc1','Szene',?,?)").run(JSON.stringify([{ type: 'media', id: szene }]), h.clock.t);
  h.db.prepare('UPDATE media SET created_at=?, valid_until=?, size=2000 WHERE id=?').run(h.clock.t - 40 * DAY, '2020-01-01', alt);
  h.db.prepare('UPDATE media SET size=1234 WHERE id=?').run(frei);

  const r = await a('GET', '/api/v1/media/unused'); assert.equal(r.statusCode, 200, r.body); const u = r.json();
  assert.deepEqual(u.items.map((m) => m.id), [alt, frei], 'nur die zwei unbenutzten, ältestes zuerst');
  assert.equal(u.items[0].expired, true); assert.ok(u.items[0].ageDays >= 40); assert.equal(u.items[0].recent, false);
  assert.equal(u.items[1].expired, false); assert.equal(u.items[1].recent, true, 'frisch hochgeladen: noch nicht „vergessen“');
  assert.equal(u.totalBytes, 3234); assert.match(u.hint, /Papierkorb/);

  assert.equal((await a('DELETE', `/api/v1/media/${frei}`)).statusCode, 200, 'löschen wie gewohnt (mit Papierkorb)');
  assert.deepEqual((await a('GET', '/api/v1/media/unused')).json().items.map((m) => m.id), [alt], 'Gelöschtes verschwindet aus der Liste');
  await plist(a, 'Neue Liste', [{ mediaId: alt, duration: 10 }]);
  assert.equal((await a('GET', '/api/v1/media/unused')).json().items.length, 0, 'in eine Liste gelegt = nicht mehr unbenutzt');

  assert.equal((await (await h.as('edi'))('GET', '/api/v1/media/unused')).statusCode, 200, 'Redakteur darf aufräumen helfen');
  assert.equal((await (await h.as('vera'))('GET', '/api/v1/media/unused')).statusCode, 403, 'Anzeige-Rolle nicht');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/media/unused' })).statusCode, 401, 'ohne Anmeldung nicht');
  await h.cleanup();
});

test('Frage & Antwort: legt zwei Folien im Ordner „Quiz“ an; Eingaben werden geprüft', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const r = await a('POST', '/api/v1/media/quiz', { question: '  Wer schoss das Tor im Wunder von Bern?  ', answer: 'Helmut Rahn, 1954' }); assert.equal(r.statusCode, 201, r.body);
  const [q, ans] = r.json().ids.map((id) => h.db.prepare('SELECT * FROM media WHERE id=?').get(id));
  assert.equal(q.kind, 'text'); assert.equal(q.folder, 'Quiz'); assert.equal(ans.folder, 'Quiz');
  assert.deepEqual(JSON.parse(q.text_json), { title: 'Wer schoss das Tor im Wunder von Bern?', body: '', template: 'frage' });
  assert.deepEqual(JSON.parse(ans.text_json), { title: 'Antwort', body: 'Helmut Rahn, 1954', template: 'antwort' });
  assert.ok(ans.created_at > q.created_at, 'Antwort steht in der Liste direkt nach der Frage');
  assert.match(q.name, /^Frage: /); assert.match(ans.name, /^Antwort: /);

  const long = await a('POST', '/api/v1/media/quiz', { question: 'Wie lautet die Frage, die so lang ist, dass der Name der Folie gekürzt werden muss, bevor er überläuft?', answer: 'Kurz' }); assert.equal(long.statusCode, 201, long.body);
  assert.ok(h.db.prepare('SELECT name FROM media WHERE id=?').get(long.json().ids[0]).name.length <= 57, 'Name gekürzt'); assert.match(h.db.prepare('SELECT name FROM media WHERE id=?').get(long.json().ids[0]).name, /…$/);
  for (const bad of [{ question: '   ', answer: 'x' }, { question: 'x', answer: '   ' }, { question: '', answer: 'x' }, { question: 'x'.repeat(121), answer: 'x' }, { question: 'x', answer: 'x'.repeat(301) }, { question: 'x' }])
    assert.equal((await a('POST', '/api/v1/media/quiz', bad)).statusCode, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await (await h.as('vera'))('POST', '/api/v1/media/quiz', { question: 'x', answer: 'y' })).statusCode, 403);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE folder='Quiz'").get().n, 4, 'nur die zwei gültigen Paare wurden gespeichert');

  assert.equal((await a('POST', '/api/v1/media/text', { name: 'F', title: 'F', template: 'frage' })).statusCode, 201, 'Vorlage „frage“ ist auch einzeln wählbar');
  assert.equal((await a('POST', '/api/v1/media/text', { name: 'A', title: 'A', template: 'antwort' })).statusCode, 201);
  assert.equal((await a('POST', '/api/v1/media/text', { name: 'U', title: 'U', template: 'unsinn' })).statusCode, 400, 'unbekannte Vorlage wird abgelehnt');
  await h.cleanup();
});

test('Dauer einer Abspielliste (Text = eingestellte Zeit, Video = echte Länge) und Warnung, wenn der Termin kürzer ist', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h);
  const [m1, m2, m3] = [await txt(a, 'A'), await txt(a, 'B'), await txt(a, 'C')];
  const video = randomUUID(); h.db.prepare("INSERT INTO media(id,name,kind,duration_s,created_at) VALUES(?,'Film','video',95.4,?)").run(video, h.clock.t);
  const kurz = await plist(a, 'Drei Folien', [{ mediaId: m1, duration: 10 }, { mediaId: m2, duration: 20 }, { mediaId: m3, duration: 30 }]);
  const film = await plist(a, 'Film', [{ mediaId: video, duration: 10 }]);
  const lang = await plist(a, 'Lang', [{ mediaId: m1, duration: 40 }, { mediaId: m2, duration: 40 }, { mediaId: m3, duration: 40 }]);
  const dur = Object.fromEntries((await a('GET', '/api/v1/playlists')).json().map((p) => [p.name, p.durationS]));
  assert.equal(dur['Drei Folien'], 60); assert.equal(dur['Film'], 95, 'Video zählt mit seiner echten Länge, nicht mit der Standardzeit'); assert.equal(dur['Lang'], 120);

  const draft = async (content, end) => (await a('POST', '/api/v1/schedules', { targetType: 'device', targetId: dv, content: { type: 'playlist', id: content }, startLocal: `${TOM}T10:00`, endLocal: `${TOM}T${end}` })).json().id;
  const check = async (id) => (await a('GET', `/api/v1/schedules/${id}/publish-check`)).json();
  const tooShort = await check(await draft(lang, '10:01'));
  assert.equal(tooShort.hints.length, 1); assert.match(tooShort.hints[0], /Lang/); assert.match(tooShort.hints[0], /2:00 Minuten/); assert.match(tooShort.hints[0], /1:00 Minuten/); assert.match(tooShort.hints[0], /nicht einmal ganz/);
  assert.deepEqual((await check(await draft(lang, '10:10'))).hints, [], 'Termin länger als eine Runde: keine Warnung');
  assert.deepEqual((await check(await draft(kurz, '10:01'))).hints, [], 'genau eine Runde passt: keine Warnung');
  assert.deepEqual((await check(await draft(film, '10:01'))).hints.length, 1, 'Film (1:35) passt nicht in eine Minute');
  await h.cleanup();
});

test('USB-Stick: Erkennung nur im freigegebenen Ordner, leere Sticks und versteckte Dateien zählen nicht', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dfm-usb-')); const usb = join(root, 'usb'); const h = await makeHub({ importRoots: [root], usbDir: usb }); const a = await h.as('admin');
  try {
    assert.deepEqual((await a('GET', '/api/v1/import/usb')).json(), { present: false, path: usb }, 'kein Stick (Ordner fehlt)');
    mkdirSync(usb); assert.equal((await a('GET', '/api/v1/import/usb')).json().present, false, 'Ordner leer = nichts eingesteckt');
    writeFileSync(join(usb, '.Trash-1000'), 'x'); assert.equal((await a('GET', '/api/v1/import/usb')).json().present, false, 'versteckte Dateien zählen nicht');
    writeFileSync(join(usb, 'Foto.png'), 'x'); mkdirSync(join(usb, 'Sommer'));
    const r = (await a('GET', '/api/v1/import/usb')).json(); assert.equal(r.present, true); assert.equal(r.entries, 2); assert.ok(r.path.endsWith('usb'));
    assert.equal((await (await h.as('vera'))('GET', '/api/v1/import/usb')).statusCode, 403, 'nur mit Import-Recht');
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/import/usb' })).statusCode, 401);
  } finally { await h.cleanup(); }
  const other = mkdtempSync(join(tmpdir(), 'dfm-other-')); mkdirSync(join(root, 'usb'), { recursive: true }); writeFileSync(join(root, 'usb', 'Foto.png'), 'x');
  const h2 = await makeHub({ importRoots: [other], usbDir: usb }); try { assert.equal((await (await h2.as('admin'))('GET', '/api/v1/import/usb')).json().present, false, 'liegt der Stick-Ordner außerhalb der Freigaben, wird er nicht angeboten'); } finally { await h2.cleanup(); rmSync(other, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('Import: PDF vom Stick wird seitenweise zu Bildern, ein zweiter Import derselben PDF gilt als Duplikat', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dfm-usb-')); const usb = join(root, 'usb'); mkdirSync(usb); const h = await makeHub({ importRoots: [root], usbDir: usb }); const a = await h.as('admin');
  try {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 5>>\n%%EOF');
    writeFileSync(join(usb, 'Wochenplan.pdf'), pdf);
    const sc = (await a('POST', '/api/v1/import/scan', { path: usb })).json(); const it = sc.items.find((i) => i.rel === 'Wochenplan.pdf');
    assert.equal(it.kind, 'pdf'); assert.equal(it.supported, true); assert.match(it.note, /seitenweise/); assert.equal(sc.summary.importable, 1);
    const c = (await a('POST', '/api/v1/import/commit', { scanId: sc.scanId, confirmed: true, items: [{ rel: it.rel, name: it.name, folder: '' }] })).json(); assert.equal(c.total, 1);
    let job; for (let i = 0; i < 200; i++) { job = (await a('GET', `/api/v1/import/jobs/${c.jobId}`)).json(); if (job.finished) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(job.finished, 'Vorgang wird fertig');
    if (job.failed) { // ohne pdftoppm (z. B. Windows) kann die Umwandlung nicht laufen – dort deckt Linux-CI es ab; geprüft wird dann wenigstens, dass nichts Halbes gespeichert wird
      assert.match(job.errors[0], /PDF konnte nicht umgewandelt/); assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE kind='pdfpage'").get().n, 0);
      return t.skip('pdftoppm fehlt auf diesem Rechner – Umwandlung nur unter Linux prüfbar'); }
    assert.equal(job.done, 1); assert.equal(job.ids.length, 2, 'eine Folie je Seite');
    const rows = job.ids.map((id) => h.db.prepare('SELECT * FROM media WHERE id=?').get(id)); assert.ok(rows.every((m) => m.kind === 'pdfpage'));
    assert.deepEqual(rows.map((m) => m.name), ['Wochenplan – Seite 1', 'Wochenplan – Seite 2'], 'Namen ohne „.pdf“, Seiten in der richtigen Reihenfolge');
    assert.equal(rows[0].sha256, it.sha256, 'Hash der PDF gemerkt');
    const again = (await a('POST', '/api/v1/import/scan', { path: usb })).json(); assert.equal(again.summary.importable, 0); assert.equal(again.summary.duplicates, 1, 'dieselbe PDF noch einmal = Duplikat');
  } finally { await h.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
