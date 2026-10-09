// Wenn-Dann-Regeln (0.2.24): Bedingungen, Zustandsautomat (Wartezeit, Nachlauf, Verlängern, Hub-Ausfall, Pause nach „Beenden“), Vorrang, Rechte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { zonedToEpoch } from '../lib/apps/ical.js';
import { normalizeConditions, evalRule, describeCondition, ROLL_MS } from '../lib/rules.js';
import { schedulePayload, manifestPayload } from '../lib/plan.js';
import { resolvePlaylist } from '../../shared/sequencer.js';

const MIN = 60000, at = (date, time) => zonedToEpoch(date, time, 'Europe/Berlin');
const T = at('2026-10-10', '11:00:00'); // ein Samstag

test('Regeln: Bedingungen werden geprüft und in Klartext beschrieben', () => {
  assert.throws(() => normalizeConditions([]), /mindestens eine Bedingung/);
  assert.throws(() => normalizeConditions(new Array(5).fill({ type: 'zeit', days: ['sa'] })), /höchstens vier/);
  assert.throws(() => normalizeConditions([{ type: 'wetter', is: 'ueber', value: 'heiß' }]), /Temperatur/);
  assert.throws(() => normalizeConditions([{ type: 'wetter', is: 'sturm' }]), /Wetter-Bedingung/);
  assert.throws(() => normalizeConditions([{ type: 'zeit', from: '8:00', to: '12:00' }]), /Uhrzeit/);
  assert.throws(() => normalizeConditions([{ type: 'zeit', from: '08:00' }]), /„von“ und „bis“/);
  assert.throws(() => normalizeConditions([{ type: 'zeit', from: '08:00', to: '08:00' }]), /nicht gleich/);
  assert.throws(() => normalizeConditions([{ type: 'zeit' }]), /Wochentag oder eine Uhrzeit/);
  assert.throws(() => normalizeConditions([{ type: 'zeit', days: ['xx'] }]), /Wochentag/);
  assert.throws(() => normalizeConditions([{ type: 'spiel', is: 'bald', minutes: 2 }]), /zwischen 5 und 360/);
  assert.throws(() => normalizeConditions([{ type: 'ufo' }]), /Bedingung gibt es nicht/);
  const ok = normalizeConditions([{ type: 'wetter', is: 'ueber', value: '27.6', extra: 'x' }, { type: 'spiel', is: 'bald' }, { type: 'zeit', from: '08:00', to: '12:00', days: ['mo', 'di', 'mi', 'do', 'fr', 'fr'] }]);
  assert.deepEqual(ok, [{ type: 'wetter', is: 'ueber', value: 28 }, { type: 'spiel', is: 'bald', minutes: 60 }, { type: 'zeit', from: '08:00', to: '12:00', days: ['mo', 'di', 'mi', 'do', 'fr'] }]);
  assert.deepEqual(ok.map(describeCondition), ['Es sind mehr als 28 °C', 'Das Spiel beginnt in höchstens 60 Minuten', 'Montag bis Freitag von 08:00 bis 12:00 Uhr']);
});

