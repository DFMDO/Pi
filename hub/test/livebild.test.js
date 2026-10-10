// Live-Bild (0.2.29): Kamera oder Stream im eigenen Netz als Folie. Adressen werden streng geprüft (nur lokal), Zugangsdaten werden nie ausgegeben,
// nur mpv-Bildschirme zeigen es (Browser-Bildschirme überspringen es), die Ersatzfolie bleibt immer erreichbar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { makeHub } from './helpers.js';
import { parseStreamUrl, isLocalHost, maskStreamUrl } from '../../shared/stream.js';
import { playableItems } from '../../shared/sequencer.js';
import { manifestPayload, schedulePayload } from '../lib/plan.js';
import { liteRenderer } from '../../player/agent/lib/renderers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Adressprüfung: nur Geräte im eigenen Netz; Internet, Zahlen-Schreibweisen und fremde Protokolle werden mit Klartext abgelehnt', () => {
  const ok = ['rtsp://192.168.1.50/stream1', 'rtsp://admin:geheim@10.0.0.7:554/live', 'http://172.16.4.2:8080/video.mjpg', 'https://kamera.local/hls/index.m3u8', 'http://kamera1/live', 'rtsp://[fd12:3456::7]/x', 'udp://239.1.1.1:1234', 'http://169.254.10.10/stream', 'rtsp://localhost:8554/test'];
  for (const u of ok) assert.equal(parseStreamUrl(u).ok, true, u);
  const bad = ['rtsp://8.8.8.8/stream', 'http://example.com/live', 'rtsp://cam.example.org/x', 'rtsp://2130706433/', 'rtsp://0x7f.1/x', 'rtsp://134744072/', 'file:///etc/passwd', 'ftp://192.168.1.2/x', 'javascript:alert(1)',
    'rtsp://192.168.1.2/a b', 'http://172.32.0.1/x', 'http://192.169.0.1/x', 'rtsp://[2001:db8::1]/x', '', '   ', 'kein link', 'rtsp://' + 'a'.repeat(400)];
  for (const u of bad) { const r = parseStreamUrl(u); assert.equal(r.ok, false, `abgelehnt: ${u.slice(0, 40)}`); assert.ok(r.error.length > 10); }
  assert.equal(parseStreamUrl('http://239.1.1.1/x').ok, false, 'Multicast nur bei udp://'); assert.equal(isLocalHost('239.1.1.1', { multicast: true }), true);
  assert.equal(maskStreamUrl('rtsp://admin:geheim@10.0.0.7/live'), 'rtsp://***@10.0.0.7/live'); assert.equal(maskStreamUrl('rtsp://10.0.0.7/live'), 'rtsp://10.0.0.7/live');
});

test('Live-Bild anlegen: Hub prüft die Adresse, gibt nie Zugangsdaten aus und schreibt sie nicht ins Protokoll', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin');
    let r = await api('POST', '/api/v1/media/stream', { name: 'Eingang', url: 'http://example.com/live' }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /Museumsnetz/);
    r = await api('POST', '/api/v1/media/stream', { name: 'Eingang', url: 'rtsp://admin:geheim@192.168.1.50/stream1', title: 'Blick auf den Eingang' }); assert.equal(r.statusCode, 201, r.body); const id = r.json().id;
    const m = (await api('GET', '/api/v1/media')).json().find((x) => x.id === id);
    assert.equal(m.kind, 'text'); assert.equal(m.stream, true); assert.equal(m.text.stream.url, 'rtsp://***@192.168.1.50/stream1'); assert.ok(!JSON.stringify(m).includes('geheim'));
    assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()).includes('geheim'), 'Passwort nicht im Protokoll');
    // Adresse ändern
    r = await api('PATCH', `/api/v1/media/${id}/stream`, { url: 'rtsp://10.1.1.9/neu' }); assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(h.db.prepare('SELECT text_json FROM media WHERE id=?').get(id).text_json).stream.url, 'rtsp://10.1.1.9/neu');
    assert.equal((await api('PATCH', `/api/v1/media/${id}/stream`, { url: 'rtsp://8.8.8.8/x' })).statusCode, 400);
    const normal = (await api('POST', '/api/v1/media/text', { name: 'Text', title: 'Hallo' })).json().id;
    assert.equal((await api('PATCH', `/api/v1/media/${normal}/stream`, { url: 'rtsp://10.1.1.9/x' })).statusCode, 404, 'normale Texte sind keine Live-Bilder');
    const edi = await h.as('vera'); assert.equal((await edi('POST', '/api/v1/media/stream', { name: 'x', url: 'rtsp://10.0.0.1/x' })).statusCode, 403);
  } finally { await h.cleanup(); }
});

