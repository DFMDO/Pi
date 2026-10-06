import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHub, PW } from './helpers.js';
import { totpAt, checkPasswordPolicy } from '../lib/crypto.js';

test('Login: gleiche Fehlermeldung bei falschem Benutzer und Passwort', async () => {
  const h = await makeHub();
  const a = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: 'gibtsnicht', password: 'x' } });
  const b = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: 'admin', password: 'falsch' } });
  assert.equal(a.statusCode, 401); assert.equal(b.statusCode, 401);
  assert.equal(a.json().error, b.json().error);
  await h.cleanup();
});

test('Login: Cookie-Attribute und CSRF-Pflicht', async () => {
  const h = await makeHub();
  const s = await h.login('admin');
  const sc = s.res.headers['set-cookie'];
  assert.match(sc, /^__Host-dfm_sid=/); for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(a), a);
  const noCsrf = await h.app.inject({ method: 'POST', url: '/api/v1/groups', payload: { name: 'X' }, headers: { cookie: s.cookie } });
  assert.equal(noCsrf.statusCode, 403);
  const ok = await h.app.inject({ method: 'POST', url: '/api/v1/groups', payload: { name: 'X' }, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
  assert.equal(ok.statusCode, 201);
  await h.cleanup();
});

test('Rate-Limit: steigende Sperre nach 5 Fehlversuchen (auch mit richtigem Passwort)', async () => {
  const h = await makeHub();
  for (let i = 0; i < 5; i++) await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: 'edi', password: 'nein' } });
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: 'edi', password: PW } });
  assert.equal(r.statusCode, 429); assert.ok(r.headers['retry-after']);
  h.clock.t += 31000; // Sperre abgelaufen (Limiter nutzt die Test-Uhr)
  const r2 = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: 'edi', password: PW } });
  assert.equal(r2.statusCode, 200);
  await h.cleanup();
});

test('Sitzung läuft nach 30 Minuten Inaktivität ab', async () => {
  const h = await makeHub();
  const c = await h.as('admin');
  assert.equal((await c('GET', '/api/v1/auth/me')).statusCode, 200);
  h.clock.t += 31 * 60000;
  assert.equal((await c('GET', '/api/v1/auth/me')).statusCode, 401);
  await h.cleanup();
});

test('Rechteprüfung auf JEDER Route: ohne Login 401, falsche Rolle 403', async () => {
  const h = await makeHub();
  const routes = h.app.apiRoutes.filter((r) => r.config.perm || r.config.authenticated);
  assert.ok(routes.length > 40, 'erwartet viele Routen, hat ' + routes.length);
  const { ROLE_PERMS } = await import('../lib/permissions.js');
  for (const role of ['anzeige', 'editor']) {
    const c = await h.as(role === 'anzeige' ? 'vera' : 'edi');
    for (const r of routes.filter((x) => x.config.perm && !ROLE_PERMS[role].has(x.config.perm))) {
      const method = r.method.find((m) => m !== 'HEAD' && m !== 'OPTIONS');
      const res = await c(method, r.url.replace(/:[a-zA-Z]+/g, 'x'), method === 'GET' ? undefined : {});
      assert.equal(res.statusCode, 403, `${role} ${method} ${r.url} → ${res.statusCode}`);
    }
  }
  for (const r of routes) {
    const method = r.method.find((m) => m !== 'HEAD' && m !== 'OPTIONS');
    const res = await h.app.inject({ method, url: r.url.replace(/:[a-zA-Z]+/g, 'x'), payload: method === 'GET' ? undefined : {} });
    assert.equal(res.statusCode, 401, `anonym ${method} ${r.url} → ${res.statusCode}`);
  }
  await h.cleanup();
});

test('Routen ohne Rechte-Deklaration verhindern den Start', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: authPlugin } = await import('../lib/auth.js');
  const { openDb } = await import('../lib/db.js');
  const { createAudit } = await import('../lib/audit.js');
  const db = openDb(':memory:');
  const f = Fastify();
  await f.register(authPlugin, { db, key: Buffer.alloc(32), audit: createAudit(db) });
  await assert.rejects(async () => { f.get('/api/v1/vergessen', async () => 'x'); await f.ready(); }, /Route ohne Rechte/);
});

test('Passwortregeln', () => {
  assert.ok(checkPasswordPolicy('kurz'));
  assert.ok(checkPasswordPolicy('passwort1234'));
  assert.ok(checkPasswordPolicy('aaaaaaaaaaaaaa'));
  assert.ok(checkPasswordPolicy('MaxMustermann-2024', 'maxmustermann'));
  assert.equal(checkPasswordPolicy('Ein-langes-sicheres-Passwort'), null);
});

test('TOTP: Aktivierung, Login mit Code, Wiederherstellungscode einmalig', async () => {
  const h = await makeHub();
  const c = await h.as('admin');
  const { secret } = (await c('POST', '/api/v1/auth/totp/start')).json();
  assert.equal((await c('POST', '/api/v1/auth/totp/enable', { code: '000000' })).statusCode, 400);
  const { recoveryCodes } = (await c('POST', '/api/v1/auth/totp/enable', { code: totpAt(secret) })).json();
  assert.equal(recoveryCodes.length, 8);
  const noCode = await h.login('admin'); assert.equal(noCode.res.statusCode, 401); assert.equal(noCode.res.json().code, 'totp');
  const post = (totp) => h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { name: 'admin', password: PW, totp } });
  assert.equal((await post(totpAt(secret))).statusCode, 200);
  assert.equal((await post(recoveryCodes[0])).statusCode, 200);
  assert.equal((await post(recoveryCodes[0])).statusCode, 401, 'Wiederherstellungscode nur einmal nutzbar');
  await h.cleanup();
});

test('Ersteinrichtung des Hubs: Einrichtungscode nötig, danach gesperrt', async () => {
  const h = await makeHub({ noUsers: true });
  assert.deepEqual((await h.app.inject({ url: '/api/v1/setup/state' })).json(), { needsAdmin: true });
  const bad = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { code: 'FALSCH', name: 'chef', password: 'Ein-langes-sicheres-Passwort' } });
  assert.equal(bad.statusCode, 403);
  const { readFileSync } = await import('node:fs'); const { join } = await import('node:path');
  const code = readFileSync(join(h.dataDir, 'keys', 'setup-code.txt'), 'utf8');
  const weak = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { code, name: 'chef', password: 'kurz' } });
  assert.equal(weak.statusCode, 400);
  const ok = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { code, name: 'chef', password: 'Ein-langes-sicheres-Passwort', site: 'DFM' } });
  assert.equal(ok.statusCode, 201);
  const again = await h.app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { code, name: 'x2', password: 'Ein-langes-sicheres-Passwort' } });
  assert.equal(again.statusCode, 409);
  await h.cleanup();
});

test('Security-Header und Audit-Log unveränderbar', async () => {
  const h = await makeHub();
  const r = await h.app.inject({ url: '/api/v1/setup/state' });
  for (const k of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'strict-transport-security']) assert.ok(r.headers[k], k);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  await h.login('admin');
  assert.throws(() => h.db.prepare('UPDATE audit_log SET action=?').run('x'), /unveränderbar/);
  assert.throws(() => h.db.prepare('DELETE FROM audit_log').run(), /unveränderbar/);
  assert.equal(h.app.ctx.audit.verify().ok, true);
  await h.cleanup();
});
