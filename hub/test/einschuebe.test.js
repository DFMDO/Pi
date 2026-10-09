// Einschübe (0.2.26): „alle N Minuten Folie X für S Sekunden“ – Planfeld nur für neue Bildschirme, Regeln im Player, Rechte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { makeHub } from './helpers.js';
import { schedulePayload, manifestPayload, verGte, INSERTS_MIN_VERSION } from '../lib/plan.js';
import { validateMessage, msg } from '../../shared/protocol.js';
import { dueInsert, insertItem } from '../../shared/sequencer.js';
import { liteRenderer } from '../../player/agent/lib/renderers.js';

const MIN = 60000;
test('Einschub-Logik: erster nach einer vollen Wartezeit, dann nach jedem Abstand; nur im normalen Betrieb; Zeitraum und Reihenfolge', () => {
  const plan = { inserts: [{ id: 'a', mediaId: 'ma', everyS: 300, seconds: 10 }, { id: 'b', mediaId: 'mb', everyS: 600, seconds: 10, validFrom: '2026-10-10', validTo: '2026-10-12' }] };
  const normal = { source: 'standard' }, last = new Map(), t0 = Date.parse('2026-10-09T10:00:00Z');
  assert.equal(dueInsert(plan, normal, t0, last), null, 'beim ersten Sehen noch nicht'); assert.ok(last.has('a')); assert.ok(!last.has('b'), 'außerhalb des Zeitraums wird nichts vorgemerkt');
  assert.equal(dueInsert(plan, normal, t0 + 299000, last), null); assert.equal(dueInsert(plan, normal, t0 + 300000, last)?.id, 'a');
  last.set('a', t0 + 300000); assert.equal(dueInsert(plan, normal, t0 + 301000, last), null, 'nach der Einblendung wieder Ruhe');
  const day2 = Date.parse('2026-10-10T10:00:00Z'); assert.equal(dueInsert(plan, normal, day2, last)?.id, 'a', 'a ist längst fällig; b startet erst hier'); last.set('a', day2);
  assert.equal(dueInsert(plan, normal, day2 + 5 * MIN, last)?.id, 'a'); last.set('a', day2 + 8 * MIN); assert.equal(dueInsert(plan, normal, day2 + 10 * MIN, last)?.id, 'b', 'a ist erst 2 Minuten her, b ist seit 10 Minuten vorgemerkt und fällig');
  last.set('a', day2 + 10 * MIN); last.set('b', day2 + 10 * MIN);
  for (const source of ['uebersteuerung', 'wartung', 'nicht_bereit', 'schliesstag', 'none']) assert.equal(dueInsert(plan, { source, override: { kind: 'notfall' } }, day2 + 99 * MIN, last), null, `nicht bei ${source}`);
  assert.equal(dueInsert(plan, { source: 'uebersteuerung', override: { kind: 'tor' } }, day2 + 99 * MIN, last), null); assert.equal(dueInsert(plan, { source: 'uebersteuerung', override: { kind: 'regel' } }, day2 + 99 * MIN, last)?.id, 'a', 'Regeln sind normaler Betrieb');
  assert.equal(dueInsert({}, normal, t0, last), null); assert.equal(dueInsert(plan, null, t0, last), null);
  const manifest = { items: [{ id: 'ma', kind: 'image', name: 'Logo', sha256: 'x', url: '/m/ma' }, { id: 'mx', kind: 'image', name: 'weg', pending: true }] };
  assert.equal(insertItem({ mediaId: 'ma', seconds: 7 }, manifest, { profile: 'standard' })?.duration, 7); assert.equal(insertItem({ mediaId: 'mx', seconds: 7 }, manifest, {}), null, 'nicht vorbereitet'); assert.equal(insertItem({ mediaId: 'fehlt', seconds: 7 }, manifest, {}), null);
});

