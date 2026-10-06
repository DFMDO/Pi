// Netzwächter (Player): Verliert das Gerät das WLAN, läuft die Anzeige unverändert weiter.
// Nach 10 Minuten startet der Einrichtungsmodus (Hotspot), damit man das WLAN neu eintragen kann.
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { decideNetAction } from './lib/netwatch.js';
import { createNm } from './lib/nm.js';

const nm = createNm(); let offlineSince = null;
const sh = (c, a) => new Promise((r) => execFile(c, a, () => r()));
setInterval(async () => {
  if (!existsSync('/data/config.json')) return; // noch nicht eingerichtet: dfm-setup läuft ohnehin
  const online = (await nm.wifiConnected()) || (await nm.hasLan());
  if (online) { offlineSince = null; return; }
  offlineSince ??= Date.now();
  const hasCache = existsSync('/data/agent/cache/manifest.json');
  const act = decideNetAction({ offlineMs: Date.now() - offlineSince, hasCache, helpRequested: existsSync('/run/dfm/help-requested'), setupRunning: existsSync('/run/dfm/setup-active') });
  writeFileSync('/run/dfm/net-state.json', JSON.stringify({ offlineSince, showHelpScreen: act.showHelpScreen }));
  if (act.startSetup) { writeFileSync('/run/dfm/setup-active', '1'); await sh('systemctl', ['start', 'dfm-setup.service']); }
}, 30000);
