// Messwerte-Verlauf, Verbindungstest und Grundriss.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { makeHub, multipart } from './helpers.js';
import { createMetrics, HUB } from '../lib/metrics.js';

const mkDev = (h, name, over = {}) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at,last_seen,ready) VALUES(?,?,'standard','active',?,?,1)").run(id, name, h.clock.t, over.lastSeen ?? h.clock.t); return id; };

test('Verlauf: höchstens eine Messung pro Minute je Quelle, Mittelung auf wenige Punkte, Aufbewahrung 14 Tage', async () => {
  const h = await makeHub({}); let t = 1_700_000_000_000; const m = createMetrics({ db: h.db, now: () => t });
  for (let i = 0; i < 180; i++) { assert.equal(m.record('x', { memAvailMB: 300 - i, memTotalMB: 900, tempC: 50 + (i % 3), load1: 0.5 }), true); assert.equal(m.record('x', { memAvailMB: 1 }), false, 'zweite Messung innerhalb einer Minute wird ignoriert'); t += 60000; }
  const q = m.query('x', 6, 30); assert.ok(q.points.length <= 31 && q.points.length >= 10, `Punkte: ${q.points.length}`);
  assert.ok(q.points[0].memAvailMB > q.points.at(-1).memAvailMB, 'Verlauf sinkt');
  m.record('alt', { memAvailMB: 1 }); t += 15 * 86400000; assert.ok(m.prune() >= 1); assert.equal(m.query('alt', 24).points.length, 0);
  await h.cleanup();
});

test('Verlauf: Route für Hub und Bildschirm, Heartbeat füllt den Verlauf, unbekannter Bildschirm = 404, Rechte', async () => {
  const h = await makeHub({}); const a = await h.as('admin'), v = await h.as('vera');
  const hub = (await a('GET', '/api/v1/metrics?hours=24')).json(); assert.equal(hub.src, HUB); assert.ok(hub.points.length >= 1, 'Hub misst sich beim Start einmal selbst'); assert.equal(typeof hub.summary.memAvailNow, 'number');
  assert.equal((await a('GET', `/api/v1/metrics?src=${randomUUID()}`)).statusCode, 404);
  const id = mkDev(h, 'Foyer'); // Verlauf eines Bildschirms (direkt über den Speicher, wie der Heartbeat es tut)
  const m = createMetrics({ db: h.db, now: () => h.clock.t }); m.recordDevice(id, { ramTotalMB: 906, ramUsedMB: 800, cpuTemp: 55, load1: 1.2 });
  const dv = (await a('GET', `/api/v1/metrics?src=${id}&hours=6`)).json(); assert.equal(dv.name, 'Foyer'); assert.equal(dv.points[0].memAvailMB, 106); assert.ok(dv.hints.length === 0 || dv.hints.every((x) => typeof x === 'string'));
  assert.equal((await a('GET', '/api/v1/metrics?hours=5')).statusCode, 400, 'nur 6/24/168 Stunden');
  assert.equal((await v('GET', '/api/v1/metrics')).statusCode, 403, 'Rolle Anzeige sieht keine Messwerte');
  await h.cleanup();
});

test('Verbindungstest: Adresse, Hinweise, verbundene und ausgefallene Bildschirme mit Handlungsanweisung', async () => {
  const h = await makeHub({}); const a = await h.as('admin');
  mkDev(h, 'Foyer'); mkDev(h, 'Shop', { lastSeen: h.clock.t - 30 * 60000 }); mkDev(h, 'Café', { lastSeen: h.clock.t - 90 * 60000 });
  const r = (await a('GET', '/api/v1/system/connectivity')).json();
  const by = (t) => r.checks.find((c) => c.title === t);
  assert.ok(r.checks.some((c) => c.id === 'ports' && /443/.test(c.text)), 'Firewall-Hinweis mit Port 443');
  assert.equal(by('Foyer').level, 'ok'); assert.equal(by('Shop').level, 'bad'); assert.match(by('Shop').hint, /Strom|Firewall/); assert.match(by('Café').text, /Minuten|Stunden/);
  assert.ok(r.checks.some((c) => c.id === 'gruppe'), 'mehrere gleichzeitig offline → Netzwerkhinweis'); assert.equal(r.worst, 'bad');
  await h.cleanup();
});

test('Grundriss: Etage anlegen, Bild hochladen, Bildschirm platzieren, anzeigen, entfernen; Rechte; ungültige Eingaben', async () => {
  const h = await makeHub({}); const a = await h.as('admin'), e = await h.as('edi');
  const fl = (await a('POST', '/api/v1/floors', { name: 'Erdgeschoss' })); assert.equal(fl.statusCode, 201); const fid = fl.json().id;
  assert.equal((await a('GET', `/api/v1/floors/${fid}/image`)).statusCode, 404, 'noch kein Bild');
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#cccccc' } }).png().toBuffer();
  const up = multipart('file', 'eg.png', png); assert.equal((await a('PUT', `/api/v1/floors/${fid}/image`, up.payload, up.headers)).statusCode, 200);
  const img = await a('GET', `/api/v1/floors/${fid}/image`); assert.equal(img.statusCode, 200); assert.equal(img.headers['content-type'], 'image/jpeg');
  const bad = multipart('file', 'x.png', Buffer.from('kein bild, nur text')); assert.equal((await a('PUT', `/api/v1/floors/${fid}/image`, bad.payload, bad.headers)).statusCode, 400);
  const d = mkDev(h, 'Foyer'); assert.equal((await a('PUT', `/api/v1/devices/${d}/plan`, { floorId: fid, x: 42.25, y: 61 })).statusCode, 200);
  let list = (await a('GET', '/api/v1/floors')).json(); assert.equal(list.floors[0].hasImage, true); assert.equal(list.floors[0].devices[0].name, 'Foyer'); assert.ok(Math.abs(list.floors[0].devices[0].x - 42.25) <= 0.06, "Position auf 0,1 gerundet"); assert.equal(list.unplaced.length, 0);
  assert.equal((await a('PUT', `/api/v1/devices/${d}/plan`, { floorId: fid })).statusCode, 400, 'Position fehlt');
  assert.equal((await a('PUT', `/api/v1/devices/${d}/plan`, { floorId: randomUUID(), x: 1, y: 1 })).statusCode, 400, 'Etage gibt es nicht');
  assert.equal((await a('PUT', `/api/v1/devices/${d}/plan`, { floorId: fid, x: 101, y: 1 })).statusCode, 400, 'außerhalb 0–100');
  assert.equal((await e('GET', '/api/v1/floors')).statusCode, 200, 'Redakteur darf ansehen'); assert.equal((await e('POST', '/api/v1/floors', { name: 'X' })).statusCode, 403, 'aber nicht ändern');
  assert.equal((await a('PATCH', `/api/v1/floors/${fid}`, { name: 'EG', sort: 2 })).statusCode, 200);
  assert.equal((await a('DELETE', `/api/v1/floors/${fid}`)).statusCode, 200); list = (await a('GET', '/api/v1/floors')).json(); assert.equal(list.floors.length, 0); assert.equal(list.unplaced.length, 1, 'Bildschirm bleibt, ist nur nicht mehr platziert');
  await h.cleanup();
});
