// Der Simulator-Player ersetzt echte Pis in automatischen Tests: Pairing, Zeitplan, Live-Ansicht, Konflikte, Übersteuerung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from '../hub/test/helpers.js';
import { startSimulators } from '../tools/simulator.js';

const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 50)); } };

test('Simulator: 3 virtuelle Player (Lite/Standard/Pro) pairen, spielen den Plan, erscheinen in der Live-Ansicht; Übersteuerung und Sperre wirken', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`; const a = await h.as('admin');
  h.db.prepare("INSERT OR REPLACE INTO settings VALUES('commissioning.required','false')").run();
  const m1 = (await a('POST', '/api/v1/media/text', { name: 'Eins', title: 'Eins' })).json().id, m2 = (await a('POST', '/api/v1/media/text', { name: 'Zwei', title: 'Zwei' })).json().id;
  const def = h.db.prepare('SELECT id FROM playlists WHERE is_default=1').get().id; await a('PUT', `/api/v1/playlists/${def}`, { items: [{ mediaId: m1, duration: 1 }, { mediaId: m2, duration: 1 }], publish: true });
  const code = async () => (await a('POST', '/api/v1/pairing')).json().code;
  const sims = await startSimulators({ hubUrl, count: 3, code, tick: 100, heartbeatMs: 300, approve: async (id) => { await a('POST', `/api/v1/devices/${id}/approve`, {}); } });
  assert.deepEqual(sims.map((s) => s.profile), ['lite', 'standard', 'pro']); await until(() => sims.every((s) => s.plan && s.manifest));
  await h.app.variants.idle(); for (const s of sims) h.app.devices.pushPlan(h.db.prepare('SELECT * FROM devices WHERE id=?').get(s.deviceId));
  // Live-Ansicht Stufe 1: Ist wird gemeldet, Soll/Ist stimmen überein (Lite bekommt Text als Bild-Variante, nicht „Browser-Text“)
  await until(async () => (await a('GET', '/api/v1/live')).json().filter((r) => r.ist?.current).length === 3);
  const live = (await a('GET', '/api/v1/live')).json(); assert.equal(live.length, 3); assert.ok(live.every((r) => r.status.level === 'ok')); assert.ok(live.every((r) => !r.mismatch), 'Soll = Ist');
  // Inhaltswechsel in der Live-Ansicht nach höchstens 2 s
  const first = (await a('GET', `/api/v1/live/${sims[1].deviceId}`)).json().ist.current.mediaId; const t0 = Date.now(); await until(async () => (await a('GET', `/api/v1/live/${sims[1].deviceId}`)).json().ist.current.mediaId !== first, 3000); assert.ok(Date.now() - t0 <= 2500, `Wechsel nach ${Date.now() - t0} ms`);
  // Schnellaktion auf alle: Plan der Simulatoren enthält die Übersteuerung
  const m3 = (await a('POST', '/api/v1/media/text', { name: 'Notfall', title: 'Notfall' })).json().id; await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'media', id: m3 }, minutes: 30, confirm: true });
  await until(() => sims.every((s) => s.plan.overrides?.length === 1)); await until(async () => (await a('GET', '/api/v1/live')).json().every((r) => r.ist?.current?.name === 'Notfall' || r.ist?.current?.mediaId === m3), 4000).catch(() => null);
  assert.ok(sims.every((s) => s.plan.overrides[0].playlistId === 'media:' + m3));
  // Befehl und Sperre
  await a('POST', `/api/v1/devices/${sims[0].deviceId}/commands`, { command: 'reload' }); await until(() => sims[0].cmds.some((c) => c.command === 'reload'));
  await a('POST', `/api/v1/devices/${sims[2].deviceId}/block`); await until(() => !sims[2].connected); assert.equal(sims[2].closeCode, 4001, 'gesperrt: Verbindung sofort beendet');
  sims.forEach((s) => s.close()); h.app.server.closeAllConnections?.(); await h.cleanup();
});
