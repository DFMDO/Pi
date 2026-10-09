// Bildschirm teilen auf dem Bildschirm: Browser-Anzeige (Bild + Ereignis über den lokalen Server) und mpv („Video-optimiert“: Bild als Datei laden, Plan pausiert).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { makeHub } from '../hub/test/helpers.js';
import { sha256hex } from '../hub/lib/crypto.js';
import { Agent } from '../player/agent/agent.js';
import { liteRenderer } from '../player/agent/lib/renderers.js';

const until = async (f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Zeitüberschreitung'); await new Promise((r) => setTimeout(r, 30)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.DFM_FAKE_TIMESYNC = '1';
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1500, n)]);
const frameMsg = (id, buf) => ({ v: 1, type: 'share_frame', id, jpg: buf.toString('base64') });

async function agentOn(h, over = {}) {
  await h.app.listen({ port: 0, host: '127.0.0.1' }); const hubUrl = `https://127.0.0.1:${h.app.server.address().port}`;
  const deviceId = randomUUID(), token = 's'.repeat(40);
  h.db.prepare("INSERT INTO devices(id,name,profile,status,token_hash,created_at,last_seen,ready) VALUES(?,?,'standard','active',?,?,?,1)").run(deviceId, 'Foyer', sha256hex(token), Date.now(), Date.now());
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-share-')); writeFileSync(join(dataDir, 'agent.json'), JSON.stringify({ deviceId, hubUrl, hubSpki: h.tls.spki, token, profile: 'standard', syncJitterMs: 0 }));
  const agent = new Agent({ dataDir, port: 0, heartbeatMs: 200, pollMs: 300, exit: () => {}, ...over }); await agent.start(); await until(() => agent.connected);
  return { agent, deviceId, dataDir, local: (p) => fetch(`http://127.0.0.1:${agent.boundPort}${p}`) };
}

