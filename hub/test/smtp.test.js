// SMTP-Client gegen einen nachgebauten Mailserver: unverschlüsselt, STARTTLS, TLS, Anmeldung (PLAIN/LOGIN), Fehlerfälle mit verständlichen Meldungen.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCertificate } from '../lib/tls.js';
import { sendMail, SmtpError, validEmail } from '../lib/smtp.js';

const dir = mkdtempSync(join(tmpdir(), 'dfm-smtp-')); const cert = ensureCertificate(dir, ['DNS:localhost', 'IP:127.0.0.1']);
test.after(() => rmSync(dir, { recursive: true, force: true }));
const ctx = () => tls.createSecureContext({ key: cert.key, cert: cert.cert });

/** Nachgebauter Mailserver. mode: 'none' | 'starttls' | 'tls'; user/pass: Anmeldung verlangen (mech PLAIN oder LOGIN) */
async function fake({ mode = 'none', user = null, pass = null, mech = 'PLAIN', rejectRcpt = null } = {}) {
  const mails = [], log = [];
  const state = () => ({ mode: 'cmd', data: [], from: null, rcpt: [], authed: !user, u: null });
  const attach = (sock, st) => {
    let buf = ''; const w = (s) => { log.push('S: ' + s); sock.write(s + '\r\n'); };
    sock.on('error', () => {});
    const line = (l) => {
      log.push('C: ' + (l.length > 60 ? l.slice(0, 60) + '…' : l));
      if (st.mode === 'data') { if (l === '.') { mails.push({ from: st.from, rcpt: st.rcpt, raw: st.data.join('\r\n') }); st.mode = 'cmd'; st.data = []; return w('250 angenommen'); } st.data.push(l.startsWith('..') ? l.slice(1) : l); return; }
      if (st.mode === 'lu') { st.u = Buffer.from(l, 'base64').toString(); st.mode = 'lp'; return w('334 UGFzc3dvcmQ6'); }
      if (st.mode === 'lp') { st.mode = 'cmd'; const ok = st.u === user && Buffer.from(l, 'base64').toString() === pass; st.authed = ok; return w(ok ? '235 ok' : '535 Anmeldung falsch'); }
      const [cmd, ...rest] = l.split(' '); const arg = rest.join(' ');
      switch (cmd.toUpperCase()) {
        case 'EHLO': w('250-fake.local'); if (mode === 'starttls' && !(sock instanceof tls.TLSSocket)) w('250-STARTTLS'); if (user) w(`250-AUTH ${mech}`); return w('250 8BITMIME');
        case 'STARTTLS': { w('220 los'); sock.removeAllListeners('data'); const t = new tls.TLSSocket(sock, { isServer: true, secureContext: ctx() }); attach(t, st); return; }
        case 'AUTH': if (mech === 'LOGIN') { st.mode = 'lu'; return w('334 VXNlcm5hbWU6'); } { const [, b] = arg.split(' '); const [, u, p] = Buffer.from(b ?? '', 'base64').toString().split('\0'); st.authed = u === user && p === pass; return w(st.authed ? '235 ok' : '535 Anmeldung falsch'); }
        case 'MAIL': if (!st.authed) return w('530 Anmeldung nötig'); st.from = /<(.*)>/.exec(arg)?.[1]; return w('250 ok');
        case 'RCPT': { const a = /<(.*)>/.exec(arg)?.[1]; if (a === rejectRcpt) return w('550 Postfach unbekannt'); st.rcpt.push(a); return w('250 ok'); }
        case 'DATA': st.mode = 'data'; return w('354 los');
        case 'QUIT': w('221 tschüss'); return sock.end();
        default: return w('502 unbekannt');
      }
    };
    sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); line(l); } });
    if (!st.greeted) { st.greeted = true; w('220 fake ESMTP bereit'); }
  };
  const server = mode === 'tls' ? tls.createServer({ key: cert.key, cert: cert.cert }, (s) => attach(s, state())) : net.createServer((s) => attach(s, state()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, mails, log, close: () => new Promise((r) => server.close(r)) };
}
const base = (s, o = {}) => ({ host: '127.0.0.1', port: s.port, from: 'signage@museum.local', to: ['it@museum.local'], subject: 'Test', text: 'Hallo', ...o });
const decode = (raw) => { const [head, ...body] = raw.split('\r\n\r\n'); return { head, text: Buffer.from(body.join('').replace(/\r\n/g, ''), 'base64').toString('utf8') }; };

test('SMTP: Nachricht ohne Verschlüsselung und ohne Anmeldung (internes Relay), Umlaute und Betreff UTF-8', async () => {
  const s = await fake(); try {
    const r = await sendMail(base(s, { security: 'none', to: ['a@museum.local', 'b@museum.local'], subject: 'Bildschirm „Foyer“ ist weg', text: 'Zeile 1\n.Punkt am Anfang\nÜbergrößenträger' })); assert.equal(r.accepted, 2);
    assert.equal(s.mails.length, 1); assert.deepEqual(s.mails[0].rcpt, ['a@museum.local', 'b@museum.local']); assert.equal(s.mails[0].from, 'signage@museum.local');
    const m = decode(s.mails[0].raw); assert.equal(m.text, 'Zeile 1\n.Punkt am Anfang\nÜbergrößenträger'); assert.match(m.head, /^Subject: =\?UTF-8\?B\?/m); assert.match(m.head, /^To: a@museum.local, b@museum.local$/m); assert.match(m.head, /Content-Type: text\/plain; charset=utf-8/);
    assert.equal(Buffer.from(/Subject: =\?UTF-8\?B\?(.+)\?=/.exec(m.head)[1], 'base64').toString(), 'Bildschirm „Foyer“ ist weg');
  } finally { await s.close(); }
});

