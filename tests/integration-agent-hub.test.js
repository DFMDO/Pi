// Integrationstest: echter Hub (TLS) + echter Agent über WSS mit Pinning.
// Prüft: Pairing → Plan/Manifest → Medien-Sync (Hash) → Offline-Weiterlauf → Sperre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeHub, multipart } from '../hub/test/helpers.js';
import { pairWithHub } from '../player/agent/lib/pair.js';
import { Agent } from '../player/agent/agent.js';

const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 40)); } };
process.env.DFM_FAKE_TIMESYNC = '1';

test('Hub + Player: verbinden, synchronisieren, offline weiterlaufen, sperren', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true });
  await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const admin = await h.as('admin');

  // Inhalt: Bild + Text, Standard-Abspielliste
  const img = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#1a1a1a' } }).jpeg().toBuffer();
  const m = multipart('file', 'logo.jpg', img); const imgId = (await admin('POST', '/api/v1/media', m.payload, m.headers)).json().ids[0];
  const txt = (await admin('POST', '/api/v1/media/text', { name: 'Hallo', title: 'Hallo Museum' })).json().id;
  const pl = h.db.prepare('SELECT id FROM playlists WHERE is_default=1').get().id;
  await admin('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: imgId, duration: 5 }, { mediaId: txt, duration: 5 }] });

  // Pairing
  const { code, fingerprintRaw } = (await admin('POST', '/api/v1/pairing')).json();
  const deviceId = randomUUID();
  const paired = pairWithHub({ hubUrl, code, expectedFp: fingerprintRaw, deviceId, name: 'Test-Screen', model: 'Raspberry Pi 4', profile: 'standard', hw: {}, pollMs: 30, timeoutMs: 10000 });
  await until(async () => (await admin('GET', '/api/v1/devices')).json().length);
  await admin('POST', `/api/v1/devices/${deviceId}/approve`, {});
  const { token, spki } = await paired;
  h.app.variants.ensureAll(); await h.app.variants.idle();

  // Agent starten
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-'));
  writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ deviceId, hubUrl, hubSpki: spki, token, profile: 'standard', syncJitterMs: 0 }));
  let exited = null;
  const agent = new Agent({ dataDir, port: 0, heartbeatMs: 200, pollMs: 300, exit: (c) => { exited = c; } });
  await agent.start();
  const local = (p) => fetch(`http://127.0.0.1:${agent.boundPort}${p}`);

  const plan = await until(async () => { const p = await (await local('/plan.json')).json(); return p.segments && p.playlists?.[pl] ? p : null; });
  assert.equal(plan.playlists[pl].items.length, 2);
  await until(() => agent.syncState.total === 1 && agent.syncState.done === 1);
  const manifest = await (await local('/manifest.json')).json();
  const item = manifest.items.find((i) => i.id === imgId);
  const cached = readFileSync(join(dataDir, 'cache', 'media', imgId));
  assert.equal(createHash('sha256').update(cached).digest('hex'), item.sha256, 'Hash der geladenen Datei stimmt');
  assert.equal((await local(`/media/${imgId}`)).status, 200);
  const r = await fetch(`http://127.0.0.1:${agent.boundPort}/media/${imgId}`, { headers: { Range: 'bytes=0-9' } }); assert.equal(r.status, 206);
  assert.equal((await local('/media/../../etc/passwd')).status, 404); assert.equal((await local('/media/notauuid')).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${agent.boundPort}/plan.json`, { method: 'POST' })).status, 405);

  // Heartbeat → Hub zeigt „läuft“
  await until(async () => (await admin('GET', `/api/v1/devices/${deviceId}`)).json().status.level === 'ok');
  assert.match((await admin('GET', `/api/v1/devices/${deviceId}`)).json().summary, /Test-Screen: läuft/);

  // Neuer Termin wird live übertragen
  const sc = await admin('POST', '/api/v1/schedules', { targetType: 'device', targetId: deviceId, content: { type: 'playlist', id: pl }, startLocal: '2030-01-01T10:00', endLocal: '2030-01-01T11:00', priority: 5 });
  assert.equal(sc.statusCode, 201);

  // Hub fällt aus → Player läuft mit Cache weiter (Plan + Medien weiter verfügbar)
  await h.app.close();
  await until(() => !agent.connected);
  assert.equal((await local('/plan.json')).status, 200); assert.equal((await local(`/media/${imgId}`)).status, 200);
  assert.ok(agent.health().offlineSince);
  await agent.stop();

  // Neustart OHNE Hub: sofort aus dem Cache bedienen
  const agent2 = new Agent({ dataDir, port: 0, pollMs: 200 }); await agent2.start();
  const p2 = await (await fetch(`http://127.0.0.1:${agent2.boundPort}/plan.json`)).json();
  assert.ok(p2.playlists[pl]); assert.equal((await fetch(`http://127.0.0.1:${agent2.boundPort}/media/${imgId}`)).status, 200);
  await agent2.stop();
  await h.cleanup().catch(() => {});
});

