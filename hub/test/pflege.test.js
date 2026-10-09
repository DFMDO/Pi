// Pflege-Erinnerungen (0.2.26): Reinigung, Netzteil, SD-Karte – Bezugsdatum, Fälligkeit, Abhaken, Hinweise auf der Startseite, Rechte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { careOverview, careWarnings, taskConfig, TASKS } from '../lib/pflege.js';
import { warnings } from '../lib/plan.js';

const DAY = 86400000, NOW = Date.parse('2026-10-09T12:00:00Z');
const mkDev = (h, name, o = {}) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,installed_at,group_id) VALUES(?,?,'standard','active',?,?,?,?)").run(id, name, NOW, o.created ?? NOW, o.installed ?? null, o.group ?? null); return id; };
const items = (o, name) => o.devices.find((d) => d.name === name).items;
const st = (o, name, task) => items(o, name).find((i) => i.task === task);

test('Pflege: Bezugsdatum (erledigt vor eingebaut vor verbunden) und Fälligkeit nach den Standardabständen', async () => {
  const h = await makeHub(); const dev = (n, o) => mkDev(h, n, o);
  dev('Neu', { created: NOW - 10 * DAY }); dev('Alt', { created: NOW - 400 * DAY }); dev('Eingebaut', { created: NOW - 5 * DAY, installed: '2024-06-01' }); const kurz = dev('Bald', { created: NOW - 340 * DAY });
  h.db.prepare("INSERT INTO care_done(device_id,task,done_at,done_by) VALUES(?,?,?,?)").run(kurz, 'reinigung', NOW - 200 * DAY, 'Tyrone');
  const o = careOverview(h.db, NOW);
  assert.deepEqual(o.tasks.map((t) => [t.id, t.months, t.enabled]), [['reinigung', 12, true], ['netzteil', 12, true], ['sd', 24, true]]);
  assert.deepEqual(items(o, 'Neu').map((i) => i.status), ['ok', 'ok', 'ok']); assert.equal(st(o, 'Neu', 'sd').base, 'verbunden');
  assert.equal(st(o, 'Alt', 'reinigung').status, 'faellig', 'vor 400 Tagen verbunden → Reinigung fällig'); assert.equal(st(o, 'Alt', 'sd').status, 'ok', 'SD-Karte erst nach 24 Monaten');
  assert.equal(st(o, 'Eingebaut', 'sd').base, 'eingebaut'); assert.equal(st(o, 'Eingebaut', 'sd').status, 'faellig', 'Einbau 06/2024: SD-Karte nach 24 Monaten fällig'); assert.equal(st(o, 'Eingebaut', 'reinigung').status, 'faellig');
  assert.equal(st(o, 'Bald', 'reinigung').base, 'erledigt'); assert.equal(st(o, 'Bald', 'reinigung').by, 'Tyrone'); assert.equal(st(o, 'Bald', 'reinigung').status, 'ok', 'vor 200 Tagen erledigt'); assert.equal(st(o, 'Bald', 'netzteil').status, 'bald', 'verbunden vor 340 Tagen: in 25 Tagen fällig');
  assert.equal(o.summary.faellig, 5); assert.equal(o.summary.bald, 1); assert.ok(o.devices.length === 4);
  h.db.prepare("UPDATE devices SET status='blocked' WHERE name='Alt'").run(); assert.ok(!careOverview(h.db, NOW).devices.some((d) => d.name === 'Alt'), 'gesperrte/ersetzte Bildschirme zählen nicht'); await h.cleanup();
});

test('Pflege: Hinweise für die Startseite fassen je Aufgabe zusammen (überfällig oder in 14 Tagen), Abstände und Aufgaben sind einstellbar', async () => {
  const h = await makeHub(); for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) mkDev(h, n, { created: NOW - 400 * DAY }); mkDev(h, 'Neu', { created: NOW - 5 * DAY });
  const w = careWarnings(h.db, NOW); assert.equal(w.length, 2, 'Reinigung und Netzteil'); assert.match(w[0].text, /„Kühlkörper, Gehäuse und Lüftung reinigen“ ist fällig bei „A“, „B“, „C“, „D“ und 2 weitere/); assert.equal(w[0].ids.length, 6); assert.equal(w[0].kind, 'pflege');
  assert.ok(warnings(h.db, NOW).some((x) => x.kind === 'pflege'), 'auch in den Warnungen der Startseite');
  const early = careWarnings(h.db, NOW - 380 * DAY + 5 * DAY * 0 + 0); assert.ok(Array.isArray(early));
  h.db.prepare("UPDATE devices SET created_at=? WHERE name='A'").run(NOW - 355 * DAY); const only = careWarnings(h.db, NOW).find((x) => /Reinigung|reinigen/.test(x.text)); assert.match(only.text, /„A“/);
  h.db.prepare("INSERT INTO settings VALUES('care.tasks',?)").run(JSON.stringify({ reinigung: { months: 24, enabled: true }, netzteil: { enabled: false }, sd: { months: 99 } }));
  const cfg = taskConfig(h.db); assert.deepEqual(cfg.map((t) => [t.id, t.months, t.enabled]), [['reinigung', 24, true], ['netzteil', 12, false], ['sd', 24, true]], 'ungültige Werte (99 Monate) fallen auf den Standard zurück');
  const o = careOverview(h.db, NOW); assert.deepEqual(items(o, 'B').map((i) => i.task), ['reinigung', 'sd'], 'ausgeschaltete Aufgabe fehlt'); assert.equal(st(o, 'B', 'reinigung').status, 'ok', 'mit 24 Monaten ist die Reinigung nach 400 Tagen noch nicht fällig');
  assert.equal(TASKS.length, 3); await h.cleanup();
});