test('SMTP: STARTTLS + Anmeldung (PLAIN); falsches Passwort wird als Anmelde-Fehler erkannt; ohne Zertifikatsprüfung geht es, mit Prüfung nicht (selbst signiert)', async () => {
  const s = await fake({ mode: 'starttls', user: 'signage', pass: 'geheim-1' }); try {
    await assert.rejects(() => sendMail(base(s, { security: 'starttls', user: 'signage', pass: 'geheim-1' })), (e) => e instanceof SmtpError && e.code === 'tls' && /Zertifikat/.test(e.message), 'selbst signiertes Zertifikat wird standardmäßig abgelehnt');
    await assert.rejects(() => sendMail(base(s, { security: 'starttls', user: 'signage', pass: 'falsch', rejectUnauthorized: false })), (e) => e.code === 'auth' && /Anmeldung abgelehnt/.test(e.message));
    assert.equal(s.mails.length, 0);
    const r = await sendMail(base(s, { security: 'starttls', user: 'signage', pass: 'geheim-1', rejectUnauthorized: false })); assert.equal(r.accepted, 1); assert.equal(s.mails.length, 1);
    assert.ok(s.log.some((l) => l.startsWith('C: AUTH PLAIN')), 'Anmeldung erst NACH STARTTLS'); const i = s.log.findIndex((l) => l === 'S: 220 los'), j = s.log.findIndex((l) => l.startsWith('C: AUTH')); assert.ok(i >= 0 && j > i);
  } finally { await s.close(); }
});

test('SMTP: implizites TLS (Port 465) mit Anmeldung LOGIN; Server ohne STARTTLS bei „starttls“ wird verständlich abgelehnt', async () => {
  const s = await fake({ mode: 'tls', user: 'u', pass: 'p', mech: 'LOGIN' }); try {
    assert.equal((await sendMail(base(s, { security: 'tls', user: 'u', pass: 'p', rejectUnauthorized: false }))).accepted, 1);
  } finally { await s.close(); }
  const plain = await fake(); try {
    await assert.rejects(() => sendMail(base(plain, { security: 'starttls' })), (e) => e.code === 'tls' && /STARTTLS/.test(e.message));
    await assert.rejects(() => sendMail(base(plain, { security: 'tls', rejectUnauthorized: false, timeoutMs: 2000 })), (e) => e instanceof SmtpError, 'TLS auf einem Klartext-Port scheitert mit verständlicher Meldung');
  } finally { await plain.close(); }
});

test('SMTP: abgelehnter Empfänger, unerreichbarer Server, falsche Eingaben (Zeilenumbruch im Betreff, Anmeldung ohne Verschlüsselung, ungültige Adressen)', async () => {
  const s = await fake({ rejectRcpt: 'weg@museum.local' }); try {
    await assert.rejects(() => sendMail(base(s, { security: 'none', to: ['it@museum.local', 'weg@museum.local'] })), (e) => e.code === 'rejected' && /weg@museum.local/.test(e.message));
    await assert.rejects(() => sendMail(base(s, { security: 'none', subject: 'A\r\nBcc: boese@x.de' })), (e) => e.code === 'config' && /Zeilenumbr/.test(e.message), 'Header-Einschleusung verhindert');
    await assert.rejects(() => sendMail(base(s, { security: 'none', user: 'u', pass: 'p' })), (e) => e.code === 'config' && /ohne Verschlüsselung/.test(e.message), 'Passwörter nie im Klartext');
    await assert.rejects(() => sendMail(base(s, { security: 'none', to: ['keine-adresse'] })), (e) => e.code === 'config' && /keine gültige/.test(e.message));
    await assert.rejects(() => sendMail(base(s, { security: 'none', to: [] })), (e) => /Empfänger/.test(e.message)); await assert.rejects(() => sendMail(base(s, { security: 'none', host: '' })), (e) => /Mailserver/.test(e.message));
    assert.equal(s.mails.length, 0);
  } finally { await s.close(); }
  const closed = await fake(); const port = closed.port; await closed.close();
  await assert.rejects(() => sendMail({ ...base({ port }), security: 'none' }), (e) => e.code === 'connect' && /keine Verbindung/.test(e.message), 'Server nicht erreichbar');
  assert.ok(validEmail('it@museum.local') && !validEmail('a b@c.de') && !validEmail('a@b') && !validEmail('<a@b.de>') && !validEmail('a@b.de,c@d.de'));
});

test('SMTP: Server, der nicht antwortet, führt zu einer Zeitüberschreitung statt zu einem Hänger', async () => {
  const srv = net.createServer((s) => { s.on('error', () => {}); /* sagt nichts */ }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await assert.rejects(() => sendMail({ host: '127.0.0.1', port: srv.address().port, security: 'none', from: 'a@b.de', to: ['c@d.de'], subject: 'x', text: 'y', timeoutMs: 400 }), (e) => e.code === 'timeout' && /antwortet nicht/.test(e.message)); }
  finally { await new Promise((r) => srv.close(r)); }
});
