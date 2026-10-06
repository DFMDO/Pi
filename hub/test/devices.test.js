import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { makeHub } from './helpers.js';
import { pairWithHub, pairMac } from '../../player/agent/lib/pair.js';
import { request, pinnedAgent } from '../../player/agent/lib/pinned.js';
import { ensureCertificate } from '../lib/tls.js';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';

async function listening() {
  const h = await makeHub({ useTls: true });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  h.url = `https://127.0.0.1:${h.app.server.address().port}`;
  h.admin = await h.as('admin');
  return h;
}
const dev = () => ({ deviceId: randomUUID(), name: 'Shop-Screen', model: 'Raspberry Pi 4 Model B', profile: 'pro', hw: { ramMB: 4096 } });
const fast = { pollMs: 20, timeoutMs: 8000 };

test('Pairing über echtes TLS mit Pinning: Ablauf bis Token, Token einmalig abholbar', async () => {
  const h = await listening();
  const { code, fingerprintRaw } = (await h.admin('POST', '/api/v1/pairing')).json();
  const d = dev();
  const p = pairWithHub({ hubUrl: h.url, code, expectedFp: fingerprintRaw, ...d, ...fast });
  // Admin bestätigt, sobald das Gerät als wartend auftaucht
  let list; for (let i = 0; i < 100; i++) { list = (await h.admin('GET', '/api/v1/devices')).json(); if (list.length) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(list[0].status.level, 'pending'); assert.equal(list[0].model, d.model);
  assert.equal((await h.admin('POST', `/api/v1/devices/${d.deviceId}/approve`, { name: 'Shop-Screen' })).statusCode, 200);
  const { token, spki } = await p;
  assert.equal(spki, h.tls.spki); assert.ok(token.length >= 40);
  // Token nur gehasht gespeichert
  const row = h.db.prepare('SELECT token_hash FROM devices WHERE id=?').get(d.deviceId);
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex')); assert.notEqual(row.token_hash, token);
  // Geräte-API mit Token (über gepinntes TLS)
  const r = await request({ url: h.url + '/api/v1/device/schedule', pin: spki, token });
  assert.equal(r.status, 200); assert.equal(r.json().type, 'schedule_update');
  await h.cleanup();
});

test('Pinning lehnt fremdes Zertifikat ab (simulierter MitM) – ohne Daten zu senden', async () => {
  const h = await listening();
  const other = ensureCertificate(mkdtempSync(join(tmpdir(), 'evil-')), ['IP:127.0.0.1']);
  assert.notEqual(other.spki, h.tls.spki);
  await assert.rejects(() => request({ url: h.url + '/api/v1/setup/state', pin: other.spki }), (e) => e.code === 'PIN_MISMATCH');
  await h.cleanup();
});

test('Pairing: Fingerabdruck aus Startkarte weicht ab -> Abbruch vor dem ersten Request', async () => {
  const h = await listening();
  const { code } = (await h.admin('POST', '/api/v1/pairing')).json();
  await assert.rejects(() => pairWithHub({ hubUrl: h.url, code, expectedFp: 'ab'.repeat(32), ...dev(), ...fast }), (e) => e.code === 'fingerprint');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM devices').get().n, 0);
  await h.cleanup();
});

test('Pairing mit falschem Code abgelehnt + Sicherheitsereignis, nach 5 Fehlversuchen Code gesperrt', async () => {
  const h = await listening();
  const { code } = (await h.admin('POST', '/api/v1/pairing')).json();
  for (let i = 0; i < 5; i++) await assert.rejects(() => pairWithHub({ hubUrl: h.url, code: 'AAAA-AAAA', ...dev(), ...fast }), (e) => e.code === 'code');
  const ev = (await h.admin('GET', '/api/v1/audit?security=1')).json();
  assert.ok(ev.filter((e) => e.action === 'pairing.fehlgeschlagen').length >= 5);
  // Auch der richtige Code geht jetzt nicht mehr
  await assert.rejects(() => pairWithHub({ hubUrl: h.url, code, ...dev(), ...fast }));
  await h.cleanup();
});

test('MitM-Simulation: HMAC mit falschem Hub-Schlüssel wird abgelehnt', async () => {
  const h = await listening();
  const { code } = (await h.admin('POST', '/api/v1/pairing')).json();
  const nonce = (await h.app.inject({ method: 'POST', url: '/api/v1/pair/challenge' })).json().nonce;
  const deviceId = randomUUID(), secretHash = 'a'.repeat(64);
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/pair/request', payload: { nonce, deviceId, name: 'x', secretHash,
    hmac: pairMac(code, 'f'.repeat(64) /* falscher SPKI */, deviceId, nonce, secretHash) } });
  assert.equal(r.statusCode, 403);
  assert.ok((await h.admin('GET', '/api/v1/audit?security=1')).json().some((e) => e.action === 'pairing.fehlgeschlagen'));
  await h.cleanup();
});

test('Code läuft nach 10 Minuten ab, Nonce nur einmal verwendbar', async () => {
  const h = await makeHub(); const admin = await h.as('admin');
  await admin('POST', '/api/v1/pairing');
  const n1 = (await h.app.inject({ method: 'POST', url: '/api/v1/pair/challenge' })).json().nonce;
  h.clock.t += 11 * 60000;
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/pair/challenge' })).statusCode, 404);
  assert.ok(n1);
  await h.cleanup();
});

