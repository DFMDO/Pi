import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFirstboot, genSuffix, shred, serialOf, resetRequested, SETUP_TEMPLATE } from '../lib/firstboot.js';
import { parseSetupFile } from '../lib/parse.js';
import { decideNetAction } from '../lib/netwatch.js';

const mk = () => ({ dataDir: mkdtempSync(join(tmpdir(), 'fb-d-')), bootDir: mkdtempSync(join(tmpdir(), 'fb-b-')) });
const CPU = 'Hardware\t: BCM2835\nSerial\t\t: 10000000a1b2c3d4\nModel\t\t: Raspberry Pi 4';

test('Erststart: zufällige ID/Hostname pro Gerät, Geräteinfo für den PC – zwei Karten unterscheiden sich', async () => {
  const a = mk(), b = mk(), calls = [];
  const ra = await runFirstboot({ ...a, cpuinfo: CPU, exec: async (...c) => calls.push(c), drmDir: '/nichts' });
  const rb = await runFirstboot({ ...b, cpuinfo: CPU, drmDir: '/nichts' });
  assert.equal(ra.mode, 'setup'); assert.notEqual(ra.device.deviceId, rb.device.deviceId); assert.match(ra.device.hostname, /^dfm-[a-hj-km-np-z2-9]{4}$/);
  assert.deepEqual(calls[0], ['hostname', [ra.device.hostname]]);
  const info = readFileSync(join(a.bootDir, 'geraeteinfo.txt'), 'utf8'); assert.match(info, /Seriennummer: 10000000a1b2c3d4/); assert.match(info, /PIN \(Headless\): [0-9A-F]{6}/);
  const again = await runFirstboot({ ...a, cpuinfo: CPU, drmDir: '/nichts' }); assert.equal(again.device.deviceId, ra.device.deviceId, 'idempotent');
  assert.equal(new Set(Array.from({ length: 200 }, () => genSuffix())).size > 150, true);
});

test('Konfigurationsdatei: wird eingelesen und danach sicher gelöscht', async () => {
  const { dataDir, bootDir } = mk(); let applied;
  writeFileSync(join(bootDir, 'dfm-setup.txt'), 'wlan_name = Signage\nwlan_passwort = geheimgeheim\nrolle = player\ngeraetename = Shop-Screen\nhub_adresse = dfm-signage.local\neinrichtungscode = K7M4-X9RD\n');
  const r = await runFirstboot({ dataDir, bootDir, cpuinfo: CPU, drmDir: '/x', applyConfig: async (d) => { applied = d; } });
  assert.equal(r.mode, 'configured'); assert.equal(applied.wifi.password, 'geheimgeheim'); assert.equal(applied.hubAddress, 'https://dfm-signage.local');
  assert.equal(existsSync(join(bootDir, 'dfm-setup.txt')), false, 'Datei mit Passwörtern gelöscht');
});

test('Konfigurationsdatei mit Fehlern: verständliche Fehlerdatei, Einrichtungsmodus bleibt möglich', async () => {
  const { dataDir, bootDir } = mk();
  writeFileSync(join(bootDir, 'dfm-setup.txt'), 'rolle = player\nhub_adresse = evil.example.com\nunbekannt = 1\n');
  const r = await runFirstboot({ dataDir, bootDir, cpuinfo: CPU, drmDir: '/x', applyConfig: async () => assert.fail('darf nicht angewendet werden') });
  assert.equal(r.mode, 'setup'); assert.ok(r.errors.length >= 2); assert.match(readFileSync(join(bootDir, 'dfm-setup-FEHLER.txt'), 'utf8'), /Unbekannter Eintrag/);
  assert.equal(existsSync(join(bootDir, 'dfm-setup.txt')), false);
});

test('Vorlage im Image ist selbst gültig (alle Beispielwerte parsebar)', () => {
  const t = SETUP_TEMPLATE.replace('wlan_passwort = HIER-DAS-WLAN-PASSWORT', 'wlan_passwort = abcdefgh').replace('einrichtungscode = XXXX-XXXX', 'einrichtungscode = K7M4-X9RD');
  assert.deepEqual(parseSetupFile(t).errors, []);
});

