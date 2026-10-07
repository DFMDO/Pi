// Chromium-Richtlinie: Alles gesperrt außer dem eigenen Rechner. Die Freigabe muss im Chromium-Format stehen
// (Schema://Host:Port – gilt für alle Pfade). Ein angehängtes "/*" ist KEIN Platzhalter und sperrt sonst die Anzeige ("Diese Seite ist blockiert").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Chromium-Richtlinie: Freigaben für 127.0.0.1:8080/8081 im gültigen Format', () => {
  const p = JSON.parse(readFileSync(new URL('../build/rootfs/etc/chromium/policies/managed/dfm.json', import.meta.url), 'utf8'));
  assert.deepEqual(p.URLBlocklist, ['*']);
  assert.deepEqual(p.URLAllowlist, ['http://127.0.0.1:8080', 'http://127.0.0.1:8081']);
  for (const u of p.URLAllowlist) assert.ok(!u.includes('*'), 'kein Platzhalter in der Freigabe');
});
