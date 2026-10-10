// Auslöser-Links (0.2.29): ein geheimer Link startet/beendet von außen eine Szene. Sicherheit: Geheimnis nur als Prüfsumme gespeichert, falsche Links
// werden gebremst, Notfall-Meldungen bleiben unberührt, jeder Aufruf steht im Protokoll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';

async function setup(h) {
  const api = await h.as('admin');
  const pl = (await api('POST', '/api/v1/playlists', { name: 'Eröffnung', publish: true })).json().id;
  const m = randomUUID(); h.db.prepare("INSERT INTO media(id,name,kind,created_at) VALUES(?,?,'image',?)").run(m, 'Bild', h.clock.t);
  await api('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m, duration: 10 }], publish: true });
  const dev = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?,'standard','active',?)").run(dev, 'Foyer', h.clock.t);
  const sc = await api('POST', '/api/v1/scenes', { name: 'Eröffnung', items: [{ scope: 'all', content: { type: 'playlist', id: pl } }], publish: true }); assert.equal(sc.statusCode, 201, sc.body);
  return { api, scene: sc.json().id, playlist: pl };
}
const call = (h, method, token, extra = {}) => h.app.inject({ method, url: `/api/v1/trigger/${token}`, remoteAddress: extra.ip ?? '10.0.0.5' });
const running = (h, scene) => h.db.prepare('SELECT * FROM overrides WHERE scene_id=? AND ended_at IS NULL AND until>?').all(scene, h.clock.t);

test('Auslöser: Anlegen zeigt den Link einmal; gespeichert wird nur die Prüfsumme; nur Admins verwalten', async () => {
  const h = await makeHub();
  try {
    const { api, scene } = await setup(h);
    const r = await api('POST', '/api/v1/triggers', { name: 'Taste 1', sceneId: scene, minutes: 45 }); assert.equal(r.statusCode, 201, r.body);
    const { id, token, path } = r.json(); assert.ok(token.length >= 40); assert.equal(path, `/api/v1/trigger/${token}`);
    const row = h.db.prepare('SELECT * FROM triggers WHERE id=?').get(id); assert.notEqual(row.token_hash, token); assert.ok(!JSON.stringify(row).includes(token), 'Klartext nirgends in der Datenbank');
    const list = (await api('GET', '/api/v1/triggers')).json(); assert.equal(list.length, 1); assert.ok(!JSON.stringify(list).includes(token), 'die Liste verrät den Link nicht'); assert.equal(list[0].sceneName, 'Eröffnung'); assert.equal(list[0].useCount, 0);
    const edi = await h.as('edi'); assert.equal((await edi('GET', '/api/v1/triggers')).statusCode, 403); assert.equal((await edi('POST', '/api/v1/triggers', { name: 'x', sceneId: scene })).statusCode, 403);
    assert.equal((await api('POST', '/api/v1/triggers', { name: 'x', sceneId: 'gibtsnicht' })).statusCode, 400);
  } finally { await h.cleanup(); }
});

test('Auslöser: Aufruf ohne Anmeldung startet die Szene für die eingestellte Zeit; zweiter Aufruf zu schnell wird gebremst; Protokoll ohne Link', async () => {
  const h = await makeHub();
  try {
    const { api, scene } = await setup(h);
    const { token } = (await api('POST', '/api/v1/triggers', { name: 'Taste 1', sceneId: scene, minutes: 45 })).json();
    const r = await call(h, 'POST', token); assert.equal(r.statusCode, 200, r.body); assert.match(r.json().text, /Eröffnung/);
    const ov = running(h, scene); assert.equal(ov.length, 1); assert.equal(ov[0].until, h.clock.t + 45 * 60000); assert.match(ov[0].created_by_name, /Auslöser „Taste 1“/);
    assert.equal((await call(h, 'POST', token)).statusCode, 429, 'Doppelklick innerhalb von 2 Sekunden');
    h.clock.t += 5000; assert.equal((await call(h, 'POST', token)).statusCode, 200, 'nach der Pause wieder erlaubt');
    const t = (await api('GET', '/api/v1/triggers')).json()[0]; assert.equal(t.useCount, 2); assert.ok(t.lastUsed);
    const log = h.db.prepare("SELECT * FROM audit_log WHERE action='ausloeser.ausgeloest'").all(); assert.equal(log.length, 2);
    assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_log').all()).includes(token), 'der Link steht nirgends im Protokoll');
  } finally { await h.cleanup(); }
});

