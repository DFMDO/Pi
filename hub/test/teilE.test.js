import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeHub, multipart } from './helpers.js';
import { fitInfo } from '../lib/extras3.js';
import { schedulePayload, manifestPayload, warnings } from '../lib/plan.js';
import { playableItems } from '../../shared/sequencer.js';

const mkDev = (h, name = 'Dev', profile = 'standard') => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at) VALUES(?,?,?,'active',?,?)").run(id, name, profile, h.clock.t, h.clock.t); return id; };
const upload = async (a, w = 1600, hgt = 900) => { const png = await sharp({ create: { width: w, height: hgt, channels: 3, background: '#c8102e' } }).png().toBuffer(); const m = multipart('file', 'bild.png', png); return (await a('POST', '/api/v1/media', m.payload, m.headers)).json().ids[0]; };
const pl = async (a, ids, def = true) => { const id = (await a('POST', '/api/v1/playlists', { name: 'P' + Math.random(), publish: true })).json().id; await a('PUT', `/api/v1/playlists/${id}`, { items: ids.map((m) => ({ mediaId: m })), publish: true, ...(def ? { isDefault: true } : {}) }); return id; };

test('Hochkant: Seitenverhältnis-Warnungen, Darstellung (Einpassen/Füllen/Sicherheitsrand) im Plan, Vorschau als JPEG', async () => {
  assert.equal(fitInfo(1920, 1080, 1080, 1920, 'cover').crop, 68, 'Querformat auf Hochkant füllen: starker Beschnitt'); assert.equal(fitInfo(1920, 1080, 1920, 1080, 'cover').crop, 0); assert.ok(fitInfo(1920, 1080, 1080, 1920, 'contain').bars > 60);
  const h = await makeHub(); const a = await h.as('admin'), dv = mkDev(h, 'Foyer-Hochkant'); const m = await upload(a); await pl(a, [m]); h.db.prepare('UPDATE devices SET orientation=90 WHERE id=?').run(dv);
  const c1 = (await a('GET', `/api/v1/devices/${dv}/fit-check`)).json(); assert.equal(c1.portrait, true); assert.match(c1.text, /hochkant/); assert.equal(c1.warnings.length, 1); assert.match(c1.warnings[0].text, /füllt nur etwa/);
  assert.equal((await a('PUT', `/api/v1/devices/${dv}/fit`, { fit: 'cover', safe: 5 })).statusCode, 200); const c2 = (await a('GET', `/api/v1/devices/${dv}/fit-check`)).json(); assert.match(c2.warnings[0].text, /werden etwa \d+ % des Bildes abgeschnitten/);
  assert.deepEqual(schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv)).fit, { fit: 'cover', safe: 5 });
  const pv = await a('GET', `/api/v1/media/${m}/preview?deviceId=${dv}`); assert.equal(pv.statusCode, 200); assert.equal(pv.headers['content-type'], 'image/jpeg'); const meta = await sharp(pv.rawPayload).metadata(); assert.equal(meta.width, 480); assert.equal(meta.height, 853, 'Vorschau im Hochkant-Format');
  assert.equal((await a('PUT', `/api/v1/devices/${dv}/fit`, { fit: 'stretch' })).statusCode, 400); assert.equal((await a('PUT', `/api/v1/devices/${dv}/fit`, { fit: 'cover', safe: 40 })).statusCode, 400);
  const v = await h.as('vera'); assert.equal((await v('PUT', `/api/v1/devices/${dv}/fit`, { fit: 'cover' })).statusCode, 403); await h.cleanup();
});

test('Lizenz und Ablaufdatum: Warnung 14 Tage vorher, abgelaufene Medien verschwinden aus Plan, Manifest und Player (auch offline)', async () => {
  const h = await makeHub(); const a = await h.as('admin'), dv = mkDev(h); const m1 = await upload(a, 800, 600), m2 = await upload(a, 800, 600); await pl(a, [m1, m2]);
  const day = (n) => new Date(h.clock.t + n * 86400e3).toISOString().slice(0, 10);
  assert.equal((await a('PATCH', `/api/v1/media/${m1}`, { author: 'Foto: Max Mustermann', license: 'CC BY 4.0', validUntil: day(10) })).statusCode, 200);
  const w = warnings(h.db, h.clock.t).filter((x) => x.kind === 'laeuft_ab'); assert.equal(w.length, 1); assert.match(w[0].text, /läuft in 10 Tagen ab/);
  assert.equal((await a('GET', '/api/v1/media')).json().find((x) => x.id === m1).license, 'CC BY 4.0');
  const d = h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv); await h.app.variants.idle(); assert.equal(schedulePayload(h.db, d, h.clock.t).playlists[Object.keys(schedulePayload(h.db, d, h.clock.t).playlists)[0]].items.length, 2);
  await a('PATCH', `/api/v1/media/${m1}`, { validUntil: day(-1) }); const pay = schedulePayload(h.db, d, h.clock.t); assert.equal(Object.values(pay.playlists)[0].items.length, 1, 'abgelaufenes Medium aus der Liste genommen');
  assert.ok(!manifestPayload(h.db, d, h.clock.t).items.some((i) => i.id === m1), 'nicht mehr im Manifest'); assert.ok(warnings(h.db, h.clock.t).some((x) => x.kind === 'abgelaufen' && /nicht mehr gezeigt/.test(x.text))); assert.equal((await a('GET', '/api/v1/media')).json().find((x) => x.id === m1).expired, true);
  // Player ohne Hub: Manifest enthält validUntil, der Player nimmt abgelaufene selbst heraus
  const plan = { playlists: { p: { items: [{ mediaId: 'a', duration: 5 }, { mediaId: 'b', duration: 5 }] } } }, manifest = { items: [{ id: 'a', kind: 'image', name: 'A', validUntil: '2000-01-01' }, { id: 'b', kind: 'image', name: 'B', validUntil: '2999-01-01' }] };
  const r = playableItems(plan, 'p', manifest, { profile: 'standard', now: Date.now() }); assert.deepEqual(r.items.map((i) => i.mediaId), ['b']); assert.equal(r.skipped[0].reason, 'Lizenz abgelaufen');
  assert.equal((await a('PATCH', `/api/v1/media/${m2}`, { validUntil: 'morgen' })).statusCode, 400); await h.cleanup();
});

