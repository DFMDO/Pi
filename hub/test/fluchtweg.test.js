// Fluchtweg-Plan je Bildschirm (0.2.29): Bei einer Notfall-Meldung folgt dem Text auf genau diesem Bildschirm sein Plan. Der Plan ist immer vorab geladen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { schedulePayload, manifestPayload, ESCAPE_TEXT_S, ESCAPE_PLAN_S } from '../lib/plan.js';

const mkDev = (h, name) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(id, name, h.clock.t); return id; };
const mkMedia = (h, name, kind = 'image') => { const id = randomUUID(); h.db.prepare('INSERT INTO media(id,name,kind,created_at) VALUES(?,?,?,?)').run(id, name, kind, h.clock.t); return id; };
const dev = (h, id) => h.db.prepare('SELECT * FROM devices WHERE id=?').get(id);

test('Fluchtweg: Bildschirm bekommt einen Plan zugewiesen (nur Bilder), wieder entfernbar; Liste zeigt ihn', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), a = mkDev(h, 'Foyer'), img = mkMedia(h, 'Plan EG'), vid = mkMedia(h, 'Film', 'video');
    let r = await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: img }); assert.equal(r.statusCode, 200, r.body);
    assert.equal((await api('GET', `/api/v1/devices/${a}`)).json().escapeMediaId, img);
    r = await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: vid }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /Bild/);
    r = await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: randomUUID() }); assert.equal(r.statusCode, 400);
    assert.equal((await api('GET', `/api/v1/devices/${a}`)).json().escapeMediaId, img, 'ungültige Eingaben ändern nichts');
    r = await api('PATCH', `/api/v1/devices/${a}`, { name: 'Foyer neu' }); assert.equal(r.statusCode, 200); assert.equal((await api('GET', `/api/v1/devices/${a}`)).json().escapeMediaId, img, 'andere Änderungen lassen den Plan stehen');
    r = await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: null }); assert.equal(r.statusCode, 200); assert.equal((await api('GET', `/api/v1/devices/${a}`)).json().escapeMediaId, null);
    const edi = await h.as('edi'); assert.equal((await edi('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: img })).statusCode, 403);
  } finally { await h.cleanup(); }
});

test('Fluchtweg: Notfall-Meldung → Plan des Bildschirms folgt dem Text; Bildschirme ohne Plan zeigen nur die Meldung; danach ist alles wieder normal', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), a = mkDev(h, 'Foyer'), b = mkDev(h, 'Café'), img = mkMedia(h, 'Plan EG');
    await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: img });
    assert.deepEqual((await api('GET', '/api/v1/emergency')).json().escape, { withPlan: 1, total: 2 });
    const e = await api('POST', '/api/v1/emergency/start', { presetId: 'raeumung', confirm: true }); assert.equal(e.statusCode, 201, e.body);
    h.clock.t += 1000;
    const pa = schedulePayload(h.db, dev(h, a), h.clock.t), pb = schedulePayload(h.db, dev(h, b), h.clock.t);
    const oa = pa.overrides.find((o) => o.label === 'NOTFALL'), ob = pb.overrides.find((o) => o.label === 'NOTFALL');
    const la = pa.playlists[oa.playlistId], lb = pb.playlists[ob.playlistId];
    assert.equal(la.items.length, 2); assert.equal(la.items[1].mediaId, img); assert.equal(la.items[0].duration, ESCAPE_TEXT_S); assert.equal(la.items[1].duration, ESCAPE_PLAN_S);
    assert.equal(lb.items.length, 1, 'ohne Plan nur die Meldung'); assert.notEqual(la.items[0].mediaId, img);
    assert.equal(oa.kind, 'notfall'); assert.equal(oa.scope, 'all');
    await api('POST', '/api/v1/emergency/stop');
    h.clock.t += 1000; assert.ok(!schedulePayload(h.db, dev(h, a), h.clock.t).overrides.some((o) => o.label === 'NOTFALL'));
  } finally { await h.cleanup(); }
});

test('Fluchtweg: Der Plan steht immer im Medien-Verzeichnis des Bildschirms (vorab geladen), auch ohne laufende Notfall-Meldung; andere Bildschirme laden ihn nicht', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), a = mkDev(h, 'Foyer'), b = mkDev(h, 'Café'), img = mkMedia(h, 'Plan EG');
    await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: img });
    assert.ok(manifestPayload(h.db, dev(h, a), h.clock.t).items.some((i) => i.id === img), 'Foyer lädt seinen Plan vorab');
    assert.ok(!manifestPayload(h.db, dev(h, b), h.clock.t).items.some((i) => i.id === img), 'Café braucht ihn nicht');
  } finally { await h.cleanup(); }
});

test('Fluchtweg: Ein zugewiesener Plan gilt nicht als „unbenutzt“; Löschen fragt nach und nimmt den Plan danach vom Bildschirm', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), a = mkDev(h, 'Foyer'), img = mkMedia(h, 'Plan EG');
    assert.ok((await api('GET', '/api/v1/media/unused')).json().items.some((m) => m.id === img), 'ohne Zuweisung wäre er unbenutzt');
    await api('PATCH', `/api/v1/devices/${a}`, { escapeMediaId: img });
    assert.ok(!(await api('GET', '/api/v1/media/unused')).json().items.some((m) => m.id === img), 'als Plan zugewiesen: wird benutzt');
    let r = await api('DELETE', `/api/v1/media/${img}`); assert.equal(r.statusCode, 409); assert.match(r.json().error, /Fluchtweg-Plan/); assert.equal(r.json().needsConfirm, true);
    r = await api('DELETE', `/api/v1/media/${img}?force=1`); assert.equal(r.statusCode, 200);
    assert.equal((await api('GET', `/api/v1/devices/${a}`)).json().escapeMediaId, null);
  } finally { await h.cleanup(); }
});
