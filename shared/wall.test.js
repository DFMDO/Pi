// Gleichtakt und Videowand: gemeinsame Rechnung (Position im Ablauf, Zuschnitt je Kachel).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wallPosition, tileCrop, cropRect, slotMs } from './wall.js';

const img = (d) => ({ kind: 'image', duration: d });
const vid = (s) => ({ kind: 'video', durationS: s });

test('Gleichtakt: Position aus der Uhrzeit – Elemente, Übergänge, Umlauf und Zeit vor dem Startpunkt', () => {
  const items = [img(10), vid(60), img(5)]; // Runde: 75 s
  const e = 1_000_000_000_000;
  const at = (s) => wallPosition(items, e, e + s * 1000);
  assert.deepEqual([at(0).index, at(0).offsetMs], [0, 0]);
  assert.deepEqual([at(9.999).index], [0]); assert.deepEqual([at(10).index, at(10).offsetMs], [1, 0]);
  assert.deepEqual([at(40).index, at(40).offsetMs], [1, 30000]);
  assert.deepEqual([at(70).index, at(70).offsetMs], [2, 0]); assert.deepEqual([at(75).index], [0], 'neue Runde');
  assert.deepEqual([at(75 * 1000 + 3).index], [0]); assert.equal(at(12).cycleMs, 75000);
  const p = at(40); assert.equal(p.startMs, e + 10000); assert.equal(p.endMs, e + 70000, 'Ende dieses Elements');
  const before = wallPosition(items, e, e - 5000); assert.equal(before.index, 2, 'vor dem Startpunkt rechnet rückwärts (Ende der vorigen Runde)'); assert.equal(before.offsetMs, 0);
  assert.equal(wallPosition([], e, e), null); assert.equal(wallPosition(items, NaN, e), null);
});

test('Gleichtakt: Zwei Bildschirme mit verschiedenen Uhrzeiten (±40 ms) landen im selben Element, außer direkt an der Kante', () => {
  const items = [img(10), img(10), img(10)], e = 5_000_000_000;
  for (let s = 0; s < 30; s += 3.7) {
    const a = wallPosition(items, e, e + s * 1000 - 40), b = wallPosition(items, e, e + s * 1000 + 40);
    const nearEdge = Math.abs((s % 10) - 0) < 0.05 || Math.abs((s % 10) - 10) < 0.05;
    if (!nearEdge) assert.equal(a.index, b.index, `bei ${s} s`);
  }
});

test('Zeitabschnitt eines Elements: Bilder nach eingestellter Dauer, Videos nach ihrer Länge; nie unter einer Sekunde', () => {
  assert.equal(slotMs(img(7)), 7000); assert.equal(slotMs(vid(241.6)), 241600); assert.equal(slotMs({ kind: 'video' }), 30000); assert.equal(slotMs({ kind: 'image' }), 10000); assert.equal(slotMs(img(0)), 1000);
});

/** Wie mpv den Ausschnitt anwendet: die Verschiebung ist ein Anteil des FREIEN Platzes (so verifiziert mit mpv 0.37) */
const cover = (cols, rows, aspect) => {
  const tiles = []; let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const rc = cropRect(tileCrop({ cols, rows, col: c, row: r, aspect })); tiles.push(rc);
    minX = Math.min(minX, rc.x); minY = Math.min(minY, rc.y); maxX = Math.max(maxX, rc.x + rc.w); maxY = Math.max(maxY, rc.y + rc.h);
  }
  return { tiles, area: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
};

test('Videowand 2×2 mit 16:9-Inhalt: vier gleich große Viertel ohne Lücken und Überlappung', () => {
  const { tiles, area } = cover(2, 2, 16 / 9);
  assert.deepEqual(tiles.map((t) => [t.x, t.y, t.w, t.h]), [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
  assert.deepEqual([area.x, area.y, area.w, area.h], [0, 0, 1, 1]);
});

test('Videowand: Jede Kachel hat das Seitenverhältnis des Bildschirms (16:9), egal wie Wand und Inhalt zueinander passen', () => {
  for (const [cols, rows] of [[2, 1], [1, 2], [3, 1], [2, 2], [3, 2], [4, 1], [4, 4]]) for (const aspect of [16 / 9, 4 / 3, 21 / 9, 9 / 16, 1]) {
    const { tiles, area } = cover(cols, rows, aspect);
    for (const t of tiles) {
      const tileAspect = (t.w * aspect) / t.h; // Breite/Höhe der Kachel im Quellbild
      assert.ok(Math.abs(tileAspect - 16 / 9) < 0.14, `${cols}×${rows} mit ${aspect.toFixed(2)}: Kachel ${tileAspect.toFixed(2)}`); // ±1 % Rundung auf ganze Prozent
    }
    // gefüllte Fläche liegt mittig, füllt eine Richtung ganz aus und überlappt nicht
    assert.ok(Math.abs(area.x * 2 + area.w - 1) < 0.03 && Math.abs(area.y * 2 + area.h - 1) < 0.03, 'mittig');
    assert.ok(area.w > 0.97 || area.h > 0.97, 'eine Richtung voll');
    const sum = tiles.reduce((s, t) => s + t.w * t.h, 0); assert.ok(Math.abs(sum - area.w * area.h) < 0.03, `Summe der Kacheln = Fläche (${cols}×${rows})`);
  }
});

test('Videowand: Beispiele wie sie mpv bekommt, und Randfälle (1×1 = kein Zuschnitt, ungültiges Seitenverhältnis)', () => {
  assert.equal(tileCrop({ cols: 1, rows: 1, col: 0, row: 0 }), '');
  assert.equal(tileCrop({ cols: 2, rows: 2, col: 1, row: 0 }), '50%x50%+100%+0%');
  assert.equal(tileCrop({ cols: 4, rows: 1, col: 1, row: 0 }), '25%x25%+33%+50%');
  assert.equal(tileCrop({ cols: 2, rows: 1, col: 0, row: 0, aspect: 0 }), tileCrop({ cols: 2, rows: 1, col: 0, row: 0, aspect: 16 / 9 }), 'ungültig → 16:9');
  assert.equal(tileCrop({ cols: 0, rows: 2, col: 0, row: 0 }), '');
});