test('Reset ohne Tastatur: Datei dfm-reset-wifi und 5× Strom aus/ein', () => {
  const { bootDir } = mk(), counterFile = join(mkdtempSync(join(tmpdir(), 'c-')), 'n');
  writeFileSync(join(bootDir, 'dfm-reset-wifi'), ''); assert.equal(resetRequested({ bootDir, counterFile }), 'datei'); assert.equal(existsSync(join(bootDir, 'dfm-reset-wifi')), false);
  const r = [1, 2, 3, 4, 5].map(() => resetRequested({ bootDir, counterFile })); assert.deepEqual(r.slice(0, 4), [null, null, null, null]); assert.equal(r[4], 'strom');
});

test('Netzausfall: nach 10 min Einrichtungsmodus, Technikhinweis nie über Inhalten', () => {
  assert.deepEqual(decideNetAction({ offlineMs: 5 * 60000, hasCache: true }), { startSetup: false, showHelpScreen: false, keepShowingContent: true });
  assert.equal(decideNetAction({ offlineMs: 11 * 60000, hasCache: true }).startSetup, true);
  assert.equal(decideNetAction({ offlineMs: 11 * 60000, hasCache: true }).showHelpScreen, false);
  assert.equal(decideNetAction({ offlineMs: 25 * 3600000, hasCache: true }).showHelpScreen, false, 'mit Cache nie');
  assert.equal(decideNetAction({ offlineMs: 25 * 3600000, hasCache: false }).showHelpScreen, true);
  assert.equal(decideNetAction({ offlineMs: 60000, hasCache: true, helpRequested: true }).showHelpScreen, true);
  assert.equal(serialOf(CPU), '10000000a1b2c3d4');
  const f = join(mkdtempSync(join(tmpdir(), 's-')), 'x'); writeFileSync(f, 'passwort'); shred(f); assert.equal(existsSync(f), false);
});

import { restoreHubFromBackup } from '../lib/restore.js';
import { setupBackupKey, encryptBackup, createArchive } from '../../hub/lib/backup.js';
import { openDb } from '../../hub/lib/db.js';
import { ensureCertificate } from '../../hub/lib/tls.js';
import { loadOrCreateKey } from '../../hub/lib/crypto.js';

test('Hub aus Backup per Konfigurationsdatei wiederherstellen: gleicher Fingerabdruck, falsche Passphrase abgelehnt', async () => {
  // „alter Hub“
  const old = mkdtempSync(join(tmpdir(), 'old-hub-')); const db = openDb(join(old, 'hub.db')); const cert = ensureCertificate(join(old, 'tls'), ['DNS:dfm-signage.local']); loadOrCreateKey(join(old, 'keys', 'master.key'));
  db.prepare("INSERT INTO playlists(id,name) VALUES('p','Gerettet')").run();
  const key = setupBackupKey('Meine-Backup-Passphrase'); const file = encryptBackup(createArchive(old, db), key);
  // neue SD-Karte
  const { dataDir, bootDir } = mk(); writeFileSync(join(bootDir, 'dfm-backup.dfmbak'), file);
  writeFileSync(join(bootDir, 'dfm-setup.txt'), 'rolle = hub\nbackup_datei = dfm-backup.dfmbak\nbackup_passphrase = Meine-Backup-Passphrase\n'); let applied;
  const r = await runFirstboot({ dataDir, bootDir, cpuinfo: CPU, drmDir: '/x', applyConfig: async (d) => { applied = d; restoreHubFromBackup({ bootDir, file: d.backup.file, passphrase: d.backup.passphrase, hubDataDir: join(dataDir, 'hub') }); } });
  assert.equal(r.mode, 'configured'); assert.ok(applied.backup);
  const restored = ensureCertificate(join(dataDir, 'hub', 'tls'), ['DNS:dfm-signage.local']); assert.equal(restored.spki, cert.spki, 'gleicher Hub-Schlüssel → kein Neu-Pairing');
  assert.ok(openDb(join(dataDir, 'hub', 'hub.db')).prepare("SELECT 1 FROM playlists WHERE name='Gerettet'").get());
  assert.equal(existsSync(join(bootDir, 'dfm-setup.txt')), false, 'Passphrase-Datei gelöscht');
  assert.throws(() => restoreHubFromBackup({ bootDir, file: 'dfm-backup.dfmbak', passphrase: 'falsch-falsch-falsch', hubDataDir: join(dataDir, 'x') }), /Passphrase stimmt nicht/);
  assert.throws(() => restoreHubFromBackup({ bootDir, file: 'nicht-da.dfmbak', passphrase: 'x', hubDataDir: join(dataDir, 'y') }), /liegt nicht auf der SD-Karte/);
});
