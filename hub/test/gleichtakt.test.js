// Gleichtakt und Videowand (0.2.29): Gruppen-Einstellung, Plan nur für neue Bildschirme, Plätze der Videowand, Warnungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { schedulePayload, manifestPayload, warnings, wallFor } from '../lib/plan.js';
import { validateMessage, msg } from '../../shared/protocol.js';

const mkDev = (h, name, over = {}) => {
  const id = randomUUID();
  h.db.prepare("INSERT INTO devices(id,name,profile,status,group_id,state_json,orientation,renderer,created_at) VALUES(?,?,'standard','active',?,?,?,?,?)")
    .run(id, name, over.group ?? null, JSON.stringify({ version: over.version ?? '0.2.29' }), over.orientation ?? 0, over.renderer ?? 'browser', h.clock.t);
  return id;
};
const dev = (h, id) => h.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
const mkGroup = async (api, name = 'Wand') => (await api('POST', '/api/v1/groups', { name })).json().id;

test('Gruppe: Gleichtakt einstellen – gemeinsamer Startpunkt bleibt stehen, Liste zeigt Betriebsart und Anzahl', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), g = await mkGroup(api); mkDev(h, 'A', { group: g }); mkDev(h, 'B', { group: g });
    let r = await api('PATCH', `/api/v1/groups/${g}`, { syncMode: 'gleichtakt' }); assert.equal(r.statusCode, 200, r.body);
    const g1 = (await api('GET', '/api/v1/groups')).json().find((x) => x.id === g); assert.equal(g1.syncMode, 'gleichtakt'); assert.equal(g1.members, 2); assert.ok(g1.sync_epoch > 0);
    const epoch = g1.sync_epoch; h.clock.t += 3 * 86400000; const api2 = await h.as('admin'); // (die Sitzung gilt nur 30 Minuten der Test-Uhr)
    await api2('PATCH', `/api/v1/groups/${g}`, { name: 'Wand neu' }); assert.equal((await api2('GET', '/api/v1/groups')).json().find((x) => x.id === g).sync_epoch, epoch, 'Startpunkt bleibt');
    await api2('PATCH', `/api/v1/groups/${g}`, { syncMode: 'off' }); assert.equal((await api2('GET', '/api/v1/groups')).json().find((x) => x.id === g).sync_epoch, null);
    r = await api2('PATCH', `/api/v1/groups/${g}`, { syncMode: 'videowand', cols: 1, rows: 1 }); assert.equal(r.statusCode, 400); assert.match(r.json().error, /zwei Kacheln/);
    assert.equal((await api2('PATCH', `/api/v1/groups/${randomUUID()}`, { syncMode: 'off' })).statusCode, 404);
    const edi = await h.as('edi'); assert.equal((await edi('PATCH', `/api/v1/groups/${g}`, { syncMode: 'gleichtakt' })).statusCode, 403);
  } finally { await h.cleanup(); }
});

test('Plan: Bildschirme ab 0.2.29 bekommen „wall“ und mpv, ältere und Nicht-Mitglieder nicht; Einschübe entfallen im Gleichtakt; Protokoll akzeptiert das Feld', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), g = await mkGroup(api);
    const neu = mkDev(h, 'Neu', { group: g, version: '0.2.29' }), alt = mkDev(h, 'Alt', { group: g, version: '0.2.28' }), solo = mkDev(h, 'Solo', { version: '0.2.29' });
    const m = randomUUID(); h.db.prepare("INSERT INTO media(id,name,kind,created_at) VALUES(?,?,'image',?)").run(m, 'Logo', h.clock.t);
    h.db.prepare("INSERT INTO inserts(id,name,media_id,every_min,seconds,scope,enabled,created_at) VALUES(?,?,?,?,?,'all',1,?)").run(randomUUID(), 'Logo', m, 5, 10, h.clock.t);
    let p = schedulePayload(h.db, dev(h, neu), h.clock.t); assert.equal(p.wall, undefined); assert.equal(p.inserts?.length, 1, 'ohne Gleichtakt: Einschübe da');
    await api('PATCH', `/api/v1/groups/${g}`, { syncMode: 'gleichtakt' });
    p = schedulePayload(h.db, dev(h, neu), h.clock.t); assert.equal(p.wall.mode, 'gleichtakt'); assert.ok(p.wall.epoch > 0); assert.equal(p.renderer, 'mpv'); assert.equal(p.inserts, undefined);
    assert.equal(validateMessage(JSON.parse(msg('schedule_update', p))), null, 'Protokoll akzeptiert den Plan mit „wall“');
    const pa = schedulePayload(h.db, dev(h, alt), h.clock.t); assert.equal(pa.wall, undefined); assert.equal(pa.renderer, 'browser'); assert.equal(pa.inserts?.length, 1);
    assert.equal(schedulePayload(h.db, dev(h, solo), h.clock.t).wall, undefined);
    assert.equal(wallFor(h.db, dev(h, neu), '0.2.30').mode, 'gleichtakt'); assert.equal(wallFor(h.db, dev(h, neu), ''), null);
  } finally { await h.cleanup(); }
});