test('Versionsvergleich und Protokoll: das Planfeld „inserts“ ist erlaubt', () => {
  assert.equal(verGte('0.2.26', '0.2.26'), true); assert.equal(verGte('0.2.27', '0.2.26'), true); assert.equal(verGte('0.3.0', '0.2.26'), true); assert.equal(verGte('0.2.25', '0.2.26'), false); assert.equal(verGte('', '0.2.26'), false); assert.equal(verGte('x.y.z', '0.2.26'), false); assert.equal(verGte(undefined, '0.2.26'), false);
  const plan = { generatedAt: 1, from: 0, to: 1, segments: [], playlists: {}, defaultPlaylistId: null, inserts: [{ id: 'a', mediaId: 'm', everyS: 300, seconds: 10 }] };
  assert.equal(validateMessage(JSON.parse(msg('schedule_update', plan))), null); assert.match(validateMessage(JSON.parse(msg('schedule_update', { ...plan, inserts: 'x' }))), /inserts/);
});

const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const mkDev = (h, name, version, group = null) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,group_id,state_json) VALUES(?,?,'standard','active',?,?,?,?)").run(id, name, h.clock.t, h.clock.t, group, JSON.stringify({ version })); return id; };
const body = (m, o = {}) => ({ name: 'Sponsor-Logo', mediaId: m, everyMin: 5, seconds: 10, scope: 'all', ...o });

test('Einschübe: anlegen mit Prüfung, im Plan nur für Bildschirme ab 0.2.26, Medium wird vorab geladen, Bereich und Zeitraum', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const m = await txt(a, 'Logo'); const g = randomUUID(); h.db.prepare('INSERT INTO device_groups(id,name) VALUES(?,?)').run(g, 'Foyer');
  const neu = mkDev(h, 'Neu', '0.2.26', g), alt = mkDev(h, 'Alt', '0.2.25'), ohne = mkDev(h, 'Ohne', ''); const get = (id) => h.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const bad = async (b, re) => { const r = await a('POST', '/api/v1/inserts', b); assert.equal(r.statusCode, 400, JSON.stringify(b)); if (re) assert.match(r.json().error, re); };
  await bad(body('gibtsnicht'), /gibt es nicht/); await bad(body(m, { seconds: 200 }), /Hälfte|ungültig/); await bad(body(m, { everyMin: 1, seconds: 40 }), /Hälfte/); await bad(body(m, { scope: 'group', targetId: 'nix' }), /Gruppe/); await bad(body(m, { scope: 'device', targetId: 'nix' }), /Bildschirm/);
  await bad(body(m, { name: '   ' }), /Namen/); await bad(body(m, { validFrom: '2026-10-12', validTo: '2026-10-10' }), /vor dem Beginn/); await bad(body(m, { validFrom: '2026-13-45' }), /ungültig/); await bad(body(m, { everyMin: 0 })); await bad(body(m, { seconds: 2 }));
  const c = await a('POST', '/api/v1/inserts', body(m)); assert.equal(c.statusCode, 201, c.body); const id = c.json().id; assert.equal(c.json().insert.status, 'aktiv'); assert.equal(c.json().insert.screens, 3); assert.equal(c.json().insert.oldScreens, 2, 'zwei Bildschirme sind noch zu alt');
  const p = schedulePayload(h.db, get(neu), h.clock.t); assert.deepEqual(p.inserts, [{ id, mediaId: m, everyS: 300, seconds: 10 }]); assert.equal(validateMessage(JSON.parse(msg('schedule_update', p))), null, 'der Plan ist für den Bildschirm gültig');
  for (const old of [alt, ohne]) assert.equal(schedulePayload(h.db, get(old), h.clock.t).inserts, undefined, 'ältere Bildschirme würden das Feld ablehnen: es wird nicht gesendet');
  assert.ok(manifestPayload(h.db, get(alt), h.clock.t).items.some((x) => x.id === m), 'Medium ist vorab im Manifest');
  assert.equal((await a('PUT', `/api/v1/inserts/${id}`, body(m, { scope: 'group', targetId: g, validFrom: '2026-01-01', validTo: '2026-01-31' }))).statusCode, 200); assert.equal(schedulePayload(h.db, get(neu), h.clock.t).inserts[0].validTo, '2026-01-31');
  const other = mkDev(h, 'Fremd', '0.2.26'); assert.equal(schedulePayload(h.db, get(other), h.clock.t).inserts, undefined, 'nur die Gruppe');
  const l = (await a('GET', '/api/v1/inserts')).json(); assert.equal(l.inserts[0].targetName, 'Gruppe „Foyer“'); assert.equal(l.inserts[0].status, 'abgelaufen'); assert.equal(l.inserts[0].screens, 1); assert.match(l.hint, /nicht während einer Notfall-Meldung/);
  await a('PUT', `/api/v1/inserts/${id}`, body(m, { enabled: false })); assert.equal(schedulePayload(h.db, get(neu), h.clock.t).inserts, undefined, 'ausgeschaltet'); assert.equal((await a('GET', '/api/v1/inserts')).json().inserts[0].status, 'aus');
  await a('PUT', `/api/v1/inserts/${id}`, body(m)); h.db.prepare('DELETE FROM media WHERE id=?').run(m); assert.equal((await a('GET', '/api/v1/inserts')).json().inserts[0].status, 'fehler');
  assert.equal((await a('DELETE', `/api/v1/inserts/${id}`)).statusCode, 200); assert.equal((await a('DELETE', `/api/v1/inserts/${id}`)).statusCode, 404); assert.equal((await a('PUT', `/api/v1/inserts/${id}`, body(m))).statusCode, 404);
  await h.cleanup();
});