test('Pflege: Routen – Übersicht, Abhaken (mit Datum), Abstände ändern; Rechte und Eingabeprüfung', async () => {
  const h = await makeHub(); h.clock.t = NOW; const a = await h.as('admin'), e = await h.as('edi'), v = await h.as('vera');
  const alt = mkDev(h, 'Alt', { created: NOW - 400 * DAY }), neu = mkDev(h, 'Neu', { created: NOW - 5 * DAY });
  assert.equal((await v('GET', '/api/v1/care')).statusCode, 403); assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/care' })).statusCode, 401);
  let g = (await e('GET', '/api/v1/care')).json(); assert.equal(g.summary.faellig, 2); assert.match(g.hint, /Erinnerung, keine Messung/); assert.equal(g.devices.length, 2);
  assert.equal((await e('POST', '/api/v1/care/done', { task: 'reinigung', deviceIds: [alt] })).statusCode, 403, 'Abhaken nur durch Admins');
  const d1 = await a('POST', '/api/v1/care/done', { task: 'reinigung', deviceIds: [alt, 'gibtsnicht', alt] }); assert.equal(d1.statusCode, 200, d1.body); assert.equal(d1.json().count, 1);
  g = (await a('GET', '/api/v1/care')).json(); const x = g.devices.find((d) => d.id === alt).items.find((i) => i.task === 'reinigung'); assert.equal(x.base, 'erledigt'); assert.equal(x.by, 'admin'); assert.equal(x.status, 'ok'); assert.equal(g.summary.faellig, 1);
  assert.equal((await a('POST', '/api/v1/care/done', { task: 'netzteil', deviceIds: [alt], date: '2026-09-01' })).statusCode, 200); const y = (await a('GET', '/api/v1/care')).json().devices.find((d) => d.id === alt).items.find((i) => i.task === 'netzteil'); assert.equal(y.baseAt, Date.parse('2026-09-01T12:00:00Z'));
  for (const bad of [{ task: 'ufo', deviceIds: [alt] }, { task: 'sd', deviceIds: [] }, { task: 'sd', deviceIds: ['nix'] }, { task: 'sd', deviceIds: [alt], date: '2099-01-01' }, { task: 'sd', deviceIds: [alt], date: 'gestern' }]) assert.equal((await a('POST', '/api/v1/care/done', bad)).statusCode, 400, JSON.stringify(bad));
  assert.equal((await e('PUT', '/api/v1/care/tasks', { tasks: { sd: { months: 36 } } })).statusCode, 403); const p = await a('PUT', '/api/v1/care/tasks', { tasks: { sd: { months: 36 }, netzteil: { enabled: false } } }); assert.equal(p.statusCode, 200, p.body); assert.deepEqual(p.json().tasks.map((t) => [t.id, t.months, t.enabled]), [['reinigung', 12, true], ['netzteil', 12, false], ['sd', 36, true]]);
  for (const bad of [{ tasks: { sd: { months: 0 } } }, { tasks: { sd: { months: 61 } } }]) assert.equal((await a('PUT', '/api/v1/care/tasks', bad)).statusCode, 400, JSON.stringify(bad));
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='pflege.erledigt'").get().n, 2); void neu;
  // Konto mit Gruppen-Beschränkung sieht nur die eigenen Bildschirme
  const g1 = randomUUID(); h.db.prepare('INSERT INTO device_groups(id,name) VALUES(?,?)').run(g1, 'Eigene'); h.db.prepare('UPDATE devices SET group_id=? WHERE id=?').run(g1, neu); h.db.prepare('UPDATE users SET groups_json=? WHERE name=?').run(JSON.stringify([g1]), 'edi'); const e2 = await h.as('edi');
  assert.deepEqual((await e2('GET', '/api/v1/care')).json().devices.map((d) => d.name), ['Neu']); await h.cleanup();
});