const ctx = (w, m, t = T, wAge = 10 * MIN, mAge = 5 * MIN) => ({ t, weather: { enabled: w !== undefined, state: w ?? null, ts: w ? t - wAge : null }, match: { enabled: m !== undefined, state: m ?? null, ts: m ? t - mAge : null } });
const ev = (cond, c) => evalRule(normalizeConditions(Array.isArray(cond) ? cond : [cond]), c);
test('Regeln: Wetter-, Spiel- und Zeit-Bedingungen; veraltete oder fehlende Daten sind „unbekannt“ und lösen nie aus', () => {
  const w = { tempC: 12, rain: false, rainSoon: true };
  assert.deepEqual(['regen', 'regen_bald', 'trocken'].map((is) => ev({ type: 'wetter', is }, ctx(w)).ok), [false, true, false]);
  assert.equal(ev({ type: 'wetter', is: 'ueber', value: 10 }, ctx(w)).ok, true); assert.equal(ev({ type: 'wetter', is: 'unter', value: 10 }, ctx(w)).ok, false);
  assert.match(ev({ type: 'wetter', is: 'regen' }, ctx(w)).items[0].text, /12 °C, Regen bald \(vor 10 Min\.\)/);
  assert.equal(ev({ type: 'wetter', is: 'regen' }, ctx(w, undefined, T, 3 * 3600e3)).ok, null, 'Wetterdaten älter als 2 Stunden'); assert.match(ev({ type: 'wetter', is: 'regen' }, ctx(w, undefined, T, 3 * 3600e3)).items[0].text, /veraltet/);
  assert.equal(ev({ type: 'wetter', is: 'regen' }, ctx(undefined)).ok, null); assert.match(ev({ type: 'wetter', is: 'regen' }, ctx(undefined)).items[0].text, /ausgeschaltet/);
  // Zeit: Samstag 11:00
  assert.equal(ev({ type: 'zeit', from: '10:00', to: '12:00', days: ['sa'] }, ctx()).ok, true); assert.equal(ev({ type: 'zeit', from: '10:00', to: '12:00', days: ['mo', 'di'] }, ctx()).ok, false);
  assert.equal(ev({ type: 'zeit', from: '11:00', to: '12:00' }, ctx()).ok, true, 'Beginn zählt dazu'); assert.equal(ev({ type: 'zeit', from: '10:00', to: '11:00' }, ctx()).ok, false, 'Ende zählt nicht mehr dazu');
  assert.equal(ev({ type: 'zeit', from: '22:00', to: '02:00' }, ctx(undefined, undefined, at('2026-10-10', '23:30:00'))).ok, true, 'über Mitternacht'); assert.equal(ev({ type: 'zeit', from: '22:00', to: '02:00' }, ctx(undefined, undefined, at('2026-10-11', '03:00:00'))).ok, false);
  // Spiel
  const m = (o) => ({ match: { id: '1', kickoff: T - 30 * MIN, finished: false, team1: 'BVB', team2: 'FCB', goals: [], ...o } });
  const is = (x, st, c) => ev({ type: 'spiel', is: x, ...(c ?? {}) }, ctx(undefined, st)).ok;
  assert.deepEqual(['laeuft', 'heute', 'bald', 'nicht'].map((x) => is(x, m({}))), [true, true, false, false]);
  assert.deepEqual(['laeuft', 'heute', 'bald', 'nicht'].map((x) => is(x, m({ kickoff: T + 40 * MIN }))), [false, true, true, true]);
  assert.equal(is('bald', m({ kickoff: T + 40 * MIN }), { minutes: 30 }), false); assert.equal(is('heute', m({ kickoff: T + 30 * 3600e3 })), false, 'Spiel morgen'); assert.equal(is('laeuft', m({ finished: true })), false);
  assert.equal(is('laeuft', m({ kickoff: T - 4 * 3600e3 })), false, 'nach 3,5 Stunden gilt das Spiel als vorbei, auch wenn die Quelle es nicht meldet'); assert.equal(is('nicht', { match: null }), true); assert.equal(is('heute', { match: null }), false);
  assert.equal(ev({ type: 'spiel', is: 'laeuft' }, ctx(undefined, m({}), T, 0, 4 * 3600e3)).ok, null, 'Spieldaten älter als 3 Stunden');
  // Verknüpfung (UND): falsch gewinnt vor unbekannt
  const stale = { type: 'wetter', is: 'regen' }, no = { type: 'zeit', from: '01:00', to: '02:00' }, yes = { type: 'zeit', from: '10:00', to: '12:00' };
  assert.equal(ev([stale, no], ctx(w, undefined, T, 3 * 3600e3)).ok, false); assert.equal(ev([stale, yes], ctx(w, undefined, T, 3 * 3600e3)).ok, null); assert.equal(ev([yes, yes], ctx()).ok, true);
});

