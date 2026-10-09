// Laufband, Uhr und Infozone auf mpv-Bildschirmen („Video-optimiert“): Berechnung der Einblendung und Verhalten des Renderers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { zonesFor, esc, wrapLines, PAGE_MS, BAR_H, INFO_W, RES } from '../player/agent/lib/zones.js';
import { liteRenderer } from '../player/agent/lib/renderers.js';

const NOW = Date.UTC(2026, 9, 10, 8, 41); // 10:41 Uhr Berliner Zeit (Sommerzeit)
const plain = (e) => e.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n'); // sichtbarer Text eines ASS-Ereignisses

test('Berechnung: ohne Layout oder mit unbekanntem Layout wird nichts gezeichnet; „nur Laufband“ ohne Meldungen auch nicht', () => {
  assert.equal(zonesFor({ layout: null, tickers: [{ text: 'x' }], now: NOW }), null); assert.equal(zonesFor({ layout: { preset: 'quatsch' }, now: NOW }), null); assert.equal(zonesFor({ layout: { preset: 'ticker' }, tickers: [], now: NOW }), null, 'leere Leiste würde nur stören');
  assert.equal(zonesFor({ layout: { preset: 'ticker-clock-info', info: '   ' }, tickers: [], now: NOW }).marginRight, 0, 'leere Infozone: Video bleibt breit');
});

test('Berechnung: Leiste mit Laufband und Uhr (Berliner Zeit), Video bekommt unten Platz; mit Infozone auch rechts', () => {
  const z = zonesFor({ layout: { preset: 'ticker-clock' }, tickers: [{ text: 'Heute Familientag' }], now: NOW });
  assert.equal(z.marginBottom, Math.round(BAR_H / RES.y * 1000) / 1000); assert.equal(z.marginRight, 0); assert.equal(z.events.length, 4, 'Leiste, Streifen, Laufband, Uhr');
  const txt = z.events.map(plain); assert.ok(txt.some((t) => t === 'Heute Familientag')); assert.ok(txt.some((t) => /^10:41\nSamstag, 10\. Oktober$/.test(t)), txt.join(' | '));
  const zi = zonesFor({ layout: { preset: 'ticker-clock-info', info: 'Führung um 14:00 Uhr am Haupteingang' }, tickers: [], now: NOW });
  assert.equal(zi.marginRight, Math.round(INFO_W / RES.x * 1000) / 1000); assert.ok(zi.events.some((e) => /Führung um 14:00 Uhr/.test(plain(e))));
  const only = zonesFor({ layout: { preset: 'ticker' }, tickers: [{ text: 'Nur Text' }], now: NOW }); assert.ok(!only.events.some((e) => /^\d\d:\d\d/.test(plain(e))), 'ohne Uhr');
});

test('Laufband zeigt lange Meldungen seitenweise im Wechsel; abgelaufene und noch nicht gültige Meldungen fehlen', () => {
  const long = 'Heute ist Familientag im Museum und der Eintritt für Kinder ist frei, bitte beachten Sie auch die Garderobe im Untergeschoss und die Führungen';
  const page = (now) => plain(zonesFor({ layout: { preset: 'ticker-clock' }, tickers: [{ text: long }], now }).events.find((e) => /\\fs40/.test(e)));
  const seen = new Set([0, 1, 2, 3].map((i) => page(NOW + i * PAGE_MS))); assert.ok(seen.size >= 2, 'mehrere Seiten'); assert.ok([...seen].every((p) => p.length <= 62), 'jede Seite passt in eine Zeile neben der Uhr');
  assert.equal(page(NOW), page(NOW + PAGE_MS - 1), 'innerhalb von 6 s bleibt die Seite'); assert.notEqual(page(NOW), page(NOW + PAGE_MS));
  const tk = [{ text: 'Gültig' }, { text: 'Vorbei', validTo: '2026-10-09' }, { text: 'Kommt noch', validFrom: '2026-10-11' }, { text: 'Heute genau', validFrom: '2026-10-10', validTo: '2026-10-10' }];
  const shown = new Set([0, 1, 2, 3, 4, 5].map((i) => plain(zonesFor({ layout: { preset: 'ticker' }, tickers: tk, now: NOW + i * PAGE_MS }).events.find((e) => /\\fs40/.test(e))))); assert.deepEqual([...shown].sort(), ['Gültig', 'Heute genau']);
});

test('Sicherheit: Formatzeichen aus Meldungen können die Einblendung nicht verändern; Umbrüche und Steuerzeichen entfallen; Wörter werden gekürzt', () => {
  assert.equal(esc('a{\\p1}b\\Nc\u0000d\ne'), 'a(/p1)b/Nc d e'); assert.deepEqual(wrapLines('eins zwei drei', 9), ['eins zwei', 'drei']); assert.equal(wrapLines('x'.repeat(100), 10)[0].length, 10);
  const z = zonesFor({ layout: { preset: 'ticker' }, tickers: [{ text: '{\\fs200}{\\1c&H0000FF&}GROSS \\N Zeile' }], now: NOW }); const t = z.events.find((e) => /\\fs40/.test(e));
  assert.equal((t.match(/\{/g) || []).length, 1, 'nur unser eigener Formatblock'); assert.ok(!/\\N|\\fs200/.test(t.replace(/^\{[^}]*\}/, '')));
});

