// Startet den Hub wie im Betrieb (server.js als eigener Prozess): HTTPS, Weiterleitung von Port 80, TLS-Version, Dateirechte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import { request } from '../player/agent/lib/pinned.js';

const get = (port, path) => new Promise((res, rej) => http.get({ port, host: '127.0.0.1', path, headers: { host: 'dfm-signage.local:80' } }, (r) => { r.resume(); res({ status: r.statusCode, location: r.headers.location }); }).on('error', rej));

test('Hub-Prozess: HTTPS ≥ TLS 1.2, Port 80 nur Weiterleitung, Schlüssel 0600, HSTS, sauberes Beenden', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proc-')), P443 = 20000 + Math.floor(Math.random() * 20000), P80 = P443 + 1;
  const p = spawn(process.execPath, ['hub/server.js'], { env: { ...process.env, DFM_DATA: dir, DFM_HTTPS_PORT: String(P443), DFM_HTTP_PORT: String(P80), DFM_UPDATE_KEY: '/nonexistent' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => { err += d; });
  try {
    let ok = false; for (let i = 0; i < 100 && !ok; i++) { await new Promise((r) => setTimeout(r, 100)); try { ok = (await request({ url: `https://127.0.0.1:${P443}/api/v1/setup/state`, pin: null, timeout: 500 })).status === 200; } catch {} }
    assert.ok(ok, 'Hub startet: ' + err);
    const r = await request({ url: `https://127.0.0.1:${P443}/api/v1/setup/state`, pin: null }); assert.deepEqual(r.json(), { needsAdmin: true }); assert.match(r.headers['strict-transport-security'], /max-age/);
    const red = await get(P80, '/irgendwas'); assert.equal(red.status, 301); assert.equal(red.location, `https://dfm-signage.local:${P443}/`, 'Weiterleitung auf HTTPS, Host bereinigt');
    const proto = await new Promise((res, rej) => { const s = tls.connect({ port: P443, host: '127.0.0.1', rejectUnauthorized: false, maxVersion: 'TLSv1.1' }, () => res('verbunden')); s.on('error', (e) => res('abgelehnt: ' + e.code)); });
    assert.match(proto, /abgelehnt/, 'TLS 1.1 wird abgelehnt');
    assert.equal(statSync(join(dir, 'tls', 'hub.key')).mode & 0o777, 0o600, 'privater Schlüssel nur für den Dienst lesbar'); assert.equal(statSync(join(dir, 'keys', 'master.key')).mode & 0o777, 0o600);
    const cert = new (await import('node:crypto')).X509Certificate(readFileSync(join(dir, 'tls', 'hub.crt'))); assert.match(cert.subjectAltName, /DNS:dfm-signage\.local/); assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
    assert.ok((new Date(cert.validTo) - Date.now()) / 86400000 > 1800, 'rund 5 Jahre gültig');
    const exited = new Promise((r) => p.on('exit', (c, s) => r(c ?? s))); p.kill('SIGTERM'); assert.ok([0, 'SIGTERM'].includes(await exited), 'beendet sich sauber');
  } finally { p.kill('SIGKILL'); }
});
