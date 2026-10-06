import test from 'node:test';
import assert from 'node:assert/strict';
import { localToEpoch, epochToLocal, tzOffset } from './time.js';
import { expand, buildTimeline, currentSegment, findConflicts, parseRrule } from './schedule.js';

const H = 3600000;
const mk = (o) => ({ id: 'x', targetType: 'device', targetId: 'd1', content: { type: 'playlist', id: 'p' },
  priority: 5, exdates: [], rrule: null, ...o });
const range = (a, b) => [localToEpoch(a, '00:00'), localToEpoch(b, '00:00')];

test('Zeitumstellung: Berlin-Offsets', () => {
  assert.equal(tzOffset(Date.UTC(2026, 0, 15, 12)), H);
  assert.equal(tzOffset(Date.UTC(2026, 6, 15, 12)), 2 * H);
});

test('März: 02:30 existiert nicht -> 03:30 Sommerzeit', () => {
  const e = localToEpoch('2026-03-29', '02:30');
  assert.deepEqual(epochToLocal(e), { date: '2026-03-29', time: '03:30', dow: 0 });
});

test('Oktober: 02:30 doppelt -> erste Instanz (Sommerzeit)', () => {
  const e = localToEpoch('2026-10-25', '02:30');
  assert.equal(e, Date.UTC(2026, 9, 25, 0, 30)); // 02:30 CEST = 00:30 UTC
});

test('täglicher Termin 02:30 bleibt über die Umstellung lokal 02:30 (außer Lücke)', () => {
  const s = mk({ startLocal: '2026-10-23T02:30', endLocal: '2026-10-23T03:30', rrule: 'FREQ=DAILY' });
  const [a, b] = range('2026-10-23', '2026-10-28');
  const w = expand(s, a, b);
  assert.equal(w.length, 5);
  assert.equal(epochToLocal(w[0].start).time, '02:30');
  assert.equal(epochToLocal(w[4].start).time, '02:30'); // 27.10. (Winterzeit)
});

test('wöchentlich Mo/Mi mit Ausnahme', () => {
  const s = mk({ startLocal: '2026-10-05T10:00', endLocal: '2026-10-05T11:00',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE', exdates: ['2026-10-07'] });
  const [a, b] = range('2026-10-05', '2026-10-19');
  const days = expand(s, a, b).map((w) => epochToLocal(w.start).date);
  assert.deepEqual(days, ['2026-10-05', '2026-10-12', '2026-10-14']);
});

test('Intervall und COUNT', () => {
  const s = mk({ startLocal: '2026-10-05T10:00', endLocal: '2026-10-05T11:00', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=2' });
  const [a, b] = range('2026-10-01', '2026-12-31');
  assert.deepEqual(expand(s, a, b).map((w) => epochToLocal(w.start).date), ['2026-10-05', '2026-10-19']);
});

test('Priorität, Gleichstand, Gerät vor Gruppe', () => {
  const [a, b] = range('2026-10-06', '2026-10-07');
  const lo = mk({ id: 'lo', priority: 3, startLocal: '2026-10-06T10:00', endLocal: '2026-10-06T14:00' });
  const hi = mk({ id: 'hi', priority: 8, startLocal: '2026-10-06T11:00', endLocal: '2026-10-06T12:00' });
  let tl = buildTimeline([lo, hi], { deviceId: 'd1' }, a, b);
  const at = (h) => currentSegment(tl, localToEpoch('2026-10-06', h))?.source?.scheduleId ?? null;
  assert.equal(at('09:00'), null); assert.equal(at('10:30'), 'lo');
  assert.equal(at('11:30'), 'hi'); assert.equal(at('12:30'), 'lo');
  // Gleichstand: später gestarteter gewinnt
  const t1 = mk({ id: 't1', startLocal: '2026-10-06T10:00', endLocal: '2026-10-06T14:00' });
  const t2 = mk({ id: 't2', startLocal: '2026-10-06T12:00', endLocal: '2026-10-06T13:00' });
  tl = buildTimeline([t1, t2], { deviceId: 'd1' }, a, b);
  assert.equal(at('12:30'), 't2');
  // Direkt zugewiesen schlägt Gruppe, auch bei niedrigerer Priorität
  const g = mk({ id: 'g', targetType: 'group', targetId: 'G', priority: 10, startLocal: '2026-10-06T10:00', endLocal: '2026-10-06T14:00' });
  const d = mk({ id: 'd', priority: 1, startLocal: '2026-10-06T10:00', endLocal: '2026-10-06T14:00' });
  tl = buildTimeline([g, d], { deviceId: 'd1', groupId: 'G' }, a, b);
  assert.equal(at('11:00'), 'd');
});

test('Gültig-von/bis und Konflikte', () => {
  const s = mk({ startLocal: '2026-10-05T10:00', endLocal: '2026-10-05T11:00', rrule: 'FREQ=DAILY', validTo: '2026-10-06' });
  const [a, b] = range('2026-10-05', '2026-10-12');
  assert.equal(expand(s, a, b).length, 2);
  const c1 = mk({ id: 'c1', startLocal: '2026-10-06T10:00', endLocal: '2026-10-06T12:00' });
  const c2 = mk({ id: 'c2', startLocal: '2026-10-06T11:00', endLocal: '2026-10-06T13:00' });
  assert.equal(findConflicts([c1, c2], a, b).length, 1);
});

test('Termin über Mitternacht und ungültige Regeln', () => {
  const s = mk({ startLocal: '2026-10-06T22:00', endLocal: '2026-10-07T02:00' });
  const [a, b] = range('2026-10-06', '2026-10-08');
  const [w] = expand(s, a, b);
  assert.equal(w.end - w.start, 4 * H);
  assert.throws(() => parseRrule('FREQ=YEARLY'));
  assert.throws(() => expand(mk({ startLocal: '2026-10-06T12:00', endLocal: '2026-10-06T11:00' }), a, b));
});
