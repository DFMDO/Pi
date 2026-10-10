// Version 0.2.28 – Stabilität am Bildschirm: Die Anzeige läuft weiter, auch wenn die Karte voll ist, ein Download hängt, der Plan Unsinn enthält
// oder ein Fehler in einer Hintergrundaufgabe auftritt. Und: Friert die Anzeige ein, startet sie sich (selten und vorsichtig) selbst neu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { syncMedia } from '../lib/sync.js';
import { createLocalServer } from '../lib/localserver.js';
import { liteRenderer } from '../lib/renderers.js';
import { Agent } from '../agent.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'ag-stab-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const item = (id, buf) => ({ id, url: '/m/' + id, sha256: sha(buf), size: buf.length });

// ---------------------------------------------------------------- Sync
test('Sync: Reicht der freie Platz nicht, wird gar nicht erst geladen (keine halbe Datei), und der Hub-Zustand zeigt „Speicher voll“', async () => {
  const dir = tmp(), a = Buffer.alloc(100, 1); let calls = 0;
  const r = await syncMedia({ manifest: { items: [item('a', a)] }, dir, fetchRange: async () => { calls++; return { status: 200, stream: Readable.from([a]) }; }, freeBytes: () => 500, minFreeBytes: 1000 });
  assert.equal(calls, 0); assert.equal(r.failed.length, 1); assert.equal(r.noSpace, true); assert.match(r.failed[0].error, /Speicherplatz/);
  assert.ok(!existsSync(join(dir, 'a')) && !existsSync(join(dir, 'a.part')));
});

test('Sync: Bei knappem Platz werden zuerst nicht mehr benötigte Medien entfernt – danach klappt der Download (eine volle Karte bleibt nicht für immer voll)', async () => {
  const dir = tmp(), a = Buffer.alloc(100, 7), stale = join(dir, 'altes-medium'); writeFileSync(stale, 'x'.repeat(50));
  const r = await syncMedia({ manifest: { items: [item('a', a)] }, dir, fetchRange: async () => ({ status: 200, stream: Readable.from([a]) }), freeBytes: () => (existsSync(stale) ? 10 : 1e9), minFreeBytes: 1000 });
  assert.equal(r.done, 1); assert.equal(r.failed.length, 0); assert.ok(!existsSync(stale)); assert.deepEqual(readFileSync(join(dir, 'a')), a);
});

test('Sync: Ein Download, der nichts mehr sendet, wird abgebrochen (der Abgleich bleibt nie für immer hängen)', async () => {
  const dir = tmp(), a = Buffer.alloc(100, 3); let destroyed = false;
  const hang = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), destroy: () => { destroyed = true; } };
  const t0 = Date.now();
  const r = await syncMedia({ manifest: { items: [item('a', a)] }, dir, fetchRange: async () => ({ status: 200, stream: hang }), stallMs: 80, freeBytes: () => 1e9 });
  assert.ok(Date.now() - t0 < 3000, 'nach ca. 80 ms aufgegeben'); assert.equal(r.failed.length, 1); assert.match(r.failed[0].error, /keine Daten/); assert.equal(destroyed, true, 'Verbindung beendet');
});

test('Sync: Antwortet der Hub gar nicht, wird ebenfalls abgebrochen; ein Fehler beim Verbindungsaufbau betrifft nur dieses Medium', async () => {
  const dir = tmp(), a = Buffer.alloc(100, 3), b = Buffer.alloc(100, 4), c = Buffer.alloc(50, 9);
  const fetchRange = async (url) => { if (url.endsWith('/a')) return new Promise(() => {}); if (url.endsWith('/b')) throw new TypeError('kaputte Adresse'); return { status: 200, stream: Readable.from([c]) }; };
  const r = await syncMedia({ manifest: { items: [item('a', a), item('b', b), item('c', c)] }, dir, fetchRange, stallMs: 80, freeBytes: () => 1e9 });
  assert.equal(r.done, 1, 'das dritte Medium kam trotzdem an'); assert.equal(r.failed.length, 2);
  assert.match(r.failed.find((f) => f.id === 'a').error, /antwortet nicht/); assert.match(r.failed.find((f) => f.id === 'b').error, /kaputte Adresse/);
});