// ---------------------------------------------------------------- Hub-Tests
const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const plist = async (a, name, m) => { const id = (await a('POST', '/api/v1/playlists', { name, publish: true })).json().id; await a('PUT', `/api/v1/playlists/${id}`, { items: [{ mediaId: m, duration: 10 }], publish: true }); return id; };
const mkDev = (h, name = 'Dev', group = null) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,group_id,renderer) VALUES(?,?,'standard','active',?,?,?,'browser')").run(id, name, h.clock.t, h.clock.t, group); return id; };
const setApp = (h, type, state, ts = h.clock.t) => h.db.prepare("INSERT INTO apps(type,enabled,config_json,created_at,last_ok,state_json) VALUES(?,1,'{}',?,?,?) ON CONFLICT(type) DO UPDATE SET enabled=1,last_ok=excluded.last_ok,state_json=excluded.state_json").run(type, h.clock.t, ts, JSON.stringify(state));
const weather = (h, o = {}) => setApp(h, 'wetter', { tempC: 18, rain: false, rainSoon: false, ts: h.clock.t, ...o });
const rule = (P, o = {}) => ({ name: 'Bei Regen', conditions: [{ type: 'wetter', is: 'regen_bald' }], content: { type: 'playlist', id: P }, scope: 'all', priority: 5, stableS: 0, ...o });
const regelOv = (h) => h.db.prepare("SELECT o.*, k.prio FROM overrides o JOIN override_kind k ON k.id=o.id WHERE k.kind='regel' ORDER BY o.created_at, o.id").all();
const live = (h) => regelOv(h).filter((o) => !o.ended_at && o.until > h.clock.t);
const setup = async () => {
  const h = await makeHub(); h.clock.t = T; const a = await h.as('admin'); const m1 = await txt(a, 'Regen-Tipp'), P = await plist(a, 'Regenprogramm', m1), dv = mkDev(h);
  weather(h); return { h, a, P, dv, m1, tick: () => h.app.rules.tick(), view: () => h.app.rules.view() };
};

test('Regel startet bei Regen, verlängert sich laufend, endet mit Nachlauf – und ein kurzer Schauer-Wechsel lässt sie stehen', async () => {
  const { h, a, P, dv, tick, view } = await setup();
  const c = await a('POST', '/api/v1/rules', rule(P)); assert.equal(c.statusCode, 201, c.body); assert.equal(c.json().rule.status, 'inaktiv'); assert.equal(regelOv(h).length, 0, 'trocken: nichts');
  const lone = await txt(a, 'Nur-Regel-Folie'), names = () => manifestPayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv), h.clock.t).items.map((i) => i.name); assert.ok(!names().includes('Nur-Regel-Folie'));
  const c3 = await a('POST', '/api/v1/rules', { name: 'Nie', conditions: [{ type: 'zeit', days: ['mo'] }], content: { type: 'media', id: lone }, scope: 'all' }); assert.ok(names().includes('Nur-Regel-Folie'), 'Inhalt einer eingeschalteten Regel ist vorab im Manifest (mpv braucht das fertige Bild)');
  await a('PUT', `/api/v1/rules/${c3.json().id}`, { name: 'Nie', enabled: false, conditions: [{ type: 'zeit', days: ['mo'] }], content: { type: 'media', id: lone }, scope: 'all' }); assert.ok(!names().includes('Nur-Regel-Folie'), 'ausgeschaltet: nicht vorladen');
  h.clock.t += MIN; weather(h, { rain: true, rainSoon: true }); assert.equal(tick(), true);
  let o = live(h); assert.equal(o.length, 1); assert.equal(o[0].label, 'REGEL: Bei Regen'); assert.equal(o[0].scope, 'all'); assert.equal(o[0].until, h.clock.t + ROLL_MS); assert.equal(o[0].prio, 5); const id = o[0].id, t0 = h.clock.t;
  const plan = schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv), h.clock.t); assert.deepEqual(plan.overrides.map((x) => [x.kind, x.prio]), [['regel', 5]]); assert.equal(resolvePlaylist(plan, h.clock.t).playlistId, P);
  assert.equal(view().find((r) => r.name === 'Bei Regen').status, 'zeigt'); assert.match((await a('GET', '/api/v1/overrides')).json()[0].text, /Regel „Bei Regen“ zeigt auf alle Bildschirme \(automatisch/);
  for (let i = 0; i < 6; i++) { h.clock.t += MIN; weather(h, { rain: true, rainSoon: true }); tick(); } assert.equal(live(h)[0].id, id, 'dieselbe Übersteuerung'); assert.equal(live(h)[0].until, t0 + ROLL_MS, 'noch 9 Minuten übrig: nicht verlängert');
  h.clock.t += 2 * MIN; weather(h, { rain: true, rainSoon: true }); tick(); assert.ok(live(h)[0].until > t0 + ROLL_MS, 'unter 8 Minuten übrig → verlängert'); assert.equal(live(h)[0].until, h.clock.t + ROLL_MS); assert.equal(regelOv(h).length, 1);
  // Nachlauf: 2 Minuten ohne Regen bis zum Ende; ein kurzer Schauer dazwischen hält die Regel
  h.clock.t += MIN; weather(h, { rain: false, rainSoon: false }); tick(); assert.equal(live(h).length, 1, 'gerade erst trocken');
  h.clock.t += 60000; weather(h, { rain: true, rainSoon: true }); tick(); h.clock.t += 60000; weather(h, { rain: false, rainSoon: false }); tick(); h.clock.t += 60000; tick(); assert.equal(live(h).length, 1, 'nach dem Schauer beginnt die Wartezeit neu');
  h.clock.t += 61000; tick(); assert.equal(live(h).length, 0, 'zwei Minuten trocken → beendet'); assert.equal(regelOv(h).length, 1); assert.ok(regelOv(h)[0].ended_at); assert.equal(view().find((r) => r.name === 'Bei Regen').status, 'inaktiv');
  await h.cleanup();
});

