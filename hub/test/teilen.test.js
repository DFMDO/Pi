// Bildschirm teilen im Hub: Start (mit Gründen für nicht verfügbare Bildschirme), Bilder weiterreichen (mpv gedrosselt), Beenden, Zeitgrenzen, Notfall-Vorrang, Rechte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1)]); // sieht aus wie ein JPEG (Kopf), reicht für die Prüfung
const IMG = { 'content-type': 'image/jpeg' };

async function setup() {
  const h = await makeHub(); h.clock.t = Date.UTC(2026, 9, 10, 10, 0); const sent = [];
  const dev = (name, over = {}) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,renderer,group_id) VALUES(?,?,?,?,?,?,?,?)").run(id, name, over.profile ?? 'standard', over.status ?? 'active', h.clock.t, h.clock.t, over.renderer ?? 'browser', over.group ?? null);
    if (over.online !== false) h.app.devices.sockets.set(id, { readyState: 1, send: (s) => sent.push({ id, ...JSON.parse(s) }), close() {} }); return id; };
  return { h, sent, dev, a: await h.as('admin'), msgs: (type, id) => sent.filter((m) => m.type === type && (!id || m.id === id)) };
}

test('Start: Bildschirme erhalten share_start; Browser- und mpv-Bildschirm werden unterschieden; Offline/Unbekannte/Gesperrte werden mit Grund übersprungen', async () => {
  const { h, a, dev, sent } = await setup(); const web = dev('Foyer'), film = dev('Videowand', { renderer: 'mpv' }), off = dev('Kasse', { online: false }), pend = dev('Neu', { status: 'pending' });
  assert.equal((await a('POST', '/api/v1/share', {})).statusCode, 400, 'ohne Auswahl'); assert.equal((await a('POST', '/api/v1/share', { deviceIds: [web], minutes: 1 })).statusCode, 400, 'mindestens 5 Minuten'); assert.equal((await a('POST', '/api/v1/share', { deviceIds: [web], minutes: 500 })).statusCode, 400, 'höchstens 4 Stunden');
  const r = await a('POST', '/api/v1/share', { deviceIds: [web, film, off, pend, randomUUID()], minutes: 30 }); assert.equal(r.statusCode, 201, r.body); const j = r.json();
  assert.deepEqual(j.devices.map((d) => [d.name, d.mode]).sort(), [['Foyer', 'browser'], ['Videowand', 'mpv']]); assert.deepEqual(j.fps, { browser: 5, mpv: 1 }); assert.equal(j.maxWidth, 1920); assert.equal(j.until, h.clock.t + 30 * 60000); assert.match(j.text, /2 Bildschirme/);
  assert.deepEqual(j.skipped.map((s) => s.reason).sort(), ['Der Bildschirm hat gerade keine Verbindung zum Hub.', 'Diesen Bildschirm gibt es nicht.', 'Diesen Bildschirm gibt es nicht.']);
  assert.deepEqual(sent.filter((m) => m.type === 'share_start').map((m) => m.id).sort(), [web, film].map(() => j.id).sort(), 'share_start an beide Bildschirme'); assert.equal(sent.filter((m) => m.type === 'share_start').length, 2);
  assert.equal(h.db.prepare("SELECT security FROM audit_log WHERE action='teilen.gestartet'").get() !== undefined, true);
  const none = await a('POST', '/api/v1/share', { deviceIds: [off] }); assert.equal(none.statusCode, 409); assert.match(none.json().error, /keine Verbindung/);
  assert.equal((await a('POST', '/api/v1/share', { all: true, minutes: 5 })).json().devices.length, 2, '„alle“ nimmt nur die verbundenen aktiven');
  await h.cleanup();
});

