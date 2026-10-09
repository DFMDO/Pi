// Wiedergabe-Nachweis von Ende zu Ende: echter Hub (TLS) + echter Agent. Der Agent zählt, meldet über WSS, der Hub bestätigt, der Agent räumt auf.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHub } from '../hub/test/helpers.js';
import { sha256hex } from '../hub/lib/crypto.js';
import { Agent } from '../player/agent/agent.js';

const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 40)); } };
process.env.DFM_FAKE_TIMESYNC = '1';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const img = { mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, film = { mediaId: B, name: 'Film', kind: 'video', duration: 60 };

test('Nachweis: Agent zählt Einblendungen, meldet sie über WSS, Hub bestätigt; Doppeltes zählt nicht doppelt; bei ausgeschaltetem Bildschirm wird nicht gezählt', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const deviceId = randomUUID(), token = 'p'.repeat(40);
  h.db.prepare("INSERT INTO devices(id,name,profile,status,token_hash,created_at,last_seen,ready) VALUES(?,?,'standard','active',?,?,?,1)").run(deviceId, 'Foyer', sha256hex(token), Date.now(), Date.now());
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-plays-')); writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ deviceId, hubUrl, hubSpki: h.tls.spki, token, profile: 'standard', syncJitterMs: 0 }));
  const agent = new Agent({ dataDir, port: 0, heartbeatMs: 200, pollMs: 300, exit: () => {} }); await agent.start();
  try {
    await until(() => agent.connected);
    const rows = () => h.db.prepare('SELECT media_id,name,plays,seconds FROM plays WHERE device_id=? ORDER BY media_id').all(deviceId);
    agent.onPlayerStatus({ current: img }); agent.onPlayerStatus({ current: film }); agent.onPlayerStatus({ current: img });
    agent.sendPlays(); await until(() => rows().length === 2 && agent.plays.peek().inflight === null, 6000); // Hub hat gespeichert UND bestätigt
    assert.deepEqual(rows().map((r) => [r.media_id, r.name, r.plays]), [[A, 'Foto', 2], [B, 'Film', 1]], 'Foto zwei Mal, Film ein Mal');
    assert.equal(agent.plays.peek().seq, 1);

    // Zweite Runde: nur das Neue wird gemeldet, der Hub addiert
    agent.onPlayerStatus({ current: film }); agent.sendPlays(); await until(() => rows().find((r) => r.media_id === B).plays === 2 && agent.plays.peek().inflight === null);
    assert.equal(rows().find((r) => r.media_id === A).plays, 2, 'Foto nicht noch einmal gezählt');

    // Dieselbe Meldung noch einmal (Bestätigung unterwegs verloren): Hub bestätigt, zählt aber nicht doppelt
    const total = () => rows().reduce((s, r) => s + r.plays, 0), before = total(); agent.send('plays', { id: 2, days: { [new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })]: { [A]: { n: 5, s: 50, name: 'Foto', kind: 'image' } } } });
    await new Promise((r) => setTimeout(r, 400)); assert.equal(total(), before, 'gleiche Nummer = schon verarbeitet');

    // Bildschirm aus: es wird nichts gezählt
    agent.displayOff = true; agent.onPlayerStatus({ current: img }); agent.onPlayerStatus({ current: film });
    assert.equal(agent.plays.payload(Date.now() + 1e6), null, 'bei ausgeschaltetem Bildschirm nichts zu melden'); agent.displayOff = false;
  } finally { await agent.stop(); await h.cleanup(); rmSync(dataDir, { recursive: true, force: true }); }
});
