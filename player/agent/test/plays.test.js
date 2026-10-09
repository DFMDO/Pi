// Wiedergabe-Zähler: zählt Einblendungen und Zeit, kappt unplausible Zeiten, wiederholt Meldungen bis zur Bestätigung, übersteht Neustarts, rechnet in Berliner Tagen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlayCounter } from '../lib/plays.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 9, 10, 10, 0, 0); // 10.10.2026 12:00 Uhr Berliner Zeit
const sum = (days) => Object.fromEntries(Object.entries(days).map(([d, m]) => [d, Object.fromEntries(Object.entries(m).map(([id, e]) => [id, [e.n, e.s]]))]));

test('Zählen: jede Einblendung ein Mal, Zeit beim Wechsel; Zeit wird auf Länge + 5 s begrenzt (Standby danach); ungültige Einträge und „kein Medium“ zählen nicht', () => {
  const c = createPlayCounter();
  c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, T0);
  c.start({ mediaId: B, name: 'Film', kind: 'video', duration: 240 }, T0 + 10000);       // A lief 10 s
  c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, T0 + 10000 + 245000); // B lief 245 s (= Länge + 5)
  c.start(null, T0 + 10000 + 245000 + 600000);                                              // danach nichts mehr gemeldet (Standby, 10 Minuten): nur 10 s + 5 s zählen
  c.start({ mediaId: 'kein-uuid', name: 'x', kind: 'image', duration: 5 }, T0 + 2e6); c.start({ mediaId: '', name: 'Einstellung zurückgesetzt' }, T0 + 2e6 + 1);
  assert.deepEqual(sum(c.payload(T0 + 3e6).days), { '2026-10-10': { [A]: [2, 10 + 15], [B]: [1, 245] } });
  assert.equal(c.peek().open, null);
});

test('Meldung wiederholen bis zur Bestätigung: gleiche Nummer, nichts doppelt, neue Zähler warten; nach Bestätigung kommt nur das Neue', () => {
  const c = createPlayCounter(); c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, T0); c.start(null, T0 + 10000);
  const p1 = c.payload(T0 + 20000); assert.equal(p1.id, 1); assert.deepEqual(sum(p1.days), { '2026-10-10': { [A]: [1, 10] } });
  c.start({ mediaId: B, name: 'Film', kind: 'video', duration: 60 }, T0 + 30000); c.start(null, T0 + 90000);
  const again = c.payload(T0 + 100000); assert.equal(again.id, 1, 'unbestätigt: dieselbe Meldung noch einmal'); assert.deepEqual(sum(again.days), sum(p1.days), 'unverändert, damit der Hub Doppeltes erkennen kann');
  c.ack(99); assert.equal(c.payload(T0 + 100000).id, 1, 'falsche Nummer bestätigt nichts');
  c.ack(1); const p2 = c.payload(T0 + 110000); assert.equal(p2.id, 2); assert.deepEqual(sum(p2.days), { '2026-10-10': { [B]: [1, 60] } }, 'nur das Neue');
  c.ack(2); assert.equal(c.payload(T0 + 120000), null, 'nichts zu melden');
});

test('Unplausible Laufzeit: ein Element, das nie „fertig“ gemeldet wurde, wird beim Melden beendet statt Stunden zu zählen', () => {
  const c = createPlayCounter(); c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, T0);
  assert.deepEqual(sum(c.payload(T0 + 5000).days), { '2026-10-10': { [A]: [1, 0] } }, 'läuft noch: Zeit folgt beim Wechsel'); assert.ok(c.peek().open);
  c.ack(1); assert.equal(c.payload(T0 + 3 * 3600e3)?.days?.['2026-10-10']?.[A]?.s, 15, 'nach 3 Stunden ohne neue Meldung: höchstens 10 + 5 s');
});

test('Tageswechsel nach Berliner Zeit: 23:30 UTC ist schon der nächste Tag', () => {
  const c = createPlayCounter(); c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, Date.UTC(2026, 9, 10, 21, 59, 55)); c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, Date.UTC(2026, 9, 10, 22, 0, 5)); c.start(null, Date.UTC(2026, 9, 10, 22, 0, 15));
  assert.deepEqual(sum(c.payload(Date.UTC(2026, 9, 10, 23, 0)).days), { '2026-10-10': { [A]: [1, 10] }, '2026-10-11': { [A]: [1, 10] } }, 'Zeit zählt zum Tag, an dem die Einblendung begann');
});

test('Speichern: höchstens alle 5 Minuten und beim Beenden; nach einem Neustart sind Zähler, Nummer und unbestätigte Meldung wieder da', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfm-plays-')); const file = join(dir, 'state', 'plays.json');
  try {
    let c = createPlayCounter({ file, saveEveryMs: 300000 }); c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, T0); c.start(null, T0 + 10000);
    assert.equal(c.save(false, T0 + 1000), true, 'erstes Mal darf sofort'); assert.ok(existsSync(file)); c.start({ mediaId: B, name: 'Film', kind: 'video', duration: 60 }, T0 + 20000); c.start(null, T0 + 30000);
    assert.equal(c.save(false, T0 + 60000), false, 'zu früh: schont die SD-Karte'); const p = c.payload(T0 + 70000); assert.equal(p.id, 1); c.stop();
    c = createPlayCounter({ file }); const back = c.payload(T0 + 80000); assert.equal(back.id, 1, 'unbestätigte Meldung überlebt den Neustart'); assert.deepEqual(sum(back.days), sum(p.days));
    c.ack(1); c.start({ mediaId: A, name: 'Foto', kind: 'image', duration: 10 }, T0 + 90000); c.start(null, T0 + 95000); assert.equal(c.payload(T0 + 99000).id, 2, 'Nummer läuft weiter, wird nicht wiederverwendet');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Kaputte Zähler-Datei stoppt nichts: es wird einfach neu gezählt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfm-plays-')); const file = join(dir, 'plays.json');
  try { writeFileSyncSafe(file, '{kaputt'); const c = createPlayCounter({ file }); assert.equal(c.payload(T0), null); c.start({ mediaId: A, name: 'x', kind: 'image', duration: 5 }, T0); assert.ok(c.payload(T0 + 1000)); } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { writeFileSync } from 'node:fs';
const writeFileSyncSafe = (f, s) => writeFileSync(f, s);
