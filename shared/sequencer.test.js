import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlaylist, playableItems } from './sequencer.js';
import { localToEpoch } from './time.js';

const plan = { defaultPlaylistId: 'def', segments: [
  { start: 1000, end: 2000, source: { scheduleId: 's1', content: { type: 'playlist', id: 'sommer' } } },
  { start: 5000, end: 6000, source: { scheduleId: 's2', content: { type: 'playlist', id: 'x' } } }],
playlists: { def: { items: [{ mediaId: 'a', duration: 10, transition: 'fade' }] }, sommer: { items: [
  { mediaId: 'a', duration: 5, transition: 'fade' }, { mediaId: 'v', duration: 10 }, { mediaId: 't', duration: 8, transition: 'fade' }, { mediaId: 'fehlt', duration: 5 },
  { mediaId: 'alt', duration: 5, validTo: '2020-01-01' }, { mediaId: 'noch', duration: 5, validFrom: '2999-01-01' }, { mediaId: 'prep', duration: 5 }] } } };

test('resolvePlaylist: Termin, Standard, nächste Kante', () => {
  assert.deepEqual(resolvePlaylist(plan, 1500), { playlistId: 'sommer', until: 2000, scheduleId: 's1', source: 'termin' });
  assert.deepEqual(resolvePlaylist(plan, 3000), { playlistId: 'def', until: 5000, scheduleId: null, source: 'standard' });
  assert.equal(resolvePlaylist(plan, 9000).until, null);
  assert.equal(resolvePlaylist(null, 1).source, 'none');
});

test('playableItems: überspringt Ungültiges, Fehlendes, Nicht-Darstellbares', () => {
  const manifest = { items: [{ id: 'a', kind: 'image', sha256: 'x' }, { id: 'v', kind: 'video', sha256: 'y' }, { id: 't', kind: 'text', text: { title: 'T' } },
    { id: 'alt', kind: 'image' }, { id: 'noch', kind: 'image' }, { id: 'prep', kind: 'image', pending: true }] };
  const now = localToEpoch('2026-10-06', '12:00');
  const std = playableItems(plan, 'sommer', manifest, { profile: 'standard', now });
  assert.deepEqual(std.items.map((i) => i.mediaId), ['a', 'v', 't']);
  assert.deepEqual(std.skipped.map((s) => s.reason).sort(), ['nicht im Manifest', 'wird noch vorbereitet']);
  const lite = playableItems(plan, 'sommer', manifest, { profile: 'lite', now });
  assert.deepEqual(lite.items.map((i) => i.mediaId), ['a', 'v'], 'Text ohne Bildvariante wird auf Lite übersprungen');
  assert.ok(lite.items.every((i) => i.transition === 'cut'), 'Lite: nur harter Schnitt');
  assert.deepEqual(playableItems(plan, 'sommer', manifest, { profile: 'standard', now, have: (m) => m.id !== 'v' }).items.map((i) => i.mediaId), ['a', 't']);
});

test('Übersteuerungen: feste Rangfolge Notfall > Tor-Jubel > Hand > Regel; Regeln untereinander nach Wichtigkeit; ohne Art wie bisher (alter Hub)', () => {
  const ov = (id, extra = {}) => ({ id, scope: 'device', playlistId: id, until: 9e12, createdAt: 1, ...extra });
  const pick = (...overrides) => resolvePlaylist({ segments: [], playlists: {}, defaultPlaylistId: 'def', overrides }, 1000).playlistId;
  assert.equal(pick(ov('regel', { kind: 'regel', scope: 'all', createdAt: 9 }), ov('hand')), 'hand');
  assert.equal(pick(ov('hand', { scope: 'all', createdAt: 9 }), ov('tor', { kind: 'tor' })), 'tor');
  assert.equal(pick(ov('tor', { kind: 'tor', scope: 'all', createdAt: 9 }), ov('notfall', { kind: 'notfall' })), 'notfall');
  assert.equal(pick(ov('a', { kind: 'regel', prio: 3, scope: 'all', createdAt: 9 }), ov('b', { kind: 'regel', prio: 7 })), 'b');
  assert.equal(pick(ov('alt1', { createdAt: 1 }), ov('alt2', { createdAt: 2 })), 'alt2', 'ohne Art: neueste gewinnt, wie in Version 0.2.23');
  assert.equal(pick(ov('alt1', { createdAt: 5 }), ov('alt2', { scope: 'all', createdAt: 2 })), 'alt2', 'ohne Art: „alle“ vor einzelnem Bildschirm, wie bisher');
  assert.equal(pick(ov('abgelaufen', { kind: 'notfall', until: 500 }), ov('hand')), 'hand', 'abgelaufene zählen nicht');
});
