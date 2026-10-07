// Chromium-Richtlinie: Alles gesperrt außer dem eigenen Rechner. Gemessen mit echtem Chromium 141 (build/check-policy-chromium.sh, Workflow "Richtlinie prüfen"):
// - Ein Platzhalter "/*" am Ende der Freigabe sperrt die Anzeige ("Diese Seite ist blockiert").
// - URLBlocklist "*" hebelt jede Freigabe aus; mit Schema-Platzhaltern ("http://*") greift die Freigabe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Chromium-Richtlinie: Schemata gesperrt, nur 127.0.0.1:8080/8081 freigegeben (im gültigen Format)', () => {
  const p = JSON.parse(readFileSync(new URL('../build/rootfs/etc/chromium/policies/managed/dfm.json', import.meta.url), 'utf8'));
  assert.ok(!p.URLBlocklist.includes('*'), 'kein "*" in der Sperrliste (hebelt die Freigabe aus)');
  for (const s of ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*', 'file://*']) assert.ok(p.URLBlocklist.includes(s), s + ' gesperrt');
  assert.deepEqual(p.URLAllowlist, ['http://127.0.0.1:8080', 'http://127.0.0.1:8081']);
  for (const u of p.URLAllowlist) assert.ok(!u.includes('*'), 'kein Platzhalter in der Freigabe');
});
