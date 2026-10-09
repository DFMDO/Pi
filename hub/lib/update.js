// Signierte Updates einspielen, mit Rollback. Nur Pakete mit gültiger
// Ed25519-Signatur werden installiert; Updates kommen nie aus dem Internet.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, symlinkSync, renameSync, writeFileSync, readdirSync, lstatSync, unlinkSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyPackage } from '../../shared/update.js';

export function readPackage(file) {
  const tmp = mkdtempSync(join(tmpdir(), 'dfm-up-'));
  try {
    const names = execFileSync('tar', ['-tf', file]).toString().split(/\r?\n/).filter(Boolean); // \r?: auch das tar von Windows liefert Zeilen mit \r\n
    const ok = new Set(['manifest.json', 'manifest.sig', 'payload.tar']);
    if (names.length !== 3 || names.some((n) => !ok.has(n))) throw new Error('Das ist kein gültiges Update-Paket.');
    execFileSync('tar', ['-C', tmp, '--no-same-owner', '-xf', file]);
    return { manifestBytes: readFileSync(join(tmp, 'manifest.json')), sigBytes: readFileSync(join(tmp, 'manifest.sig')), payload: readFileSync(join(tmp, 'payload.tar')) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Prüft Signatur und legt die neue Version unter <appDir>/<version> ab (noch nicht aktiv). */
export function stage(file, appDir, pubKeyPem, baseDir) {
  const pkg = readPackage(file), manifest = verifyPackage(pkg, pubKeyPem);
  const names = execFileSync('tar', ['-tf', '-'], { input: pkg.payload }).toString().split(/\r?\n/).filter(Boolean);
  if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw new Error('Das Update enthält ungültige Pfade.');
  mkdirSync(appDir, { recursive: true });
  const dir = join(appDir, manifest.version), tmp = dir + '.tmp';
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
  execFileSync('tar', ['-C', tmp, '--no-same-owner', '-xf', '-'], { input: pkg.payload });
  if (baseDir && !existsSync(join(tmp, 'node_modules'))) symlinkSync(join(baseDir, 'node_modules'), join(tmp, 'node_modules'));
  rmSync(dir, { recursive: true, force: true }); renameSync(tmp, dir);
  return manifest;
}

const link = (appDir, name) => join(appDir, name);
const target = (p) => { try { return readlinkSync(p); } catch { return null; } };
function setLink(p, to) { const t = p + '.new'; try { unlinkSync(t); } catch {} symlinkSync(to, t); renameSync(t, p); }

/** Neue Version aktivieren; die alte bleibt für den Rollback erhalten. */
export function activate(appDir, version) {
  const cur = target(link(appDir, 'current'));
  if (cur) setLink(link(appDir, 'previous'), cur);
  setLink(link(appDir, 'current'), version);
  writeFileSync(join(appDir, 'boot-count'), '0');
}
export function rollback(appDir) {
  const prev = target(link(appDir, 'previous'));
  if (!prev) return false;
  setLink(link(appDir, 'current'), prev); writeFileSync(join(appDir, 'boot-count'), '0'); return true;
}
/**
 * Beim Start aufrufen: zählt Fehlstarts. Wurde ein Update dreimal hintereinander
 * nicht als „gesund“ bestätigt, wird automatisch zurückgerollt.
 */
export function bootGuard(appDir) {
  if (!existsSync(join(appDir, 'current'))) return 'none';
  const f = join(appDir, 'boot-count'); const n = (existsSync(f) ? parseInt(readFileSync(f, 'utf8'), 10) : 0) + 1;
  if (n > 3) return rollback(appDir) ? 'rolled-back' : 'no-previous';
  writeFileSync(f, String(n)); return 'ok';
}
export const markHealthy = (appDir) => { if (existsSync(appDir)) writeFileSync(join(appDir, 'boot-count'), '0'); };