test('Sync: Bereits geprüfte Dateien werden beim nächsten Abgleich nicht neu gelesen; eine veränderte Datei wird trotzdem erkannt', async () => {
  const dir = tmp(), a = Buffer.alloc(200, 5); let calls = 0;
  const fetchRange = async () => { calls++; return { status: 200, stream: Readable.from([a]) }; };
  const m = { items: [item('a', a)] };
  await syncMedia({ manifest: m, dir, fetchRange, freeBytes: () => 1e9 }); assert.equal(calls, 1);
  await syncMedia({ manifest: m, dir, fetchRange, freeBytes: () => 1e9 }); assert.equal(calls, 1, 'nichts erneut geladen');
  // gleiche Größe, anderer Inhalt, neue Änderungszeit → muss auffallen
  writeFileSync(join(dir, 'a'), Buffer.alloc(200, 6)); const ts = Date.now() / 1000 + 20; utimesSync(join(dir, 'a'), ts, ts);
  const r = await syncMedia({ manifest: m, dir, fetchRange, freeBytes: () => 1e9 }); assert.equal(calls, 2, 'beschädigte Datei neu geladen'); assert.equal(r.done, 1); assert.deepEqual(readFileSync(join(dir, 'a')), a);
});

// ---------------------------------------------------------------- Agent
function mkAgent() {
  const dir = tmp(); writeFileSync(join(dir, 'agent.json'), JSON.stringify({ deviceId: 'x', profile: 'standard', token: 't', hubUrl: 'https://127.0.0.1', hubSpki: 'ab' }));
  const c = { restart: 0, exit: [], logs: [], emitted: [] };
  const a = new Agent({ dataDir: dir, port: 0, log: (...x) => c.logs.push(x.join(' ')), exit: (code) => c.exit.push(code) });
  a.renderer = { restart: () => { c.restart++; }, notify: () => { c.notified = (c.notified ?? 0) + 1; } };
  const realEmit = a.server.emit; a.server.emit = (ev, d) => { c.emitted.push(ev); return realEmit(ev, d); };
  writeFileSync(join(a.mediaDir, 'm1'), 'x');
  a.plan = { defaultPlaylistId: 'pl', playlists: { pl: { name: 'L', items: [{ mediaId: 'm1', duration: 10 }] } }, segments: [] };
  a.manifest = { items: [{ id: 'm1', kind: 'image', name: 'Bild' }] };
  return { a, c, dir };
}
const plan = () => ({ v: 1, type: 'schedule_update', generatedAt: 1, from: 0, to: 1, segments: [], playlists: {}, defaultPlaylistId: null });

test('Agent: Ist die Karte voll oder schreibgeschützt, läuft der neue Plan trotzdem im Arbeitsspeicher weiter (Anzeige wird aktualisiert, Fehler vermerkt)', async () => {
  const { a, c } = mkAgent();
  a.dataDir = 'kaputt\0pfad'; // Schreiben schlägt fehl
  await a.onMessage(JSON.stringify(plan()));
  assert.equal(a.plan.defaultPlaylistId, null, 'neuer Plan gilt trotzdem'); assert.ok(c.emitted.includes('plan'), 'Anzeige wurde benachrichtigt'); assert.equal(c.notified, 1);
  assert.ok(a.diskError, 'Fehler vermerkt'); assert.ok(c.logs.some((l) => l.includes('Speichern nicht möglich')));
});

test('Agent: Ein Fehler bei der Verarbeitung einer Nachricht wird protokolliert und beendet weder Verbindung noch Prozess', async () => {
  const { a, c } = mkAgent();
  a.handleMessage = () => { throw new Error('unerwartet'); };
  await a.onMessage(JSON.stringify(plan())); // darf nicht werfen
  assert.ok(c.logs.some((l) => l.includes('unerwartet')));
  await a.onMessage('kein json'); await a.onMessage(JSON.stringify({ v: 1, type: 'unbekannt' })); assert.deepEqual(c.exit, []);
});

test('Agent: Unsinnige Statusmeldungen des Players werden ignoriert, ohne den lokalen Server zu stören', () => {
  const { a } = mkAgent();
  a.plan = null;
  assert.doesNotThrow(() => { a.onPlayerStatus(null); a.onPlayerStatus({ current: 5 }); a.onPlayerStatus({ current: { mediaId: 'm1' } }); });
});

