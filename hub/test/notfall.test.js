// Notfall-Meldung: ein Klick, alles andere endet, rote Folie, Rechte, Bestätigung, eigene Texte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { DEFAULT_PRESETS, NOTFALL_LABEL } from '../lib/notfall.js';

const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const plist = async (a, name, m) => { const id = (await a('POST', '/api/v1/playlists', { name, publish: true })).json().id; await a('PUT', `/api/v1/playlists/${id}`, { items: [{ mediaId: m, duration: 10 }], publish: true }); return id; };
const mkDev = (h, name = 'Dev') => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at) VALUES(?,?,'standard','active',?,?)").run(id, name, h.clock.t, h.clock.t); return id; };

test('Notfall: Liste der Beispieltexte; Start braucht Bestätigung; danach läuft die rote Folie auf allen Bildschirmen', async () => {
  const h = await makeHub(); const a = await h.as('admin'); mkDev(h);
  const l = (await a('GET', '/api/v1/emergency')).json(); assert.deepEqual(l.presets, DEFAULT_PRESETS); assert.equal(l.active, null); assert.equal(l.isDefault, true);
  const r0 = await a('POST', '/api/v1/emergency/start', { presetId: 'stoerung' }); assert.equal(r0.statusCode, 409); assert.equal(r0.json().needsConfirm, true);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM overrides').get().n, 0, 'ohne Bestätigung passiert nichts');
  const r = await a('POST', '/api/v1/emergency/start', { presetId: 'stoerung', confirm: true, minutes: 30 }); assert.equal(r.statusCode, 201, r.body); assert.match(r.json().text, /Technische Störung/);
  const o = h.db.prepare('SELECT * FROM overrides WHERE ended_at IS NULL').get(); assert.equal(o.label, NOTFALL_LABEL); assert.equal(o.scope, 'all'); assert.equal(o.content_type, 'media'); assert.equal(o.until, h.clock.t + 30 * 60000);
  const m = h.db.prepare('SELECT * FROM media WHERE id=?').get(o.content_id); assert.equal(m.folder, 'Notfall'); assert.deepEqual(JSON.parse(m.text_json), { title: 'Technische Störung', body: DEFAULT_PRESETS[1].text, template: 'notfall' });
  const g = (await a('GET', '/api/v1/emergency')).json(); assert.equal(g.active.title, 'Technische Störung'); assert.equal(g.active.by, 'admin');
  assert.match((await a('GET', '/api/v1/overrides')).json()[0].text, /NOTFALL-MELDUNG von admin/);
  assert.equal(h.db.prepare("SELECT security FROM audit_log WHERE action='notfall.gestartet'").get()?.security, 1, 'Sicherheitsereignis im Protokoll');
  await h.cleanup();
});

test('Notfall: beendet alle anderen Übersteuerungen und Szenen, nutzt denselben Text wieder, Stopp stellt den Plan zurück', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h); const m = await txt(a, 'Werbung'); const p = await plist(a, 'Liste', m);
  assert.equal((await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'playlist', id: p }, minutes: 30, confirm: true })).statusCode, 201);
  assert.equal((await a('POST', '/api/v1/overrides', { scope: 'device', targetId: dv, content: { type: 'playlist', id: p }, minutes: 30 })).statusCode, 201, 'Übersteuerung nur für einen Bildschirm');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM overrides WHERE ended_at IS NULL').get().n, 2);
  await a('POST', '/api/v1/emergency/start', { text: 'Bitte alle Besucher zum Haupteingang', title: 'Hinweis', confirm: true });
  const live = h.db.prepare('SELECT label FROM overrides WHERE ended_at IS NULL').all(); assert.deepEqual(live.map((x) => x.label), [NOTFALL_LABEL], 'nur noch die Notfall-Meldung');
  const first = h.db.prepare("SELECT id FROM media WHERE folder='Notfall'").all(); assert.equal(first.length, 1);
  assert.equal((await a('POST', '/api/v1/emergency/stop')).statusCode, 200); assert.equal(h.db.prepare('SELECT COUNT(*) n FROM overrides WHERE ended_at IS NULL').get().n, 0);
  assert.equal((await a('POST', '/api/v1/emergency/stop')).statusCode, 404, 'es läuft nichts mehr');
  await a('POST', '/api/v1/emergency/start', { text: 'Bitte alle Besucher zum Haupteingang', title: 'Hinweis', confirm: true, endOfDay: true });
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE folder='Notfall'").get().n, 1, 'gleicher Text = dieselbe Folie');
  assert.ok(h.db.prepare('SELECT until FROM overrides WHERE ended_at IS NULL').get().until > h.clock.t, 'bis Tagesende');
  await h.cleanup();
});

test('Notfall: Eingaben werden geprüft, Rechte je Rolle, Texte ändern nur für Admins', async () => {
  const h = await makeHub(); const a = await h.as('admin'), ed = await h.as('edi'), vera = await h.as('vera');
  for (const bad of [{ confirm: true }, { presetId: 'gibtsnicht', confirm: true }, { text: '   ', confirm: true }, { text: 'x'.repeat(301), confirm: true }, { text: 'ok', minutes: 1, confirm: true }]) assert.equal((await a('POST', '/api/v1/emergency/start', bad)).statusCode, 400, JSON.stringify(bad).slice(0, 50));
  assert.equal((await vera('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true })).statusCode, 403, 'Anzeige-Rolle darf nicht');
  assert.equal((await vera('GET', '/api/v1/emergency')).statusCode, 403); assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/emergency/start', payload: {} })).statusCode, 401);
  assert.equal((await ed('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true })).statusCode, 201, 'Redakteur darf auslösen');
  assert.equal((await ed('PUT', '/api/v1/emergency/presets', { presets: [{ title: 'A', text: 'B' }] })).statusCode, 403, 'Texte ändern nur Admin');
  const put = await a('PUT', '/api/v1/emergency/presets', { presets: [{ title: 'Alarm-Probe', text: 'Dies ist eine Übung.' }, { title: '   ', text: 'wird verworfen' }] }); assert.equal(put.statusCode, 200, put.body); assert.deepEqual(put.json().presets, [{ id: 'p1', title: 'Alarm-Probe', text: 'Dies ist eine Übung.' }]);
  const l = (await a('GET', '/api/v1/emergency')).json(); assert.equal(l.isDefault, false); assert.equal(l.presets[0].title, 'Alarm-Probe');
  assert.equal((await a('PUT', '/api/v1/emergency/presets', { presets: [] })).statusCode, 400); assert.equal((await a('PUT', '/api/v1/emergency/presets', { presets: [{ title: '  ', text: 'x' }] })).statusCode, 400, 'nur leere Einträge');
  assert.equal((await a('POST', '/api/v1/emergency/start', { presetId: 'p1', confirm: true })).statusCode, 201, 'eigener Text lässt sich auslösen');
  await h.cleanup();
});

test('Notfall-Texte tauchen nicht in der Aufräumhilfe auf', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  await a('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true }); await a('POST', '/api/v1/emergency/stop');
  const un = (await a('GET', '/api/v1/media/unused')).json(); assert.ok(!un.items.some((m) => m.folder === 'Notfall'));
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media WHERE folder='Notfall'").get().n, 1);
  await h.cleanup();
});
