// Regression aus dem Pilot (Diagnose von 0.2.4): Der Hub stürzte beim Start ab, weil dfm-hub.service den Adressfamilien-Zugriff AF_NETLINK sperrte
// (os.networkInterfaces() → "Unknown system error 97"). Gleiches Risiko für Cage/Chromium unter dem Agent (udev/libinput nutzen Netlink).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = (n) => readFileSync(new URL(`../build/rootfs/etc/systemd/system/${n}`, import.meta.url), 'utf8');

test('Dienste, die Netzwerkadressen lesen oder die Anzeige starten, dürfen Netlink nutzen', () => {
  for (const n of ['dfm-hub.service', 'dfm-agent.service', 'dfm-setup.service']) {
    const m = /^RestrictAddressFamilies=(.*)$/m.exec(unit(n));
    assert.ok(m, `${n} hat eine Adressfamilien-Beschränkung`);
    assert.match(m[1], /\bAF_NETLINK\b/, `${n} erlaubt AF_NETLINK`);
    for (const f of ['AF_UNIX', 'AF_INET', 'AF_INET6']) assert.match(m[1], new RegExp(`\\b${f}\\b`), `${n} erlaubt ${f}`);
  }
});

test('Hub startet auch, wenn die Netzwerkabfrage fehlschlägt', () => {
  const s = readFileSync(new URL('../hub/server.js', import.meta.url), 'utf8');
  assert.match(s, /try \{ ifaces = networkInterfaces\(\); \} catch/);
});
