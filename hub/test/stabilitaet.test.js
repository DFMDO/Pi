// Version 0.2.28 – Stabilität: Ein einzelner Fehler (kaputte Daten, hängendes Programm, kurze Datenbanksperre) darf nie den Hub beenden
// oder eine ganze Seite unbrauchbar machen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseJson, guarded, safeInterval, installProcessGuards } from '../../shared/guard.js';
import { openDb } from '../lib/db.js';
import { fitState } from '../lib/devices.js';
import { deviceWarnings } from '../lib/health.js';
import { run } from '../lib/variants.js';
import { makeHub } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtempSync(join(tmpdir(), 'dfm-stab-'));

test('parseJson: kaputte, leere und fehlende Werte ergeben den Ersatzwert statt eines Fehlers', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson('{kaputt'), null); assert.deepEqual(parseJson('', []), []); assert.equal(parseJson(null, 7), 7); assert.equal(parseJson(undefined), null);
});

test('guarded: weder ein Fehler noch eine abgelehnte Zusage kommt nach außen', async () => {
  const errs = []; const f = guarded((x) => { if (x === 'sync') throw new Error('s'); if (x === 'async') return Promise.reject(new Error('a')); return 'ok'; }, (e) => errs.push(e.message));
  assert.equal(f('gut'), 'ok'); assert.equal(f('sync'), undefined); await f('async').catch(() => {}); await sleep(5);
  assert.deepEqual(errs, ['s', 'a']);
});

test('safeInterval: ein Fehler im Takt wird gemeldet, der Zeitgeber läuft weiter', async () => {
  const errs = []; let n = 0; const t = safeInterval(() => { n++; throw new Error('boom'); }, 10, (...a) => errs.push(a.join(' ')), 'Test');
  await sleep(80); clearInterval(t);
  assert.ok(n >= 3, `läuft weiter: ${n} Durchläufe`); assert.ok(errs.length >= 3 && errs[0].startsWith('Test:'));
});

test('Schutzschalter: Einzelfehler werden nur protokolliert; viele Fehler in kurzer Zeit und schwere Fehler führen zum sauberen Neustart (Code 75)', async () => {
  const proc = new EventEmitter(); const exits = [], logs = [];
  const off = installProcessGuards({ name: 'T', log: (...a) => logs.push(a.join(' ')), exit: (c) => exits.push(c), proc, maxRejections: 5, windowMs: 1000, delayMs: 5 });
  for (let i = 0; i < 4; i++) proc.emit('unhandledRejection', new Error('x' + i));
  assert.deepEqual(exits, [], 'vier Fehler: nur protokolliert'); assert.equal(logs.length, 4);
  proc.emit('unhandledRejection', new Error('x5')); assert.deepEqual(exits, [75], 'der fünfte löst den Neustart aus');
  exits.length = 0; proc.emit('uncaughtException', new Error('schwer')); await sleep(30); assert.deepEqual(exits, [75]);
  off(); assert.equal(proc.listenerCount('unhandledRejection'), 0);
});

test('Schutzschalter: Fehler außerhalb des Zeitfensters zählen nicht zusammen', async () => {
  const proc = new EventEmitter(); const exits = [];
  installProcessGuards({ log: () => {}, exit: (c) => exits.push(c), proc, maxRejections: 3, windowMs: 40 });
  proc.emit('unhandledRejection', 1); proc.emit('unhandledRejection', 2); await sleep(80); proc.emit('unhandledRejection', 3); proc.emit('unhandledRejection', 4);
  assert.deepEqual(exits, [], 'zwei + zwei in getrennten Fenstern');
});

test('fitState: kleiner Zustand bleibt, zu großer verliert die größten Einträge (immer gültiges JSON, nie abgeschnitten)', () => {
  const small = { a: 1, b: [1, 2] }; assert.equal(fitState(small), JSON.stringify(small));
  const big = { version: '0.2.28', kleines: 'x', riesig: 'y'.repeat(30000), mittel: 'z'.repeat(500) };
  const j = fitState(big, 20000); const o = JSON.parse(j); // würde bei abgeschnittenem JSON fehlschlagen
  assert.ok(j.length <= 20000); assert.equal(o.gekuerzt, true); assert.equal(o.riesig, undefined); assert.equal(o.version, '0.2.28'); assert.equal(o.mittel, 'z'.repeat(500));
  const hopeless = fitState({ version: '1', a: 'q'.repeat(100) }, 10); assert.equal(JSON.parse(hopeless).gekuerzt, true);
});