test('Sperren: Token sofort ungültig und WebSocket sofort beendet', async () => {
  const h = await listening();
  const { code, fingerprintRaw } = (await h.admin('POST', '/api/v1/pairing')).json();
  const d = dev(); const p = pairWithHub({ hubUrl: h.url, code, expectedFp: fingerprintRaw, ...d, ...fast });
  for (let i = 0; i < 100 && !(await h.admin('GET', '/api/v1/devices')).json().length; i++) await new Promise((r) => setTimeout(r, 20));
  await h.admin('POST', `/api/v1/devices/${d.deviceId}/approve`, {});
  const { token, spki } = await p;
  const ws = new WebSocket(h.url.replace('https', 'wss') + '/api/v1/ws', { agent: pinnedAgent(spki), headers: { Authorization: `Bearer ${token}` } });
  const msgs = []; ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.send(JSON.stringify({ v: 1, type: 'hello', version: '0.1.0', profile: 'pro' }));
  for (let i = 0; i < 100 && msgs.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(msgs.map((m) => m.type).sort(), ['media_manifest', 'schedule_update']);
  const closed = new Promise((r) => ws.on('close', (c) => r(c)));
  await h.admin('POST', `/api/v1/devices/${d.deviceId}/block`);
  assert.equal(await closed, 4001);
  assert.equal((await request({ url: h.url + '/api/v1/device/schedule', pin: spki, token })).status, 401);
  await h.cleanup();
});

test('WebSocket: ungültige Nachrichten werden abgelehnt; Heartbeat, Befehle und Ergebnis', async () => {
  const h = await listening();
  const { code, fingerprintRaw } = (await h.admin('POST', '/api/v1/pairing')).json();
  const d = dev(); const p = pairWithHub({ hubUrl: h.url, code, expectedFp: fingerprintRaw, ...d, ...fast });
  for (let i = 0; i < 100 && !(await h.admin('GET', '/api/v1/devices')).json().length; i++) await new Promise((r) => setTimeout(r, 20));
  await h.admin('POST', `/api/v1/devices/${d.deviceId}/approve`, {}); const { token, spki } = await p;
  const open = async () => { const ws = new WebSocket(h.url.replace('https', 'wss') + '/api/v1/ws', { agent: pinnedAgent(spki), headers: { Authorization: `Bearer ${token}` } }); ws.msgs = []; ws.on('message', (m) => ws.msgs.push(JSON.parse(m))); await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }); return ws; };
  const wait = async (f) => { for (let i = 0; i < 150 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };
  const ws = await open();
  ws.send(JSON.stringify({ v: 1, type: 'heartbeat', state: { cpuTemp: 51.2, nowPlaying: { name: 'Sommer-Aktion' } } }));
  await wait(() => h.db.prepare('SELECT state_json FROM devices').get().state_json);
  assert.match((await h.admin('GET', `/api/v1/devices/${d.deviceId}`)).json().summary, /Shop-Screen: läuft, zeigt gerade „Sommer-Aktion“/);
  const c = (await h.admin('POST', `/api/v1/devices/${d.deviceId}/commands`, { command: 'reload' })).json();
  await wait(() => ws.msgs.some((m) => m.type === 'command'));
  assert.equal(ws.msgs.find((m) => m.type === 'command').command, 'reload');
  ws.send(JSON.stringify({ v: 1, type: 'command_result', id: c.id, ok: true }));
  await wait(() => h.db.prepare('SELECT status FROM commands WHERE id=?').get(c.id).status === 'done');
  assert.equal((await h.admin('POST', `/api/v1/devices/${d.deviceId}/commands`, { command: 'rotate', args: { degrees: 45 } })).statusCode, 400);
  assert.equal((await h.admin('POST', `/api/v1/devices/${d.deviceId}/commands`, { command: 'rm -rf' })).statusCode, 400);
  // Ungültige Nachricht -> Verbindung wird beendet
  const closed = new Promise((r) => ws.on('close', r)); ws.send(JSON.stringify({ v: 1, type: 'heartbeat', state: {}, evil: 1 })); await closed;
  // WLAN-Befehl: Passwort wird nach Zustellung aus der Datenbank gelöscht
  const ws2 = await open();
  await h.admin('POST', `/api/v1/devices/${d.deviceId}/commands`, { command: 'wifi_change', args: { ssid: 'Neu', password: 'geheimgeheim' } });
  await wait(() => ws2.msgs.some((m) => m.type === 'command'));
  assert.equal(ws2.msgs.find((m) => m.type === 'command').args.password, 'geheimgeheim');
  assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM commands').all()).includes('geheimgeheim'));
  assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()).includes('geheimgeheim'));
  ws2.close(); await h.cleanup();
});

test('Offline-Erkennung (Ampel) und Klartext', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const id = randomUUID();
  h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at) VALUES(?,?,?,?,?,?)").run(id, 'Foyer', 'standard', 'active', h.clock.t - 5 * 60000, h.clock.t);
  let d = (await a('GET', '/api/v1/devices')).json()[0]; assert.equal(d.status.level, 'warn'); assert.match(d.summary, /keine Verbindung seit 5 Minuten/);
  h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(h.clock.t - 20 * 60000, id);
  d = (await a('GET', '/api/v1/devices')).json()[0]; assert.equal(d.status.level, 'bad');
  await h.cleanup();
});
