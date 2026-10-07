// Hub und Bildschirm in einem Gerät: Die Einrichtung schreibt agent.json (Token, Pin auf den eigenen Hub) und local-player.json (nur Token-Hash).
// Der Hub legt den eigenen Bildschirm beim Start an; der Agent verbindet sich über 127.0.0.1 – ohne Einmalcode und ohne Bestätigung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHub } from '../hub/test/helpers.js';
import { Agent } from '../player/agent/agent.js';
import { writeFinalConfig } from '../setup/lib/config.js';

process.env.DFM_FAKE_TIMESYNC = '1';
const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 50)); } };

test('Hub + Bildschirm: eigener Bildschirm wird beim Hub-Start angelegt und verbindet sich gepinnt über 127.0.0.1', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kombi-')), deviceId = randomUUID(), token = randomBytes(32).toString('base64url');
  // so wie die Einrichtung es schreibt (Hub-Daten in /data/hub, Agent in /data/agent)
  await writeFinalConfig({ v: 1, role: 'kombi', name: 'Foyer' }, { localPlayer: { deviceId, tokenHash: createHash('sha256').update(token).digest('hex'), name: 'Foyer', profile: 'pro', model: 'Raspberry Pi 5' }, agent: { deviceId, token, name: 'Foyer', profile: 'pro' } }, root, { chown: () => {} });
  assert.ok(existsSync(join(root, 'hub', 'local-player.json')));
  const h = await makeHub({ useTls: true, dataDir: join(root, 'hub') }); await h.app.listen({ port: 0, host: '127.0.0.1' }); const a = await h.as('admin');
  assert.equal(existsSync(join(root, 'hub', 'local-player.json')), false, 'Datei nach dem Übernehmen gelöscht');
  const dev = h.db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId); assert.equal(dev.status, 'active'); assert.equal(dev.ready, 1); assert.equal(dev.name, 'Foyer');
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='bildschirm.hub_bildschirm_angelegt'").get());
  const m = (await a('POST', '/api/v1/media/text', { name: 'Willkommen', title: 'Willkommen' })).json().id, pl = h.db.prepare('SELECT id FROM playlists WHERE is_default=1').get().id;
  await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m, duration: 5 }], publish: true });
  // Agent mit der von der Einrichtung geschriebenen Konfiguration (Adresse/Pin wie im Gerät: 127.0.0.1 + eigener Hub-Schlüssel)
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-')); writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ deviceId, token, hubUrl: `https://127.0.0.1:${h.app.server.address().port}`, hubSpki: h.tls.spki, profile: 'pro', syncJitterMs: 0 }));
  const agent = new Agent({ dataDir, port: 0, heartbeatMs: 200, pollMs: 300, exit: () => {} }); await agent.start();
  await until(() => agent.connected); const plan = await until(async () => { const p = await (await fetch(`http://127.0.0.1:${agent.boundPort}/plan.json`)).json(); return p.playlists?.[pl] ? p : null; });
  assert.equal(plan.playlists[pl].items[0].mediaId, m);
  assert.equal((await a('GET', '/api/v1/live')).json()[0].status.level, 'ok', 'erscheint in der Live-Ansicht');
  // Falscher Schlüssel = kein Zugang (der Pin gilt auch lokal)
  const bad = mkdtempSync(join(tmpdir(), 'agent-')); writeFileSync(join(bad, 'agent.json'), JSON.stringify({ deviceId, token, hubUrl: `https://127.0.0.1:${h.app.server.address().port}`, hubSpki: 'ab'.repeat(32), profile: 'pro' }));
  const ag2 = new Agent({ dataDir: bad, port: 0, heartbeatMs: 200, pollMs: 300, exit: () => {} }); await ag2.start(); await new Promise((r) => setTimeout(r, 800)); assert.equal(ag2.connected, false, 'Pin-Fehler: keine Verbindung');
  await ag2.stop(); await agent.stop(); h.app.server.closeAllConnections?.(); await h.cleanup();
});

test('Hub + Bildschirm: das Hub-Gerät lässt sich nicht sperren, entfernen oder zurücksetzen', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kombi-')), deviceId = randomUUID(), token = randomBytes(32).toString('base64url');
  await writeFinalConfig({ v: 1, role: 'kombi', name: 'Foyer' }, { localPlayer: { deviceId, tokenHash: createHash('sha256').update(token).digest('hex'), name: 'Foyer', profile: 'pro', model: 'Raspberry Pi 3 B+' }, agent: { deviceId, token, name: 'Foyer', profile: 'pro' } }, root, { chown: () => {} });
  const h = await makeHub({ useTls: true, dataDir: join(root, 'hub') }); const a = await h.as('admin');
  assert.equal((await a('GET', `/api/v1/devices/${deviceId}`)).json().isHub, true);
  for (const [m, u, b] of [['POST', `/api/v1/devices/${deviceId}/block`], ['DELETE', `/api/v1/devices/${deviceId}`], ['POST', `/api/v1/devices/${deviceId}/commands`, { command: 'factory_reset' }]]) {
    const r = await a(m, u, b); assert.equal(r.statusCode, 409, `${m} ${u}`); assert.match(r.json().error, /Hub/);
  }
  // auch der Austausch („Ersetzen“) würde das Hub-Gerät sperren
  const nw = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?, 'standard','pending',?)").run(nw, 'Neuer Pi', Date.now());
  const rr = await a('POST', `/api/v1/devices/${nw}/approve`, { replaces: deviceId }); assert.equal(rr.statusCode, 409); assert.match(rr.json().error, /Hub/);
  assert.equal(h.db.prepare('SELECT status FROM devices WHERE id=?').get(nw).status, 'pending', 'neuer Bildschirm bleibt unbestätigt');
  assert.equal(h.db.prepare('SELECT status FROM devices WHERE id=?').get(deviceId).status, 'active');
  await h.cleanup();
});