test('Einschübe: Rechte, Gruppen-Beschränkung, Höchstzahl, Protokoll, Aufräumhilfe', async () => {
  const h = await makeHub(); const a = await h.as('admin'), e = await h.as('edi'), v = await h.as('vera'); const m = await txt(a, 'Logo'), m2 = await txt(a, 'Frei');
  assert.equal((await v('GET', '/api/v1/inserts')).statusCode, 403); assert.equal((await v('POST', '/api/v1/inserts', body(m))).statusCode, 403); assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/inserts' })).statusCode, 401);
  assert.equal((await e('POST', '/api/v1/inserts', body(m, { name: 'Vom Redakteur' }))).statusCode, 201, 'Redakteur darf Einschübe anlegen');
  const g1 = randomUUID(), g2 = randomUUID(); for (const [g, n] of [[g1, 'Eigene'], [g2, 'Fremde']]) h.db.prepare('INSERT INTO device_groups(id,name) VALUES(?,?)').run(g, n); const mine = mkDev(h, 'Meiner', '0.2.26', g1), foreign = mkDev(h, 'Fremder', '0.2.26', g2);
  h.db.prepare('UPDATE users SET groups_json=? WHERE name=?').run(JSON.stringify([g1]), 'edi'); const e2 = await h.as('edi'); const post = (b) => e2('POST', '/api/v1/inserts', body(m, b));
  assert.equal((await post({})).statusCode, 403, '„alle“ ist tabu'); assert.equal((await post({ scope: 'group', targetId: g2 })).statusCode, 403); assert.equal((await post({ scope: 'device', targetId: foreign })).statusCode, 403);
  const ok = await post({ scope: 'group', targetId: g1 }); assert.equal(ok.statusCode, 201); assert.equal((await post({ scope: 'device', targetId: mine })).statusCode, 201);
  const open = (await a('POST', '/api/v1/inserts', body(m, { name: 'Vom Admin' }))).json().id; assert.equal((await e2('PUT', `/api/v1/inserts/${open}`, body(m, { scope: 'group', targetId: g1 }))).statusCode, 403); assert.equal((await e2('DELETE', `/api/v1/inserts/${open}`)).statusCode, 403);
  assert.equal((await e2('PUT', `/api/v1/inserts/${ok.json().id}`, body(m, { scope: 'group', targetId: g2 }))).statusCode, 403); assert.equal((await e2('DELETE', `/api/v1/inserts/${ok.json().id}`)).statusCode, 200);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='einschub.angelegt'").get().n, 4);
  const un = (await a('GET', '/api/v1/media/unused')).json().items.map((x) => x.id); assert.ok(!un.includes(m), 'Medium in einem Einschub gilt als benutzt'); assert.ok(un.includes(m2));
  while (h.db.prepare('SELECT COUNT(*) n FROM inserts').get().n < 20) await a('POST', '/api/v1/inserts', body(m, { name: 'x' })); const full = await a('POST', '/api/v1/inserts', body(m)); assert.equal(full.statusCode, 400); assert.match(full.json().error, /schon 20/);
  await h.cleanup();
});