test('Live-Bild im Plan: Das Verzeichnis trägt die Adresse als eigenes Feld; Browser-Bildschirme überspringen das Element, mpv-Bildschirme zeigen es', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin');
    const id = (await api('POST', '/api/v1/media/stream', { name: 'Eingang', url: 'rtsp://192.168.1.50/stream1' })).json().id;
    const mp = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,renderer,created_at) VALUES(?,?,'standard','active','mpv',?)").run(mp, 'Video-Wand', h.clock.t);
    const br = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,renderer,created_at) VALUES(?,?,'standard','active','browser',?)").run(br, 'Foyer', h.clock.t);
    const pl = (await api('POST', '/api/v1/playlists', { name: 'Mit Live', publish: true })).json().id;
    await api('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: id, duration: 20 }], publish: true });
    h.app.variants.ensureAll(); await h.app.variants.idle(); // Varianten für die neuen Bildschirme erzeugen (Ersatzfolie)
    const mf = (d) => manifestPayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(d), h.clock.t).items.find((i) => i.id === id);
    const mItem = mf(mp), bItem = mf(br);
    assert.deepEqual(mItem.stream, { url: 'rtsp://192.168.1.50/stream1' }); assert.deepEqual(bItem.stream, { url: 'rtsp://192.168.1.50/stream1' });
    assert.ok(!('url' in (bItem.text ?? {})) && !bItem.text?.stream, 'der Text im Verzeichnis enthält die Adresse nicht noch einmal');
    const plan = { playlists: { [pl]: { name: 'Mit Live', items: [{ mediaId: id, duration: 20, transition: 'fade' }] } } };
    const lite = playableItems(plan, pl, { items: [{ ...mItem, sha256: 'x', url: '/m' }] }, { profile: 'lite', have: () => true });
    assert.equal(lite.items.length, 1); assert.equal(lite.items[0].kind, 'stream'); assert.equal(lite.items[0].stream.url, 'rtsp://192.168.1.50/stream1');
    const std = playableItems(plan, pl, { items: [bItem] }, { profile: 'standard' });
    assert.equal(std.items.length, 0); assert.match(std.skipped[0].reason, /nicht darstellbar/);
    assert.equal(schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(mp), h.clock.t).renderer, 'mpv');
  } finally { await h.cleanup(); }
});

// ---- mpv-Anzeige
const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.kill = () => {}; return c; };
function rig(items, over = {}, dur = 30) {
  const writes = []; const socks = [];
  const net = { connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => writes.push(JSON.parse(String(x).trim())); socks.push(s); return s; } };
  const plan = { defaultPlaylistId: 'pl', playlists: { pl: { name: 'L', items: items.map((m) => ({ mediaId: m.id, duration: dur })) } }, segments: [] };
  const r = liteRenderer({ getPlan: () => plan, getManifest: () => ({ items }), haveFile: () => true, fileOf: (i) => `/cache/${i.mediaId ?? i.id}`, net, spawnFn: fakeChild, reconnectMs: 5, streamRetryMs: 80, ...over });
  return { r, writes, socks };
}
const loads = (w) => w.filter((c) => c.command[0] === 'loadfile').map((c) => c.command[1]);

test('mpv zeigt ein Live-Bild über die Adresse, nutzt dafür einen Zwischenspeicher und fällt bei Fehler auf die Ersatzfolie zurück – später erneut', async () => {
  const live = { id: 'cam', kind: 'text', name: 'Eingang', sha256: 'x', url: '/m/cam', stream: { url: 'rtsp://192.168.1.50/stream1' } };
  const { r, writes, socks } = rig([live]);
  try {
    await sleep(40); socks[0].emit('connect'); await sleep(40);
    assert.deepEqual(loads(writes), ['rtsp://192.168.1.50/stream1']);
    const cacheCmd = writes.filter((c) => c.command[0] === 'set_property' && c.command[1] === 'cache'); assert.equal(cacheCmd.at(-1).command[2], 'yes');
    socks[0].emit('data', Buffer.from('{"event":"end-file","reason":"error"}\n'));
    await sleep(20); assert.equal(loads(writes).at(-1), '/cache/cam', 'Ersatzfolie wird gezeigt');
    await sleep(120); assert.equal(loads(writes).at(-1), 'rtsp://192.168.1.50/stream1', 'nach kurzer Zeit wird es erneut versucht');
  } finally { r.stop(); }
});

test('mpv: Eine unzulässige Adresse (Internet) wird nie geladen – es bleibt bei der Ersatzfolie; nach dem Live-Bild gilt wieder „kein Zwischenspeicher“', async () => {
  const evil = { id: 'x', kind: 'text', name: 'Böse', sha256: 'x', url: '/m/x', stream: { url: 'rtsp://8.8.8.8/stream' } };
  const a = rig([evil]);
  try { await sleep(40); a.socks[0].emit('connect'); await sleep(40); assert.deepEqual(loads(a.writes), ['/cache/x']); } finally { a.r.stop(); }
  const live = { id: 'cam', kind: 'text', name: 'Live', sha256: 'x', url: '/m/cam', stream: { url: 'rtsp://10.0.0.5/s' } }, img = { id: 'img', kind: 'image', name: 'Bild', sha256: 'y', url: '/m/img' };
  const b = rig([live, img], {}, 1);
  try {
    await sleep(40); b.socks[0].emit('connect'); await sleep(40);
    assert.equal(loads(b.writes)[0], 'rtsp://10.0.0.5/s');
    await sleep(1100); // nach 1 s kommt das Bild
    assert.equal(loads(b.writes)[1], '/cache/img');
    const cache = b.writes.filter((c) => c.command[0] === 'set_property' && c.command[1] === 'cache').map((c) => c.command[2]);
    assert.deepEqual(cache, ['yes', 'no'], 'für das Live-Bild an, danach wieder aus');
  } finally { b.r.stop(); }
});
