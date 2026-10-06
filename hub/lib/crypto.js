// Kleine Kryptohilfen: Master-Key, AES-256-GCM, Tokens, TOTP, Passwortregeln.
import { randomBytes, createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Gleichzeitig konstant-zeitiger Vergleich beliebig langer Strings. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest(), hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Schlüssel nur beim ersten Start erzeugen (0600), nie im Image. */
export function loadOrCreateKey(file) {
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const k = randomBytes(32);
  writeFileSync(file, k, { mode: 0o600 });
  chmodSync(file, 0o600);
  return k;
}

export function encrypt(key, plain) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decrypt(key, b64) {
  const b = Buffer.from(b64, 'base64'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// argon2id (OWASP-Richtwerte; auf dem Pi ~0,3 s)
const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw) => argonHash(pw, ARGON);
export const verifyPassword = (h, pw) => argonVerify(h, pw).catch(() => false);

// Liste häufiger Passwörter (klein, lokal; erweiterbar über hub/data/common-passwords.txt)
const COMMON = new Set(['passwort1234', 'password1234', '123456789012', 'qwertzuiop12', 'willkommen123',
  'fussball12345', 'fußball12345', 'museum123456', 'administrator1', 'changeme1234', 'letmein12345', 'passwort12345']);
export function checkPasswordPolicy(pw, name = '') {
  if (typeof pw !== 'string' || pw.length < 12) return 'Das Passwort muss mindestens 12 Zeichen lang sein.';
  if (pw.length > 200) return 'Das Passwort ist zu lang.';
  if (COMMON.has(pw.toLowerCase())) return 'Dieses Passwort ist zu bekannt. Bitte wähle ein anderes.';
  if (name && pw.toLowerCase().includes(name.toLowerCase())) return 'Das Passwort darf deinen Namen nicht enthalten.';
  if (/^(.)\1+$/.test(pw)) return 'Das Passwort darf nicht nur aus einem Zeichen bestehen.';
  return null;
}

// ---- TOTP (RFC 6238, SHA-1, 6 Stellen, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, v = 0, out = '';
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(v << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  let bits = 0, v = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) throw new Error('base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpAt(secretB32, t = Date.now()) {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', unbase32(secretB32)).update(ctr).digest();
  const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export function verifyTotp(secretB32, code, t = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  return [-1, 0, 1].some((w) => safeEqual(totpAt(secretB32, t + w * 30000), code));
}
export const newTotpSecret = () => base32(randomBytes(20));
export function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => randomBytes(5).toString('hex').match(/.{5}/g).join('-'));
}

/** Einmalcode ohne verwechselbare Zeichen (kein 0/O/1/I/L/U). */
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function pairingCode(len = 8) {
  const b = randomBytes(len); let s = '';
  for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}
