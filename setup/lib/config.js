// Endgültige Konfiguration schreiben (atomar, 0600) – erst nach erfolgreichem WLAN-Test.
import { join } from 'node:path';
import { writeAtomic } from '../../player/agent/lib/store.js';

export async function writeFinalConfig(cfg, extra, dataDir = process.env.DFM_DATA ?? '/data') {
  if (extra.hubBootstrap) writeAtomic(join(dataDir, 'hub-bootstrap.json'), JSON.stringify(extra.hubBootstrap));
  if (extra.agent) writeAtomic(join(dataDir, 'agent', 'agent.json'), JSON.stringify(extra.agent));
  writeAtomic(join(dataDir, 'config.json'), JSON.stringify(cfg), 0o644); // zuletzt: „Einrichtung fertig“-Marker
}
