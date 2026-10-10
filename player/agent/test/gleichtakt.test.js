// Gleichtakt und Videowand im mpv-Renderer (0.2.29): gleicher Ablauf aus der Uhrzeit, Zuschnitt je Kachel, Sprung an die gemeinsame Stelle,
// keine Wand bei Notfall-Meldungen. Geprüft mit einem nachgebildeten mpv-Steuerkanal (die echte Anzeige braucht die Pi-Hardware, siehe docs/hardware-checkliste.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { liteRenderer } from '../lib/renderers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.kill = () => {}; return c; };
const img = (id, extra = {}) => ({ id, kind: 'image', name: id, sha256: 'x', url: '/m/' + id, ...extra });
const vid = (id, durationS, extra = {}) => ({ id, kind: 'video', name: id, sha256: 'x', url: '/m/' + id, durationS, ...extra });

/** Ein Bildschirm mit nachgebildetem mpv; wall darf sich während des Tests ändern (wallRef.value) */
function rig(items, wallRef, { dur = 1, over = {}, plan: planOver } = {}) {
  const writes = [], socks = [];
  const net = { connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => { for (const l of String(x).split('\n')) if (l.trim()) writes.push(JSON.parse(l)); }; socks.push(s); return s; } };
  const plan = { defaultPlaylistId: 'pl', playlists: { pl: { name: 'L', items: items.map((m) => ({ mediaId: m.id, duration: dur })) } }, segments: [], ...(planOver ?? {}) };
  const shows = [];
  const r = liteRenderer({ getPlan: () => plan, getManifest: () => ({ items }), haveFile: over.haveFile ?? (() => true), fileOf: (i) => `/cache/${i.mediaId ?? i.id}`, getWall: () => wallRef.value, net, spawnFn: fakeChild, reconnectMs: 5,
    onShow: (s) => shows.push(s.current.mediaId), ...over });
  return { r, writes, socks, shows, connect: async () => { await sleep(30); socks[0].emit('connect'); await sleep(30); } };
}
const loads = (w) => w.filter((c) => c.command[0] === 'loadfile').map((c) => c.command[1]);
const prop = (w, name) => w.filter((c) => c.command[0] === 'set_property' && c.command[1] === name).map((c) => c.command[2]);

test('Gleichtakt: Zwei Bildschirme mit gleichem Startpunkt zeigen zur selben Zeit dasselbe und wechseln gemeinsam; letztes Bild bleibt stehen (keep-open)', async () => {
  const epoch = Date.now() - 300, wall = { value: { mode: 'gleichtakt', epoch } };
  const a = rig([img('a'), img('b')], wall), b = rig([img('a'), img('b')], wall);
  try {
    await Promise.all([a.connect(), b.connect()]);
    assert.deepEqual(loads(a.writes), ['/cache/a']); assert.deepEqual(loads(b.writes), ['/cache/a']);
    assert.deepEqual(prop(a.writes, 'keep-open'), ['yes']); assert.deepEqual(prop(a.writes, 'video-crop'), [], 'Gleichtakt: kein Zuschnitt');
    await sleep(800); // Grenze bei 1 s nach dem Startpunkt
    assert.deepEqual(loads(a.writes), ['/cache/a', '/cache/b']); assert.deepEqual(loads(b.writes), ['/cache/a', '/cache/b']);
    assert.deepEqual(a.shows, ['a', 'b']);
  } finally { a.r.stop(); b.r.stop(); }
});

test('Gleichtakt: Fehlt eine Datei hier noch, bleibt der Takt trotzdem gleich (Ersatzbild, kein Verschieben der Liste)', async () => {
  const epoch = Date.now() - 1300, wall = { value: { mode: 'gleichtakt', epoch } }; // gerade im zweiten Element (b)
  const a = rig([img('a'), img('b'), img('c')], wall, { over: { haveFile: (m) => m.id !== 'b' } });
  try {
    await a.connect();
    assert.deepEqual(loads(a.writes), ['/usr/share/dfm/standby.png'], 'b fehlt → Standby statt zu c zu springen');
    assert.deepEqual(a.shows, ['b']);
  } finally { a.r.stop(); }
});

test('Videowand: Jede Kachel bekommt ihren Ausschnitt in Prozent (vor dem Laden), bei anderem Seitenverhältnis des Inhalts wird gefüllt', async () => {
  const epoch = Date.now() - 100;
  const mk = (col, row, items) => rig(items, { value: { mode: 'videowand', epoch, cols: 2, rows: 2, col, row } });
  const tiles = [mk(0, 0, [img('a', { aspect: 1.7778 })]), mk(1, 0, [img('a', { aspect: 1.7778 })]), mk(0, 1, [img('a', { aspect: 1.7778 })]), mk(1, 1, [img('a', { aspect: 1.7778 })])];
  const wide = mk(1, 0, [img('w', { aspect: 2.3333 })]);
  try {
    await Promise.all([...tiles, wide].map((t) => t.connect()));
    assert.deepEqual(tiles.map((t) => prop(t.writes, 'video-crop')), [['50%x50%+0%+0%'], ['50%x50%+100%+0%'], ['50%x50%+0%+100%'], ['50%x50%+100%+100%']]);
    const t = tiles[1].writes, iCrop = t.findIndex((c) => c.command[1] === 'video-crop'), iLoad = t.findIndex((c) => c.command[0] === 'loadfile');
    assert.ok(iCrop >= 0 && iCrop < iLoad, 'Zuschnitt kommt vor dem Laden');
    // 21:9-Inhalt auf 2×2: die Wand ist 16:9, also werden links und rechts Ränder abgeschnitten (Breite 76 % → Kachel 38 %)
    assert.deepEqual(prop(wide.writes, 'video-crop'), ['38%x50%+81%+0%']);
  } finally { [...tiles, wide].forEach((t) => t.r.stop()); }
});

