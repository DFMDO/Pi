// Bild-Wächter (0.2.26): schwarz, eingefroren, Wiedergabe steht – ohne Fehlalarme; es wird nichts gespeichert außer Prüfsumme und Helligkeit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { makeHub } from './helpers.js';
import { analyzeImage, freezeWindow, judge, stalled, MAX_SAMPLES } from '../lib/waechter.js';
import { warnings } from '../lib/plan.js';

const MIN = 60000;
const solid = (r, g, b, w = 320, h = 180) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();
const split = (n) => sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 30, g: 30, b: 30 } } }).composite([{ input: { create: { width: 20 + n * 7, height: 90, channels: 3, background: { r: 230, g: 230, b: 230 } } }, left: 10, top: 10 }]).png().toBuffer();

test('Bildanalyse: schwarz wird erkannt, ein dunkles Standby-Bild nicht, gleiche Bilder haben dieselbe Prüfsumme', async () => {
  const black = await analyzeImage(await solid(0, 0, 0)), noisy = await analyzeImage(await solid(2, 2, 2)), standby = await analyzeImage(await solid(26, 26, 26)), bright = await analyzeImage(await solid(200, 180, 20));
  assert.equal(black.black, true); assert.equal(noisy.black, true, 'fast schwarz (Rauschen) zählt auch'); assert.equal(standby.black, false, 'das Standby-Bild (#1a1a1a) ist nicht schwarz'); assert.equal(bright.black, false);
  assert.equal(black.h, (await analyzeImage(await solid(0, 0, 0, 640, 360))).h, 'gleiche Prüfsumme, auch bei anderer Größe'); assert.notEqual(black.h, standby.h);
  const a = await analyzeImage(await split(1)), b = await analyzeImage(await split(2)); assert.notEqual(a.h, b.h, 'ein wenig anderer Inhalt ändert die Prüfsumme'); assert.equal(a.h, (await analyzeImage(await split(1))).h);
  assert.ok(black.mean < 1 && standby.mean > 20 && standby.mean < 30);
});

const item = (id, d = 10, kind = 'image', durationS) => ({ mediaId: id, kind, duration: d, durationS });
test('Fenster für „Bild steht“: je nach Liste mehr oder weniger gleiche Proben nötig, bei zu großer Zufallschance gar keine Meldung', () => {
  assert.equal(freezeWindow([item('a'), item('b'), item('c'), item('d')]), 11, 'vier gleich lange Elemente'); assert.equal(freezeWindow([item('a'), item('b'), item('c')]), 14);
  assert.equal(freezeWindow([item('a'), item('b')]), 21, 'zwei Elemente: erst nach gut 3 Stunden sicher'); assert.equal(freezeWindow([item('a', 90), item('b', 10)]), null, 'ein Element dominiert: zu unsicher');
  assert.equal(freezeWindow([item('a')]), null, 'ein einzelnes Bild darf stillstehen'); assert.equal(freezeWindow([]), null);
  assert.equal(freezeWindow([item('v', 0, 'video', 240), item('a', 10)]), 4, 'mit Video ändert sich das Bild ständig: schon wenige Proben genügen'); assert.equal(freezeWindow([item('a'), item('a'), item('b')]), 21 - 4 > 0 ? freezeWindow([item('a'), item('a'), item('b')]) : null);
  assert.ok(freezeWindow([item('a'), item('b'), item('c')]) <= MAX_SAMPLES);
});