test('Auslöser: GET nur mit ausdrücklicher Erlaubnis; falsche Links werden je Absender gebremst (und verraten nichts)', async () => {
  const h = await makeHub();
  try {
    const { api, scene } = await setup(h);
    const { id, token } = (await api('POST', '/api/v1/triggers', { name: 'T', sceneId: scene })).json();
    const g = await call(h, 'GET', token); assert.equal(g.statusCode, 405); assert.equal(running(h, scene).length, 0, 'GET löst ohne Erlaubnis nichts aus');
    await api('PATCH', `/api/v1/triggers/${id}`, { allowGet: true });
    assert.equal((await call(h, 'GET', token)).statusCode, 200); assert.equal(running(h, scene).length, 1);
    // falsche Links: nach 10 Fehlversuchen von derselben Adresse wird gebremst – auch für den richtigen Link dieser Adresse
    for (let i = 0; i < 10; i++) { const r = await call(h, 'POST', 'falsch' + i, { ip: '10.0.0.99' }); assert.equal(r.statusCode, 404); assert.equal(r.json().error, 'Dieser Link gilt nicht (mehr).'); }
    h.clock.t += 5000;
    const blocked = await call(h, 'POST', token, { ip: '10.0.0.99' }); assert.equal(blocked.statusCode, 429); assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.equal((await call(h, 'POST', token, { ip: '10.0.0.5' })).statusCode, 200, 'andere Adresse nicht betroffen');
  } finally { await h.cleanup(); }
});

test('Auslöser: Eine Notfall-Meldung wird nie beendet oder verdeckt; „beenden“-Auslöser beendet nur die eigene Szene', async () => {
  const h = await makeHub();
  try {
    const { api, scene } = await setup(h);
    const start = (await api('POST', '/api/v1/triggers', { name: 'Start', sceneId: scene })).json(), stop = (await api('POST', '/api/v1/triggers', { name: 'Ende', sceneId: scene, action: 'stop' })).json();
    assert.equal((await call(h, 'POST', start.token)).statusCode, 200); assert.equal(running(h, scene).length, 1);
    h.clock.t += 5000; assert.equal((await call(h, 'POST', stop.token)).statusCode, 200); assert.equal(running(h, scene).length, 0, 'Szene beendet');
    // Notfall läuft: Start-Auslöser wird abgelehnt, die Meldung bleibt
    const e = await api('POST', '/api/v1/emergency/start', { presetId: 'raeumung', confirm: true }); assert.equal(e.statusCode, 201, e.body);
    h.clock.t += 5000; const r = await call(h, 'POST', start.token); assert.equal(r.statusCode, 423); assert.match(r.json().error, /Notfall/);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM overrides WHERE label='NOTFALL' AND ended_at IS NULL").get().n, 1, 'Notfall läuft weiter');
    assert.equal(running(h, scene).length, 0);
    assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='ausloeser.abgelehnt_notfall'").get());
  } finally { await h.cleanup(); }
});

test('Auslöser: ausschalten, Link erneuern (alter Link ungültig), löschen; Szene-Entwurf oder gelöschte Szene ergibt eine klare Meldung', async () => {
  const h = await makeHub();
  try {
    const { api, scene } = await setup(h);
    const { id, token } = (await api('POST', '/api/v1/triggers', { name: 'T', sceneId: scene })).json();
    await api('PATCH', `/api/v1/triggers/${id}`, { enabled: false }); assert.equal((await call(h, 'POST', token)).statusCode, 403);
    await api('PATCH', `/api/v1/triggers/${id}`, { enabled: true }); h.clock.t += 5000;
    const n = (await api('POST', `/api/v1/triggers/${id}/regenerate`)).json(); assert.notEqual(n.token, token);
    assert.equal((await call(h, 'POST', token)).statusCode, 404, 'alter Link gilt nicht mehr'); assert.equal((await call(h, 'POST', n.token)).statusCode, 200);
    // Szene wird wieder zum Entwurf → Auslöser meldet das, statt etwas Halbes zu tun
    h.db.prepare("UPDATE scenes SET state='draft' WHERE id=?").run(scene); h.clock.t += 5000;
    const d = await call(h, 'POST', n.token); assert.equal(d.statusCode, 409); assert.match(d.json().error, /Entwurf/);
    assert.match((await api('GET', '/api/v1/triggers')).json()[0].problem, /Entwurf/);
    h.db.prepare('DELETE FROM scenes WHERE id=?').run(scene); h.clock.t += 5000;
    assert.equal((await call(h, 'POST', n.token)).statusCode, 410);
    assert.equal((await api('DELETE', `/api/v1/triggers/${id}`)).statusCode, 200); assert.equal((await call(h, 'POST', n.token)).statusCode, 404);
  } finally { await h.cleanup(); }
});