test('Regel: Wartezeit vor dem Start; Hub-Ausfall beendet die Anzeige nach spätestens 15 Minuten von selbst', async () => {
  const { h, a, P, dv, tick } = await setup();
  await a('POST', '/api/v1/rules', rule(P, { stableS: 120 })); weather(h, { rain: true, rainSoon: true }); tick(); assert.equal(live(h).length, 0, 'sofort noch nicht');
  h.clock.t += 60000; tick(); assert.equal(live(h).length, 0); h.clock.t += 61000; tick(); assert.equal(live(h).length, 1, 'nach 2 Minuten Wartezeit');
  const dev = h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv), id = live(h)[0].id;
  h.clock.t += 16 * MIN; // Hub „tot“: keine Auswertung
  assert.equal(schedulePayload(h.db, dev, h.clock.t).overrides.length, 0, 'der Plan enthält die abgelaufene Übersteuerung nicht mehr');
  weather(h, { rain: true, rainSoon: true }); tick(); assert.equal(live(h).length, 0, 'Wartezeit startet nach dem Wiederanlauf neu'); h.clock.t += 121000; tick(); assert.equal(live(h).length, 1); assert.notEqual(live(h)[0].id, id, 'neue Übersteuerung');
  await h.cleanup();
});

test('Regel: „Beenden“ von Hand pausiert die Regel, bis die Bedingung einmal nicht mehr gilt – oder bis „Jetzt wieder starten“', async () => {
  const { h, a, P, tick, view } = await setup(); const c = await a('POST', '/api/v1/rules', rule(P)); const rid = c.json().id;
  weather(h, { rain: true, rainSoon: true }); tick(); assert.equal(live(h).length, 1);
  assert.equal((await a('DELETE', `/api/v1/overrides/${live(h)[0].id}`)).statusCode, 200);
  h.clock.t += MIN; tick(); assert.equal(live(h).length, 0, 'nicht sofort neu gestartet'); assert.equal(view()[0].status, 'pausiert'); assert.match(view()[0].statusText, /von Hand beendet/);
  h.clock.t += 5 * MIN; tick(); assert.equal(live(h).length, 0, 'bleibt pausiert, solange es regnet');
  const r = await a('POST', `/api/v1/rules/${rid}/resume`); assert.equal(r.statusCode, 200); assert.equal(live(h).length, 1, 'Jetzt wieder starten'); assert.equal(r.json().rule.status, 'zeigt');
  await a('DELETE', `/api/v1/overrides/${live(h)[0].id}`); h.clock.t += MIN; tick(); assert.equal(view()[0].status, 'pausiert');
  h.clock.t += MIN; weather(h, { rain: false, rainSoon: false }); tick(); assert.equal(view()[0].status, 'inaktiv', 'Bedingung galt einmal nicht → Pause vorbei');
  h.clock.t += MIN; weather(h, { rain: true, rainSoon: true }); tick(); assert.equal(live(h).length, 1, 'beim nächsten Regen läuft die Regel wieder');
  assert.equal((await a('POST', '/api/v1/rules/gibtsnicht/resume')).statusCode, 404); await h.cleanup();
});