test('Bilder: gültiges JPEG wird an Browser-Bildschirme weitergereicht, an mpv höchstens ein Bild pro Sekunde; Unsinn, fremde und beendete Übertragungen werden abgelehnt', async () => {
  const { h, a, dev, msgs } = await setup(); const web = dev('Foyer'), film = dev('Videowand', { renderer: 'mpv' }); const id = (await a('POST', '/api/v1/share', { deviceIds: [web, film] })).json().id;
  const send = (body = JPEG, c = a, sid = id) => c('POST', `/api/v1/share/${sid}/frame`, body, IMG);
  assert.equal((await send()).statusCode, 204); let f = msgs('share_frame', id); assert.equal(f.length, 2, 'beide Bildschirme'); assert.equal(Buffer.from(f.find((m) => m.id === id && m.jpg).jpg, 'base64').compare(JPEG), 0, 'Bild unverändert weitergereicht');
  h.clock.t += 200; await send(); assert.equal(msgs('share_frame').filter((m) => true).length, 3, 'Browser: sofort, mpv: noch nicht (zu schnell)');
  h.clock.t += 900; await send(); assert.equal(msgs('share_frame').length, 5, 'nach einer Sekunde bekommt auch mpv wieder eins');
  assert.equal((await send(Buffer.from('kein bild, nur text'))).statusCode, 400); assert.equal((await send(Buffer.alloc(3 * 1024 * 1024, 0xff))).statusCode, 413, 'zu groß'); assert.equal((await send(JPEG, a, randomUUID())).statusCode, 410, 'unbekannte Übertragung');
  const ed = await h.as('edi'); assert.equal((await send(JPEG, ed)).statusCode, 410, 'fremde Übertragung wird nicht verraten'); assert.equal((await send(JPEG, await h.as('vera'))).statusCode, 403); assert.equal((await h.app.inject({ method: 'POST', url: `/api/v1/share/${id}/frame`, payload: JPEG, headers: IMG })).statusCode, 401);
  await a('DELETE', `/api/v1/share/${id}`); assert.equal((await send()).statusCode, 410, 'nach dem Beenden: Browser bekommt „410“ und hört auf');
  await h.cleanup();
});

test('Beenden: Besitzer und Admin dürfen, andere nicht; Bildschirme bekommen share_stop; Liste zeigt wer was teilt; pro Person nur eine Übertragung; ein Bildschirm nur für eine Person', async () => {
  const { h, a, dev, msgs } = await setup(); const d1 = dev('Foyer'), d2 = dev('Shop'); const ed = await h.as('edi');
  const s1 = (await ed('POST', '/api/v1/share', { deviceIds: [d1] })).json().id;
  const l = (await a('GET', '/api/v1/share')).json(); assert.equal(l.length, 1); assert.deepEqual([l[0].by, l[0].mine, l[0].devices], ['edi', false, ['Foyer']]); assert.equal((await ed('GET', '/api/v1/share')).json()[0].mine, true);
  const busy = await a('POST', '/api/v1/share', { deviceIds: [d1, d2] }); assert.equal(busy.statusCode, 201); assert.deepEqual(busy.json().skipped, [{ name: 'Foyer', reason: 'Wird gerade von edi geteilt.' }], 'Foyer ist belegt, Shop wird übernommen');
  assert.equal((await ed('DELETE', `/api/v1/share/${busy.json().id}`)).statusCode, 403, 'fremde Übertragung kann ein Redakteur nicht beenden'); assert.equal((await (await h.as('vera'))('DELETE', `/api/v1/share/${s1}`)).statusCode, 403);
  const again = await a('POST', '/api/v1/share', { deviceIds: [d2] }); assert.equal(again.statusCode, 201); assert.equal((await a('GET', '/api/v1/share')).json().filter((x) => x.by === 'admin').length, 1, 'die vorige eigene Übertragung wurde ersetzt');
  assert.equal(msgs('share_stop', busy.json().id).length, 1, 'ersetzte Übertragung: Bildschirm wird freigegeben');
  assert.equal((await a('DELETE', `/api/v1/share/${s1}`)).statusCode, 200, 'Admin darf fremde beenden'); assert.equal(msgs('share_stop', s1).length, 1); assert.equal((await a('DELETE', `/api/v1/share/${s1}`)).statusCode, 404);
  assert.match(JSON.stringify(h.db.prepare("SELECT detail_json FROM audit_log WHERE action='teilen.beendet'").all()), /beendet von admin/);
  await h.cleanup();
});