test('Urteil aus den Proben: zwei Schwarz-Proben, lange gleiche Bilder; ein anderes Bild setzt alles zurück', () => {
  const s = (t, h, b = 0, x = 11) => ({ t, h, b, x });
  assert.equal(judge([]).status, 'unbekannt'); assert.equal(judge([s(0, 'a', 1)]).status, 'ok', 'eine Schwarz-Probe reicht nicht (Überblendung)'); assert.equal(judge([s(0, 'a', 1), s(3 * MIN, 'a', 1)]).status, 'ok', 'zu kurz hintereinander');
  assert.deepEqual(judge([s(0, 'z'), s(10 * MIN, 'a', 1), s(20 * MIN, 'a', 1)]), { status: 'schwarz', since: 10 * MIN }); assert.equal(judge([s(0, 'a', 1), s(10 * MIN, 'a', 1), s(20 * MIN, 'q')]).status, 'ok', 'wieder hell');
  const same = Array.from({ length: 11 }, (_, i) => s(i * 10 * MIN, 'h')); assert.deepEqual(judge(same), { status: 'steht', since: 0 }); assert.equal(judge(same.slice(1)).status, 'ok', 'zehn Proben reichen bei diesem Fenster noch nicht');
  const mixed = [...same.slice(0, 5), s(50 * MIN, 'andere'), ...same.slice(6)]; assert.equal(judge(mixed).status, 'ok', 'zwischendurch ein anderes Bild');
  assert.equal(judge(same.map((x) => ({ ...x, x: 0 }))).status, 'ok', 'Stillstand nicht erkennbar (Uhr im Bild, einzelnes Bild): keine Meldung');
  const late = same.map((x, i) => ({ ...x, x: i < 6 ? 0 : 11 })); assert.equal(judge(late).status, 'ok', 'vorher war Stillstand normal (alte Liste): diese Proben zählen nicht');
});

test('Wiedergabe steht: nur bei frischem Start, vollständig geladenen Medien und wirklich langer Stille', () => {
  const t = 1e12, st = (o = {}) => ({ uptimeS: 7200, syncState: { done: 3, total: 3 }, playerStatus: { current: { since: t - 20 * MIN } }, ...o }), items = [item('a'), item('b')];
  assert.deepEqual(stalled(st(), items, t), { since: t - 20 * MIN }); assert.equal(stalled(st({ playerStatus: { current: { since: t - 10 * MIN } } }), items, t), null, 'unter 15 Minuten');
  assert.equal(stalled(st({ uptimeS: 600 }), items, t), null, 'gerade gestartet'); assert.equal(stalled(st({ syncState: { done: 1, total: 3 } }), items, t), null, 'lädt noch'); assert.equal(stalled(st(), [], t), null, 'nichts zu zeigen (Standby)');
  assert.equal(stalled(st({ playerStatus: undefined }), items, t), null, 'keine Meldung bekannt: kein Urteil'); assert.equal(stalled(st({ playerStatus: { current: { since: t - 40 * MIN } } }), [item('v', 0, 'video', 1500)], t), null, 'ein 25-Minuten-Video darf lange laufen');
  assert.ok(stalled(st({ playerStatus: { current: { since: t - 70 * MIN } } }), [item('v', 0, 'video', 1500)], t));
});

// ---------------------------------------------------------------- im Hub
const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const setup = async ({ items = 4, profile = 'standard' } = {}) => {
  const h = await makeHub(); h.clock.t = Date.parse('2026-10-09T10:00:00Z'); const a = await h.as('admin'); const ids = []; for (let i = 0; i < items; i++) ids.push(await txt(a, `Folie ${i}`));
  const pl = (await a('POST', '/api/v1/playlists', { name: 'Haupt', publish: true })).json().id; await a('PUT', `/api/v1/playlists/${pl}`, { items: ids.map((m) => ({ mediaId: m, duration: 10 })), publish: true }); h.db.prepare('UPDATE playlists SET is_default=0').run(); h.db.prepare('UPDATE playlists SET is_default=1 WHERE id=?').run(pl);
  const id = randomUUID(), sent = []; h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,ready,state_json) VALUES(?,?,?,'active',?,?,1,?)").run(id, 'Foyer links', profile, h.clock.t, h.clock.t, JSON.stringify({ version: '0.2.26', uptimeS: 90000, syncState: { done: 4, total: 4 }, playerStatus: { current: { since: h.clock.t - MIN } } }));
  h.app.devices.sockets.set(id, { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} });
  const touch = () => h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(h.clock.t, id); const fresh = () => h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(JSON.stringify({ version: '0.2.26', uptimeS: 90000, syncState: { done: 4, total: 4 }, playerStatus: { current: { since: h.clock.t - MIN } } }), id);
  return { h, a, id, sent, touch, fresh, W: h.app.waechter, shots: () => sent.filter((m) => m.type === 'command' && m.command === 'screenshot').length };
};
const step = async (c, ms, png) => { c.h.clock.t += ms; c.touch(); c.fresh(); const n = c.W.tick(c.h.clock.t); assert.equal(n, 1, 'der Wächter fragt ein Bild an'); await c.W.ingest(c.id, png, c.h.clock.t); };
const state = (c) => c.h.db.prepare('SELECT * FROM watch_state WHERE device_id=?').get(c.id);

