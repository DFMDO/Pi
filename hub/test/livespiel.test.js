// Live-Spiel und Tor-Jubel (0.2.24): Spielstand aus OpenLigaDB, Tor-Erkennung ohne Doppelmeldung, kurze Übersteuerung „tor“, Rangfolge im Plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { zonedToEpoch } from '../lib/apps/ical.js';
import { buildLive, liveIntervalMin, favoriteSide, pickFavoriteMatch, liveMinute, inText } from '../lib/apps/builders.js';
import { createApps } from '../lib/apps/index.js';
import { manifestPayload, schedulePayload } from '../lib/plan.js';
import { resolvePlaylist, overrideRank } from '../../shared/sequencer.js';

const KICK = Date.parse('2026-10-10T13:30:00Z'); // 15:30 Uhr deutscher Zeit
const MIN = 60000;
const team = (teamName, shortName) => ({ teamName, shortName });
const goal = (goalID, scoreTeam1, scoreTeam2, goalGetterName, matchMinute, extra = {}) => ({ goalID, scoreTeam1, scoreTeam2, goalGetterName, matchMinute, isPenalty: false, isOwnGoal: false, ...extra });
const match = (o = {}) => ({ matchID: 100, matchDateTimeUTC: '2026-10-10T13:30:00Z', matchIsFinished: false, team1: team('Borussia Dortmund', 'BVB'), team2: team('FC Bayern München', 'FCB'), matchResults: [], goals: [], ...o });
const other = () => match({ matchID: 101, team1: team('VfB Stuttgart', 'VfB'), team2: team('SC Freiburg', 'SCF') });

test('Live-Spiel: Anstoß-Countdown, Spielstand mit Toren, Endstand – und der Verein wird an einem Namensteil erkannt', () => {
  const up = buildLive([other(), match()], { favorite: 'dortmund' }, KICK - 25 * MIN);
  assert.equal(up.title, 'Nächstes Spiel'); assert.match(up.body, /Samstag, 10\. Oktober um 15:30 Uhr/); assert.match(up.body, /Borussia Dortmund – FC Bayern München/); assert.match(up.body, /Anstoß in 25 Min\./);
  assert.equal(up.state.match.side, 1); assert.deepEqual(up.state.match.goals, []);
  const live = buildLive([match({ goals: [goal(1, 1, 0, 'Brandt', 12), goal(2, 1, 1, 'Kane', 40)] })], { favorite: 'Dortmund' }, KICK + 67 * MIN);
  assert.equal(live.title, 'BVB 1:1 FCB'); assert.match(live.body, /^LIVE – ca\. 52\. Minute/); assert.match(live.body, /12' Brandt \(1:0\)/); assert.match(live.body, /40' Kane \(1:1\)/);
  assert.deepEqual(live.state.match.goals.map((g) => g.team), [1, 2], 'wer getroffen hat, wird aus dem Stand abgeleitet');
  const end = buildLive([match({ matchIsFinished: true, matchResults: [{ resultTypeID: 2, pointsTeam1: 3, pointsTeam2: 2 }], goals: [goal(1, 1, 0, 'A', 5)] })], { favorite: 'Bayern' }, KICK + 3 * 3600e3);
  assert.equal(end.title, 'BVB 3:2 FCB'); assert.match(end.body, /^Endstand\n/); assert.equal(end.state.match.side, 2, 'Bayern spielt auswärts'); assert.equal(end.state.match.finished, true);
  assert.equal(buildLive([other()], { favorite: 'Dortmund' }, KICK).state.match, null, 'kein Spiel des Vereins an diesem Spieltag');
  assert.throws(() => buildLive([], { favorite: 'x' }, KICK), /keine Spiele/);
  assert.equal(favoriteSide(match(), 'borussia'), 1); assert.equal(favoriteSide(match(), 'FCB'), 2); assert.equal(favoriteSide(match(), ''), 0);
});

