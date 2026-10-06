// Signierte Updates (.dfmpkg): ein tar-Archiv mit manifest.json, manifest.sig
// (Ed25519 über die Bytes von manifest.json) und payload.tar.
// Manifest: { version, payloadSha256, created, notes }
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

/** Prüft Signatur und Nutzlast. Wirft verständliche Fehler. */
export function verifyPackage({ manifestBytes, sigBytes, payload }, pubKeyPem) {
  let ok = false;
  try { ok = edVerify(null, manifestBytes, createPublicKey(pubKeyPem), sigBytes); } catch { ok = false; }
  if (!ok) throw new Error('Die Signatur dieses Updates ist ungültig. Das Update wurde nicht installiert.');
  const m = JSON.parse(manifestBytes.toString('utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) throw new Error('Die Versionsnummer des Updates ist ungültig.');
  if (createHash('sha256').update(payload).digest('hex') !== m.payloadSha256) throw new Error('Das Update ist beschädigt.');
  return m;
}