test('Videowand: Hinweisbilder (Standby, Uhrzeit) und Notfall-Meldungen werden nie zugeschnitten – jeder Bildschirm zeigt sie ganz', async () => {
  const epoch = Date.now() - 100, wall = { value: { mode: 'videowand', epoch, cols: 2, rows: 1, col: 1, row: 0 } };
  const nf = { id: 'nf-1', scope: 'all', playlistId: 'nf', until: Date.now() + 60000, createdAt: Date.now(), kind: 'notfall', label: 'NOTFALL' };
  const plan = { overrides: [nf] }; // Notfall läuft: Liste „nf“ statt der Wand
  const a = rig([img('a'), img('n')], wall, { plan: { ...plan, playlists: { pl: { name: 'L', items: [{ mediaId: 'a', duration: 1 }] }, nf: { name: 'Notfall', items: [{ mediaId: 'n', duration: 1 }] } } } });
  try {
    await a.connect();
    assert.deepEqual(loads(a.writes), ['/cache/n'], 'Notfall-Folie läuft normal'); assert.deepEqual(prop(a.writes, 'video-crop'), []); assert.deepEqual(prop(a.writes, 'keep-open'), []);
  } finally { a.r.stop(); }
  const empty = rig([], wall);
  try { await empty.connect(); assert.deepEqual(loads(empty.writes), ['/usr/share/dfm/standby.png']); assert.deepEqual(prop(empty.writes, 'video-crop'), []); } finally { empty.r.stop(); }
});

test('Gleichtakt: Wer später dazukommt (Video läuft schon 20 s), springt nach kurzer Zeit an die gemeinsame Stelle – und nur, wenn er wirklich abweicht', async () => {
  const epoch = Date.now() - 20000, wall = { value: { mode: 'gleichtakt', epoch } };
  const a = rig([vid('v', 60)], wall, { dur: 60 });
  try {
    await a.connect();
    assert.deepEqual(loads(a.writes), ['/cache/v']);
    await sleep(1600); // erste Prüfung nach 1,5 s: mpv wird nach der Position gefragt
    const ask = a.writes.find((c) => c.command[0] === 'get_property' && c.command[1] === 'time-pos'); assert.ok(ask, 'Abfrage der Position');
    a.socks[0].emit('data', Buffer.from(JSON.stringify({ request_id: ask.request_id, error: 'success', data: 0.4 }) + '\n'));
    await sleep(60);
    const seek = a.writes.find((c) => c.command[0] === 'seek'); assert.ok(seek, 'Sprung');
    assert.ok(Math.abs(seek.command[1] - 21.6) < 0.5, `Ziel ${seek.command[1]} (erwartet ≈ 21,6 s)`); assert.equal(seek.command[2], 'absolute+exact');
  } finally { a.r.stop(); }
  // genau an der richtigen Stelle: kein Sprung
  const epoch2 = Date.now() - 20000, b = rig([vid('v', 60)], { value: { mode: 'gleichtakt', epoch: epoch2 } }, { dur: 60 });
  try {
    await b.connect(); await sleep(1600);
    const ask = b.writes.find((c) => c.command[0] === 'get_property'); b.socks[0].emit('data', Buffer.from(JSON.stringify({ request_id: ask.request_id, error: 'success', data: (Date.now() - epoch2) / 1000 - 0.05 }) + '\n'));
    await sleep(60); assert.equal(b.writes.filter((c) => c.command[0] === 'seek').length, 0, 'bereits an der richtigen Stelle');
  } finally { b.r.stop(); }
});

test('Gleichtakt beenden: mpv bekommt die Standard-Einstellungen zurück (kein Zuschnitt, Video wird wieder normal weitergeschaltet)', async () => {
  const wall = { value: { mode: 'videowand', epoch: Date.now() - 50, cols: 2, rows: 1, col: 0, row: 0 } };
  const a = rig([img('a', { aspect: 1.7778 }), img('b')], wall);
  try {
    await a.connect(); assert.deepEqual(prop(a.writes, 'video-crop'), ['50%x50%+0%+50%'], '2×1-Wand mit 16:9-Inhalt: mittlere Hälfte der Höhe, linke Hälfte der Breite');
    wall.value = null; a.r.notify(); await sleep(30);
    assert.equal(prop(a.writes, 'video-crop').at(-1), '', 'Zuschnitt zurückgesetzt'); assert.equal(prop(a.writes, 'keep-open').at(-1), 'no');
  } finally { a.r.stop(); }
});