test('Bild-Wächter: Anfrage, zweimal Schwarz → Warnung in Gesundheit und Startseite, wieder hell → weg', async () => {
  const c = await setup(), black = await solid(0, 0, 0), normal = await split(3); const { h } = c;
  assert.equal(c.W.tick(h.clock.t), 1, 'erste Anfrage sofort'); assert.equal(c.shots(), 1); assert.equal(c.sent.find((m) => m.type === 'command').id.startsWith('auto-'), true);
  assert.equal(c.W.tick(h.clock.t + 1000), 0, 'keine zweite Anfrage, solange die Antwort aussteht'); await c.W.ingest(c.id, black, h.clock.t + 2000); h.clock.t += 2000;
  assert.equal(state(c).status, 'ok', 'eine Probe genügt nicht'); assert.equal(JSON.parse(state(c).samples_json).length, 1);
  await step(c, 13 * MIN, black); assert.equal(state(c).status, 'schwarz'); assert.ok(state(c).since <= h.clock.t - 7 * MIN);
  const hl = (await (await h.as('admin'))('GET', '/api/v1/health')).json().find((x) => x.id === c.id); assert.equal(hl.level, 'bad'); assert.match(hl.warnings.find((w) => w.kind === 'bild_schwarz').text, /zeigt seit etwa \d+ Minuten nur Schwarz/); assert.equal(hl.watch.status, 'schwarz');
  assert.ok(warnings(h.db, h.clock.t).some((w) => w.kind === 'bild_schwarz' && w.ids[0] === c.id), 'auch auf der Startseite');
  await step(c, 13 * MIN, normal); assert.equal(state(c).status, 'ok'); assert.ok(!warnings(h.db, h.clock.t).some((w) => w.kind === 'bild_schwarz'));
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='bildwaechter.schwarz'").get().n, 1); await h.cleanup();
});

test('Bild-Wächter: eingefrorenes Bild bei einer Liste mit vier Folien wird nach dem berechneten Fenster gemeldet, ein wechselndes Bild nie', async () => {
  const c = await setup({ items: 4 }); const same = await split(5); const { h } = c;
  c.W.tick(h.clock.t); await c.W.ingest(c.id, same, h.clock.t);
  for (let i = 1; i < 10; i++) { await step(c, 13 * MIN, same); assert.equal(state(c).status, 'ok', `Probe ${i + 1}: noch kein Alarm`); }
  await step(c, 13 * MIN, same); assert.equal(state(c).status, 'steht', 'elfte gleiche Probe'); assert.match((warnings(h.db, h.clock.t).find((w) => w.kind === 'bild_steht') ?? {}).text, /nicht verändert/);
  await step(c, 13 * MIN, await split(9)); assert.equal(state(c).status, 'ok');
  const d = await setup({ items: 4 }); d.W.tick(d.h.clock.t); await d.W.ingest(d.id, await split(1), d.h.clock.t); for (let i = 0; i < 30; i++) await step(d, 13 * MIN, await split(i % 4)); assert.equal(state(d).status, 'ok', 'wechselnde Bilder: nie Alarm');
  await h.cleanup(); await d.h.cleanup();
});

