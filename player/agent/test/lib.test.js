import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { syncMedia, inSyncWindow } from '../lib/sync.js';
import { plan, processDir, request as privReq, ACTIONS } from '../lib/privd.js';
import { parseAvahi, hubCandidates } from '../lib/discovery.js';
import { detectHardware, parseMeminfo, parseSignal } from '../lib/sysinfo.js';
import { backoff } from '../agent.js';
import { localToEpoch } from '../../../shared/time.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'ag-'));

test('Sync: lädt, prüft SHA-256, Delta beim zweiten Lauf, räumt Altes auf', async () => {
  const dir = tmp(), a = Buffer.alloc(5000, 1), b = Buffer.alloc(3000, 2);
  const files = { '/m/a': a, '/m/b': b }; let calls = 0;
  const fetchRange = async (url, start) => { calls++; return { status: start ? 206 : 200, stream: Readable.from([files[url].subarray(start)]) }; };
  const items = [{ id: 'a', url: '/m/a', sha256: sha(a), size: a.length }, { id: 'b', url: '/m/b', sha256: sha(b), size: b.length }];
  writeFileSync(join(dir, 'alt'), 'x'); // nicht mehr im Manifest
  const s = await syncMedia({ manifest: { items }, dir, fetchRange });
  assert.equal(s.done, 2); assert.deepEqual(readFileSync(join(dir, 'a')), a); assert.ok(!existsSync(join(dir, 'alt')), 'Altes entfernt');
  calls = 0; await syncMedia({ manifest: { items }, dir, fetchRange }); assert.equal(calls, 0, 'Delta: nichts erneut laden');
});

test('Sync: fortsetzbar (Range), Prüfsummenfehler wird verworfen, maximal 2 parallel', async () => {
  const dir = tmp(), a = Buffer.from(Array.from({ length: 10000 }, (_, i) => i % 251));
  writeFileSync(join(dir, 'a.part'), a.subarray(0, 4000)); const seen = [];
  const r = await syncMedia({ manifest: { items: [{ id: 'a', url: '/a', sha256: sha(a), size: a.length }] }, dir, fetchRange: async (u, s) => { seen.push(s); return { status: 206, stream: Readable.from([a.subarray(s)]) }; } });
  assert.deepEqual(seen, [4000]); assert.equal(r.done, 1);
  const dir2 = tmp(); const bad = await syncMedia({ manifest: { items: [{ id: 'x', url: '/x', sha256: sha(a), size: 4 }] }, dir: dir2, fetchRange: async () => ({ status: 200, stream: Readable.from([Buffer.from('boes')]) }) });
  assert.equal(bad.failed.length, 1); assert.ok(!existsSync(join(dir2, 'x')) && !existsSync(join(dir2, 'x.part')));
  let active = 0, peak = 0; const items = Array.from({ length: 6 }, (_, i) => { const d = Buffer.from('d' + i); return { id: 'i' + i, url: '/' + i, d, sha256: sha(d), size: d.length }; });
  await syncMedia({ manifest: { items }, dir: tmp(), fetchRange: async (u) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return { status: 200, stream: Readable.from([items[+u.slice(1)].d]) }; } });
  assert.ok(peak <= 2, 'Spitze ' + peak);
});

test('Sync-Zeitfenster', async () => {
  assert.equal(inSyncWindow('22:00-06:00', localToEpoch('2026-10-06', '23:30')), true);
  assert.equal(inSyncWindow('22:00-06:00', localToEpoch('2026-10-06', '12:00')), false);
  assert.equal(inSyncWindow('08:00-10:00', localToEpoch('2026-10-06', '09:00')), true);
  assert.equal(inSyncWindow('', Date.now()), true);
  const dir = tmp(), d = Buffer.from('x'); let calls = 0;
  const s = await syncMedia({ manifest: { items: [{ id: 'a', url: '/a', sha256: sha(d), size: 1 }] }, dir, window: '03:00-04:00', now: () => localToEpoch('2026-10-06', '12:00'), fetchRange: async () => { calls++; return { status: 200, stream: Readable.from([d]) }; } });
  assert.equal(s.skippedWindow, true); assert.equal(calls, 0);
});

