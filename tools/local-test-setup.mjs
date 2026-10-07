// Läuft IM Image (chroot, arm64): schreibt die Dateien so, wie die Handy-Einrichtung es für die Rolle "kombi" tut –
// auch mit demselben Fehlerbild: der Aufruf läuft ohne CAP_CHOWN (setpriv), chown scheitert dort still wie beim Einrichtungsdienst.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { chownSync } from 'node:fs';

const { writeFinalConfig } = await import('/opt/dfm/setup/lib/config.js');
const { ensureCertificate, formatFingerprint } = await import('/opt/dfm/hub/lib/tls.js');

// wie prepareHub() in setup/setup.js
const c = ensureCertificate('/data/hub/tls', ['DNS:dfm-signage.local', 'DNS:localhost', 'IP:127.0.0.1']);
for (const f of ['/data/hub', '/data/hub/tls', '/data/hub/tls/hub.key', '/data/hub/tls/hub.crt']) { try { chownSync(f, 990, 990); } catch {} }

const deviceId = randomUUID(), token = randomBytes(32).toString('base64url'), name = 'Testbildschirm', profile = 'standard';
await writeFinalConfig(
  { v: 1, role: 'kombi', name, createdAt: new Date().toISOString() },
  {
    hubBootstrap: { admin: { name: 'Test', pwHash: '$argon2id$v=19$m=65536,t=3,p=4$dGVzdA$dGVzdGhhc2g' }, site: 'Test' },
    agent: { deviceId, hubUrl: 'https://127.0.0.1', hubSpki: c.spki, token, name, profile, model: 'Lokaltest', local: true },
    localPlayer: { deviceId, tokenHash: createHash('sha256').update(token).digest('hex'), name, profile, model: 'Lokaltest' },
  },
  '/data');
console.log('Einrichtungsdateien geschrieben, Fingerabdruck', formatFingerprint(c.spki));
