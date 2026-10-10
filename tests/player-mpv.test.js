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
  assert.match(src, /show\(target, current\.kind === 'video' \|\| current\.kind === 'stream'\)/, 'Videos und Live-Bilder werden immer neu gestartet (Schleife mit einem Video)');
  assert.match(src, /s\.on\('connect', \(\) => \{ if \(sock === s\) \{ shown = null; zoneKey = null; zoneOn = false; wallActive = false; wallKey = null; lastCrop = null; tick\(\); applyZones\(\); \} \}\)/, 'nach mpv-Neustart wird wieder geladen (und die Einstellungen von Gleichtakt/Zuschnitt sind wieder Standard)');
});

test('mpv: Speicher-Wächter startet mpv neu, wenn er zu viel belegt; end-file nur bei eof weiter', () => {
  assert.match(src, /VmRSS/); assert.match(src, /RSS_LIMIT_KB/); assert.match(src, /sup\.restart\(\)/);
  assert.match(src, /clearInterval\(watchdog\)/, 'beim Stoppen aufräumen');
  assert.match(src, /"reason":"eof"/);
});

// Pilot (0.2.16, Diagnose nach 3 h 48 min): Speicher voll, Systemwächter beendete chrony, avahi, NetworkManager, Hub und Agent; der Agent belegte 349 MB.
// Ursache: error UND close planten je einen neuen Verbindungsversuch zu mpv → Verdopplung jede Sekunde, jeder mpv-Neustart vervielfachte die offenen Sockets.
import { EventEmitter } from 'node:events';
import { liteRenderer } from '../player/agent/lib/renderers.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeChild = () => { const c = new EventEmitter(); c.pid = 4242; c.kill = () => {}; return c; };
const mk = (net) => liteRenderer({ getPlan: () => ({ segments: [], playlists: {} }), getManifest: () => ({ items: [] }), haveFile: () => false, fileOf: () => '', net, spawnFn: fakeChild, reconnectMs: 20 });

test('mpv-Verbindung: fehlt mpv, wächst die Zahl der Versuche nur linear (kein Verdoppeln), nach stop() ist Ruhe', async () => {
  const st = { n: 0 }; const net = { connect: () => { st.n++; const s = new EventEmitter(); s.destroy = () => {}; s.write = () => {}; setImmediate(() => { s.emit('error', new Error('ENOENT')); s.emit('close'); }); return s; } };
  const r = mk(net); await sleep(500);
  assert.ok(st.n >= 5 && st.n <= 40, `Verbindungsversuche in 0,5 s: ${st.n} (exponentiell wären Tausende)`);
  r.stop(); const after = st.n; await sleep(150); assert.equal(st.n, after, 'nach stop() keine weiteren Versuche');
});

test('mpv-Verbindung: steht die Verbindung, wird ein Standby-Bild nur einmal geladen; nach Abbruch genau eine neue Verbindung', async () => {
  const st = { n: 0, writes: [] }; let cur = null;
  const net = { connect: () => { st.n++; const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => st.writes.push(String(x)); cur = s; setImmediate(() => s.emit('connect')); return s; } };
  const r = mk(net); await sleep(250);
  assert.equal(st.n, 1, 'eine Verbindung'); assert.equal(st.writes.filter((w) => w.includes('standby.png')).length, 1, 'Standby-Bild nur einmal geladen');
  cur.emit('close'); await sleep(250);
  assert.equal(st.n, 2, 'nach Abbruch genau eine neue Verbindung'); assert.equal(st.writes.filter((w) => w.includes('standby.png')).length, 2, 'danach wird das Bild wieder geladen');
  r.stop();
});
