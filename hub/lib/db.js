// SQLite im WAL-Modus, nummerierte Migrationen (PRAGMA user_version).
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  let v = db.pragma('user_version', { simple: true });
  for (const f of files) {
    const n = parseInt(f, 10);
    if (n <= v) continue;
    db.transaction(() => { db.exec(readFileSync(join(MIG, f), 'utf8')); db.pragma(`user_version = ${n}`); })();
    v = n;
  }
  return db;
}
