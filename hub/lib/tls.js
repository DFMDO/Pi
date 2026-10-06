// Selbstsigniertes TLS-Zertifikat (ECDSA P-256, 5 Jahre) – ohne eigene CA.
// Der Schlüssel entsteht beim ersten Start; Erneuerung behält den Schlüssel,
// damit der SPKI-Hash (Pinning) gleich bleibt.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { X509Certificate, createPublicKey, createHash } from 'node:crypto';

export function spkiHash(certPemOrPubKey) {
  const pub = certPemOrPubKey instanceof X509Certificate ? certPemOrPubKey.publicKey
    : certPemOrPubKey.includes('CERTIFICATE') ? new X509Certificate(certPemOrPubKey).publicKey : createPublicKey(certPemOrPubKey);
  return createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex');
}
/** Fingerabdruck in Vierergruppen: "A3F2 91C0 …" */
export const formatFingerprint = (hex) => hex.toUpperCase().match(/.{4}/g).join(' ');

function certCovers(certPem, sans) {
  try {
    const c = new X509Certificate(certPem);
    if (new Date(c.validTo) < new Date(Date.now() + 30 * 86400000)) return false; // <30 Tage Rest
    return sans.every((s) => (c.subjectAltName ?? '').includes(s));
  } catch { return false; }
}

/**
 * @param dir  Verzeichnis (z. B. /data/tls), Schlüssel 0600
 * @param sans Liste wie ['DNS:dfm-signage.local','DNS:dfm-abcd','IP:192.168.1.10']
 */
export function ensureCertificate(dir, sans) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyF = join(dir, 'hub.key'), crtF = join(dir, 'hub.crt');
  const hasKey = existsSync(keyF);
  if (hasKey && existsSync(crtF) && certCovers(readFileSync(crtF, 'utf8'), sans)) return load(keyF, crtF);
  const tmp = mkdtempSync(join(tmpdir(), 'dfm-tls-'));
  try {
    if (!hasKey) {
      execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyF]);
      chmodSync(keyF, 0o600);
    }
    const conf = join(tmp, 'o.cnf');
    writeFileSync(conf, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=DFM Signage Hub\nO=Deutsches Fussballmuseum\n[ext]\nsubjectAltName=${sans.join(',')}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
    execFileSync('openssl', ['req', '-new', '-x509', '-key', keyF, '-out', crtF, '-days', '1826', '-sha256', '-config', conf]);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return load(keyF, crtF);
}
function load(keyF, crtF) {
  const cert = readFileSync(crtF, 'utf8');
  return { key: readFileSync(keyF), cert, spki: spkiHash(cert), certPath: crtF };
}
