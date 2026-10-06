import test from 'node:test';
import assert from 'node:assert/strict';
import { switchWifi } from '../lib/wifi-switch.js';
import { plan } from '../../player/agent/lib/privd.js';

function fakeNm({ upCode = 0, addCode = 0, old = true } = {}) {
  const calls = []; const conns = new Set(old ? ['dfm-wifi'] : []);
  const run = async (_c, a) => { calls.push(a.join(' ')); const [x, y, z] = a; let code = 0, stdout = '';
    if (x === '-t') stdout = [...conns].join('\n');
    else if (x === 'connection' && y === 'add') { if (addCode) code = 1; else conns.add(a[a.indexOf('con-name') + 1]); }
    else if (x === 'connection' && y === 'modify') { const i = a.indexOf('connection.id'); if (i > 0) { conns.delete(z); conns.add(a[i + 1]); } }
    else if (x === 'connection' && y === 'delete') conns.delete(z);
    else if (x === '--wait' && a[4] === 'dfm-wifi-new' && upCode) code = upCode;
    return { code, stdout, stderr: upCode && a[4] === 'dfm-wifi-new' ? 'Error: Secrets were required' : '' }; };
  return { run, calls, conns };
}
test('WLAN-Wechsel: erst nach erfolgreichem Test übernommen, altes WLAN wird danach entfernt', async () => {
  const f = fakeNm(); const r = await switchWifi({ run: f.run, ssid: 'Neu', password: 'passwort123', reachable: async () => true });
  assert.deepEqual(r, { ok: true }); assert.deepEqual([...f.conns], ['dfm-wifi']); assert.ok(!f.calls.some((c) => c.includes('delete dfm-wifi ') && false));
  assert.ok(f.calls.indexOf(f.calls.find((c) => c.includes('connection up dfm-wifi-new'))) < f.calls.indexOf(f.calls.find((c) => c.includes('delete dfm-wifi-old'))), 'alt wird erst nach dem Test gelöscht');
});
test('WLAN-Wechsel: falsches Passwort → Rückfall auf das alte WLAN', async () => {
  const f = fakeNm({ upCode: 4 }); const r = await switchWifi({ run: f.run, ssid: 'Neu', password: 'falsch1234', reachable: async () => true });
  assert.deepEqual(r, { ok: false, reason: 'auth' }); assert.deepEqual([...f.conns], ['dfm-wifi'], 'altes WLAN wieder aktiv'); assert.ok(f.calls.some((c) => c === '--wait 40 connection up dfm-wifi'));
});
test('WLAN-Wechsel: verbunden, aber Hub nicht erreichbar → Rückfall', async () => {
  const f = fakeNm(); let n = 0; const orig = global.setTimeout; global.setTimeout = (fn) => orig(fn, 0);
  try { const r = await switchWifi({ run: f.run, ssid: 'Neu', password: 'passwort123', reachable: async () => { n++; return false; } }); assert.deepEqual(r, { ok: false, reason: 'hub_nicht_erreichbar' }); assert.equal(n, 6); assert.deepEqual([...f.conns], ['dfm-wifi']); } finally { global.setTimeout = orig; }
});
test('WLAN-Wechsel: privd erlaubt nur geprüfte Eingaben', () => {
  assert.deepEqual(plan({ action: 'wifi-switch', args: { ssid: 'DFM', password: 'passwort123' } }).map((c) => c.slice(0, 3)), [['/usr/lib/dfm/launch', 'wifi-switch', 'DFM']]);
  assert.throws(() => plan({ action: 'wifi-switch', args: { ssid: 'x'.repeat(40), password: 'passwort123' } })); assert.throws(() => plan({ action: 'wifi-switch', args: { ssid: 'DFM', password: 'kurz' } }));
});
