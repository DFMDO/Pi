// Verschlüsselte Backups ohne gespeicherte Passphrase.
// Beim Einrichten leitet die Passphrase (scrypt) einen Schlüssel ab, der ein
// X25519-Schlüsselpaar schützt. Nur der öffentliche Teil liegt auf dem Gerät –
// so kann der Hub täglich Backups schreiben, ohne die Passphrase zu kennen.
// Wiederherstellen geht nur mit der Passphrase (Format: AES-256-GCM, ECIES).
import { generateKeyPairSync, createPrivateKey, createPublicKey, diffieHellman, randomBytes, scryptSync,
  createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MAGIC = Buffer.from('DFMB1');
const aes = (key, iv, data) => { const c = createCipheriv('aes-256-gcm', key, iv); const e = Buffer.concat([c.update(data), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]); };
const unaes = (key, b) => { const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]); };
const kdf = (pass, salt) => scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

/** Erzeugt Schlüsselpaar; gibt öffentlichen Schlüssel + passwortgeschützten privaten zurück. */
export function setupBackupKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Die Backup-Passphrase muss mindestens 12 Zeichen lang sein.');
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const salt = randomBytes(16);
  const wrapped = Buffer.concat([salt, aes(kdf(passphrase, salt), randomBytes(12), privateKey.export({ type: 'pkcs8', format: 'der' }))]);
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), wrappedPrivate: wrapped.toString('base64') };
}

const hk = (shared) => Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'dfm-backup-v1', 32));

export function encryptBackup(plain, { publicKeyPem, wrappedPrivate }) {
  const eph = generateKeyPairSync('x25519');
  const key = hk(diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey(publicKeyPem) }));
  const ephRaw = eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const wp = Buffer.from(wrappedPrivate, 'base64'), len = Buffer.alloc(2); len.writeUInt16BE(wp.length);
  return Buffer.concat([MAGIC, ephRaw, len, wp, aes(key, randomBytes(12), plain)]);
}

export function decryptBackup(buf, passphrase) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('Das ist keine DFM-Backup-Datei.');
  const eph = buf.subarray(5, 37), wl = buf.readUInt16BE(37), wp = buf.subarray(39, 39 + wl), body = buf.subarray(39 + wl);
  let priv;
  try { priv = unaes(kdf(passphrase, wp.subarray(0, 16)), wp.subarray(16)); } catch { throw new Error('Die Passphrase stimmt nicht.'); }
  const ephPub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), eph]), format: 'der', type: 'spki' });
  return unaes(hk(diffieHellman({ privateKey: createPrivateKey({ key: priv, format: 'der', type: 'pkcs8' }), publicKey: ephPub })), body);
}

/** Inhalt: Datenbank-Schnappschuss, Schlüssel, Zertifikat, Konfiguration (ohne Medien). */
export function createArchive(dataDir, db) {
  const st = mkdtempSync(join(tmpdir(), 'dfm-bk-'));
  try {
    mkdirSync(join(st, 'keys')); mkdirSync(join(st, 'tls'));
    db.exec(`VACUUM INTO '${join(st, 'hub.db').replace(/'/g, "''")}'`); // konsistenter Schnappschuss
    for (const f of ['keys/master.key', 'keys/backup.json', 'config.json']) if (existsSync(join(dataDir, f))) cpSync(join(dataDir, f), join(st, f));
    for (const f of ['hub.key', 'hub.crt']) if (existsSync(join(dataDir, 'tls', f))) cpSync(join(dataDir, 'tls', f), join(st, 'tls', f));
    return execFileSync('tar', ['-C', st, '-cf', '-', '.'], { maxBuffer: 1 << 30 });
  } finally { rmSync(st, { recursive: true, force: true }); }
}

/** Stellt ein Backup in ein (leeres) Datenverzeichnis zurück – inkl. Schlüssel, daher kein Neu-Pairing. */
export function restoreArchive(tarBuf, dataDir) {
  const st = mkdtempSync(join(tmpdir(), 'dfm-rs-'));
  try {
    const list = execFileSync('tar', ['-tf', '-'], { input: tarBuf }).toString().split('\n').filter(Boolean);
    if (list.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw new Error('Das Backup enthält ungültige Pfade.');
    execFileSync('tar', ['-C', st, '--no-same-owner', '-xf', '-'], { input: tarBuf });
    mkdirSync(join(dataDir, 'keys'), { recursive: true, mode: 0o700 }); mkdirSync(join(dataDir, 'tls'), { recursive: true, mode: 0o700 });
    copyFileSync(join(st, 'hub.db'), join(dataDir, 'hub.db'));
    for (const f of ['keys/master.key', 'keys/backup.json', 'config.json', 'tls/hub.key', 'tls/hub.crt']) if (existsSync(join(st, f))) { copyFileSync(join(st, f), join(dataDir, f)); }
    for (const f of ['keys/master.key', 'tls/hub.key']) if (existsSync(join(dataDir, f))) execFileSync('chmod', ['600', join(dataDir, f)]);
    return existsSync(join(st, 'config.json')) ? JSON.parse(readFileSync(join(st, 'config.json'), 'utf8')) : {};
  } finally { rmSync(st, { recursive: true, force: true }); }
}

// ---- Zeitgesteuert: täglich 7 / wöchentlich 4 behalten ----
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = t.getUTCFullYear(); return `${y}-W${String(Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)).padStart(2, '0')}`; };
export function runScheduledBackup({ dataDir, db, keyInfo, extraDir, now = new Date() }) {
  if (!keyInfo) return { skipped: 'Kein Backup-Schlüssel eingerichtet.' };
  const dir = join(dataDir, 'backups'); mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10), week = isoWeek(now);
  const out = [];
  const dailyF = join(dir, `daily-${day}.dfmbak`);
  if (!existsSync(dailyF)) { writeFileSync(dailyF, encryptBackup(createArchive(dataDir, db), keyInfo)); out.push(dailyF); }
  const weeklyF = join(dir, `weekly-${week}.dfmbak`);
  if (!existsSync(weeklyF)) { copyFileSync(dailyF, weeklyF); out.push(weeklyF); }
  for (const [pre, keep] of [['daily-', 7], ['weekly-', 4]]) for (const f of readdirSync(dir).filter((x) => x.startsWith(pre)).sort().reverse().slice(keep)) rmSync(join(dir, f));
  if (extraDir && existsSync(extraDir)) for (const f of out) { try { copyFileSync(f, join(extraDir, f.split('/').pop())); } catch {} }
  return { written: out };
}
