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

// Regression aus dem Pilot (Diagnose von 0.2.5): Die Einrichtung (root, ohne CAP_CHOWN) legte /data/hub/tls als root an → Hub: "Can't open hub.key for writing".
test('Einrichtung darf Dateien übereignen; beim Start gehört /data/hub/tls dem Hub', () => {
  assert.match(unit('dfm-setup.service'), /^CapabilityBoundingSet=.*\bCAP_CHOWN\b/m);
  assert.match(unit('dfm-setup.service'), /^AmbientCapabilities=.*\bCAP_CHOWN\b/m);
  const dm = readFileSync(new URL('../build/rootfs/usr/lib/dfm/datamount.sh', import.meta.url), 'utf8');
  assert.match(dm, /chown -R 990:990 \/data\/hub\/tls/);
});

// Regression aus dem Pilot (Diagnose von 0.2.6): "Fontconfig error: No writable cache directories" bei jedem Textbild (HOME=/nonexistent).
test('Hub hat ein beschreibbares Cache-Verzeichnis für Schriften', () => {
  assert.match(unit('dfm-hub.service'), /XDG_CACHE_HOME=\/data\/hub\/cache/);
  assert.match(unit('dfm-hub.service'), /^ReadWritePaths=.*\/data\/hub\b/m);
});

test('Hub startet auch, wenn die Netzwerkabfrage fehlschlägt', () => {
  const s = readFileSync(new URL('../hub/server.js', import.meta.url), 'utf8');
  assert.match(s, /try \{ ifaces = networkInterfaces\(\); \} catch/);
});

// Pilot (0.2.6): Pi 3 mit 1 GB lief beim Start mit 12 MB frei und Last > 5 (Text-Bilder, Chromium, Hub gleichzeitig).
test('Bildverarbeitung begrenzt ihre Threads auf Geräten mit wenig Arbeitsspeicher', () => {
  const s = readFileSync(new URL('../hub/lib/variants.js', import.meta.url), 'utf8');
  assert.match(s, /SMALL_RAM = totalmem\(\) < 1\.5 \* 1024 \*\* 3/);
  assert.match(s, /sharp\.concurrency\(SMALL_RAM \? 2 : 0\)/);
});

// Pilot (0.2.6, Kernel-Log): "Out of memory: Killed process (ffmpeg) … anon-rss:284676kB" beim Testvideo der Diagnose (x264 "medium", alle Threads).
test('Alle ffmpeg-Aufrufe zum Umrechnen nutzen Preset veryfast und begrenzte Threads', () => {
  const s = readFileSync(new URL('../hub/lib/variants.js', import.meta.url), 'utf8');
  const enc = s.split('\n').filter((l) => l.includes("'libx264'") || (l.includes("'-preset'") && l.includes('veryfast')));
  assert.ok(enc.length >= 2);
  assert.equal((s.match(/'libx264'/g) ?? []).length, (s.match(/'-preset', 'veryfast', '-threads', FF_THREADS|'-c:v', 'libx264', '-preset', 'veryfast', '-threads', FF_THREADS/g) ?? []).length, 'jeder libx264-Aufruf hat veryfast + FF_THREADS');
});
