// Pilot (0.2.14): mpv wuchs im Standby auf 522 MB (alle 5 s dasselbe Bild neu geladen); Bilder > 10 s wären nach 10 s schwarz geworden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../player/agent/lib/renderers.js', import.meta.url), 'utf8');

test('mpv: Bild bleibt stehen (duration inf) und wird nur bei Änderung neu geladen', () => {
  assert.match(src, /--image-display-duration=inf/);
  assert.ok(!/--image-display-duration=\d/.test(src), 'keine feste Anzeigedauer, der Agent steuert den Wechsel');
  assert.match(src, /const show = \(file, force = false\) => \{ if \(!force && file === shown\) return;/);
  assert.ok(!/send\(\['loadfile'/.test(src.replace(/const show = [^\n]*\n/, '')), 'loadfile nur noch über show()');
  assert.match(src, /show\(fileOf\(current\), current\.kind === 'video'\)/, 'Videos werden immer neu gestartet (Schleife mit einem Video)');
  assert.match(src, /sock\.on\('connect', \(\) => \{ shown = null; tick\(\); \}\)/, 'nach mpv-Neustart wird wieder geladen');
});

test('mpv: Speicher-Wächter startet mpv neu, wenn er zu viel belegt; end-file nur bei eof weiter', () => {
  assert.match(src, /VmRSS/); assert.match(src, /RSS_LIMIT_KB/); assert.match(src, /sup\.restart\(\)/);
  assert.match(src, /clearInterval\(watchdog\)/, 'beim Stoppen aufräumen');
  assert.match(src, /"reason":"eof"/);
});