test('Regeln: Vorrang – Hand-Aktion, Tor-Jubel und Notfall gehen vor; unter Regeln gewinnt die wichtigere, auch wenn sie nur einen Bildschirm betrifft', async () => {
  const { h, a, P, dv, tick, view } = await setup(); const m2 = await txt(a, 'Hitze-Tipp'), P2 = await plist(a, 'Hitze', m2); const dv2 = mkDev(h, 'Zweiter');
  await a('POST', '/api/v1/rules', rule(P, { name: 'Allgemein', priority: 3 })); await a('POST', '/api/v1/rules', rule(P2, { name: 'Nur Erster', priority: 7, scope: 'device', targetId: dv }));
  weather(h, { rain: true, rainSoon: true }); tick(); assert.equal(live(h).length, 2);
  const pick = (id) => resolvePlaylist(schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(id), h.clock.t), h.clock.t).playlistId;
  assert.equal(pick(dv), P2, 'wichtigere Regel für diesen Bildschirm'); assert.equal(pick(dv2), P, 'der andere Bildschirm zeigt die allgemeine Regel');
  const v = view(); assert.equal(v.find((r) => r.name === 'Allgemein').status, 'verdraengt'); assert.match(v.find((r) => r.name === 'Allgemein').statusText, /„Nur Erster“/); assert.equal(v.find((r) => r.name === 'Nur Erster').status, 'zeigt');
  // Hand-Aktion beendet die Regel-Übersteuerung NICHT, geht aber vor
  const m3 = await txt(a, 'Werbung'), P3 = await plist(a, 'Werbung', m3);
  assert.equal((await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'playlist', id: P3 }, minutes: 30, confirm: true })).statusCode, 201);
  assert.equal(live(h).length, 2, 'Regeln laufen im Hintergrund weiter'); assert.equal(pick(dv), P3); assert.equal(pick(dv2), P3);
  // Notfall: beendet die Hand-Aktion, nicht die Regeln, und liegt vor allem
  assert.equal((await a('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true })).statusCode, 201); assert.equal(live(h).length, 2);
  const em = h.db.prepare("SELECT content_id FROM overrides WHERE label='NOTFALL'").get(); assert.equal(pick(dv), `media:${em.content_id}`);
  await a('POST', '/api/v1/emergency/stop'); assert.equal(pick(dv), P2, 'nach dem Notfall zeigt wieder die Regel');
  // „Alle beenden“ ist ausdrücklich Handarbeit → Regeln pausieren
  await a('POST', '/api/v1/overrides/end-all'); h.clock.t += MIN; tick(); assert.equal(live(h).length, 0); assert.ok(view().every((r) => r.status === 'pausiert'));
  await h.cleanup();
});

test('Regeln: Ändern, Ausschalten, Löschen, verschwundener Inhalt und veraltete Daten', async () => {
  const { h, a, P, tick, view, dv } = await setup(); const m2 = await txt(a, 'Einzelfolie');
  const c = await a('POST', '/api/v1/rules', rule(P)); const id = c.json().id; weather(h, { rain: true, rainSoon: true }); tick(); const first = live(h)[0].id;
  assert.equal((await a('PUT', `/api/v1/rules/${id}`, rule(P, { name: 'Neuer Name', priority: 8 }))).statusCode, 200);
  assert.equal(live(h).length, 1, 'geänderte Regel startet frisch (Wartezeit 0)'); assert.notEqual(live(h)[0].id, first); assert.equal(live(h)[0].label, 'REGEL: Neuer Name'); assert.equal(live(h)[0].prio, 8); assert.ok(h.db.prepare('SELECT ended_at FROM overrides WHERE id=?').get(first).ended_at);
  assert.equal((await a('PUT', `/api/v1/rules/${id}`, rule(P, { enabled: false }))).statusCode, 200); assert.equal(live(h).length, 0); assert.equal(view()[0].status, 'aus');
  assert.equal((await a('PUT', `/api/v1/rules/${id}`, rule(P, { enabled: true }))).statusCode, 200); assert.equal(live(h).length, 1);
  // Daten veraltet → unbekannt → nach 2 Minuten beendet
  h.db.prepare("UPDATE apps SET last_ok=? WHERE type='wetter'").run(h.clock.t - 3 * 3600e3); tick(); assert.equal(live(h).length, 1, 'noch im Nachlauf'); h.clock.t += 121000; tick(); assert.equal(live(h).length, 0); assert.equal(view()[0].status, 'unbekannt');
  weather(h, { rain: true, rainSoon: true }); tick(); assert.equal(live(h).length, 1, 'frische Daten → läuft wieder');
  // Inhalt verschwindet
  const c2 = await a('POST', '/api/v1/rules', { name: 'Folie', conditions: [{ type: 'zeit', days: ['sa'] }], content: { type: 'media', id: m2 }, scope: 'all' }); assert.equal(c2.statusCode, 201, c2.body); assert.equal(live(h).length, 2);
  h.db.prepare('DELETE FROM media WHERE id=?').run(m2); tick(); assert.equal(live(h).length, 1); const bad = view().find((r) => r.name === 'Folie'); assert.equal(bad.status, 'fehler'); assert.match(bad.statusText, /Inhalt .* gelöscht/);
  // Löschen räumt auf
  assert.equal((await a('DELETE', `/api/v1/rules/${id}`)).statusCode, 200); assert.equal(live(h).length, 0); assert.equal(h.db.prepare('SELECT COUNT(*) n FROM rule_state WHERE rule_id=?').get(id).n, 0); assert.equal((await a('DELETE', `/api/v1/rules/${id}`)).statusCode, 404);
  void dv; await h.cleanup();
});

test('Regel nach Uhrzeit endet auf die Minute genau (ohne Nachlauf) und wirkt nur an den gewählten Wochentagen', async () => {
  const { h, a, P, tick } = await setup(); h.clock.t = at('2026-10-10', '09:59:00'); weather(h);
  await a('POST', '/api/v1/rules', { name: 'Vormittag', conditions: [{ type: 'zeit', from: '10:00', to: '12:00', days: ['sa', 'so'] }], content: { type: 'playlist', id: P }, scope: 'all' });
  tick(); assert.equal(live(h).length, 0); h.clock.t = at('2026-10-10', '10:00:30'); tick(); assert.equal(live(h).length, 1);
  h.clock.t = at('2026-10-10', '11:59:30'); tick(); assert.equal(live(h).length, 1); h.clock.t = at('2026-10-10', '12:00:10'); tick(); assert.equal(live(h).length, 0, 'sofort aus');
  h.clock.t = at('2026-10-12', '10:30:00'); tick(); assert.equal(live(h).length, 0, 'Montag: nicht dabei'); await h.cleanup();
});

test('Regel „Spiel läuft“ startet direkt nach dem Abruf der Live-App (ohne auf die nächste Minute zu warten)', async () => {
  const KICK = Date.parse('2026-10-10T13:30:00Z'); let goals = [];
  const h = await makeHub({ fetchText: async () => JSON.stringify([{ matchID: 1, matchDateTimeUTC: '2026-10-10T13:30:00Z', matchIsFinished: false, team1: { teamName: 'Borussia Dortmund', shortName: 'BVB' }, team2: { teamName: 'FC Bayern München', shortName: 'FCB' }, matchResults: [], goals }]) });
  h.clock.t = KICK - 30 * MIN; const a = await h.as('admin'); const m1 = await txt(a, 'Live-Folie'), P = await plist(a, 'Live', m1);
  await a('PUT', '/api/v1/apps/livespiel', { enabled: true, config: { favorite: 'Dortmund' } });
  await a('POST', '/api/v1/rules', { name: 'Spiel läuft', conditions: [{ type: 'spiel', is: 'laeuft' }], content: { type: 'playlist', id: P }, scope: 'all', priority: 6 }); assert.equal(live(h).length, 0);
  h.clock.t = KICK + MIN; await h.app.apps.run('livespiel'); assert.equal(live(h).length, 1, 'läuft'); h.clock.t = KICK + 4 * 3600e3; await h.app.apps.run('livespiel'); h.clock.t += 3 * MIN; h.app.rules.tick(); assert.equal(live(h).length, 0, 'nach dem Spiel beendet'); await h.cleanup();
});

test('Regeln: Prüfung der Eingaben, Vorschau und Rechte je Rolle', async () => {
  const { h, a, P } = await setup(); const e = await h.as('edi'), v = await h.as('vera'); const post = (b, who = a) => who('POST', '/api/v1/rules', b);
  assert.equal((await post(rule('gibtsnicht'))).statusCode, 400); assert.match((await post(rule('gibtsnicht'))).json().error, /Abspielliste gibt es nicht/);
  const draft = (await a('POST', '/api/v1/playlists', { name: 'Entwurf' })).json().id; assert.match((await post(rule(draft))).json().error, /Entwurf/);
  assert.match((await post(rule(P, { scope: 'group', targetId: 'nix' }))).json().error, /Gruppe/); assert.match((await post(rule(P, { scope: 'device', targetId: 'nix' }))).json().error, /Bildschirm/);
  assert.equal((await post(rule(P, { name: '   ' }))).statusCode, 400); assert.equal((await post(rule(P, { conditions: [] }))).statusCode, 400); assert.equal((await post(rule(P, { conditions: new Array(5).fill({ type: 'zeit', days: ['sa'] }) }))).statusCode, 400);
  assert.equal((await post(rule(P, { conditions: [{ type: 'wetter', is: 'sturm' }] }))).statusCode, 400); assert.equal((await post(rule(P, { priority: 10 }))).statusCode, 400);
  assert.equal((await post(rule(P, { name: 'Vom Redakteur' }), e)).statusCode, 201, 'Redakteur darf Regeln anlegen');
  assert.equal((await v('GET', '/api/v1/rules')).statusCode, 403); assert.equal((await post(rule(P), v)).statusCode, 403); assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/rules' })).statusCode, 401);
  const l = (await e('GET', '/api/v1/rules')).json(); assert.equal(l.rules.length, 1); assert.equal(l.templates.length, 5); assert.equal(l.apps.wetter, true); assert.equal(l.apps.livespiel, false);
  const p = await e('POST', '/api/v1/rules/preview', { conditions: [{ type: 'wetter', is: 'trocken' }, { type: 'zeit', days: ['sa'] }] }); assert.equal(p.statusCode, 200); assert.equal(p.json().ok, true); assert.equal(p.json().items.length, 2);
  assert.equal((await e('POST', '/api/v1/rules/preview', { conditions: [{ type: 'ufo' }] })).statusCode, 400);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='regel.angelegt'").get().n, 1);
  assert.equal((await a('GET', '/api/v1/media/unused')).json().items.some((m) => m.name === 'Regen-Tipp'), false, 'Inhalte in Listen gelten als benutzt');
  await h.cleanup();
});

test('Regeln: Konten mit Gruppen-Beschränkung dürfen nur für ihre eigenen Gruppen und Bildschirme Regeln anlegen, ändern und löschen', async () => {
  const { h, a, P } = await setup(); const g1 = randomUUID(), g2 = randomUUID(); for (const [g, n] of [[g1, 'Eigene'], [g2, 'Fremde']]) h.db.prepare('INSERT INTO device_groups(id,name) VALUES(?,?)').run(g, n);
  const mine = mkDev(h, 'Meiner', g1), foreign = mkDev(h, 'Fremder', g2);
  h.db.prepare('UPDATE users SET groups_json=? WHERE name=?').run(JSON.stringify([g1]), 'edi'); const e = await h.as('edi'); const post = (b) => e('POST', '/api/v1/rules', rule(P, b));
  assert.equal((await post({})).statusCode, 403, '„alle Bildschirme“ ist tabu'); assert.equal((await post({ scope: 'group', targetId: g2 })).statusCode, 403); assert.equal((await post({ scope: 'device', targetId: foreign })).statusCode, 403);
  const ok = await post({ scope: 'group', targetId: g1 }); assert.equal(ok.statusCode, 201, ok.body); assert.equal((await post({ scope: 'device', targetId: mine })).statusCode, 201);
  const open = (await a('POST', '/api/v1/rules', rule(P, { name: 'Vom Admin für alle' }))).json().id;
  assert.equal((await e('PUT', `/api/v1/rules/${open}`, rule(P, { name: 'geklaut', scope: 'group', targetId: g1 }))).statusCode, 403); assert.equal((await e('DELETE', `/api/v1/rules/${open}`)).statusCode, 403); assert.equal((await e('POST', `/api/v1/rules/${open}/resume`)).statusCode, 403);
  assert.equal((await e('PUT', `/api/v1/rules/${ok.json().id}`, rule(P, { scope: 'group', targetId: g2 }))).statusCode, 403, 'auch nicht auf eine fremde Gruppe umbiegen');
  assert.equal((await e('DELETE', `/api/v1/rules/${ok.json().id}`)).statusCode, 200); await h.cleanup();
});