test('Videowand: Plätze werden der Reihe nach vergeben, lassen sich ändern; der Plan trägt Spalte, Zeile und Raster; Gruppenwechsel setzt den Platz zurück', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), g = await mkGroup(api);
    const a = mkDev(h, 'A', { group: g }), b = mkDev(h, 'B', { group: g }), c = mkDev(h, 'C', { group: g }), d = mkDev(h, 'D', { group: g });
    assert.equal((await api('PATCH', `/api/v1/groups/${g}`, { syncMode: 'videowand', cols: 2, rows: 2 })).statusCode, 200);
    const pos = (id) => { const x = dev(h, id); return [x.wall_col, x.wall_row]; };
    assert.deepEqual([pos(a), pos(b), pos(c), pos(d)], [[0, 0], [1, 0], [0, 1], [1, 1]], 'zeilenweise nach Name');
    const p = schedulePayload(h.db, dev(h, d), h.clock.t); assert.deepEqual({ ...p.wall, epoch: undefined }, { mode: 'videowand', epoch: undefined, cols: 2, rows: 2, col: 1, row: 1 });
    // Plätze tauschen
    assert.equal((await api('PATCH', `/api/v1/devices/${a}`, { wallCol: 1, wallRow: 1 })).statusCode, 200); assert.deepEqual(pos(a), [1, 1]);
    assert.equal((await api('GET', `/api/v1/devices/${a}`)).json().wallCol, 1);
    assert.equal((await api('PATCH', `/api/v1/devices/${a}`, { wallCol: 9, wallRow: 0 })).statusCode, 400, 'außerhalb von 0 … 3 wird abgelehnt');
    // ohne gültigen Platz → Gleichtakt mit ganzem Bild
    h.db.prepare('UPDATE devices SET wall_col=5 WHERE id=?').run(b); assert.equal(schedulePayload(h.db, dev(h, b), h.clock.t).wall.mode, 'gleichtakt');
    // in eine andere Gruppe (ohne Videowand) → Platz weg
    const g2 = await mkGroup(api, 'Andere'); await api('PATCH', `/api/v1/devices/${c}`, { groupId: g2 }); assert.deepEqual(pos(c), [null, null]);
    assert.equal(schedulePayload(h.db, dev(h, c), h.clock.t).wall, undefined);
  } finally { await h.cleanup(); }
});

test('Verzeichnis: im Gleichtakt als Bild statt Textobjekt; Seitenverhältnis aus Breite und Höhe', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), g = await mkGroup(api), a = mkDev(h, 'A', { group: g });
    const t = randomUUID(); h.db.prepare("INSERT INTO media(id,name,kind,text_json,created_at) VALUES(?,?,'text',?,?)").run(t, 'Text', JSON.stringify({ title: 'Hallo', body: 'x' }), h.clock.t);
    const v = randomUUID(); h.db.prepare("INSERT INTO media(id,name,kind,width,height,created_at) VALUES(?,?,'image',1440,1080,?)").run(v, 'Bild 4:3', h.clock.t);
    h.db.prepare("INSERT INTO media_variants(id,media_id,profile,path,sha256,size,status) VALUES(?,?,'standard','x.jpg','ab',10,'ready')").run(randomUUID(), v);
    const pl = (await api('POST', '/api/v1/playlists', { name: 'L', publish: true })).json().id;
    await api('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: t, duration: 10 }, { mediaId: v, duration: 10 }], publish: true });
    h.app.variants.ensureAll(); await h.app.variants.idle();
    assert.ok(manifestPayload(h.db, dev(h, a), h.clock.t).items.find((i) => i.id === t).text, 'ohne Gleichtakt: Browser bekommt das Textobjekt');
    await api('PATCH', `/api/v1/groups/${g}`, { syncMode: 'gleichtakt' }); h.app.variants.ensureAll(); await h.app.variants.idle();
    const items = manifestPayload(h.db, dev(h, a), h.clock.t).items;
    const ti = items.find((i) => i.id === t); assert.ok(!ti.text && ti.url && ti.sha256, 'mpv: Bild-Fassung des Texts');
    assert.equal(items.find((i) => i.id === v).aspect, 1.3333);
  } finally { await h.cleanup(); }
});

test('Warnungen: veraltete Bildschirme, fehlende oder doppelte Plätze, gedrehte Bildschirme und Lücken in der Videowand', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin'), g = await mkGroup(api, 'Atrium');
    const a = mkDev(h, 'A', { group: g }), b = mkDev(h, 'B', { group: g, version: '0.2.27' }), c = mkDev(h, 'C', { group: g, orientation: 90 });
    await api('PATCH', `/api/v1/groups/${g}`, { syncMode: 'videowand', cols: 2, rows: 2 });
    h.db.prepare('UPDATE devices SET wall_col=0, wall_row=0 WHERE id IN (?,?)').run(a, c); h.db.prepare('UPDATE devices SET wall_col=NULL, wall_row=NULL WHERE id=?').run(b);
    const w = warnings(h.db, h.clock.t); const kinds = w.map((x) => x.kind);
    for (const k of ['gleichtakt_alt', 'videowand_position', 'videowand_doppelt', 'videowand_gedreht', 'videowand_luecke']) assert.ok(kinds.includes(k), `${k} fehlt: ${kinds.join(',')}`);
    assert.match(w.find((x) => x.kind === 'videowand_luecke').text, /4 Kacheln.*nur 3/);
  } finally { await h.cleanup(); }
});