test('Datenbank: Schutzeinstellungen, Prüfung beim Start und keine Kopie, wenn nichts zu migrieren ist', () => {
  const dir = tmp(); const file = join(dir, 'hub.db'); const logs = [];
  try {
    const db = openDb(file, { log: (...a) => logs.push(a.join(' ')) });
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal'); assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1); assert.equal(db.pragma('journal_size_limit', { simple: true }), 64 * 1024 * 1024);
    assert.equal(db.integrity, 'ok'); db.close();
    const db2 = openDb(file); db2.close();
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.vor-v')), [], 'ohne Migration keine Sicherungskopie');
    assert.deepEqual(logs, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Datenbank: Vor einer Migration entsteht eine Kopie des alten Stands; ältere Kopien werden aufgeräumt (zwei bleiben)', () => {
  const dir = tmp(); const file = join(dir, 'hub.db'); const MIG = new URL('../migrations/', import.meta.url);
  try {
    const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort(); const last = files.at(-1), prev = parseInt(files.at(-2), 10);
    // Stand "eine Version zurück" bauen: alle Migrationen außer der letzten
    const old = new Database(file); old.pragma('journal_mode = WAL');
    for (const f of files.slice(0, -1)) old.exec(readFileSync(new URL(f, MIG), 'utf8'));
    old.pragma(`user_version = ${prev}`); old.prepare("INSERT INTO settings(key,value) VALUES('probe','vorher')").run(); old.close();
    // zwei ältere Kopien aus früheren Updates
    for (const [v, tage] of [[1, 3], [2, 2]]) { const p = join(dir, `hub.db.vor-v${v}`); const d = new Database(p); d.exec('CREATE TABLE t(x)'); d.close(); const ts = (Date.now() - tage * 86400000) / 1000; utimesSync(p, ts, ts); }
    const db = openDb(file);
    assert.equal(db.pragma('user_version', { simple: true }), parseInt(last, 10), 'neue Version');
    const copy = join(dir, `hub.db.vor-v${prev}`); assert.ok(existsSync(copy), 'Kopie des alten Stands liegt neben der Datenbank');
    const c = new Database(copy, { readonly: true }); assert.equal(c.prepare("SELECT value FROM settings WHERE key='probe'").get().value, 'vorher'); assert.equal(c.pragma('user_version', { simple: true }), prev); c.close();
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.vor-v')).sort(), ['hub.db.vor-v' + prev, 'hub.db.vor-v2'].sort(), 'die älteste Kopie wurde entfernt');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Hub: kaputte Zustandsdaten eines Geräts machen weder die Liste noch die Warnungen unbrauchbar', async () => {
  const h = await makeHub();
  try {
    const id = randomUUID();
    h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,state_json,display_json,hw_json) VALUES(?,?,'standard','active',?,?,?,?,?)").run(id, 'Kaputt', h.clock.t, h.clock.t, '{abgeschnitten', '[1,', 'nope');
    const api = await h.as('admin');
    const list = await api('GET', '/api/v1/devices'); assert.equal(list.statusCode, 200, list.body); assert.ok(list.json().some((d) => d.id === id));
    assert.equal((await api('GET', `/api/v1/devices/${id}`)).statusCode, 200);
    assert.equal((await api('GET', '/api/v1/warnings')).statusCode, 200);
  } finally { await h.cleanup(); }
});

test('Hub: Meldet die Datenbank-Prüfung Fehler, erscheint auf der Startseite eine Warnung mit Handlungsanweisung', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin');
    assert.ok(!(await api('GET', '/api/v1/warnings')).json().some((w) => w.kind === 'datenbank'), 'im Normalfall keine Warnung');
    h.db.integrity = '*** in database main ***'; // so würde quick_check einen Schaden melden
    const w = (await api('GET', '/api/v1/warnings')).json().find((x) => x.kind === 'datenbank');
    assert.ok(w, 'Warnung vorhanden'); assert.match(w.text, /Backup/); assert.match(w.text, /IT/);
  } finally { await h.cleanup(); }
});

test('Hub: Ein beschädigter Befehl in der Warteschlange blockiert die übrigen nicht (wird als fehlgeschlagen markiert)', async () => {
  const h = await makeHub();
  try {
    const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(id, 'D', h.clock.t);
    const ins = h.db.prepare("INSERT INTO commands(id,device_id,type,args_json,status,created_at) VALUES(?,?,?,?,'queued',?)");
    ins.run('c-kaputt', id, 'wifi_change', 'kein-verschluesselter-text', h.clock.t); ins.run('c-gut', id, 'identify', '{}', h.clock.t + 1);
    const sent = []; h.app.devices.sockets.set(id, { readyState: 1, send: (m) => sent.push(JSON.parse(m)) });
    h.app.devices.deliverQueued(id);
    assert.equal(h.db.prepare("SELECT status FROM commands WHERE id='c-kaputt'").get().status, 'failed');
    assert.equal(h.db.prepare("SELECT status FROM commands WHERE id='c-gut'").get().status, 'sent');
    assert.deepEqual(sent.map((m) => m.id), ['c-gut']);
  } finally { await h.cleanup(); }
});


test('Datenpflege: alte erledigte und nie zugestellte Befehle werden entfernt, frische bleiben', async () => {
  const h = await makeHub();
  try {
    const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(id, 'D', h.clock.t);
    const DAY = 86400000, ins = h.db.prepare("INSERT INTO commands(id,device_id,type,args_json,status,created_at) VALUES(?,?,?,?,?,?)");
    ins.run('alt-fertig', id, 'identify', '{}', 'done', h.clock.t - 31 * DAY); ins.run('neu-fertig', id, 'identify', '{}', 'done', h.clock.t - 5 * DAY);
    ins.run('alt-wartend', id, 'identify', '{}', 'queued', h.clock.t - 8 * DAY); ins.run('neu-wartend', id, 'identify', '{}', 'queued', h.clock.t - 1 * DAY);
    h.app.extras2.retentionTick();
    const left = h.db.prepare('SELECT id FROM commands ORDER BY id').all().map((r) => r.id);
    assert.deepEqual(left, ['neu-fertig', 'neu-wartend']);
  } finally { await h.cleanup(); }
});

test('Medien-Programme haben ein Zeitlimit: Ein hängendes Programm wird beendet, die Verarbeitung läuft weiter', async () => {
  const t0 = Date.now();
  await assert.rejects(() => run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }), (e) => /Zeitüberschreitung/.test(e.message));
  assert.ok(Date.now() - t0 < 10000, 'nicht 60 s gewartet');
  assert.equal((await run(process.execPath, ['-e', 'process.stdout.write("fertig")'], { timeoutMs: 5000 })), 'fertig');
  await assert.rejects(() => run(process.execPath, ['-e', 'console.error("kaputt"); process.exit(3)']), (e) => /kaputt/.test(e.message));
});

test('Warnungen: volle Karte, Schreibfehler und ein automatischer Neustart der Anzeige erscheinen in Klartext (alte Neustarts nicht mehr)', () => {
  const d = { name: 'Foyer' }, now = Date.now();
  const w = deviceWarnings(d, { syncState: { done: 1, total: 2, failed: 1, noSpace: true }, speicherFehler: { code: 'ENOSPC' }, selfHeal: { count: 1, last: now - 10 * 60000 } }, now);
  const kinds = w.map((x) => x.kind);
  assert.ok(kinds.includes('speicher_voll') && kinds.includes('schreibfehler') && kinds.includes('selbstheilung'), kinds.join(','));
  assert.match(w.find((x) => x.kind === 'selbstheilung').text, /vor 10 Minuten/);
  assert.ok(!deviceWarnings(d, { selfHeal: { count: 1, last: now - 3 * 86400000 } }, now).some((x) => x.kind === 'selbstheilung'));
  assert.deepEqual(deviceWarnings(d, { syncState: { done: 2, total: 2 } }, now), [], 'ohne Störung keine Meldung');
});