test('Gestaffelte Updates: erst Test-Bildschirm, nach Beobachtungszeit in Gruppen, bei Fehler automatischer Rückfall', async () => {
  const h = await makeHub(); const a = await h.as('admin'); mkdirSync(join(h.dataDir, 'updates'), { recursive: true }); writeFileSync(join(h.dataDir, 'updates', 'current.dfmpkg'), 'x');
  const ids = ['T', 'A', 'B', 'C', 'D'].map((n) => mkDev(h, n)); for (const id of ids) h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(JSON.stringify({ version: '0.1.0' }), id);
  const behaviour = {}; const cmds = [];
  const fake = (id) => ({ readyState: 1, send(raw) { const m = JSON.parse(raw); if (m.type !== 'command') return; cmds.push([id, m.command]); const b = behaviour[id] ?? 'ok'; if (m.command === 'update') setTimeout(() => { // Antwort kommt asynchron, nach der Zustellung
    if (b === 'fail') h.db.prepare("UPDATE commands SET status='failed' WHERE id=?").run(m.id); else { h.db.prepare("UPDATE commands SET status='done', result_json=? WHERE id=?").run(JSON.stringify({ version: '0.2.0' }), m.id); h.db.prepare('UPDATE devices SET state_json=?, last_seen=? WHERE id=?').run(JSON.stringify({ version: '0.2.0' }), h.clock.t, id); } }, 0); } });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  for (const id of ids) h.app.devices.sockets.set(id, fake(id));
  const touch = () => { for (const id of ids) h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(h.clock.t, id); };
  assert.equal((await a('POST', '/api/v1/rollouts', { testDevice: 'nix' })).statusCode, 400);
  const r = (await a('POST', '/api/v1/rollouts', { testDevice: ids[0], batchSize: 2, soakMinutes: 5 })).json(); assert.ok(r.id); assert.equal((await a('POST', '/api/v1/rollouts', { testDevice: ids[0] })).statusCode, 409, 'nur ein Rollout gleichzeitig');
  await settle(); assert.deepEqual(cmds, [[ids[0], 'update']], 'zuerst nur der Test-Bildschirm');
  h.app.rollouts.tick(); assert.equal(cmds.length, 1, 'Beobachtungszeit läuft'); h.clock.t += 6 * 60000; touch(); h.app.rollouts.tick();
  let ro = (await a('GET', '/api/v1/rollouts')).json()[0]; assert.equal(ro.state, 'rolling'); h.app.rollouts.tick(); await settle(); assert.equal(cmds.filter((c) => c[1] === 'update').length, 3, 'Test + 2 aus der ersten Gruppe'); h.clock.t += 1000; touch(); h.app.rollouts.tick(); await settle(); h.app.rollouts.tick(); await settle();
  h.app.rollouts.tick(); await settle(); h.app.rollouts.tick();assert.equal(cmds.filter((c) => c[1] === 'update').length, 5, 'zweite Gruppe'); ro = (await a('GET', '/api/v1/rollouts')).json()[0]; assert.equal(ro.state, 'done'); assert.ok(ro.steps.every((s) => s.state === 'ok'));
  // Fehlerfall: Test-Bildschirm besteht, in der ersten Gruppe schlägt einer fehl → alle aktualisierten gehen zurück
  for (const id of ids) h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(JSON.stringify({ version: '0.1.0' }), id); cmds.length = 0; behaviour[ids[2]] = 'fail';
  (await a('POST', '/api/v1/rollouts', { testDevice: ids[0], batchSize: 2, soakMinutes: 1 })).json(); await settle(); h.app.rollouts.tick();
  h.clock.t += 2 * 60000; touch(); h.app.rollouts.tick(); await settle(); h.app.rollouts.tick(); await settle(); h.app.rollouts.tick();
  const ro2 = (await a('GET', '/api/v1/rollouts')).json()[0]; assert.equal(ro2.state, 'aborted'); assert.ok(cmds.some((c) => c[1] === 'rollback' && c[0] === ids[0]), 'Rückfall für den Test-Bildschirm'); assert.ok(ro2.log.some((l) => /vorherigen Version/.test(l.text)));
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='rollout.rueckfall' AND security=1").get());
  await h.cleanup();
});