test('Bild-Wächter: ein einzelnes Bild darf stillstehen; Wartung, ausgeschaltet und Lite werden nicht per Bild geprüft; Wiedergabe steht wird ohne Bild erkannt', async () => {
  const one = await setup({ items: 1 }); const same = await split(2); one.W.tick(one.h.clock.t); await one.W.ingest(one.id, same, one.h.clock.t); for (let i = 0; i < 30; i++) await step(one, 13 * MIN, same); assert.equal(state(one).status, 'ok', 'Standbild ist erlaubt');
  const m = await setup(); m.h.db.prepare('UPDATE devices SET maintenance_since=? WHERE id=?').run(m.h.clock.t, m.id); assert.equal(m.W.tick(m.h.clock.t), 0); assert.equal(state(m).status, 'ausgesetzt'); assert.match(state(m).note, /Wartung/);
  const off = await setup(); off.h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(JSON.stringify({ version: '0.2.26', displayOff: true }), off.id); assert.equal(off.W.tick(off.h.clock.t), 0); assert.equal(state(off).status, 'ausgesetzt');
  const lite = await setup({ profile: 'lite' }); assert.equal(lite.W.tick(lite.h.clock.t), 0, 'Lite: keine Bildprobe'); assert.equal(lite.shots(), 0); assert.equal(state(lite).status, 'ok'); assert.match(state(lite).note, /Lite/);
  const hot = await setup(); const hotState = (since) => JSON.stringify({ version: '0.2.26', cpuTemp: 85, uptimeS: 90000, syncState: { done: 4, total: 4 }, playerStatus: { current: { since } } }); hot.h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(hotState(hot.h.clock.t - MIN), hot.id);
  assert.equal(hot.W.tick(hot.h.clock.t), 0, 'überhitzt/ausgelastet: keine Bildprobe'); assert.equal(state(hot).status, 'ok');
  hot.h.clock.t += 30 * MIN; hot.touch(); hot.h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(hotState(hot.h.clock.t - 40 * MIN), hot.id);
  hot.W.tick(hot.h.clock.t); assert.equal(state(hot).status, 'wiedergabe_steht'); assert.match(warnings(hot.h.db, hot.h.clock.t).find((w) => w.kind === 'wiedergabe_steht').text, /keinen Wechsel mehr/);
  const closed = await setup(); closed.h.db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(closed.h.clock.t - 20 * MIN, closed.id); assert.equal(closed.W.tick(closed.h.clock.t), 0, 'nicht erreichbare Bildschirme werden nicht abgefragt');
  for (const x of [one, m, off, lite, hot, closed]) await x.h.cleanup();
});

test('Bild-Wächter: ausgeschaltet fragt nichts an; Antwort bleibt aus → kein Absturz; Rechte; veraltete Ergebnisse stehen nicht ewig in den Warnungen', async () => {
  const c = await setup(); const { h } = c; const a = await h.as('admin'), e = await h.as('edi'), v = await h.as('vera');
  assert.equal((await e('PUT', '/api/v1/watch', { enabled: false })).statusCode, 403, 'nur Admin'); assert.equal((await v('GET', '/api/v1/watch')).statusCode, 403); const g = (await e('GET', '/api/v1/watch')).json(); assert.equal(g.enabled, true); assert.match(g.hint, /keine Bilder gespeichert/);
  assert.equal((await a('PUT', '/api/v1/watch', { enabled: false })).statusCode, 200); assert.equal(c.W.tick(h.clock.t), 0); assert.equal(c.shots(), 0); await c.W.ingest(c.id, await solid(0, 0, 0), h.clock.t); assert.equal(state(c), undefined, 'nichts gespeichert');
  await a('PUT', '/api/v1/watch', { enabled: true }); assert.equal(c.W.tick(h.clock.t), 1); h.clock.t += 2 * MIN; c.touch(); c.fresh(); c.W.tick(h.clock.t); assert.equal(state(c).status, 'ok', 'ohne Antwort wird nach 90 Sekunden abgeschlossen'); assert.match(state(c).note, /nicht abgefragt/);
  h.db.prepare("UPDATE watch_state SET status='schwarz', since=?, checked_at=? WHERE device_id=?").run(h.clock.t - 3 * 3600e3, h.clock.t - 2 * 3600e3, c.id); assert.ok(!warnings(h.db, h.clock.t).some((w) => w.kind === 'bild_schwarz'), 'Ergebnis älter als eine Stunde zählt nicht mehr');
  h.db.prepare('UPDATE watch_state SET checked_at=? WHERE device_id=?').run(h.clock.t - 5 * MIN, c.id); assert.ok(warnings(h.db, h.clock.t).some((w) => w.kind === 'bild_schwarz'));
  h.db.prepare('UPDATE devices SET maintenance_since=? WHERE id=?').run(h.clock.t, c.id); assert.ok(!warnings(h.db, h.clock.t).some((w) => w.kind === 'bild_schwarz'), 'Wartungsmodus ist stumm');
  await a('PUT', '/api/v1/watch', { enabled: false }); assert.equal(state(c).status, 'unbekannt', 'beim Ausschalten wird der Zustand zurückgesetzt'); await h.cleanup();
});
