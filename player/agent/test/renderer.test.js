import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.js';

test('Wiedergabe-Art vom Hub: Wechsel auf mpv wird gespeichert und die Anzeige startet neu; gleiche Art = kein Neustart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-')); writeFileSync(join(dir, 'agent.json'), JSON.stringify({ deviceId: 'x', profile: 'standard', token: 't', hubUrl: 'https://127.0.0.1', hubSpki: 'ab' }));
  let exits = 0; const a = new Agent({ dataDir: dir, port: 0, exit: () => { exits++; } });
  assert.equal(a.rendererWanted(), 'browser'); a.applyHubSettings({ renderer: 'browser' }); await new Promise((r) => setTimeout(r, 400)); assert.equal(exits, 0);
  a.applyHubSettings({ renderer: 'mpv' }); await new Promise((r) => setTimeout(r, 400)); assert.equal(exits, 1); assert.equal(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')).renderer, 'mpv'); assert.equal(a.rendererWanted(), 'mpv');
  a.applyHubSettings({ renderer: 'mpv' }); await new Promise((r) => setTimeout(r, 400)); assert.equal(exits, 1, 'kein erneuter Neustart');
  clearInterval(a.timeTimer);
});