test('Live-Spiel: Tore ohne Spielminute, Eigentor/Elfmeter, vorläufiger Endstand, Halbzeit, gerundeter Countdown', () => {
  const g = buildLive([match({ goals: [goal(1, 0, 1, null, null, { isOwnGoal: true }), goal(2, 1, 1, 'Füllkrug', 55, { isPenalty: true })] })], { favorite: 'Dortmund' }, KICK + 100 * MIN);
  assert.match(g.body, /Tor \(0:1\) Eigentor/); assert.match(g.body, /55' Füllkrug \(1:1\) Elfmeter/); assert.deepEqual(g.state.match.goals.map((x) => x.team), [2, 1]);
  const stale = buildLive([match()], { favorite: 'Dortmund' }, KICK + 4 * 3600e3); assert.match(stale.body, /^Endstand \(vorläufig\)/, 'Quelle meldet das Ende nicht → nach 3,5 Stunden vorläufig beendet');
  assert.equal(liveMinute(KICK, KICK + 50 * MIN).label, 'Halbzeit'); assert.equal(liveMinute(KICK, KICK + 108 * MIN).label, 'Nachspielzeit'); assert.equal(liveMinute(KICK, KICK + 30 * MIN).label, 'ca. 30. Minute');
  assert.equal(inText(40 * 1000), 'jetzt gleich'); assert.equal(inText(7 * MIN), 'in 7 Min.'); assert.equal(inText(22 * MIN), 'in 25 Min.'); assert.equal(inText(95 * MIN), 'in 1 Std. 35 Min.');
  assert.equal(pickFavoriteMatch([match(), match({ matchID: 7, matchDateTimeUTC: '2026-10-03T13:30:00Z', matchIsFinished: true })], 'Dortmund', KICK - 10 * MIN).id, '100', 'kommendes Spiel vor beendetem');
});

test('Abrufabstand: rund um das Spiel jede Minute, sonst selten (schont die Datenquelle)', () => {
  const st = (o) => ({ match: { id: '1', kickoff: KICK, finished: false, ...o } });
  assert.equal(liveIntervalMin(st({}), KICK + 20 * MIN), 1, 'läuft'); assert.equal(liveIntervalMin(st({}), KICK - 10 * MIN), 1, 'kurz vor Anstoß');
  assert.equal(liveIntervalMin(st({}), KICK - 2 * 3600e3), 5); assert.equal(liveIntervalMin(st({}), KICK - 20 * 3600e3), 15); assert.equal(liveIntervalMin(st({ finished: true }), KICK + MIN), 15);
  assert.equal(liveIntervalMin(null, KICK), 15); assert.equal(liveIntervalMin({ match: null }, KICK), 15); assert.equal(liveIntervalMin(st({}), KICK + 5 * 3600e3), 15, 'lange nach Anstoß: Quelle meldet kein Ende');
});

const mkDev = (h, name = 'Dev') => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at,renderer) VALUES(?,?,'standard','active',?,?,'browser')").run(id, name, h.clock.t, h.clock.t); return id; };
const setup = async (cfg = {}) => {
  const box = { matches: [match()] };
  const h = await makeHub({ fetchText: async () => JSON.stringify(box.matches) }); h.clock.t = KICK - 30 * MIN; const a = await h.as('admin');
  const put = await a('PUT', '/api/v1/apps/livespiel', { enabled: true, config: { favorite: 'Dortmund', jubel: true, jubelSeconds: 20, ...cfg } }); assert.equal(put.statusCode, 200, put.body);
  return { h, a, box, run: async () => h.app.apps.run('livespiel'), again: () => h.as('admin') }; // die Uhr springt in den Tests: nach langen Pausen neu anmelden (Sitzung läuft nach 30 Min. Ruhe ab)
};
const tor = (h) => h.db.prepare("SELECT o.*, k.kind, k.prio FROM overrides o JOIN override_kind k ON k.id=o.id WHERE k.kind='tor' ORDER BY o.created_at").all();

