// Diagnosedatei auf der Boot-Partition: Dienst + Zeitgeber sind im Image, Skript ist gültig und gibt keine Geheimnisse preis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('Diagnose: Dienst, Zeitgeber und Aktivierung im Image vorhanden', () => {
  for (const f of ['usr/lib/dfm/diagnose', 'etc/systemd/system/dfm-diag.service', 'etc/systemd/system/dfm-diag.timer']) assert.ok(existsSync(new URL('../build/rootfs/' + f, import.meta.url)), f);
  assert.match(r('build/rootfs/etc/systemd/system/dfm-diag.timer'), /OnBootSec=\d+/);
  assert.match(r('build/rootfs/etc/systemd/system/dfm-diag.service'), /ExecStart=\/usr\/lib\/dfm\/diagnose/);
  assert.match(r('build/pi-gen/stage-dfm/02-system/00-run.sh'), /systemctl enable dfm-diag\.timer/);
});

test('Diagnose: schreibt nur nach /boot/firmware/dfm-diagnose.txt, filtert Geheimnisse, lässt Einrichtungs-Logs weg', () => {
  const s = r('build/rootfs/usr/lib/dfm/diagnose');
  assert.match(s, /^#!\/bin\/sh/); assert.match(s, /OUT=\/boot\/firmware\/dfm-diagnose\.txt/);
  assert.match(s, /grep -viE '[^']*pass[^']*psk[^']*token[^']*secret/, 'Filter für Passwörter/Schlüssel/Token');
  assert.ok(!/dfm-setup/.test(s), 'keine Logs des Einrichtungsdienstes');
  assert.match(s, /remount,ro \/boot\/firmware/, 'Boot-Partition wird wieder schreibgeschützt');
  assert.ok(!/cat \/data\/(hub|agent)|agent\.json|hub-bootstrap/.test(s), 'liest keine Zugangsdateien');
});