test('Browser-Anzeige: Hub → Agent → lokaler Server; Bild abrufbar, Ereignis „share“/„shareend“, Gesundheitswert, Ende per Hub und per Zeitüberwachung', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true }); const a = await h.as('admin'); const { agent, deviceId, dataDir, local } = await agentOn(h);
  agent.shareIdleMs = 400; agent.shareCheckMs = 100; clearInterval(agent.shareTimer); agent.shareTimer = setInterval(() => { if (agent.share && Date.now() - agent.share.last > agent.shareIdleMs) agent.shareStop('keine Bilder mehr'); }, agent.shareCheckMs); agent.shareTimer.unref();
  const events = []; const ctrl = new AbortController(); const res = await fetch(`http://127.0.0.1:${agent.boundPort}/events`, { signal: ctrl.signal });
  (async () => { const rd = res.body.getReader(), dec = new TextDecoder(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; events.push(dec.decode(value)); } } catch {} })();
  try {
    assert.equal((await local('/share/frame.jpg')).status, 404, 'ohne Übertragung kein Bild'); assert.equal((await (await local('/health')).json()).share, null);
    const s = (await a('POST', '/api/v1/share', { deviceIds: [deviceId] })).json(); assert.ok(s.id);
    await until(async () => (await (await local('/health')).json()).share?.active, 4000);
    const f1 = jpeg(7); assert.equal((await a('POST', `/api/v1/share/${s.id}/frame`, f1, { 'content-type': 'image/jpeg' })).statusCode, 204);
    const r = await until(async () => { const x = await local('/share/frame.jpg'); return x.status === 200 ? x : null; }); assert.equal(r.headers.get('content-type'), 'image/jpeg'); assert.equal(Buffer.from(await r.arrayBuffer()).compare(f1), 0, 'Bild kommt unverändert an');
    await until(() => events.join('').includes('event: share\n')); assert.match(events.join(''), /event: share\ndata: \{"n":1\}/); assert.equal((await (await local('/health')).json()).share.n, 1);
    const f2 = jpeg(9); await a('POST', `/api/v1/share/${s.id}/frame`, f2, { 'content-type': 'image/jpeg' }); await until(async () => Buffer.from(await (await local('/share/frame.jpg')).arrayBuffer()).compare(f2) === 0);
    await a('DELETE', `/api/v1/share/${s.id}`); await until(async () => (await local('/share/frame.jpg')).status === 404); assert.match(events.join(''), /event: shareend/); assert.equal((await (await local('/health')).json()).share, null, 'nach dem Ende: nichts mehr geteilt');
    // Hub weg / Browser geschlossen: Agent beendet die Übertragung selbst, wenn keine Bilder mehr kommen
    agent.shareFrame(frameMsg('xyz', jpeg(3))); assert.ok(agent.share, 'ein Bild startet die Anzeige auch ohne vorheriges share_start (nach kurzem Verbindungsabbruch)'); await until(() => agent.share === null, 3000); assert.equal((await local('/share/frame.jpg')).status, 404);
    // Ungültige Bilder werden ignoriert
    agent.shareStart('abc'); agent.shareFrame(frameMsg('abc', Buffer.from('das ist kein jpeg, nur ein langer text '.repeat(10)))); assert.equal((await local('/share/frame.jpg')).status, 404, 'kein JPEG-Kopf: nicht angezeigt'); agent.shareStop('Test');
  } finally { ctrl.abort(); await agent.stop(); await h.cleanup(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('mpv-Anzeige über den Agenten: Bild wird in eine Datei im Arbeitsspeicher-Ordner geschrieben (abwechselnd zwei Namen) und dem Renderer übergeben; Ende ruft den Renderer mit null', { timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true }); const shareDir = mkdtempSync(join(tmpdir(), 'dfm-sharedir-')); const calls = [];
  const { agent, dataDir } = await agentOn(h); agent.shareDir = shareDir; agent.renderer = { share: (f) => calls.push(f), start() {}, stop() {} };
  try {
    const a1 = jpeg(1), a2 = jpeg(2), a3 = jpeg(3); agent.shareFrame(frameMsg('s1', a1)); agent.shareFrame(frameMsg('s1', a2)); agent.shareFrame(frameMsg('s1', a3));
    assert.equal(calls.length, 3); assert.deepEqual(calls.map((c) => c.split(/[\\/]/).pop()), ['share-1.jpg', 'share-0.jpg', 'share-1.jpg'], 'abwechselnd, damit mpv nie die Datei liest, die gerade geschrieben wird');
    assert.equal(readFileSync(join(shareDir, 'share-1.jpg')).compare(a3), 0); assert.equal(readFileSync(join(shareDir, 'share-0.jpg')).compare(a2), 0); assert.deepEqual(readdirSync(shareDir).sort(), ['share-0.jpg', 'share-1.jpg'], 'nie mehr als zwei Dateien');
    agent.shareStop('Test'); assert.equal(calls.at(-1), null, 'Renderer wird zurückgesetzt'); agent.shareStop('nochmal'); assert.equal(calls.length, 4, 'zweites Beenden tut nichts');
  } finally { await agent.stop(); await h.cleanup(); rmSync(shareDir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }
});

test('mpv-Renderer: während der Übertragung pausiert der Plan und die Uhr-Einblendung ist weg; danach läuft alles wieder', async () => {
  const writes = []; const net = { connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => writes.push(JSON.parse(String(x)).command); setImmediate(() => s.emit('connect')); return s; } };
  const fake = () => { const c = new EventEmitter(); c.pid = 1; c.kill = () => {}; return c; };
  const r = liteRenderer({ getPlan: () => ({ segments: [], playlists: {}, layout: { preset: 'ticker-clock' }, tickers: [] }), getManifest: () => ({ items: [] }), haveFile: () => false, fileOf: () => '', now: () => Date.UTC(2026, 9, 10, 8, 41), net, spawnFn: fake, reconnectMs: 10 });
  const loads = () => writes.filter((c) => c[0] === 'loadfile').map((c) => c[1]), ov = () => writes.filter((c) => c[0] === 'osd-overlay');
  try {
    await sleep(150); assert.deepEqual(loads(), ['/usr/share/dfm/standby.png'], 'ohne Inhalte: Standby'); assert.equal(ov().at(-1)[2], 'ass-events');
    r.share('/run/x/share-1.jpg'); await sleep(30); assert.equal(loads().at(-1), '/run/x/share-1.jpg', 'geteiltes Bild wird geladen'); assert.equal(ov().at(-1)[2], 'none', 'Leiste/Uhr verschwinden');
    r.share('/run/x/share-0.jpg'); await sleep(30); assert.equal(loads().at(-1), '/run/x/share-0.jpg'); const before = loads().length; r.notify(); await sleep(60); assert.equal(loads().length, before, 'Plan-Wechsel (Standby) darf das geteilte Bild nicht überschreiben');
    r.share(null); await sleep(60); assert.equal(loads().at(-1), '/usr/share/dfm/standby.png', 'danach wieder der Plan'); assert.equal(ov().at(-1)[2], 'ass-events', 'Uhr ist wieder da'); r.share(null); await sleep(30);
  } finally { r.stop(); }
});
