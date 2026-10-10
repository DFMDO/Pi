// SQLite im WAL-Modus, nummerierte Migrationen (PRAGMA user_version).
// Stabilität: Wartezeit bei kurzen Sperren, begrenzte WAL-Datei, Prüfung beim Start (Ergebnis in db.integrity, der Hub zeigt bei Fehlern eine Warnung)
// und eine Kopie der Datenbank VOR jeder Migration (hub.db.vor-v<alte Version>), damit ein misslungenes Update nie Daten kostet.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';

const MIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const QUICK_CHECK_MAX_BYTES = 400 * 1024 * 1024; // größere Dateien nicht beim Start prüfen (Start soll auf dem Pi schnell bleiben)
const KEEP_COPIES = 2;

/** Kopie vor einer Migration anlegen und ältere Kopien aufräumen. Fehler dabei dürfen den Start nicht verhindern. */
function copyBeforeMigration(db, file, version, log) {
  try {
    const dst = `${file}.vor-v${version}`; if (existsSync(dst)) unlinkSync(dst);
    db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    const dir = dirname(file), prefix = `${basename(file)}.vor-v`;
    const old = readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP_COPIES);
    for (const o of old) unlinkSync(join(dir, o.f));
  } catch (e) { log('Kopie vor der Migration nicht möglich:', e.message); }
}

export function openDb(file, { log = () => {} } = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');                      // kurze Sperren (z. B. Sicherung) abwarten statt sofort zu scheitern
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma(`journal_size_limit = ${64 * 1024 * 1024}`); // die WAL-Datei wächst nie unbegrenzt
  let integrity = 'ok';
  try { if (statSync(file).size < QUICK_CHECK_MAX_BYTES) { const r = db.pragma('quick_check', { simple: true }); if (r !== 'ok') integrity = String(r).slice(0, 300); } } catch (e) { integrity = `Prüfung nicht möglich: ${e.message}`.slice(0, 300); }
  if (integrity !== 'ok') log('Datenbank-Prüfung meldet:', integrity);
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  let v = db.pragma('user_version', { simple: true });
  if (v > 0 && integrity === 'ok' && files.some((f) => parseInt(f, 10) > v)) copyBeforeMigration(db, file, v, log);
  for (const f of files) {
    const n = parseInt(f, 10);
    if (n <= v) continue;
    db.transaction(() => { db.exec(readFileSync(join(MIG, f), 'utf8')); db.pragma(`user_version = ${n}`); })();
    v = n;
  }
  db.integrity = integrity;
  return db;
}
