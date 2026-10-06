import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkTrees } from '../build/check-image.js';
import { stage, activate } from '../hub/lib/update.js';
import { ensureCertificate } from '../hub/lib/tls.js';
import { loadOrCreateKey } from '../hub/lib/crypto.js';
import { runFirstboot } from '../setup/lib/firstboot.js';
import { createController } from '../setup/lib/controller.js';

function fakeImage() {
  const d = mkdtempSync(join(tmpdir(), 'img-')), root = join(d, 'root'), boot = join(d, 'boot'), data = join(d, 'data');
  const w = (f, c = '') => { const p = join(root, f); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); };
  mkdirSync(boot); mkdirSync(data);
  w('etc/passwd', 'root:x:0:0::/root:/bin/false\ndfm-hub:x:990:990::/nonexistent:/usr/sbin/nologin\n'); w('etc/shadow', 'root:!:19000:0:99999:7:::\ndfm-hub:!*:19000::::::\n');
  w('etc/machine-id', ''); w('etc/dfm/update-key.pub', '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc\n-----END PUBLIC KEY-----\n'); w('etc/dfm/version', '1.0.0');
  w('etc/fstab', 'PARTUUID=abcd-02 / ext4 defaults,ro,noatime 0 1\n/data/state/machine-id /etc/machine-id none bind 0 0\n/data/journal /var/log/journal none bind 0 0\n');
  w('etc/systemd/journald.conf.d/dfm.conf', '[Journal]\nSystemMaxUse=50M\n'); w('etc/NetworkManager/conf.d/dfm.conf', '[connection]\nwifi.powersave=2\n');
  for (const u of ['dfm-firstboot.service', 'dfm-mode.service']) w('etc/systemd/system/multi-user.target.wants/' + u); w('etc/systemd/system/local-fs.target.wants/dfm-data.service');
  mkdirSync(join(root, 'etc/systemd/system'), { recursive: true }); for (const u of ['ssh.service', 'getty@tty1.service']) symlinkSync('/dev/null', join(root, 'etc/systemd/system', u));
  w('opt/dfm/admin-ui/dist/index.html', '<html><script src="/assets/app.js"></script></html>'); w('opt/dfm/admin-ui/dist/assets/app.js', 'const ns="http://www.w3.org/2000/svg";fetch("/api/v1/x")');
  writeFileSync(join(boot, 'cmdline.txt'), 'console=tty3 quiet splash root=PARTUUID=abcd-02 rootfstype=ext4 ro rootwait cfg80211.ieee80211_regdom=DE\n');
  writeFileSync(join(boot, 'dfm-setup.vorlage.txt'), '# Vorlage'); writeFileSync(join(boot, 'LIES-MICH.txt'), 'hallo');
  return { root, boot, data, w };
}
const run = (t) => checkTrees({ rootfs: t.root, boot: t.boot, data: t.data });
const failed = (r) => r.filter((c) => !c.ok).map((c) => c.name);

test('Image-Prüfung: sauberes Image besteht alle Prüfungen', () => { assert.deepEqual(failed(run(fakeImage())), []); });

test('Image-Prüfung erkennt jedes Geheimnis und jede Abweichung', () => {
  const cases = [
    ['Kein Benutzer mit Passwort', (t) => t.w('etc/shadow', 'pi:$6$salt$hash:19000:0:99999:7:::\nroot:!:1::::::\n')],
    ['Kein Standardbenutzer', (t) => t.w('etc/passwd', 'pi:x:1000:1000::/home/pi:/bin/bash\n')],
    ['SSH-Hostschlüssel', (t) => t.w('etc/ssh/ssh_host_ed25519_key', 'x')],
    ['machine-id', (t) => t.w('etc/machine-id', 'abcdef0123456789abcdef0123456789\n')],
    ['privaten Schlüssel', (t) => t.w('opt/dfm/hub/oops.txt', '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----')],
    ['Konfigurationsgeheimnisse', (t) => t.w('root/.env', 'TOKEN=1')],
    ['schreibgeschützt', (t) => t.w('etc/fstab', 'PARTUUID=abcd-02 / ext4 defaults,noatime 0 1\n')],
    ['Standardbenutzer', (t) => t.w('home/pi/x', '')],
    ['externen Hosts', (t) => t.w('opt/dfm/admin-ui/dist/assets/app.js', 'import("https://cdn.jsdelivr.net/x.js")')],
    ['NetworkManager', (t) => t.w('etc/NetworkManager/system-connections/Museum.nmconnection', '[wifi-security]\npsk=geheim')],
    ['SSH ist nicht aktiviert', (t) => t.w('etc/systemd/system/multi-user.target.wants/ssh.service', '')],
  ];
  for (const [needle, mutate] of cases) { const t = fakeImage(); mutate(t); assert.ok(failed(run(t)).some((n) => n.includes(needle)), `${needle} nicht erkannt: ${JSON.stringify(failed(run(t)))}`); }
  const t1 = fakeImage(); writeFileSync(join(t1.boot, 'dfm-setup.txt'), 'wlan_passwort=x'); assert.ok(failed(run(t1)).some((n) => /Einrichtungsdatei/.test(n)));
  const t2 = fakeImage(); mkdirSync(join(t2.data, 'keys')); writeFileSync(join(t2.data, 'keys', 'master.key'), 'x'); assert.ok(failed(run(t2)).some((n) => /Datenpartition/.test(n)));
  const t3 = fakeImage(); writeFileSync(join(t3.boot, 'cmdline.txt'), 'console=serial0,115200 root=/dev/mmcblk0p2 rw init=/usr/lib/raspberrypi-sys-mods/firstboot'); assert.ok(failed(run(t3)).some((n) => /Boot-Parameter/.test(n)));
});

