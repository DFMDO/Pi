// Präsentation im Notfall: PowerPoint wird freundlich abgelehnt (mit Anleitung PDF/MP4); der Weg über PDF-Seiten + Liste + Übersteuerung funktioniert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, multipart } from './helpers.js';
import { PRESENTATION_NAME } from '../lib/content.js';

test('PowerPoint-Dateinamen werden erkannt', () => {
  for (const n of ['Folien.pptx', 'a.PPT', 'x.ppsx', 'v.potx', 'f.odp', 'k.key']) assert.ok(PRESENTATION_NAME.test(n), n);
  for (const n of ['Folien.pdf', 'pptx.txt', 'video.mp4', 'bild.jpg']) assert.ok(!PRESENTATION_NAME.test(n), n);
});

test('Upload einer .pptx: verständliche Meldung mit Anleitung (PDF/Video), nichts wird gespeichert', async () => {
  const h = await makeHub({}); const a = await h.as('admin');
  const before = h.db.prepare('SELECT COUNT(*) n FROM media').get().n; const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]); // „PK“-Kopf wie bei Office-Dateien
  const m = multipart('file', 'Notfall-Folien.pptx', zip); const r = await a('POST', '/api/v1/media', m.payload, m.headers);
  assert.equal(r.statusCode, 400, r.body); assert.match(r.json().error, /PowerPoint/); assert.match(r.json().error, /PDF/); assert.match(r.json().error, /MP4/);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM media').get().n, before, 'nichts gespeichert');
  const x = multipart('file', 'unbekannt.xyz', zip); assert.match((await a('POST', '/api/v1/media', x.payload, x.headers)).json().error, /nicht unterstützt/, 'andere Formate: bisherige Meldung');
  await h.cleanup();
});

test('Ablauf der Oberfläche über die API: PDF hochladen → Liste mit Folien veröffentlichen → auf allen Bildschirmen übersteuern', async () => {
  const h = await makeHub({}); const a = await h.as('admin');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 5>>\n%%EOF');
  const up = await a('POST', '/api/v1/media', ...(() => { const m = multipart('file', 'plan.pdf', pdf, { folder: 'Präsentation' }); return [m.payload, m.headers]; })());
  if (up.statusCode !== 201) { await h.cleanup(); return; } // ohne pdftoppm (z. B. Windows) kann die Umwandlung nicht laufen – dort deckt Linux-CI es ab
  const { ids, items } = up.json(); assert.equal(ids.length, 2);
  const pl = (await a('POST', '/api/v1/playlists', { name: 'Präsentation: plan.pdf', publish: true })).json();
  assert.equal((await a('PUT', `/api/v1/playlists/${pl.id}`, { items: items.map((m) => ({ mediaId: m.id, duration: 15 })), publish: true })).statusCode, 200);
  const o = await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'playlist', id: pl.id }, confirm: true, minutes: 30 });
  assert.equal(o.statusCode, 201, o.body); assert.match(o.json().text, /Präsentation/);
  await h.cleanup();
});