test('Tor-Jubel: nur ein NEUES Tor des Lieblingsvereins löst aus – kein Jubel für Gegentore, alte Tore oder doppelt innerhalb von 30 Sekunden', async () => {
  const { h, a, box, run, again } = await setup(); const dv = mkDev(h);
  assert.equal(tor(h).length, 0, 'vor dem Anstoß kein Jubel'); assert.equal(h.db.prepare('SELECT last_goal_id FROM live_state').get().last_goal_id, 0, 'Spiel gemerkt (Stand 0)');
  h.clock.t = KICK + 20 * MIN; box.matches = [match({ goals: [goal(1, 1, 0, 'Brandt', 18)] })]; assert.equal((await run()).ok, true);
  let o = tor(h); assert.equal(o.length, 1, 'Tor für Dortmund → Jubel'); assert.equal(o[0].label, 'TOR'); assert.equal(o[0].scope, 'all'); assert.equal(o[0].until, h.clock.t + 20000); assert.equal(o[0].content_type, 'media');
  const m = h.db.prepare('SELECT * FROM media WHERE id=?').get(o[0].content_id); assert.deepEqual(JSON.parse(m.text_json), { title: 'TOR!', body: '', template: 'tor' }); assert.equal(m.folder, 'Apps');
  assert.equal(h.db.prepare("SELECT value FROM settings WHERE key='live.torMediaId'").get().value, m.id);
  await run(); assert.equal(tor(h).length, 1, 'derselbe Stand wird nicht noch einmal gefeiert');
  h.clock.t += 10000; box.matches = [match({ goals: [goal(1, 1, 0, 'Brandt', 18), goal(2, 1, 1, 'Kane', 19)] })]; await run(); assert.equal(tor(h).length, 1, 'Gegentor: kein Jubel');
  h.clock.t += 10000; box.matches = [match({ goals: [goal(1, 1, 0, 'Brandt', 18), goal(2, 1, 1, 'Kane', 19), goal(3, 2, 1, 'Adeyemi', 20)] })]; await run(); assert.equal(tor(h).length, 1, 'zweites Tor nach 20 Sekunden: noch Sperrzeit');
  h.clock.t += 60000; box.matches = [match({ goals: [goal(1, 1, 0, 'B', 18), goal(2, 1, 1, 'K', 19), goal(3, 2, 1, 'A', 20), goal(4, 3, 1, 'M', 22)] })]; await run(); assert.equal(tor(h).length, 2, 'späteres Tor → wieder Jubel');
  // Plan des Bildschirms: Art „tor“ steht darin, und die Jubel-Folie ist vorab im Manifest (mpv-Bildschirme brauchen das fertige Bild)
  const dev = h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv), plan = schedulePayload(h.db, dev, h.clock.t);
  assert.deepEqual(plan.overrides.map((x) => x.kind), ['tor']); assert.ok(manifestPayload(h.db, dev, h.clock.t).items.some((x) => x.id === m.id && x.kind === 'text' && x.text.template === 'tor'));
  assert.match((await (await again())('GET', '/api/v1/overrides')).json().find((x) => x.kind === 'tor').text, /Tor-Jubel auf alle/i); void a;
  await h.cleanup();
});