test('Agent: Ein unbrauchbarer Hub-Pfad ergibt beim Herunterladen einen Fehler statt eines hängenden Abgleichs', async () => {
  const { a } = mkAgent();
  a.cfg.hubUrl = 'das ist keine adresse';
  await assert.rejects(() => a.fetchRange('/api/v1/device/media/x', 0));
});

test('Selbstheilung: Meldet die Anzeige viel zu lange nichts, startet zuerst die Anzeige neu, beim zweiten Mal in Folge der Agent – höchstens einmal pro Stunde', () => {
  const { a, c } = mkAgent(); const T = Date.now(), MIN = 60000;
  a.startedAt = T - 3 * 3600000; a.playerStatus = { current: { since: T - 30 * MIN } }; a.cfg.profile = 'standard';
  assert.equal(a.watchPlayback(T), 'anzeige'); assert.equal(c.restart, 1); assert.deepEqual(c.exit, []); assert.equal(a.heal.count, 1);
  assert.equal(a.watchPlayback(T + 2 * MIN), null, 'in der folgenden Stunde nicht noch einmal'); assert.equal(c.restart, 1);
  assert.equal(a.watchPlayback(T + 61 * MIN), 'agent', 'nach einer Stunde ohne Lebenszeichen: Agent neu'); assert.deepEqual(c.exit, [75]); assert.equal(c.restart, 1);
});

test('Selbstheilung: Meldet sich die Anzeige wieder, beginnt die Zählung von vorn', () => {
  const { a, c } = mkAgent(); const T = Date.now(), MIN = 60000;
  a.startedAt = T - 3 * 3600000; a.playerStatus = { current: { since: T - 30 * MIN } };
  assert.equal(a.watchPlayback(T), 'anzeige');
  a.onPlayerStatus({ current: { mediaId: 'm1', name: 'Bild', kind: 'image', duration: 10 } }); assert.equal(a.heal.streak, 0, 'Lebenszeichen: Zähler zurück');
  a.playerStatus.current.since = T + 70 * MIN - 30 * MIN; // später wieder still
  assert.equal(a.watchPlayback(T + 70 * MIN), 'anzeige', 'wieder zuerst nur die Anzeige'); assert.equal(c.restart, 2); assert.deepEqual(c.exit, []);
});

test('Selbstheilung: greift nie ein, wenn es dafür keinen Grund gibt', () => {
  const T = Date.now(), MIN = 60000, fresh = () => { const x = mkAgent(); x.a.startedAt = T - 3 * 3600000; x.a.playerStatus = { current: { since: T - 30 * MIN } }; return x; };
  const never = (label, mutate) => { const { a, c } = fresh(); mutate(a); assert.equal(a.watchPlayback(T), null, label); assert.equal(c.restart, 0, label); assert.deepEqual(c.exit, [], label); };
  never('gerade erst gestartet', (a) => { a.startedAt = T - 10 * MIN; });
  never('Anzeige hat sich vor Kurzem gemeldet', (a) => { a.playerStatus.current.since = T - 5 * MIN; });
  never('Bildschirm planmäßig aus', (a) => { a.displayOff = true; });
  never('Bildschirm wird geteilt', (a) => { a.share = { id: 'x', last: T, n: 1 }; });
  never('Rückfall-Frist für die Ausrichtung läuft', (a) => { a.displayRevert = { prev: 0, timer: null }; });
  never('Medien werden noch geladen', (a) => { a.syncState = { done: 1, total: 3 }; });
  never('Uhrzeit noch nicht eingestellt', (a) => { a.timeOk = false; });
  never('kein Plan', (a) => { a.plan = null; });
  never('Plan ohne abspielbare Elemente (Medium fehlt noch)', (a) => { a.manifest = { items: [] }; });
  never('Wartung / Halt', (a) => { a.plan = { ...a.plan, hold: 'wartung' }; });
  never('Anzeige ohne Neustart-Möglichkeit', (a) => { a.renderer = {}; });
  never('Agent bereits beendet', (a) => { a.stopped = true; });
  // lange Videos: die Frist wächst mit dem längsten Element (30-Minuten-Video: 2 × 30 + 5 = 65 Minuten)
  const x = fresh(); x.a.manifest.items[0] = { id: 'm1', kind: 'video', name: 'V', durationS: 30 * 60 };
  x.a.playerStatus.current.since = T - 40 * MIN; assert.equal(x.a.watchPlayback(T), null, '40 Minuten sind bei diesem Video noch normal');
  x.a.playerStatus.current.since = T - 70 * MIN; assert.equal(x.a.watchPlayback(T), 'anzeige', 'nach 70 Minuten ist es zu lang');
});