test('Zeitgrenzen: nach der Höchstzeit oder ohne Bilder (20 s) wird beendet und der Bildschirm freigegeben', async () => {
  const { h, a, dev, msgs } = await setup(); const d1 = dev('Foyer'), d2 = dev('Shop');
  const s1 = (await a('POST', '/api/v1/share', { deviceIds: [d1], minutes: 5 })).json().id; h.clock.t += 15000; await a('POST', `/api/v1/share/${s1}/frame`, JPEG, IMG); h.app.share.expire(); assert.equal(h.app.share.active().length, 1, 'läuft noch');
  h.clock.t += 21000; h.app.share.expire(); assert.equal(h.app.share.active().length, 0, '20 s ohne Bilder: beendet'); assert.equal(msgs('share_stop', s1).length, 1);
  const s2 = (await a('POST', '/api/v1/share', { deviceIds: [d2], minutes: 5 })).json().id; for (let i = 0; i < 12; i++) { h.clock.t += 30000; await a('POST', `/api/v1/share/${s2}/frame`, JPEG, IMG); h.app.share.expire(); } // 6 Minuten lang Bilder, aber Höchstzeit 5 Minuten
  assert.equal(h.app.share.active().length, 0, 'nach 5 Minuten Schluss, auch wenn Bilder kommen'); assert.match(JSON.stringify(h.db.prepare("SELECT detail_json FROM audit_log WHERE action='teilen.beendet'").all()), /Zeit abgelaufen/);
  await h.cleanup();
});

test('Notfall hat Vorrang: während einer Notfall-Meldung kann nicht geteilt werden, und sie beendet laufende Übertragungen', async () => {
  const { h, a, dev, msgs } = await setup(); const d1 = dev('Foyer'); const id = (await a('POST', '/api/v1/share', { deviceIds: [d1] })).json().id;
  const n = await a('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true }); assert.equal(n.statusCode, 201); assert.equal(h.app.share.active().length, 0, 'Übertragung beendet'); assert.equal(msgs('share_stop', id).length, 1);
  const blocked = await a('POST', '/api/v1/share', { deviceIds: [d1] }); assert.equal(blocked.statusCode, 409); assert.match(blocked.json().error, /Notfall-Meldung/);
  await a('POST', '/api/v1/emergency/stop'); assert.equal((await a('POST', '/api/v1/share', { deviceIds: [d1] })).statusCode, 201, 'danach wieder möglich'); await h.cleanup();
});

test('Rechte: Redakteure dürfen teilen, aber nur auf ihre Gruppen; Anzeige-Rolle und Unangemeldete nicht', async () => {
  const { h, a, dev } = await setup(); const g = randomUUID(); h.db.prepare('INSERT INTO device_groups(id,name) VALUES(?,?)').run(g, 'Foyer-Gruppe'); const inG = dev('Foyer', { group: g }), outG = dev('Shop');
  h.db.prepare('UPDATE users SET groups_json=? WHERE name=?').run(JSON.stringify([g]), 'edi'); const ed = await h.as('edi');
  const r = await ed('POST', '/api/v1/share', { deviceIds: [inG, outG] }); assert.equal(r.statusCode, 201); assert.deepEqual(r.json().skipped, [{ name: 'Shop', reason: 'Diesen Bildschirm darfst du nicht steuern.' }]);
  assert.equal((await (await h.as('vera'))('POST', '/api/v1/share', { all: true })).statusCode, 403); assert.equal((await (await h.as('vera'))('GET', '/api/v1/share')).statusCode, 403); assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/share', payload: { all: true } })).statusCode, 401);
  await h.cleanup();
});
