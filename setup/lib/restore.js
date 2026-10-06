// Hub aus einem verschlüsselten Backup wiederherstellen (ohne Konsole: über dfm-setup.txt).
// Schlüssel und Datenbank kommen aus dem Backup – dadurch bleiben Fingerabdruck und Geräte-Verbindungen gültig.
import { readFileSync, existsSync, mkdirSync, chownSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { decryptBackup, restoreArchive } from '../../hub/lib/backup.js';

const chownR = (p, uid, gid) => { try { chownSync(p, uid, gid); } catch {} if (statSync(p).isDirectory()) for (const f of readdirSync(p)) chownR(join(p, f), uid, gid); };
/** @returns {object} Konfiguration aus dem Backup (Rolle bleibt hub) */
export function restoreHubFromBackup({ bootDir, file, passphrase, hubDataDir, uid = 990 }) {
  const f = join(bootDir, basename(file));
  if (!existsSync(f)) throw new Error(`Die Backup-Datei ${basename(file)} liegt nicht auf der SD-Karte.`);
  const tar = decryptBackup(readFileSync(f), passphrase);       // wirft „Die Passphrase stimmt nicht.“
  mkdirSync(hubDataDir, { recursive: true }); const cfg = restoreArchive(tar, hubDataDir);
  if (process.getuid?.() === 0) chownR(hubDataDir, uid, uid);
  return cfg;
}
