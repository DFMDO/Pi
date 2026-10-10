// Verschachtelte Abspiellisten (0.2.29): Eine Liste kann andere (veröffentlichte) Listen enthalten. Der Hub liefert dem Player eine FLACHE Liste.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { schedulePayload, playlistItems } from '../lib/plan.js';

const media = (h, name, kind = 'image') => { const id = randomUUID(); h.db.prepare('INSERT INTO media(id,name,kind,duration_s,created_at) VALUES(?,?,?,?,?)').run(id, name, kind, kind === 'video' ? 60 : null, h.clock.t); return id; };
/** Veröffentlichte Liste mit den angegebenen Einträgen anlegen (über die echte Programmierschnittstelle) */
async function mkList(api, name, items) {
  const c = await api('POST', '/api/v1/playlists', { name, publish: true }); assert.equal(c.statusCode, 201, c.body);
  const id = c.json().id; const r = await api('PUT', `/api/v1/playlists/${id}`, { items, publish: true }); assert.equal(r.statusCode, 200, r.body); return r.json().id ?? id;
}

test('Verschachtelt: Hauptliste enthält eine Unterliste – der Plan enthält eine flache Liste in der richtigen Reihenfolge', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'); const a = media(h, 'A'), b = media(h, 'B'), c = media(h, 'C'), d = media(h, 'D');
    const sub = await mkList(api, 'Ausstellung', [{ mediaId: b, duration: 7 }, { mediaId: c, duration: 8 }]);
    const main = await mkList(api, 'Hauptliste', [{ mediaId: a, duration: 5 }, { playlistId: sub }, { mediaId: d, duration: 6 }]);
    const flat = playlistItems(h.db, main, h.clock.t); assert.deepEqual(flat.map((i) => i.mediaId), [a, b, c, d]); assert.deepEqual(flat.map((i) => i.duration), [5, 7, 8, 6]);
    const list = (await api('GET', '/api/v1/playlists')).json().find((p) => p.id === main);
    assert.equal(list.items.length, 3); assert.equal(list.items[1].playlistId, sub); assert.equal(list.items[1].listName, 'Ausstellung'); assert.equal(list.durationS, 5 + 7 + 8 + 6, 'Rundendauer zählt die Unterliste mit');
    // Der Plan für einen Bildschirm kennt nur Medien (kein Verweis auf Unterlisten)
    const dev = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(dev, 'Foyer', h.clock.t);
    h.db.prepare("INSERT INTO schedules(id,target_type,target_id,content_type,content_id,start_local,end_local,priority,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), 'device', dev, 'playlist', main, '2026-10-01T00:00', '2026-12-31T23:59', 5, 'published', h.clock.t);
    const plan = schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(dev), h.clock.t);
    assert.deepEqual(plan.playlists[main].items.map((i) => i.mediaId), [a, b, c, d]);
    assert.ok(!JSON.stringify(plan).includes(sub + '"'), 'die Unterliste taucht im Plan nicht auf');
  } finally { await h.cleanup(); }
});

test('Verschachtelt: „gültig von/bis“ der Einfügung wirkt auf die Einträge der Unterliste (der engere Zeitraum gewinnt)', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'); const a = media(h, 'A'), b = media(h, 'B');
    const sub = await mkList(api, 'Unter', [{ mediaId: a, duration: 5, validFrom: '2026-01-01', validTo: '2026-12-31' }, { mediaId: b, duration: 5 }]);
    const main = await mkList(api, 'Haupt', [{ playlistId: sub, validFrom: '2026-06-01', validTo: '2026-08-31' }]);
    const flat = playlistItems(h.db, main, h.clock.t);
    assert.deepEqual(flat.map((i) => [i.mediaId, i.validFrom, i.validTo]), [[a, '2026-06-01', '2026-08-31'], [b, '2026-06-01', '2026-08-31']]);
    const sub2 = await mkList(api, 'Unter2', [{ mediaId: a, duration: 5, validFrom: '2026-07-15', validTo: '2026-12-31' }]);
    const main2 = await mkList(api, 'Haupt2', [{ playlistId: sub2, validFrom: '2026-06-01', validTo: '2026-08-31' }]);
    assert.deepEqual(playlistItems(h.db, main2, h.clock.t).map((i) => [i.validFrom, i.validTo]), [['2026-07-15', '2026-08-31']]);
  } finally { await h.cleanup(); }
});

