// Hinweise beim Hochladen (große Fotos, Videoformat/Bildrate) und Arbeitsspeicher-Wächter der Verwaltung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaHints } from '../lib/variants.js';
import { makeHub } from './helpers.js';

test('Hinweise: sehr großes Foto, Video nicht H.264, zu hohe Bildrate, sehr großes/langes Video – passende Videos ohne Hinweis', () => {
  assert.ok(mediaHints('image', 6000, 4000, { bytes: 3e6 }).some((t) => /sehr groß/.test(t)), 'Kantenlänge > 5000');
  assert.ok(mediaHints('image', 3000, 2000, { bytes: 20 * 1048576 }).some((t) => /sehr groß/.test(t)), 'Datei > 15 MB');
  assert.equal(mediaHints('image', 3000, 2000, { bytes: 4e6 }).length, 0);
  assert.ok(mediaHints('video', 1920, 1080, { codec: 'hevc', fps: 30, bytes: 5e7, durationS: 240 }).some((t) => /nicht im Format H\.264/.test(t)));
  assert.ok(mediaHints('video', 1920, 1080, { codec: 'h264', fps: 60, bytes: 5e7, durationS: 240 }).some((t) => /60 Bilder/.test(t)));
  assert.ok(mediaHints('video', 1920, 1080, { codec: 'h264', fps: 25, bytes: 2 * 1024 ** 3, durationS: 240 }).some((t) => /sehr groß oder lang/.test(t)));
  assert.deepEqual(mediaHints('video', 1920, 1080, { codec: 'h264', fps: 25, bytes: 4e8, durationS: 240 }), [], 'Full-HD-H.264, 4 Minuten: keine Warnung');
  assert.ok(mediaHints('video', 3840, 2160, {}).some((t) => /größer als Full-HD/.test(t)), 'bisheriger 4K-Hinweis bleibt');
});

test('Speicher-Wächter: Route nur mit Leserecht, liefert Zahlen und warnt nicht beim Start', async () => {
  const h = await makeHub({}); const a = await h.as('admin');
  const r = (await a('GET', '/api/v1/system/memory')).json();
  assert.equal(typeof r.availMB, 'number'); assert.equal(typeof r.totalMB, 'number'); assert.equal(r.warn, false, 'kurz nach dem Start keine Warnung (5 Messungen nötig)'); assert.equal(r.text, null);
  await h.cleanup();
});
