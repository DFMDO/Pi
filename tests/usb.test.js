// USB-Stick am Hub: Regel, Einheit und Einbinde-Skript. Wichtigste Sicherheitszusagen: nur lesen, nichts ausführen, nur am Hub, nie automatisch benutzen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const P = (rel) => fileURLToPath(new URL('../' + rel, import.meta.url));
const read = (rel) => readFileSync(P(rel), 'utf8').replace(/\r\n/g, '\n');
const RULE = read('build/rootfs/etc/udev/rules.d/90-dfm-usb.rules'), UNIT = read('build/rootfs/etc/systemd/system/dfm-usb@.service'), SCRIPT = read('build/rootfs/usr/lib/dfm/usb-mount');

test('udev-Regel: nur USB-Datenträger mit Dateisystem, startet nur den Dienst (kein direktes Programm)', () => {
  const rules = RULE.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.ok(rules.length >= 1);
  for (const r of rules) {
    assert.match(r, /ACTION=="add"/); assert.match(r, /SUBSYSTEM=="block"/); assert.match(r, /ENV\{ID_BUS\}=="usb"/, 'nur USB, keine SD-Karte des Systems');
    assert.match(r, /ENV\{ID_FS_USAGE\}=="filesystem"/, 'nur Datenträger mit Dateisystem'); assert.match(r, /ENV\{SYSTEMD_WANTS\}\+="dfm-usb@%k\.service"/); assert.match(r, /TAG\+="systemd"/);
    assert.ok(!/RUN\+?=/.test(r), 'udev startet selbst nichts');
  }
});

test('Dienst-Einheit: gebunden an das Gerät (verschwindet der Stick, wird ausgehängt), ruft nur das Skript auf', () => {
  assert.match(UNIT, /^BindsTo=dev-%i\.device$/m); assert.match(UNIT, /^After=.*dev-%i\.device/m); assert.match(UNIT, /^Wants=dfm-mode\.service$/m, 'Betriebsart muss vorher feststehen');
  assert.match(UNIT, /^Type=oneshot$/m); assert.match(UNIT, /^RemainAfterExit=yes$/m);
  assert.match(UNIT, /^ExecStart=\/usr\/lib\/dfm\/usb-mount mount \/dev\/%I$/m); assert.match(UNIT, /^ExecStop=\/usr\/lib\/dfm\/usb-mount umount$/m);
  assert.ok(!/\[Install\]/.test(UNIT), 'wird nur von udev gestartet, nie beim Systemstart');
});

test('Einbinde-Skript: jede Einbindung ist nur lesend, ohne Programme, ohne Gerätedateien, ohne Sonderrechte', () => {
  const opts = [...SCRIPT.matchAll(/OPTS="([^"]+)"/g)].map((m) => m[1]); assert.ok(opts.length >= 3, 'mehrere Dateisysteme unterstützt');
  for (const o of opts) for (const must of ['ro', 'nosuid', 'nodev', 'noexec']) assert.ok(o.split(',').includes(must), `„${o}“ enthält ${must}`);
  assert.ok(opts.every((o) => !o.split(',').includes('rw')));
  assert.match(SCRIPT, /case "\$MODE" in hub\|kombi\) ;; \*\) exit 0 ;; esac/, 'nur am Hub (Bildschirme und nicht eingerichtete Geräte lesen keine Sticks ein)');
  assert.match(SCRIPT, /\[ -b "\$DEV" \] \|\| exit 1/, 'nur echte Blockgeräte');
  assert.match(SCRIPT, /MP=\$\{DFM_USB_MP:-\/media\/usb\}/); assert.ok(!/\bexec\b|\beval\b|\. "/.test(SCRIPT.replace(/#.*$/gm, '')), 'führt nichts vom Stick aus');
});

test('Einhängepunkt /media/usb: gleicher Standard im Hub, wird im Image und im lokalen Schnellbau angelegt', () => {
  assert.match(read('hub/lib/extras2.js'), /process\.env\.DFM_USB_DIR \?\? '\/media\/usb'/);
  assert.match(read('build/pi-gen/stage-dfm/02-system/00-run.sh'), /install -d "\$\{ROOTFS_DIR\}\/media\/usb"/);
  assert.match(read('tools/local-image-export.sh'), /mkdir -p "\$M\/media\/usb"/);
});

const SH = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' }); const HAVE_SH = SH.status === 0 && SH.stdout.trim() === 'ok' && process.platform !== 'win32';
test('Skript-Verhalten: Betriebsart „player“ bindet nichts ein, kein Blockgerät und falscher Aufruf werden abgelehnt', { skip: !HAVE_SH && 'keine POSIX-Shell (Windows)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfm-usb-')); const run = (args, env = {}) => spawnSync('sh', [P('build/rootfs/usr/lib/dfm/usb-mount'), ...args], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, DFM_USB_MP: join(dir, 'mp'), ...env } });
  try {
    writeFileSync(join(dir, 'mount'), `#!/bin/sh\necho "$@" >> "${join(dir, 'mount.log')}"\n`); chmodSync(join(dir, 'mount'), 0o755); // Attrappe: merkt sich Aufrufe, bindet nichts ein
    assert.equal(run(['mount', '/dev/sdb1'], { DFM_MODE: 'player' }).status, 0); assert.equal(run(['mount', '/dev/sdb1'], { DFM_MODE: 'setup' }).status, 0);
    assert.throws(() => readFileSync(join(dir, 'mount.log')), /ENOENT/, 'an Bildschirmen wird nie eingebunden');
    assert.equal(run(['mount', join(dir, 'kein-geraet')], { DFM_MODE: 'hub' }).status, 1, 'keine Blockdatei');
    assert.equal(run(['mount'], { DFM_MODE: 'hub' }).status === 0, false, 'Gerät fehlt');
    assert.equal(run(['quatsch']).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
