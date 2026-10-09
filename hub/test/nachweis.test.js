// Wiedergabe-Nachweis im Hub: Annahme der Zähler (streng geprüft, Doppeltes erkannt), Auswertung nach Medium/Bildschirm/Tag, CSV für Excel, Rechte und Gruppen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { createPlays } from '../lib/nachweis.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 10, 10, 0); // 10.10.2026
const mkDev = (h, name, group = null) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,group_id) VALUES(?,?,'standard','active',?,?,?)").run(id, name, NOW, NOW, group); return id; };
const rows = (h) => h.db.prepare('SELECT day,device_id,media_id,name,kind,plays,seconds FROM plays ORDER BY day,media_id').all();

test('Annahme: Zähler werden je Tag/Bildschirm/Medium addiert, doppelt zugestellte Meldungen nur einmal gezählt, Unsinn wird verworfen', async () => {
  const h = await makeHub(); const d = mkDev(h, 'Foyer'); const p = createPlays({ db: h.db, now: () => NOW });
  assert.equal(p.ingest(d, { id: 1, days: { '2026-10-10': { [A]: { n: 3, s: 30, name: 'Foto', kind: 'image' }, [B]: { n: 1, s: 240, name: 'Film', kind: 'video' } } } }).rows, 2);
  assert.equal(p.ingest(d, { id: 1, days: { '2026-10-10': { [A]: { n: 3, s: 30, name: 'Foto', kind: 'image' } } } }).dup, true, 'gleiche Nummer = schon verarbeitet');
  p.ingest(d, { id: 2, days: { '2026-10-10': { [A]: { n: 2, s: 20, name: 'Foto (neu benannt)', kind: 'image' } }, '2026-10-09': { [A]: { n: 1, s: 5, name: 'Foto', kind: 'image' } } } });
  assert.deepEqual(rows(h).map((r) => [r.day, r.media_id === A ? 'A' : 'B', r.plays, r.seconds, r.name]), [['2026-10-09', 'A', 1, 5, 'Foto'], ['2026-10-10', 'A', 5, 50, 'Foto (neu benannt)'], ['2026-10-10', 'B', 1, 240, 'Film']]);
  const before = rows(h).length;
  p.ingest(d, { id: 3, days: { 'gestern': { [A]: { n: 1, s: 1 } }, '2027-12-31': { [A]: { n: 1, s: 1 } }, '2020-01-01': { [A]: { n: 1, s: 1 } }, '2026-10-10': { 'kein-uuid': { n: 1, s: 1 }, [B]: 'text', [A]: { n: 'viel', s: -5 } } } });
  assert.equal(rows(h).length, before, 'ungültiger Tag, Zukunft, zu alt, falsche ID, falsche Typen: nichts gespeichert');
  p.ingest(d, { id: 4, days: { '2026-10-10': { [B]: { n: 9e9, s: 9e9, name: 'x'.repeat(500), kind: 'y'.repeat(50) } } } }); const big = rows(h).find((r) => r.media_id === B && r.name.startsWith('xxx'));
  assert.equal(big.plays, 1 + 20000, 'Zähler wird begrenzt'); assert.equal(big.seconds, 240 + 86400 * 2); assert.equal(big.name.length, 120); assert.equal(big.kind.length, 12);
  assert.equal(p.ingest(randomUUID(), { id: 1, days: { '2026-10-10': { [A]: { n: 1, s: 1 } } } }).rows, 1, 'jeder Bildschirm hat seine eigene Nummernfolge');
  await h.cleanup();
});

test('Aufbewahrung: Zähler älter als 400 Tage werden gelöscht', async () => {
  const h = await makeHub(); const d = mkDev(h, 'Foyer'); const p = createPlays({ db: h.db, now: () => NOW });
  h.db.prepare('INSERT INTO plays VALUES(?,?,?,?,?,?,?)').run('2025-01-01', d, A, 'alt', 'image', 5, 50); h.db.prepare('INSERT INTO plays VALUES(?,?,?,?,?,?,?)').run('2026-01-01', d, A, 'neu', 'image', 5, 50);
  p.ingest(d, { id: 1, days: { '2026-10-10': { [B]: { n: 1, s: 1, name: 'x', kind: 'image' } } } });
  assert.deepEqual(rows(h).map((r) => r.day), ['2026-01-01', '2026-10-10']); await h.cleanup();
});

test('Protokoll: plays und plays_ack sind gültige Nachrichten, falsche Felder werden abgelehnt', async () => {
  const { validateMessage } = await import('../../shared/protocol.js');
  assert.equal(validateMessage({ v: 1, type: 'plays', id: 1, days: {} }), null); assert.equal(validateMessage({ v: 1, type: 'plays_ack', id: 1 }), null);
  assert.match(validateMessage({ v: 1, type: 'plays', id: 'x', days: {} }), /id/); assert.match(validateMessage({ v: 1, type: 'plays', id: 1, days: [] }), /days/); assert.match(validateMessage({ v: 1, type: 'plays', id: 1, days: {}, extra: 1 }), /nicht erlaubt/);
});

async function seeded() {
  const h = await makeHub(); h.clock.t = NOW; const a = await h.as('admin'); const g = randomUUID(); h.db.prepare("INSERT INTO device_groups(id,name) VALUES(?,?)").run(g, 'Foyer-Gruppe');
  const foyer = mkDev(h, 'Foyer', g), shop = mkDev(h, 'Shop-Screen'); const p = createPlays({ db: h.db, now: () => NOW });
  const media = (await a('POST', '/api/v1/media/text', { name: 'Sponsor Adidas', title: 'x' })).json().id;
  const ins = h.db.prepare('INSERT INTO plays VALUES(?,?,?,?,?,?,?)');
  ins.run('2026-10-08', foyer, media, 'Sponsor Adidas', 'text', 10, 100); ins.run('2026-10-09', foyer, media, 'Sponsor Adidas', 'text', 20, 200); ins.run('2026-10-09', shop, media, 'Sponsor Adidas', 'text', 5, 50);
  ins.run('2026-10-09', shop, A, '=HYPERLINK("http://x")', 'image', 7, 70); ins.run('2026-10-10', shop, B, 'Gelöschtes Medium', 'video', 2, 480);
  return { h, a, foyer, shop, media, g, p };
}