test('privd: nur erlaubte Aktionen, Argumente streng geprüft, keine Shell', async () => {
  assert.throws(() => plan({ action: 'rm', args: {} }), /nicht erlaubt/);
  assert.throws(() => plan({ action: 'wifi-switch', args: { ssid: 'x'.repeat(33), password: '12345678' } }));
  assert.throws(() => plan({ action: 'wifi-switch', args: { ssid: 'ok', password: 'kurz' } }));
  assert.throws(() => plan({ action: 'display-rotate', args: { degrees: 45 } }));
  const inj = '"; reboot; echo "';
  const cmds = plan({ action: 'wifi-switch', args: { ssid: inj, password: 'abcdefgh' } }); const [cmd, ...args] = cmds[0];
  assert.equal(cmd, '/usr/lib/dfm/launch'); assert.ok(args.includes(inj), 'SSID bleibt EIN Argument'); assert.equal(args.filter((a) => a === inj).length, 1);
  const dir = tmp(), ran = []; privReq(dir, 'reboot'); privReq(dir, 'hack'); writeFileSync(join(dir, 'x.req'), '{kaputt');
  await processDir(dir, async (c, a) => ran.push([c, ...a]), () => {});
  assert.deepEqual(ran, [['systemctl', 'reboot']]); assert.equal(readdirSync(dir).filter((f) => f.endsWith('.req')).length, 0);
  assert.ok(Object.keys(ACTIONS).length <= 8);
});

test('Hub-Erkennung: Reihenfolge und mDNS-Ausgabe', async () => {
  const out = '+;wlan0;IPv4;dfm;_dfm-signage._tcp;local\n=;wlan0;IPv4;dfm-signage;_dfm-signage._tcp;local;dfm-signage.local;192.168.1.50;443;"x"\n=;wlan0;IPv6;dfm;_dfm-signage._tcp;local;h;fe80::1;443';
  assert.deepEqual(parseAvahi(out), [{ name: 'dfm-signage', host: 'dfm-signage.local', ip: '192.168.1.50', port: 443 }]);
  const c = await hubCandidates({ hubUrl: 'https://dfm-signage.local', lastIp: '10.0.0.9', browse: async () => [{ ip: '192.168.1.77', port: 443 }], lookup: async () => ({ address: '192.168.1.50' }) });
  assert.deepEqual(c, ['https://dfm-signage.local', 'https://192.168.1.50', 'https://10.0.0.9', 'https://192.168.1.77']);
});

test('Hardware-Erkennung und Profilvorschlag', () => {
  const p = (m, ram) => detectHardware(m, ram, 'arm64').profile;
  assert.equal(p('Raspberry Pi Zero 2 W Rev 1.0', 416), 'lite');
  assert.equal(p('Raspberry Pi 3 Model B Plus Rev 1.3', 906), 'standard');
  assert.equal(p('Raspberry Pi 3 Model B Rev 1.2', 906), 'standard');
  assert.equal(p('Raspberry Pi 4 Model B Rev 1.5', 3800), 'pro');
  assert.equal(p('Raspberry Pi 5 Model B Rev 1.0', 8000), 'pro');
  assert.equal(p('Raspberry Pi 400 Rev 1.0', 3800), 'pro');
  assert.deepEqual(parseMeminfo('MemTotal: 1024000 kB\nMemAvailable: 512000 kB'), { ramTotalMB: 1000, ramUsedMB: 500 });
  assert.equal(parseSignal('signal: -57 dBm'), -57);
});

test('Wiederverbindung: Backoff 1 s bis 60 s mit Jitter', () => {
  assert.ok(backoff(0, () => 0.5) === 1000); assert.ok(backoff(3, () => 0.5) === 8000); assert.ok(backoff(20, () => 0.5) === 60000);
  assert.ok(backoff(0, () => 0) >= 750 && backoff(0, () => 1) <= 1250);
});