test('Tor-Jubel: kein Jubel für Tore, die schon vor dem ersten Abruf fielen (Neustart mitten im Spiel), ausgeschaltet, bei Notfall oder wenn das Spiel vorbei ist', async () => {
  const { h, box, run, again } = await setup({ jubel: false });
  h.clock.t = KICK + 30 * MIN; box.matches = [match({ goals: [goal(1, 1, 0, 'A', 5)] })]; await run(); assert.equal(tor(h).length, 0, 'Jubel ausgeschaltet');
  let a = await again(); h.db.prepare('DELETE FROM live_state').run(); await a('PUT', '/api/v1/apps/livespiel', { enabled: true, config: { jubel: true } }); // Hub „kennt“ das Spiel nicht mehr, 1 Tor liegt vor
  assert.equal(tor(h).length, 0, 'altes Tor beim ersten Sehen: kein Jubel');
  await a('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true });
  h.clock.t += 2 * MIN; box.matches = [match({ goals: [goal(1, 1, 0, 'A', 5), goal(2, 2, 0, 'B', 33)] })]; await run(); assert.equal(tor(h).length, 0, 'während einer Notfall-Meldung wird nicht gejubelt');
  await a('POST', '/api/v1/emergency/stop'); h.clock.t += 2 * MIN; a = await again(); box.matches = [match({ matchIsFinished: true, goals: [goal(1, 1, 0, 'A', 5), goal(2, 2, 0, 'B', 33), goal(3, 3, 0, 'C', 88)] })]; await run(); assert.equal(tor(h).length, 0, 'Spiel beendet: Korrekturen werden nicht gefeiert');
  assert.equal((await a('POST', '/api/v1/apps/livespiel/jubel-test')).statusCode, 200, 'Test geht auch bei ausgeschaltetem Jubel');
  await h.cleanup();
});

test('Tor-Jubel: nur auf einer Gruppe, Test-Knopf mit Rechten, Notfall ist wichtiger, Rangfolge im Player', async () => {
  const { h, a, run, box } = await setup(); const e = await h.as('edi'); // (Uhr bleibt hier stehen: keine Sitzungsprobleme)
  const gid = randomUUID(); h.db.prepare('INSERT INTO device_groups(id,name) VALUES(?,?)').run(gid, 'Foyer');
  assert.equal((await a('PUT', '/api/v1/apps/livespiel', { enabled: true, config: { jubelGroupId: gid, jubelSeconds: 8 } })).statusCode, 200);
  const r = await a('POST', '/api/v1/apps/livespiel/jubel-test'); assert.equal(r.statusCode, 200, r.body); assert.match(r.json().text, /8 Sekunden auf der gewählten Gruppe/);
  const o = tor(h); assert.equal(o.length, 1); assert.equal(o[0].scope, 'group'); assert.equal(o[0].target_id, gid);
  assert.equal((await e('POST', '/api/v1/apps/livespiel/jubel-test')).statusCode, 403, 'nur Admin');
  await a('POST', '/api/v1/emergency/start', { presetId: 'warten', confirm: true });
  assert.equal(tor(h).length, 1, 'Notfall-Meldung beendet den Jubel nicht, sie ist nur wichtiger'); const t = await a('POST', '/api/v1/apps/livespiel/jubel-test'); assert.equal(t.statusCode, 409); assert.match(t.json().error, /Notfall/);
  // Rangfolge: Notfall vor Tor vor Hand vor Regel – unabhängig vom Alter und vom Bereich
  const ov = (id, kind, extra = {}) => ({ id, scope: 'device', playlistId: id, until: 9e12, createdAt: 1, kind, ...extra });
  const pick = (...list) => resolvePlaylist({ segments: [], playlists: {}, defaultPlaylistId: null, overrides: list }, 1000).playlistId;
  assert.equal(pick(ov('r', 'regel', { scope: 'all', createdAt: 9 }), ov('m', undefined, { createdAt: 5 })), 'm', 'Hand-Aktion vor Regel, auch wenn die Regel „alle“ betrifft und neuer ist');
  assert.equal(pick(ov('m', undefined, { scope: 'all', createdAt: 9 }), ov('t', 'tor')), 't', 'Tor-Jubel vor Hand-Aktion');
  assert.equal(pick(ov('t', 'tor', { scope: 'all', createdAt: 9 }), ov('n', 'notfall')), 'n', 'Notfall vor Tor-Jubel');
  assert.equal(pick(ov('a', 'regel', { prio: 3, scope: 'all', createdAt: 9 }), ov('b', 'regel', { prio: 7 })), 'b', 'Regeln untereinander: höhere Wichtigkeit gewinnt');
  assert.ok(overrideRank({ kind: 'notfall' }) > overrideRank({ kind: 'tor' }) && overrideRank({ kind: 'tor' }) > overrideRank({}) && overrideRank({}) > overrideRank({ kind: 'regel', prio: 9 }));
  await h.cleanup(); void box; void run;
});

test('Rahmen: Live-App ruft bei laufendem Spiel jede Minute ab, speichert den Zustand und zeigt eine Zeile für die Übersicht', async () => {
  const h = await makeHub({}); let t = KICK + 20 * MIN, calls = 0;
  const apps = createApps({ db: h.db, variants: h.app.variants, now: () => t, fetchText: async () => { calls++; return JSON.stringify([match({ goals: [goal(1, 1, 0, 'Brandt', 18)] })]); } });
  apps.save('livespiel', { enabled: true, config: { favorite: 'Dortmund' } }); assert.equal((await apps.runDue()).length, 1); assert.equal(calls, 1);
  t += 30000; assert.equal((await apps.runDue()).length, 0, 'nach 30 s noch nicht fällig'); t += 31000; assert.equal((await apps.runDue()).length, 1, 'nach über einer Minute fällig');
  const s = apps.stateOf('livespiel'); assert.equal(s.enabled, true); assert.equal(s.state.match.side, 1); assert.ok(s.ts > 0);
  assert.match(apps.list().find((x) => x.type === 'livespiel').info, /BVB 1:0 FCB – läuft gerade/);
  t = KICK + 5 * 3600e3; assert.equal((await apps.runDue()).length, 1); t += 10 * MIN; assert.equal((await apps.runDue()).length, 0, 'lange nach dem Spiel: nur alle 15 Minuten'); t += 6 * MIN; assert.equal((await apps.runDue()).length, 1);
  assert.throws(() => apps.save('livespiel', { enabled: true, config: { league: 'xyz' } }), /Liga/); assert.throws(() => apps.save('livespiel', { enabled: true, config: { favorite: '  ' } }), /Namen deines Vereins/);
  await h.cleanup();
});
