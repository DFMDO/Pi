// Endgültige Konfiguration schreiben (atomar, 0600) – erst nach erfolgreichem WLAN-Test.
// Die Dateien landen dort, wo der jeweilige Dienst sie liest, und gehören dessen Benutzer (Hub 990, Player-Agent 991):
// Einrichtung und Erststart laufen als root, Hub und Agent bewusst NICHT.
import { join } from 'node:path';
import { mkdirSync, chownSync } from 'node:fs';
import { writeAtomic } from '../../player/agent/lib/store.js';

export const HUB_UID = 990, AGENT_UID = 991;
export async function writeFinalConfig(cfg, extra, dataDir = process.env.DFM_DATA ?? '/data', { chown = process.getuid?.() === 0 ? chownSync : () => {} } = {}) {
  const put = (dir, name, content, uid) => { mkdirSync(join(dataDir, dir), { recursive: true }); const f = join(dataDir, dir, name); writeAtomic(f, content); try { chown(join(dataDir, dir), uid, uid); chown(f, uid, uid); } catch {} };
  if (extra.hubBootstrap) put('hub', 'hub-bootstrap.json', JSON.stringify(extra.hubBootstrap), HUB_UID);
  if (extra.localPlayer) put('hub', 'local-player.json', JSON.stringify(extra.localPlayer), HUB_UID); // Hub+Bildschirm: der Hub legt den eigenen Bildschirm beim Start an
  if (extra.agent) put('agent', 'agent.json', JSON.stringify(extra.agent), AGENT_UID);
  writeAtomic(join(dataDir, 'config.json'), JSON.stringify(cfg), 0o644); // zuletzt: „Einrichtung fertig“-Marker
}