test('Zwei geflashte Karten: unterschiedliche Schlüssel, IDs, Hostnamen, Hotspot-Passwörter', async () => {
  const mk = async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'card-')), bootDir = mkdtempSync(join(tmpdir(), 'cardb-'));
    const fb = await runFirstboot({ dataDir, bootDir, cpuinfo: 'Serial\t\t: 10000000aabbccdd', drmDir: '/x' });
    const cert = ensureCertificate(join(dataDir, 'tls'), ['DNS:dfm-signage.local']); const master = loadOrCreateKey(join(dataDir, 'keys', 'master.key'));
    const nm = { scan: async () => [], startHotspot: async () => true };
    const ctl = createController({ nm, suffix: fb.device.suffix, writeConfig: async () => {}, hashPassword: async () => 'x', policy: () => null }); await ctl.startMode();
    return { id: fb.device.deviceId, host: fb.device.hostname, spki: cert.spki, master: master.toString('hex'), hotspot: ctl.state.password, pin: ctl.state.pin, ssid: ctl.state.ssid };
  };
  const [a, b] = [await mk(), await mk()];
  for (const k of ['id', 'host', 'spki', 'master', 'hotspot', 'ssid']) assert.notEqual(a[k], b[k], k + ' muss pro Karte verschieden sein');
});

test('Release-Werkzeuge: Schlüssel erzeugen → Update-Paket bauen → vom Hub-Code akzeptiert, Manipulation abgelehnt', { timeout: 120000 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'rel-')), key = join(d, 'key.pem'), pub = join(d, 'pub.pem');
  execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', key]); execFileSync('openssl', ['pkey', '-in', key, '-pubout', '-out', pub]);
  const out = execFileSync('bash', ['build/make-update.sh', '9.9.9'], { env: { ...process.env, DFM_SIGN_KEY: key }, encoding: 'utf8' }).trim().split('\n').pop();
  assert.ok(existsSync(out), out);
  const appDir = join(d, 'app'); const m = stage(out, appDir, readFileSync(pub, 'utf8'), '/opt/dfm');
  assert.equal(m.version, '9.9.9'); activate(appDir, '9.9.9'); assert.ok(existsSync(join(appDir, '9.9.9', 'hub', 'server.js'))); assert.ok(!existsSync(join(appDir, '9.9.9', 'hub', 'test')), 'Tests nicht im Paket');
  // falscher Schlüssel → abgelehnt
  const other = join(d, 'o.pem'), opub = join(d, 'o.pub'); execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', other]); execFileSync('openssl', ['pkey', '-in', other, '-pubout', '-out', opub]);
  assert.throws(() => stage(out, join(d, 'app2'), readFileSync(opub, 'utf8'), '/opt/dfm'), /Signatur/);
  // sign-release / verify-release für Images
  const f = join(d, 'image.img.xz'); writeFileSync(f, 'image-inhalt'); execFileSync('sha256sum', [f], { cwd: d }); writeFileSync(f + '.sha256', execFileSync('sha256sum', ['image.img.xz'], { cwd: d, encoding: 'utf8' }));
  execFileSync('bash', ['build/sign-release.sh', f], { env: { ...process.env, DFM_SIGN_KEY: key } });
  assert.match(execFileSync('bash', ['build/verify-release.sh', f, pub], { encoding: 'utf8' }), /Signatur gültig/);
  writeFileSync(f, 'manipuliert'); assert.throws(() => execFileSync('bash', ['build/verify-release.sh', f, pub], { stdio: 'pipe' }));
});
