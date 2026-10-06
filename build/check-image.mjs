// Prüft ein gebautes Image (als eingebundene Verzeichnisse) auf die Sicherheits- und Layout-Vorgaben:
// keine Geheimnisse, kein Standardbenutzer, SSH aus, Root schreibgeschützt, Vorlage vorhanden …
// Aufruf:  node build/check-image.mjs --rootfs <dir> --boot <dir> --data <dir> [--max-gb 2.5]
import { readFileSync, existsSync, readdirSync, statSync, lstatSync, readlinkSync } from 'node:fs';
/** Auch Verweise (Symlinks) zählen, deren Ziel von außen nicht auflösbar ist (absolute Pfade im Image) */
const linkExists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
function* walk(dir, skip = () => false, depth = 0) {
  let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const p = join(dir, e.name); if (skip(p)) continue; if (e.isSymbolicLink()) continue; if (e.isDirectory()) yield* walk(p, skip, depth + 1); else yield p; }
}
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const SECRET_NAMES = /(^|\/)(id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx)|\.env|ssh_host_.*_key|hub-bootstrap\.json|agent\.json|device\.json|config\.json|dfm-setup\.(txt|json))$/;

export function checkTrees({ rootfs, boot, data, maxGb = 2.5 }) {
  const r = []; const add = (name, ok, detail = '') => r.push({ name, ok: !!ok, detail });
  const passwd = read(join(rootfs, 'etc/passwd')) ?? '', shadow = read(join(rootfs, 'etc/shadow')) ?? '';
  add('Kein Standardbenutzer „pi“', !/^pi:/m.test(passwd) && !existsSync(join(rootfs, 'home/pi')));
  const usable = shadow.split('\n').filter((l) => l && /^[^:]+:\$/.test(l)).map((l) => l.split(':')[0]);
  add('Kein Benutzer mit Passwort (kein Standardpasswort)', usable.length === 0, usable.join(', '));
  add('root ist gesperrt', /^root:[!*]/m.test(shadow) || shadow === '', (shadow.match(/^root:[^:]*/m) ?? [''])[0].slice(0, 12));
  add('Keine SSH-Hostschlüssel im Image', !(existsSync(join(rootfs, 'etc/ssh')) && readdirSync(join(rootfs, 'etc/ssh')).some((f) => /^ssh_host_/.test(f))));
  const wants = join(rootfs, 'etc/systemd/system/multi-user.target.wants');
  add('SSH ist nicht aktiviert (auch kein sshswitch/Hostschlüssel-Dienst)', !(existsSync(wants) && readdirSync(wants).some((f) => /^(ssh|regenerate_ssh)/.test(f))));
  const masked = (u) => { try { return readlinkSync(join(rootfs, 'etc/systemd/system', u)) === '/dev/null'; } catch { return false; } };
  add('SSH-Dienst ist maskiert', masked('ssh.service') || !existsSync(join(rootfs, 'usr/sbin/sshd')), 'ssh.service');
  add('Konsole auf tty1 ist abgeschaltet (kein Anmeldebildschirm)', masked('getty@tty1.service'));
  const mid = join(rootfs, 'etc/machine-id'); add('machine-id ist leer (entsteht pro Gerät)', existsSync(mid) && statSync(mid).size === 0);
  add('Keine NetworkManager-Verbindungen (WLAN-Daten) im Image', !existsSync(join(rootfs, 'etc/NetworkManager/system-connections')) || readdirSync(join(rootfs, 'etc/NetworkManager/system-connections')).length === 0);
  const leaks = [];
  for (const root of ['etc', 'opt/dfm', 'usr/lib/dfm', 'root', 'home', 'var/lib', 'usr/share/dfm']) {
    for (const f of walk(join(rootfs, root), (p) => /node_modules/.test(p) || /ca-certificates|ssl\/(certs|private)|\/usr\/share\/(doc|man)/.test(p) || /\/etc\/(ssl|pki|ca-certificates)/.test(p))) {
      try { if (statSync(f).size < 200000 && PRIVATE_KEY.test(readFileSync(f, 'latin1'))) leaks.push(relative(rootfs, f)); } catch {}
      if (SECRET_NAMES.test(f) && !/node_modules|\/etc\/(ssl|ca-certificates)|\.pub$|\/opt\/dfm\/(package|package-lock)\.json$|\/opt\/dfm\/[^/]+\/package\.json$/.test(f) && !/update-key\.pub$/.test(f)) leaks.push(relative(rootfs, f));
    }
  }
  add('Keine privaten Schlüssel oder Konfigurationsgeheimnisse im Root', leaks.length === 0, leaks.slice(0, 5).join(', '));
  const key = read(join(rootfs, 'etc/dfm/update-key.pub'));
  add('Öffentlicher Update-Schlüssel vorhanden (kein privater)', !!key && /BEGIN PUBLIC KEY/.test(key) && !/PRIVATE/.test(key));
  add('Version eingetragen', !!read(join(rootfs, 'etc/dfm/version'))?.trim());
  const fstab = read(join(rootfs, 'etc/fstab')) ?? '';
  add('Root-Dateisystem ist schreibgeschützt (fstab)', /\s\/\s+ext4\s+[^\s]*\bro\b/.test(fstab) && !/@PTUUID@/.test(fstab));
  add('Datenpartition und Bind-Mounts vorbereitet', /\/data\/state\/machine-id\s+\/etc\/machine-id/.test(fstab) && /\/data\/journal/.test(fstab));
  const cmd = read(join(boot, 'cmdline.txt')) ?? '';
  add('Boot-Parameter: ro, ruhiger Start, WLAN-Land DE, kein init=', /\bro\b/.test(cmd) && /\bquiet\b/.test(cmd) && /regdom=DE/.test(cmd) && !/\binit=/.test(cmd) && !/console=(serial|ttyAMA|ttyS)/.test(cmd) && !/@PTUUID@/.test(cmd), cmd.trim().slice(0, 80));
  add('Einrichtungsvorlage liegt auf der Boot-Partition', existsSync(join(boot, 'dfm-setup.vorlage.txt')) && existsSync(join(boot, 'LIES-MICH.txt')));
  add('Keine echte Einrichtungsdatei / SSH-Marker auf der Boot-Partition', !['dfm-setup.txt', 'dfm-setup.json', 'ssh', 'ssh.txt', 'userconf.txt', 'dfm-reset-wifi'].some((f) => existsSync(join(boot, f))));
  const bleaks = []; for (const f of walk(boot)) { try { if (PRIVATE_KEY.test(readFileSync(f, 'latin1'))) bleaks.push(relative(boot, f)); } catch {} }
  add('Keine Schlüssel auf der Boot-Partition', bleaks.length === 0, bleaks.join(', '));
  const dleaks = existsSync(data) ? [...walk(data)].map((f) => relative(data, f)).filter((f) => !/^state\/fake-hwclock$/.test(f)) : [];
  add('Datenpartition enthält keine Geheimnisse/IDs (leer)', dleaks.length === 0, dleaks.slice(0, 5).join(', '));
  const ui = join(rootfs, 'opt/dfm/admin-ui/dist'); add('Admin-Oberfläche ist fertig gebaut', existsSync(join(ui, 'index.html')));
  const ext = [];
  for (const root of [ui, join(rootfs, 'opt/dfm/setup/ui'), join(rootfs, 'opt/dfm/player/chromium')]) for (const f of walk(root)) if (/\.(js|html|css)$/.test(f)) {
    for (const m of (read(f) ?? '').matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) if (!/^(127\.0\.0\.1|localhost|10\.42\.0\.1|www\.w3\.org|dfm-signage\.local|0\.0\.0\.0)$/.test(m[1]) && !/^(\d+\.){3}\d+$/.test(m[1]) && !/(example|\.local)$/.test(m[1]) && !/^(react|reactjs|developer|bit|esbuild)\./.test(m[1])) ext.push(`${relative(rootfs, f)} → ${m[1]}`);
  }
  add('Oberflächen verweisen auf keine externen Hosts', ext.length === 0, [...new Set(ext)].slice(0, 5).join(', '));
  for (const u of ['dfm-data.service', 'dfm-firstboot.service', 'dfm-mode.service']) add(`Dienst ${u} ist aktiviert`, linkExists(join(rootfs, 'etc/systemd/system/multi-user.target.wants', u)) || linkExists(join(rootfs, 'etc/systemd/system/local-fs.target.wants', u)));
  add('Journal auf 50 MB begrenzt', /SystemMaxUse=50M/.test(read(join(rootfs, 'etc/systemd/journald.conf.d/dfm.conf')) ?? ''));
  add('WLAN-Energiesparen dauerhaft aus', /wifi\.powersave=2/.test(read(join(rootfs, 'etc/NetworkManager/conf.d/dfm.conf')) ?? ''));
  let size = 0; for (const f of walk(rootfs)) { try { size += lstatSync(f).size; } catch {} }
  add(`Root-Größe unter ${maxGb} GB`, size < maxGb * 1e9, `${(size / 1e9).toFixed(2)} GB`);
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2), g = (k) => a[a.indexOf(k) + 1];
  const res = checkTrees({ rootfs: g('--rootfs'), boot: g('--boot'), data: g('--data'), maxGb: Number(g('--max-gb') ?? 2.5) });
  for (const c of res) console.log(`${c.ok ? 'OK          ' : 'FEHLGESCHLAGEN'} ${c.name}${c.detail && !c.ok ? ' – ' + c.detail : c.detail ? ' (' + c.detail + ')' : ''}`);
  const bad = res.filter((c) => !c.ok).length; console.log(bad ? `${bad} Prüfung(en) FEHLGESCHLAGEN` : 'Alle Prüfungen bestanden.'); process.exit(bad ? 1 : 0);
}