test('Auswertung: nach Medium, Bildschirm und Tag; Zeitraum und Bildschirm filtern; Namen kommen aus der Bibliothek; Gelöschtes bleibt sichtbar', async () => {
  const { h, a, foyer, media } = await seeded();
  const m = (await a('GET', '/api/v1/reports/plays?from=2026-10-08&to=2026-10-10')).json(); assert.equal(m.group, 'media'); assert.equal(m.totals.plays, 44); assert.equal(m.totals.seconds, 900);
  assert.deepEqual(m.rows.map((r) => [r.name, r.plays, r.devices, r.removed]), [['Sponsor Adidas', 35, 2, false], ['=HYPERLINK("http://x")', 7, 1, true], ['Gelöschtes Medium', 2, 1, true]], 'nach Einblendungen sortiert; nicht mehr vorhandene Medien markiert');
  const d = (await a('GET', '/api/v1/reports/plays?from=2026-10-08&to=2026-10-10&group=device')).json(); assert.deepEqual(d.rows.map((r) => [r.name, r.plays]), [['Shop-Screen', 14], ['Foyer', 30]].sort((x, y) => y[1] - x[1]));
  const t = (await a('GET', '/api/v1/reports/plays?from=2026-10-08&to=2026-10-10&group=day')).json(); assert.deepEqual(t.rows.map((r) => [r.day, r.plays]), [['2026-10-08', 10], ['2026-10-09', 32], ['2026-10-10', 2]], 'nach Datum sortiert');
  const one = (await a('GET', `/api/v1/reports/plays?from=2026-10-08&to=2026-10-10&deviceId=${foyer}`)).json(); assert.equal(one.totals.plays, 30); assert.deepEqual(one.rows.map((r) => r.mediaId), [media]);
  const def = (await a('GET', '/api/v1/reports/plays')).json(); assert.equal(def.to, '2026-10-10'); assert.equal(def.from, '2026-09-11', 'Standard: letzte 30 Tage'); assert.equal(def.totals.plays, 44); assert.ok(def.devices.length >= 2); assert.match(def.hint, /Stromausfall/);
  assert.equal((await a('GET', '/api/v1/reports/plays?from=2026-10-11&to=2026-10-10')).statusCode, 400); assert.equal((await a('GET', '/api/v1/reports/plays?from=2024-01-01&to=2026-10-10')).statusCode, 400, 'höchstens 400 Tage'); assert.equal((await a('GET', '/api/v1/reports/plays?group=quatsch')).statusCode, 400);
  await h.cleanup();
});

test('CSV: Excel-tauglich (Semikolon, BOM, deutsche Dezimalzahl), Formel-Einschleusung entschärft, Dateiname nennt den Zeitraum', async () => {
  const { h, a } = await seeded(); const r = await a('GET', '/api/v1/reports/plays.csv?from=2026-10-08&to=2026-10-10');
  assert.equal(r.statusCode, 200); assert.match(r.headers['content-type'], /text\/csv/); assert.match(r.headers['content-disposition'], /dfm-wiedergabe-2026-10-08-bis-2026-10-10\.csv/); assert.ok(r.body.startsWith('﻿Datum;Bildschirm;Medium;Art;Einblendungen;Sekunden;Minuten\r\n'));
  const lines = r.body.split('\r\n').filter(Boolean); assert.equal(lines.length, 1 + 5); assert.ok(lines.includes('2026-10-09;Foyer;Sponsor Adidas;Text;20;200;3,3'), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes("'=HYPERLINK(")), 'Zellen, die mit = beginnen, werden entschärft'); assert.ok(!lines.some((l) => /;=HYP/.test(l)));
  assert.equal((await a('GET', '/api/v1/reports/plays.csv?from=2026-10-11&to=2026-10-10')).statusCode, 400); await h.cleanup();
});

test('Rechte: Redakteur darf lesen, Anzeige-Rolle und Unangemeldete nicht; Konten mit Gruppen-Beschränkung sehen nur ihre Bildschirme', async () => {
  const { h, a, g } = await seeded(); const ed = await h.as('edi');
  assert.equal((await ed('GET', '/api/v1/reports/plays?from=2026-10-08&to=2026-10-10')).json().totals.plays, 44, 'Redakteur ohne Beschränkung sieht alles');
  h.db.prepare('UPDATE users SET groups_json=? WHERE name=?').run(JSON.stringify([g]), 'edi'); const ed2 = await h.as('edi');
  const lim = (await ed2('GET', '/api/v1/reports/plays?from=2026-10-08&to=2026-10-10')).json(); assert.equal(lim.totals.plays, 30, 'nur der Foyer-Bildschirm'); assert.deepEqual(lim.devices.map((x) => x.name), ['Foyer']);
  assert.ok(!(await ed2('GET', '/api/v1/reports/plays.csv?from=2026-10-08&to=2026-10-10')).body.includes('Shop-Screen'), 'auch die CSV zeigt nur die erlaubten Bildschirme');
  assert.equal((await (await h.as('vera'))('GET', '/api/v1/reports/plays')).statusCode, 403); assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/reports/plays' })).statusCode, 401);
  await h.cleanup();
});