test('Wechselschlüssel: ändert sich nur bei neuer Minute oder neuer Laufbandseite (sonst wird nichts neu gesendet)', () => {
  const k = (now) => zonesFor({ layout: { preset: 'ticker-clock' }, tickers: [{ text: 'Eine Meldung' }], now }).key;
  assert.equal(k(NOW), k(NOW + 30000), 'gleiche Minute, gleiche Seite'); assert.notEqual(k(NOW), k(NOW + 60000), 'neue Minute');
});

// ---- Renderer mit falschem Steuerkanal ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkRenderer(over = {}) {
  const st = { writes: [], clock: NOW, plan: { segments: [], playlists: {}, layout: { preset: 'ticker-clock' }, tickers: [{ text: 'Hallo' }] }, health: {}, rotation: 0 };
  const net = { connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => st.writes.push(JSON.parse(String(x)).command); setImmediate(() => s.emit('connect')); return s; } };
  const fake = () => { const c = new EventEmitter(); c.pid = 1; c.kill = () => {}; return c; };
  const r = liteRenderer({ getPlan: () => st.plan, getManifest: () => ({ items: [] }), haveFile: () => false, fileOf: () => '', getHealth: () => st.health, getRotation: () => st.rotation, now: () => st.clock, net, spawnFn: fake, reconnectMs: 10, ...over });
  const overlays = () => st.writes.filter((c) => c[0] === 'osd-overlay'), props = (n) => st.writes.filter((c) => c[0] === 'set_property' && c[1] === n).map((c) => c[2]);
  return { r, st, overlays, props };
}

test('Renderer: sendet die Einblendung und die Ränder einmal, bei unverändertem Inhalt nichts neu, bei neuer Minute wieder', async () => {
  const { r, st, overlays, props } = mkRenderer(); await sleep(150);
  try {
    assert.equal(overlays().length, 1, 'beim Start einmal'); assert.deepEqual(overlays()[0].slice(0, 3), ['osd-overlay', 1, 'ass-events']); assert.equal(overlays()[0][4], RES.x); assert.equal(overlays()[0][5], RES.y); assert.deepEqual(props('video-margin-ratio-bottom'), [0.074]); assert.deepEqual(props('video-margin-ratio-right'), [0]);
    r.notify(); await sleep(30); assert.equal(overlays().length, 1, 'nichts geändert: nichts gesendet');
    st.clock += 60000; r.notify(); await sleep(30); assert.equal(overlays().length, 2, 'neue Minute: Uhr wird aktualisiert'); assert.equal(props('video-margin-ratio-bottom').length, 2);
  } finally { r.stop(); }
});

test('Renderer: Einblendung verschwindet (Löschen + Ränder zurück), wenn der Bildschirm aus ist, gedreht wird, auf einem Hinweisbild oder das Layout fehlt', async () => {
  const { r, st, overlays, props } = mkRenderer(); await sleep(150);
  try {
    const last = () => overlays().at(-1);
    st.health = { displayOff: true }; r.notify(); await sleep(30); assert.deepEqual(last().slice(0, 3), ['osd-overlay', 1, 'none'], 'Bildschirm aus'); assert.deepEqual(props('video-margin-ratio-bottom').at(-1), 0);
    st.health = {}; r.notify(); await sleep(30); assert.equal(last()[2], 'ass-events', 'wieder an');
    st.rotation = 90; r.notify(); await sleep(30); assert.equal(last()[2], 'none', 'gedreht: die Einblendung würde nicht mitgedreht'); st.rotation = 0;
    st.health = { pairing: 'waiting' }; r.notify(); await sleep(30); assert.equal(last()[2], 'none', 'Warten auf Bestätigung'); st.health = { timeSynced: false }; r.notify(); await sleep(30); assert.equal(last()[2], 'none', 'Uhrzeit wird eingestellt');
    st.health = {}; r.notify(); await sleep(30); assert.equal(last()[2], 'ass-events'); st.plan = { ...st.plan, layout: null }; r.notify(); await sleep(30); assert.equal(last()[2], 'none', 'Layout vom Hub entfernt');
  } finally { r.stop(); }
});

test('Renderer: nach einem Neustart von mpv wird die Einblendung erneut gesendet; ohne Layout wird nie gezeichnet', async () => {
  const sockets = []; const st = { writes: [] };
  const net = { connect: () => { const s = new EventEmitter(); s.destroy = () => {}; s.write = (x) => st.writes.push(JSON.parse(String(x)).command); sockets.push(s); setImmediate(() => s.emit('connect')); return s; } };
  const r = liteRenderer({ getPlan: () => ({ segments: [], playlists: {}, layout: { preset: 'ticker-clock' }, tickers: [] }), getManifest: () => ({ items: [] }), haveFile: () => false, fileOf: () => '', now: () => NOW, net, spawnFn: () => { const c = new EventEmitter(); c.pid = 1; c.kill = () => {}; return c; }, reconnectMs: 10 });
  try { await sleep(120); const n1 = st.writes.filter((c) => c[0] === 'osd-overlay').length; assert.equal(n1, 1); sockets[0].emit('close'); await sleep(150); assert.equal(st.writes.filter((c) => c[0] === 'osd-overlay').length, 2, 'neues mpv = leere Fläche: neu zeichnen'); } finally { r.stop(); }
  const none = mkRenderer({ getPlan: () => ({ segments: [], playlists: {} }) }); await sleep(120); try { assert.equal(none.overlays().length, 0, 'ohne Layout keine Einblendung'); assert.ok(!none.st.writes.some((c) => c[0] === 'set_property' && /margin/.test(c[1]) && c[2] !== 0)); } finally { none.r.stop(); }
});
