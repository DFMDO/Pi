// dfm-firstboot (Node-Teil): wird von /usr/lib/dfm/firstboot.sh nach dem Erweitern der Datenpartition gestartet.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runFirstboot } from './lib/firstboot.js';
import { createNm } from './lib/nm.js';
import { writeFinalConfig } from './lib/config.js';
import { hashPassword } from '../hub/lib/crypto.js';

const dataDir = process.env.DFM_DATA ?? '/data', bootDir = process.env.DFM_BOOT ?? '/boot/firmware';
const exec = (c, a) => new Promise((r) => execFile(c, a, () => r()));
const nm = createNm();
const applyConfig = async (d, dev) => { // Datei-Weg: gleiche Ergebnisse wie die Handy-Einrichtung
  if (d.wifi) { const r = await nm.connect(d.wifi); if (!r.ok) throw new Error('WLAN-Verbindung fehlgeschlagen'); }
  const cfg = { v: 1, role: d.role, name: d.role === 'hub' ? 'Hub' : d.name, createdAt: new Date().toISOString() }, extra = {};
  if (d.role === 'hub') extra.hubBootstrap = d.admin?.password ? { admin: { name: d.admin.name, pwHash: await hashPassword(d.admin.password) }, site: d.site } : undefined;
  else extra.agent = { hubUrl: d.hubAddress, hubSpki: d.fingerprint ? d.fingerprint.replace(/[\s:-]/g, '').toLowerCase() : null, pairing: { code: d.pairCode.replace('-', '').toUpperCase() }, name: d.name, profile: dev.hw.profile, model: dev.hw.model, hw: dev.hw };
  await writeFinalConfig(cfg, extra, dataDir);
};
const res = await runFirstboot({ dataDir, bootDir, exec, cpuinfo: readFileSync('/proc/cpuinfo', 'utf8'), applyConfig });
console.log(JSON.stringify({ mode: res.mode, errors: res.errors ?? [] }));
