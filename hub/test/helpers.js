import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { ensureCertificate } from '../lib/tls.js';
import { hashPassword } from '../lib/crypto.js';

export const PW = 'Sehr-geheimes-Passwort-42';

export async function makeHub(opts = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dfm-hub-'));
  const tls = ensureCertificate(join(dataDir, 'tls'), ['DNS:dfm-signage.local', 'DNS:localhost', 'IP:127.0.0.1']);
  const clock = { t: Date.now() }; const now = () => clock.t;
  const app = await buildApp({ dataDir, tls, now, ...opts });
  await app.ready();
  const { db } = app.ctx;
  const mkUser = async (name, role) => { db.prepare('INSERT INTO users(id,name,pw_hash,role,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), name, await hashPassword(PW), role, now()); };
  if (!opts.noUsers) { await mkUser('admin', 'admin'); await mkUser('edi', 'editor'); await mkUser('vera', 'viewer'); }
  const login = async (name, password = PW) => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name, password } });
    const cookie = (r.headers['set-cookie'] ?? '').split(';')[0];
    return { res: r, cookie, csrf: r.json().csrf };
  };
  /** Bequemer Client für eine Rolle */
  const as = async (name) => {
    const s = await login(name);
    return (method, url, payload, extra = {}) => app.inject({ method, url, payload, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, ...extra } });
  };
  const cleanup = async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); };
  return { app, db, tls, dataDir, clock, login, as, cleanup, mkUser };
}

export function multipart(name, filename, data, fields = {}) {
  const b = '----dfmtest' + randomUUID(); const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
