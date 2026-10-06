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