test('Gesperrtes Gerät: Agent erkennt Sperre, löscht Token und beendet sich', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true });
  await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const admin = await h.as('admin'); const { code, fingerprintRaw } = (await admin('POST', '/api/v1/pairing')).json(); const deviceId = randomUUID();
  const paired = pairWithHub({ hubUrl, code, expectedFp: fingerprintRaw, deviceId, name: 'X', model: 'Pi', profile: 'standard', hw: {}, pollMs: 30, timeoutMs: 10000 });
  await until(async () => (await admin('GET', '/api/v1/devices')).json().length); await admin('POST', `/api/v1/devices/${deviceId}/approve`, {});
  const { token, spki } = await paired;
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-')); writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ deviceId, hubUrl, hubSpki: spki, token, profile: 'standard' }));
  let exited = null; const agent = new Agent({ dataDir, port: 0, heartbeatMs: 200, exit: (c) => { exited = c; } }); await agent.start();
  await until(() => agent.connected);
  await admin('POST', `/api/v1/devices/${deviceId}/block`);
  await until(() => exited === 0); assert.ok(existsSync(join(dataDir, 'unpaired')));
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'agent.json'), 'utf8')).token, null);
  await agent.stop(); await h.cleanup();
});

test('Agent mit falschem Hub-Schlüssel (Pin) verbindet nie', { timeout: 30000 }, async () => {
  const h = await makeHub({ useTls: true });
  await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-')); writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ hubUrl, hubSpki: 'ab'.repeat(32), token: 'x'.repeat(40), profile: 'standard' }));
  const agent = new Agent({ dataDir, port: 0, pollMs: 100 }); await agent.start();
  await new Promise((r) => setTimeout(r, 1500)); assert.equal(agent.connected, false);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'login%'").get().n, 0);
  await agent.stop(); await h.cleanup();
});

test('Erstverbindung nach der Einrichtung: Agent koppelt sich selbst mit Code + Fingerabdruck, Code wird entfernt', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true });
  await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const admin = await h.as('admin'); const { code, fingerprintRaw } = (await admin('POST', '/api/v1/pairing')).json();
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-')); const devFile = join(dataDir, 'device.json'); const deviceId = randomUUID(); writeFileSync(devFile, JSON.stringify({ deviceId }));
  process.env.DFM_DEVICE_FILE = devFile;
  writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ hubUrl, hubSpki: fingerprintRaw, pairing: { code: code.replace('-', '') }, name: 'Shop-Screen', profile: 'standard', model: 'Raspberry Pi 4', hw: {} }));
  const agent = new Agent({ dataDir, port: 0 }); const started = agent.start();
  await until(async () => (await admin('GET', '/api/v1/devices')).json().length);
  assert.equal(agent.health().pairing, 'waiting'); // Bildschirm zeigt „Bitte im Hub bestätigen“
  assert.equal((await admin('GET', '/api/v1/devices')).json()[0].name, 'Shop-Screen');
  await admin('POST', `/api/v1/devices/${deviceId}/approve`, {}); await started;
  await until(() => agent.connected);
  const saved = JSON.parse(readFileSync(join(dataDir, 'agent.json'), 'utf8')); assert.ok(saved.token); assert.equal(saved.pairing, undefined, 'Einmalcode entfernt'); assert.equal(saved.hubSpki, h.tls.spki);
  await agent.stop(); await h.cleanup(); delete process.env.DFM_DEVICE_FILE;
});

test('Diagnose-Befehl: Agent misst Durchsatz und meldet Zustand an den Hub', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const admin = await h.as('admin'); const { code, fingerprintRaw } = (await admin('POST', '/api/v1/pairing')).json(); const deviceId = randomUUID();
  const paired = pairWithHub({ hubUrl, code, expectedFp: fingerprintRaw, deviceId, name: 'D', model: 'Pi', profile: 'standard', hw: {}, pollMs: 30, timeoutMs: 10000 });
  await until(async () => (await admin('GET', '/api/v1/devices')).json().length); await admin('POST', `/api/v1/devices/${deviceId}/approve`, {}); const { token, spki } = await paired;
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-')); writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ deviceId, hubUrl, hubSpki: spki, token, profile: 'standard' }));
  const agent = new Agent({ dataDir, port: 0, heartbeatMs: 200 }); await agent.start(); await until(() => agent.connected);
  const c = (await admin('POST', `/api/v1/devices/${deviceId}/commands`, { command: 'diagnose', args: {} })).json();
  const row = await until(async () => { const r = (await admin('GET', `/api/v1/devices/${deviceId}/commands`)).json().find((x) => x.id === c.id); return r?.status === 'done' ? r : null; });
  const res = JSON.parse(row.result_json); assert.ok(res.throughputMBs > 0, 'Durchsatz gemessen'); assert.equal(res.profile, 'standard'); assert.ok('ramTotalMB' in res);
  await agent.stop(); await h.cleanup();
});
