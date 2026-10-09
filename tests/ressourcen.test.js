// Der Pi wird ganz genutzt: keine festen Speichergrenzen für Hub und Anzeige, die Anzeige hat bei Speichermangel Vorrang,
// komprimierter Auslagerungsspeicher (zram) ist eingerichtet, Bildumwandlung nutzt alle Kerne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const R = new URL('..', import.meta.url).pathname, unit = (n) => readFileSync(`${R}build/rootfs/etc/systemd/system/${n}`, 'utf8');
const oom = (u) => Number((/^OOMScoreAdjust=(-?\d+)/m.exec(u) ?? [])[1]);

test('Volle Leistung: keine festen Speichergrenzen, Anzeige vor Hub, zram aktiv, alle Kerne', () => {
  for (const n of ['dfm-hub.service', 'dfm-agent.service', 'dfm-kiosk@.service']) assert.doesNotMatch(unit(n), /^MemoryMax=/m, `${n} ohne feste Grenze`);
  assert.ok(oom(unit('dfm-agent.service')) < 0 && oom(unit('dfm-hub.service')) > 0, 'bei Speichermangel trifft es zuerst den Hub, nie die Anzeige');
  assert.match(unit('dfm-zram.service'), /ExecStart=\/usr\/lib\/dfm\/zram\.sh start/);
  assert.match(readFileSync(`${R}build/pi-gen/stage-dfm/02-system/00-run.sh`, 'utf8'), /systemctl enable[^\n]*\bdfm-zram\.service\b/);
  const z = readFileSync(`${R}build/rootfs/usr/lib/dfm/zram.sh`, 'utf8'); assert.match(z, /MEM_KB \/ 2/); assert.match(z, /swapon/);
  assert.match(readFileSync(`${R}hub/lib/variants.js`, 'utf8'), /sharp\.concurrency\(0\)/);
  assert.match(readFileSync(`${R}hub/lib/variants.js`, 'utf8'), /'nice', '-n', '19'/, 'Umwandlungen bleiben niedrig priorisiert');
});

test('Wiedergabe: GPU/Video-Hardware im Browser, Decoder-Speicher (CMA) für Pi 3/4, voller Prozessortakt, Decoder wird freigegeben', () => {
  const r = readFileSync(`${R}player/agent/lib/renderers.js`, 'utf8'); for (const f of ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy', '--enable-accelerated-video-decode']) assert.ok(r.includes(f), f);
  assert.match(r, /'--hwdec=auto-safe'/, 'mpv mit Hardware-Decoder');
  const c = readFileSync(`${R}build/boot/config.txt.add`, 'utf8'); assert.match(c, /\[pi3\]\ndtoverlay=cma,cma-256/); assert.match(c, /\[pi4\]\ndtoverlay=cma,cma-384/); assert.match(c, /\[all\]/);
  assert.match(readFileSync(`${R}build/rootfs/usr/lib/dfm/select-mode.sh`, 'utf8'), /performance/);
  assert.match(readFileSync(`${R}player/chromium/player.js`, 'utf8'), /removeAttribute\('src'\)/);
});
