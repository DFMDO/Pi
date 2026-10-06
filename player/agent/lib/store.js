// Dateien atomar schreiben (Stromausfall-sicher): temp + fsync + rename.
import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeAtomic(file, data, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp'; const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file); try { chmodSync(file, mode); } catch {}
}
export const writeJson = (f, o, mode) => writeAtomic(f, JSON.stringify(o), mode);
export function readJson(f, fallback = null) { try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback; } catch { return fallback; } }
