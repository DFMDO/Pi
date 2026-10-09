// Hub-Ersatz-Assistent: Vorsorge-Übersicht (Backup vorhanden und aktuell? Auf einen anderen Rechner geladen? Was liegt NICHT im Backup?).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeHub } from './helpers.js';

test('Vorsorge-Übersicht: ohne Einrichtung leer; nach Backup mit Alter; Download am PC wird gemerkt; Medien zählen als „nicht im Backup“', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const o0 = (await a('GET', '/api/v1/backup/overview')).json(); assert.equal(o0.configured, false); assert.equal(o0.last, null); assert.equal(o0.lastDownload, null); assert.equal(o0.count, 0); assert.equal(o0.users, 3); const demo = o0.media.count; assert.equal(o0.media.bytes, 0, 'ein frischer Hub hat nur die winzigen Demo-Folien');
  const m = (await a('POST', '/api/v1/media/text', { name: 'A', title: 'A' })).json().id; h.db.prepare('UPDATE media SET size=2048 WHERE id=?').run(m);
  assert.equal((await a('POST', '/api/v1/backup/setup', { passphrase: 'Meine-Backup-Passphrase-1' })).statusCode, 200);
  h.app.runBackup(''); const files = readdirSync(join(h.dataDir, 'backups')); assert.ok(files.some((f) => f.startsWith('daily-')));
  const o1 = (await a('GET', '/api/v1/backup/overview')).json(); assert.equal(o1.configured, true); assert.ok(o1.count >= 2, 'täglich + wöchentlich'); assert.match(o1.last.name, /\.dfmbak$/); assert.ok(o1.last.size > 100); assert.ok(Math.abs(o1.last.ts - Date.now()) < 60000, 'Zeitstempel der Datei'); assert.equal(o1.lastDownload, null, 'noch nie auf einen anderen Rechner geladen');
  assert.deepEqual(o1.media, { count: demo + 1, bytes: 2048 });
  h.clock.t += 5000; const dl = await a('POST', '/api/v1/backup/run'); assert.equal(dl.statusCode, 200); assert.ok(dl.rawPayload.length > 100);
  const o2 = (await a('GET', '/api/v1/backup/overview')).json(); assert.ok(o2.lastDownload > 0, 'Download vermerkt (aus dem Protokoll)'); assert.equal(o2.devices, 0);
  assert.equal((await (await h.as('edi'))('GET', '/api/v1/backup/overview')).statusCode, 403, 'nur Admins'); assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/backup/overview' })).statusCode, 401);
  await h.cleanup();
});
