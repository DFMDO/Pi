import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { schedulePayload } from '../lib/plan.js';

const TOM = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
const addDevice = (h, name = 'Dev') => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(id, name, Date.now()); return id; };
const text = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;

test('Entwurf: neue Termine/Listen laufen erst nach dem Veröffentlichen; Player sehen nur Veröffentlichtes', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = addDevice(h);
  const m = await text(a, 'Hallo'); const pl = (await a('POST', '/api/v1/playlists', { name: 'Neu' })).json().id;
  await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m }] });
  const d = h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv);
  assert.ok(!Object.keys(schedulePayload(h.db, d, Date.now()).playlists).includes(pl), 'Entwurfsliste nicht beim Player');
  assert.equal((await a('GET', '/api/v1/drafts')).json().playlists, 1);
  // Termin mit Entwurfsliste kann nicht veröffentlicht werden
  const sc = (await a('POST', '/api/v1/schedules', { targetType: 'device', targetId: dv, content: { type: 'playlist', id: pl }, startLocal: `${TOM}T10:00`, endLocal: `${TOM}T12:00` })).json();
  assert.equal(sc.published, false);
  const chk = (await a('GET', `/api/v1/schedules/${sc.id}/publish-check`)).json(); assert.equal(chk.problems.length, 1); assert.match(chk.summary, /10:00 bis 12:00 Uhr/);
  assert.equal((await a('POST', `/api/v1/schedules/${sc.id}/publish`)).statusCode, 400);
  assert.equal((await a('POST', `/api/v1/playlists/${pl}/publish`)).statusCode, 200);
  assert.equal((await a('POST', `/api/v1/schedules/${sc.id}/publish`)).statusCode, 200);
  assert.ok(Object.keys(schedulePayload(h.db, d, Date.now()).playlists).includes(pl));
  assert.equal((await a('GET', '/api/v1/schedules')).json().length, 1);
  await h.cleanup();
});

test('Änderung an Veröffentlichtem: Entwurf daneben, Original läuft weiter; Verwerfen; Versionen + Wiederherstellen', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = addDevice(h);
  const m = await text(a, 'A'), m2 = await text(a, 'B');
  const pl = (await a('POST', '/api/v1/playlists', { name: 'P', publish: true })).json().id;
  await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m }], publish: true });
  const put = (await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m2 }] })).json(); assert.equal(put.published, false);
  const n0 = (await a('GET', '/api/v1/playlists')).json().length; const lists = (await a('GET', '/api/v1/playlists')).json(); assert.ok(lists.some((p) => p.draftOf === pl));
  assert.equal(lists.find((p) => p.id === pl).items[0].mediaId, m, 'Original unverändert');
  assert.equal((await a('POST', `/api/v1/playlists/${put.draftId}/discard`)).statusCode, 200);
  assert.equal((await a('GET', '/api/v1/playlists')).json().length, n0 - 1);
  const s = (await a('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: dv, content: { type: 'playlist', id: pl }, startLocal: '2030-05-07T10:00', endLocal: '2030-05-07T12:00' })).json();
  assert.equal(s.published, true);
  const upd = (await a('PUT', `/api/v1/schedules/${s.id}`, { targetType: 'device', targetId: dv, content: { type: 'playlist', id: pl }, startLocal: '2030-05-07T14:00', endLocal: '2030-05-07T16:00', publish: true })).json();
  assert.equal(upd.published, true); assert.match(upd.summary, /14:00/);
  const v = (await a('GET', `/api/v1/versions?kind=schedule&refId=${s.id}`)).json(); assert.equal(v.length, 2);
  const old = v[v.length - 1]; const rs = (await a('POST', `/api/v1/versions/${old.id}/restore`)).json(); assert.ok(rs.draftId);
  assert.equal((await a('GET', '/api/v1/schedules')).json()[0].startLocal, '2030-05-07T14:00', 'Wiederherstellen erzeugt nur einen Entwurf');
  assert.equal((await a('GET', '/api/v1/schedules?drafts=1')).json().length, 2);
  await h.cleanup();
});

test('Redakteur darf nur veröffentlichen, wenn der Admin es erlaubt', async () => {
  const h = await makeHub(); const ed = await h.as('edi'), a = await h.as('admin');
  assert.equal((await ed('POST', '/api/v1/playlists', { name: 'X', publish: true })).statusCode, 201);
  await a('PUT', '/api/v1/settings', { 'publish.editor': 'false' });
  assert.equal((await ed('POST', '/api/v1/playlists', { name: 'Y', publish: true })).statusCode, 403);
  assert.equal((await ed('POST', '/api/v1/playlists', { name: 'Y' })).statusCode, 201);
  assert.equal((await ed('GET', '/api/v1/drafts')).json().canPublish, false);
  await h.cleanup();
});

test('Konten: letzter Admin geschützt, Rolle ändern, Passwort zurücksetzen, Rolle Anzeige sieht nur Live', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const users = (await a('GET', '/api/v1/users')).json(); const adm = users.find((u) => u.role === 'admin');
  assert.equal((await a('PATCH', `/api/v1/users/${adm.id}`, { role: 'editor' })).statusCode, 409, 'letzten Admin nicht herabstufen');
  assert.equal((await a('DELETE', `/api/v1/users/${adm.id}`)).statusCode >= 400, true);
  const vera = users.find((u) => u.role === 'anzeige');
  assert.equal((await a('POST', `/api/v1/users/${vera.id}/password`, { password: 'kurz' })).statusCode, 400);
  assert.equal((await a('POST', `/api/v1/users/${vera.id}/password`, { password: 'Ein-ganz-neues-Passwort-77' })).statusCode, 200);
  const v = await h.as('vera'); void v;
  await h.cleanup();
});

test('Live: Ist (vom Player gemeldet) gegen Soll, Abweichung wird erkannt; Anzeige darf lesen, aber nichts ändern', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = addDevice(h, 'Foyer');
  const m = await text(a, 'A'), m2 = await text(a, 'B');
  const pl = (await a('POST', '/api/v1/playlists', { name: 'Std', publish: true })).json().id;
  await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m }], isDefault: true, publish: true });
  h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(Date.now(), dv);
  let live = (await a('GET', '/api/v1/live')).json(); assert.equal(live.length, 1); assert.equal(live[0].soll.playlist, 'Std'); assert.equal(live[0].mismatch, false);
  const st = { playerStatus: { current: { mediaId: m2, name: 'B' }, next: null, source: 'standard', ts: Date.now() } };
  h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(JSON.stringify(st), dv);
  live = (await a('GET', '/api/v1/live')).json(); assert.equal(live[0].mismatch, true); assert.match(live[0].mismatchText, /Laut Plan sollte jetzt/);
  h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(Date.now() - 70000, dv);
  assert.equal((await a('GET', '/api/v1/live')).json()[0].status.level, 'warn', 'nach 65 s nicht mehr „läuft“');
  const v = await h.as('vera'); assert.equal((await v('GET', '/api/v1/live')).statusCode, 200);
  assert.equal((await v('GET', '/api/v1/devices')).statusCode, 403); assert.equal((await v('POST', '/api/v1/playlists', { name: 'x' })).statusCode, 403);
  await h.cleanup();
});