test('Verschachtelt: Schleifen, Entwürfe, nicht vorhandene Listen und zu tiefe Verschachtelung werden mit Klartext abgelehnt', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'); const a = media(h, 'A');
    const l1 = await mkList(api, 'L1', [{ mediaId: a, duration: 5 }]);
    const l2 = await mkList(api, 'L2', [{ playlistId: l1 }]);
    // L1 darf L2 nicht enthalten (L2 enthält schon L1) und sich nicht selbst
    let r = await api('PUT', `/api/v1/playlists/${l1}`, { items: [{ playlistId: l2 }] }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /selbst enthalten/);
    r = await api('PUT', `/api/v1/playlists/${l1}`, { items: [{ playlistId: l1 }] }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /selbst enthalten/);
    // Entwurf und unbekannte Liste
    const dr = await api('POST', '/api/v1/playlists', { name: 'Entwurf' }); const draftId = dr.json().id;
    r = await api('PUT', `/api/v1/playlists/${l2}`, { items: [{ playlistId: draftId }] }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /Entwurf/);
    r = await api('PUT', `/api/v1/playlists/${l2}`, { items: [{ playlistId: randomUUID() }] }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /nicht mehr/);
    // Tiefe: L1 ← L2 ← L3 ← L4 (4 Ebenen = 3 Einfügungen) geht, L5 darüber nicht mehr
    const l3 = await mkList(api, 'L3', [{ playlistId: l2 }]); const l4 = await mkList(api, 'L4', [{ playlistId: l3 }]);
    const l5 = await api('POST', '/api/v1/playlists', { name: 'L5', publish: true }); r = await api('PUT', `/api/v1/playlists/${l5.json().id}`, { items: [{ playlistId: l4 }], publish: true });
    assert.equal(r.statusCode, 400); assert.match(r.json().error, /Ebenen/);
    // Der Plan bleibt trotz allem endlich und flach
    assert.deepEqual(playlistItems(h.db, l4, h.clock.t).map((i) => i.mediaId), [a]);
  } finally { await h.cleanup(); }
});

test('Verschachtelt: Entwurf einer Liste mit Einfügung wird mitveröffentlicht; Löschen warnt, wenn die Liste woanders eingefügt ist; Papierkorb stellt die Einfügung wieder her', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'); const a = media(h, 'A'), b = media(h, 'B');
    const sub = await mkList(api, 'Unter', [{ mediaId: a, duration: 5 }]);
    const main = await mkList(api, 'Haupt', [{ mediaId: b, duration: 5 }]);
    // Änderung einer veröffentlichten Liste → Entwurf; veröffentlichte läuft unverändert weiter
    let r = await api('PUT', `/api/v1/playlists/${main}`, { items: [{ mediaId: b, duration: 5 }, { playlistId: sub }] }); assert.equal(r.statusCode, 200); const draft = r.json().draftId;
    assert.deepEqual(playlistItems(h.db, main, h.clock.t).map((i) => i.mediaId), [b], 'noch unveröffentlicht');
    r = await api('POST', `/api/v1/playlists/${draft}/publish`); assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(playlistItems(h.db, main, h.clock.t).map((i) => i.mediaId), [b, a]);
    // Löschen der Unterliste: erst Rückfrage
    r = await api('DELETE', `/api/v1/playlists/${sub}`); assert.equal(r.statusCode, 409); assert.match(r.json().error, /Haupt/); assert.equal(r.json().needsConfirm, true);
    r = await api('DELETE', `/api/v1/playlists/${sub}?force=1`); assert.equal(r.statusCode, 200);
    assert.deepEqual(playlistItems(h.db, main, h.clock.t).map((i) => i.mediaId), [b], 'Einfügung ist weg');
    // Papierkorb: Unterliste wiederherstellen → Einfügung in der Hauptliste ist wieder da
    const trash = (await api('GET', '/api/v1/trash')).json().find((t) => t.kind === 'playlist'); assert.ok(trash);
    r = await api('POST', `/api/v1/trash/${trash.id}/restore`); assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(playlistItems(h.db, main, h.clock.t).map((i) => i.mediaId), [b, a]);
  } finally { await h.cleanup(); }
});

test('Verschachtelt: Eine Liste, die nur aus Einfügungen besteht, gilt nicht als leer; Termin-Warnung bleibt für wirklich leere Listen', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'); const a = media(h, 'A');
    const sub = await mkList(api, 'Unter', [{ mediaId: a, duration: 5 }]);
    const nurListen = await mkList(api, 'Nur Listen', [{ playlistId: sub }]);
    const leer = await mkList(api, 'Leer', []);
    const dev = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(dev, 'Foyer', h.clock.t);
    const ins = h.db.prepare("INSERT INTO schedules(id,target_type,target_id,content_type,content_id,start_local,end_local,priority,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
    ins.run('s1', 'device', dev, 'playlist', nurListen, '2026-10-01T00:00', '2026-12-31T23:59', 5, 'published', h.clock.t);
    ins.run('s2', 'device', dev, 'playlist', leer, '2026-10-01T00:00', '2026-12-31T23:59', 4, 'published', h.clock.t);
    const w = (await api('GET', '/api/v1/warnings')).json().filter((x) => x.kind === 'liste_leer');
    assert.deepEqual(w.flatMap((x) => x.ids), ['s2']);
  } finally { await h.cleanup(); }
});
