// Hub und Bildschirm in einem Gerät: Der Standby-Bildschirm zeigt die Adresse der Verwaltung (Agent liefert sie in /health).
// Dazu: Regression Netzwerkkabel – NetworkManager muss für eth0 automatisch ein Profil anlegen (Pilot: Link da, aber keine Adresse).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, ownAddresses } from '../player/agent/agent.js';

test('Agent: /health enthält die eigenen Adressen; isHub nur im Kombi-Gerät', () => {
  for (const [local, expected] of [[true, true], [false, false]]) {
    const dir = mkdtempSync(join(tmpdir(), 'ag-')); writeFileSync(join(dir, 'agent.json'), JSON.stringify({ hubUrl: 'https://127.0.0.1', local, name: 'T' }));
    const h = new Agent({ dataDir: dir, port: 0 }).health();
    assert.equal(h.isHub, expected); assert.ok(Array.isArray(h.addresses)); assert.deepEqual(h.addresses, ownAddresses());
    for (const a of h.addresses) assert.match(a, /^\d+\.\d+\.\d+\.\d+$/);
  }
});

test('Playerseite zeigt die Adresse nur im Standby des Hub-Geräts (Adresse kommt zur Laufzeit, kein https://-Platzhalter in der Oberfläche)', () => {
  const s = readFileSync(new URL('../player/chromium/player.js', import.meta.url), 'utf8');
  assert.match(s, /health\.isHub && health\.addresses\?\.length/);
  assert.match(s, /'https:\/\/' \+ a/);
});

test('NetworkManager: Netzwerkkabel bekommt automatisch ein Profil (kein no-auto-default=*)', () => {
  const c = readFileSync(new URL('../build/rootfs/etc/NetworkManager/conf.d/dfm.conf', import.meta.url), 'utf8');
  assert.ok(!/^\s*no-auto-default\s*=/m.test(c), 'no-auto-default darf nicht gesetzt sein');
  assert.match(c, /wifi\.powersave=2/, 'WLAN-Energiesparen bleibt aus (Prüfung des Images)');
});