// ---------------------------------------------------------------- Lokaler Server
test('Lokaler Server: Ein Fehler bei einer Anfrage ergibt „500“ für diese Anfrage, der Server läuft weiter; Medien kommen mit Dateityp und Bereichsanfrage', async () => {
  const mediaDir = tmp(); const id = randomUUID(); const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 1)]); writeFileSync(join(mediaDir, id), jpg);
  let boom = true;
  const s = createLocalServer({ getPlan: () => null, getManifest: () => null, getHealth: () => { if (boom) throw new Error('kaputt'); return { ok: true }; }, mediaDir, port: 0 });
  const port = await s.listen();
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(bad.status, 500); await bad.arrayBuffer();
    boom = false; const ok = await fetch(`http://127.0.0.1:${port}/health`); assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true });
    const full = await fetch(`http://127.0.0.1:${port}/media/${id}`); assert.equal(full.headers.get('content-type'), 'image/jpeg'); assert.equal((await full.arrayBuffer()).byteLength, jpg.length);
    const part = await fetch(`http://127.0.0.1:${port}/media/${id}`, { headers: { range: 'bytes=10-19' } }); assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 10);
    const none = await fetch(`http://127.0.0.1:${port}/media/${randomUUID()}`); assert.equal(none.status, 404); await none.arrayBuffer();
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- Anzeige (mpv)
const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.kill = () => {}; return c; };
const fakeNet = () => { const st = { socks: [] }; return { st, connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = () => {}; st.socks.push(s); return s; } }; };

test('mpv-Anzeige: Ein Fehler im Takt (unbrauchbarer Plan) wird protokolliert und wirft nicht – die Anzeige versucht es weiter', async () => {
  const net = fakeNet(), logs = [];
  const r = liteRenderer({ getPlan: () => { throw new Error('Plan kaputt'); }, getManifest: () => ({ items: [] }), haveFile: () => false, fileOf: () => '', net, spawnFn: fakeChild, reconnectMs: 5, log: (...x) => logs.push(x.join(' ')) });
  try {
    await sleep(60); assert.ok(net.st.socks.length >= 1, 'Verbindung wurde aufgebaut');
    assert.doesNotThrow(() => net.st.socks[0].emit('connect'));
    assert.ok(logs.some((l) => l.includes('Anzeige-Takt') && l.includes('Plan kaputt')), logs.join(' | '));
  } finally { r.stop(); }
});

test('mpv-Anzeige: Fehlt einem Element die Dauer, wird es trotzdem ordentlich (10 s) gezeigt statt in einer Endlosschleife neu geladen', async () => {
  const net = fakeNet(); let shows = 0;
  const r = liteRenderer({ getPlan: () => ({ defaultPlaylistId: 'pl', playlists: { pl: { name: 'L', items: [{ mediaId: 'm' }] } }, segments: [] }), getManifest: () => ({ items: [{ id: 'm', kind: 'image', name: 'B' }] }), haveFile: () => true, fileOf: () => 'datei', net, spawnFn: fakeChild, reconnectMs: 5, onShow: () => { shows++; } });
  await sleep(40); net.st.socks[0].emit('connect'); await sleep(400);
  r.stop(); assert.equal(shows, 1, `nur einmal gezeigt (nicht ${shows}-mal in einer Schleife)`);
});

test('Anzeige-Überwachung: Lässt sich das Programm nicht starten, wird es später erneut versucht – ohne Absturz', async () => {
  const net = fakeNet(), logs = []; let spawns = 0;
  const r = liteRenderer({ getPlan: () => null, getManifest: () => ({ items: [] }), haveFile: () => false, fileOf: () => '', net, spawnFn: () => { spawns++; if (spawns === 1) throw new Error('nicht ausführbar'); return fakeChild(); }, reconnectMs: 5, log: (...x) => logs.push(x.join(' ')) });
  assert.equal(spawns, 1); assert.ok(logs.some((l) => l.includes('konnte nicht gestartet werden')));
  await sleep(2400); r.stop(); assert.ok(spawns >= 2, `zweiter Versuch erfolgt (${spawns})`);
});
