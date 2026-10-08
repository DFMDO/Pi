// Pilot (0.2.14): Der Bildschirm zeigte dauerhaft "Die Uhrzeit wird eingestellt".
// Ursache 1: chrony las /run/dfm/chrony.d (allow / local stratum 10) nie ein → Hub ohne Internet war keine Zeitquelle.
// Ursache 2: Das Hub-Gerät wartete auf eine Zeitquelle, obwohl es selbst die Zeitquelle ist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timeSynced, MIN_EPOCH } from '../player/agent/lib/sysinfo.js';

test('Hub-Gerät (authority) gilt als zeitgestellt, sobald die Uhr nicht vor dem Bau des Images steht', async () => {
  delete process.env.DFM_FAKE_TIMESYNC;
  assert.ok(Date.now() > MIN_EPOCH, 'Testrechner hat eine plausible Uhr');
  assert.equal(await timeSynced({ authority: true }), true, 'kein chronyc nötig');
});

test('Image-Skript: chrony liest /run/dfm/chrony.d ein', () => {
  const run = readFileSync(new URL('../build/pi-gen/stage-dfm/02-system/00-run.sh', import.meta.url), 'utf8');
  assert.match(run, /confdir \/run\/dfm\/chrony\.d/);
  assert.match(run, /\/etc\/chrony\/chrony\.conf/);
  const mode = readFileSync(new URL('../build/rootfs/usr/lib/dfm/select-mode.sh', import.meta.url), 'utf8');
  assert.match(mode, /local stratum 10/); assert.match(mode, /allow 192\.168\.0\.0\/16/);
});