// ---- mpv-Renderer: Einschübe zeitlich eingemischt, danach geht es mit dem unterbrochenen Element weiter ----
test('mpv-Renderer: Einschub erscheint nach seiner Wartezeit, die Liste läuft danach in der alten Reihenfolge weiter', async () => {
  const writes = []; let sock = null;
  const net = { connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => writes.push(String(x)); sock = s; setImmediate(() => s.emit('connect')); return s; } };
  const items = ['A', 'B', 'C'].map((id) => ({ mediaId: id, duration: 0.2, transition: 'cut' }));
  const plan = { segments: [], defaultPlaylistId: 'p', playlists: { p: { items } }, inserts: [{ id: 'i', mediaId: 'S', everyS: 1.4, seconds: 0.2 }] };
  const manifest = { items: ['A', 'B', 'C', 'S'].map((id) => ({ id, kind: 'image', name: id, sha256: id })) };
  const shown = []; const r = liteRenderer({ getPlan: () => plan, getManifest: () => manifest, haveFile: () => true, fileOf: (m) => `/f/${m.mediaId}.png`, onShow: (s) => shown.push(s.current.mediaId), net, spawnFn: () => { const c = new EventEmitter(); c.pid = 1; c.kill = () => {}; return c; }, reconnectMs: 20 });
  await new Promise((res) => setTimeout(res, 4200)); r.stop(); void sock;
  assert.ok(shown.includes('S'), `Einschub wurde gezeigt: ${shown.join('')}`); assert.ok(shown.filter((x) => x === 'S').length <= 3, 'nicht ständig');
  const regular = shown.filter((x) => x !== 'S').join(''); assert.match(regular, /^(ABC)+[ABC]?$/, `die Liste läuft ohne Lücke weiter: ${shown.join('')}`);
  const si = shown.indexOf('S'); assert.ok(si > 0 && shown[si - 1] !== 'S' && shown[si + 1] !== 'S');
});

// ---- Über das echte WebSocket: Einschübe nur, wenn der Bildschirm sich mit Version ≥ 0.2.26 meldet ----
import WebSocket from 'ws';
import { pairWithHub } from '../../player/agent/lib/pair.js';
import { pinnedAgent } from '../../player/agent/lib/pinned.js';
test('WebSocket: der Plan enthält Einschübe erst, wenn sich der Bildschirm mit Version ≥ 0.2.26 meldet (auch gleich nach einem Update)', async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' }); const url = `https://127.0.0.1:${h.app.server.address().port}`; const a = await h.as('admin');
  const m = await txt(a, 'Logo'); assert.equal((await a('POST', '/api/v1/inserts', body(m))).statusCode, 201);
  const { code, fingerprintRaw } = (await a('POST', '/api/v1/pairing')).json(); const d = { deviceId: randomUUID(), name: 'Shop-Screen', model: 'Raspberry Pi 4 Model B', profile: 'pro', hw: { ramMB: 4096 } };
  const p = pairWithHub({ hubUrl: url, code, expectedFp: fingerprintRaw, ...d, pollMs: 20, timeoutMs: 8000 });
  for (let i = 0; i < 100 && !(await a('GET', '/api/v1/devices')).json().length; i++) await new Promise((r) => setTimeout(r, 20)); await a('POST', `/api/v1/devices/${d.deviceId}/approve`, {}); const { token, spki } = await p;
  const connect = async (version) => { const ws = new WebSocket(url.replace('https', 'wss') + '/api/v1/ws', { agent: pinnedAgent(spki), headers: { Authorization: `Bearer ${token}` } }); ws.msgs = []; ws.on('message', (x) => ws.msgs.push(JSON.parse(x))); await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }); ws.send(JSON.stringify({ v: 1, type: 'hello', version, profile: 'pro' })); for (let i = 0; i < 100 && ws.msgs.length < 3; i++) await new Promise((r) => setTimeout(r, 20)); ws.close(); return ws.msgs.find((x) => x.type === 'schedule_update'); };
  const alt = await connect('0.2.25'); assert.equal(alt.inserts, undefined, 'älterer Bildschirm: Plan ohne das neue Feld'); assert.equal(validateMessage(alt), null);
  const neu = await connect('0.2.26'); assert.equal(neu.inserts?.length, 1, 'nach dem Update gleich mit Einschüben'); assert.equal(neu.inserts[0].mediaId, m); assert.equal(validateMessage(neu), null);
  assert.equal(JSON.parse(h.db.prepare('SELECT state_json FROM devices WHERE id=?').get(d.deviceId).state_json).version, '0.2.26');
  await h.cleanup();
});
