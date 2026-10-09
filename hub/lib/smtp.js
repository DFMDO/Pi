// Minimaler SMTP-Client (ohne Abhängigkeit): verschlüsselt (TLS oder STARTTLS), Anmeldung PLAIN/LOGIN, eine Nachricht an mehrere Empfänger.
// Gedacht für den internen Mailserver des Museums. Anmeldedaten gehen nie unverschlüsselt über das Netz.
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

export class SmtpError extends Error { constructor(message, code = 'smtp') { super(message); this.code = code; } }
const EMAIL = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[^\s<>@,;"]+$/;
export const validEmail = (s) => typeof s === 'string' && s.length <= 200 && EMAIL.test(s);
const noBreaks = (s) => !/[\r\n]/.test(String(s));
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s) => s.replace(/(.{76})/g, '$1\r\n');

/** Liest Server-Antworten Zeile für Zeile; eine Antwort endet mit einer Zeile „250 …“ (mit Leerzeichen nach dem Code). */
function reader(sock, timeoutMs) {
  let buf = '', waiting = null, failure = null; const lines = [];
  const feed = () => { let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } pump(); };
  const pump = () => {
    if (!waiting) return;
    if (failure && !lines.length) { const w = waiting; waiting = null; clearTimeout(w.t); return w.reject(failure); }
    const end = lines.findIndex((l) => /^\d{3}( |$)/.test(l)); if (end < 0) return;
    const got = lines.splice(0, end + 1), w = waiting; waiting = null; clearTimeout(w.t); w.resolve({ code: Number(got[end].slice(0, 3)), lines: got.map((l) => l.slice(4)) });
  };
  sock.on('data', (d) => { buf += d.toString('utf8'); feed(); });
  sock.on('error', (e) => { failure = e; pump(); }); sock.on('close', () => { failure ??= new SmtpError('Der Mailserver hat die Verbindung beendet.', 'closed'); pump(); });
  return { read: () => new Promise((resolve, reject) => { waiting = { resolve, reject, t: setTimeout(() => { waiting = null; reject(new SmtpError('Der Mailserver antwortet nicht.', 'timeout')); }, timeoutMs) }; pump(); }) };
}

/**
 * @param o { host, port, security: 'tls'|'starttls'|'none', user?, pass?, from, to: string[], subject, text, rejectUnauthorized?, timeoutMs?, helo? }
 * @returns {Promise<{accepted:number}>} wirft SmtpError mit verständlicher Meldung (code: 'connect'|'tls'|'auth'|'rejected'|'timeout'|…)
 */
export async function sendMail(o) {
  const { host, port = 587, security = 'starttls', user = '', pass = '', from, to = [], subject = '', text = '', rejectUnauthorized = true, timeoutMs = 15000, helo = 'dfm-signage.local' } = o;
  if (!host || !noBreaks(host)) throw new SmtpError('Es ist kein Mailserver eingetragen.', 'config');
  for (const a of [from, ...to]) if (!validEmail(a)) throw new SmtpError(`„${String(a).slice(0, 60)}“ ist keine gültige E-Mail-Adresse.`, 'config');
  if (!to.length) throw new SmtpError('Es ist kein Empfänger eingetragen.', 'config');
  if (!noBreaks(subject)) throw new SmtpError('Der Betreff darf keine Zeilenumbrüche enthalten.', 'config');
  if (user && security === 'none') throw new SmtpError('Anmeldung ohne Verschlüsselung ist nicht erlaubt. Bitte „TLS“ oder „STARTTLS“ wählen oder die Anmeldung weglassen.', 'config');

  const tlsOpts = { servername: net.isIP(host) ? undefined : host, rejectUnauthorized };
  let sock = await new Promise((resolve, reject) => {
    const s = security === 'tls' ? tls.connect({ host, port, ...tlsOpts }) : net.connect({ host, port }); let done = false;
    const fail = (e) => { if (done) return; done = true; s.destroy(); reject(e); };
    s.setTimeout(timeoutMs, () => fail(new SmtpError('Der Mailserver antwortet nicht (Adresse und Port prüfen).', 'timeout')));
    s.once(security === 'tls' ? 'secureConnect' : 'connect', () => { if (!done) { done = true; s.setTimeout(0); resolve(s); } });
    s.once('error', (e) => fail(explain(e)));
  });
  let rd = reader(sock, timeoutMs); const send = (l) => sock.write(l + '\r\n');
  const expect = async (want, what) => { const r = await rd.read(); if (!want.includes(r.code)) throw new SmtpError(`${what}: ${r.code} ${r.lines.join(' ').slice(0, 160)}`, r.code === 535 || r.code === 534 || r.code === 530 ? 'auth' : 'rejected'); return r; };
  try {
    await expect([220], 'Der Mailserver hat sich nicht gemeldet');
    send(`EHLO ${helo}`); let caps = (await expect([250], 'Begrüßung abgelehnt')).lines.map((l) => l.toUpperCase());
    if (security === 'starttls') {
      if (!caps.some((c) => c.startsWith('STARTTLS'))) throw new SmtpError('Der Mailserver bietet keine Verschlüsselung (STARTTLS) an.', 'tls');
      send('STARTTLS'); await expect([220], 'STARTTLS abgelehnt');
      sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
      sock = await new Promise((resolve, reject) => { const t = tls.connect({ socket: sock, ...tlsOpts }, () => resolve(t)); t.once('error', (e) => reject(explain(e))); });
      rd = reader(sock, timeoutMs); send(`EHLO ${helo}`); caps = (await expect([250], 'Begrüßung abgelehnt')).lines.map((l) => l.toUpperCase());
    }
    if (user) {
      const auth = caps.find((c) => c.startsWith('AUTH')) ?? '';
      if (/\bPLAIN\b/.test(auth)) { send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`); await expect([235], 'Anmeldung abgelehnt'); }
      else if (/\bLOGIN\b/.test(auth)) { send('AUTH LOGIN'); await expect([334], 'Anmeldung abgelehnt'); send(b64(user)); await expect([334], 'Anmeldung abgelehnt'); send(b64(pass)); await expect([235], 'Anmeldung abgelehnt'); }
      else throw new SmtpError('Der Mailserver bietet keine Anmeldung an, obwohl ein Benutzername eingetragen ist.', 'auth');
    }
    send(`MAIL FROM:<${from}>`); await expect([250], 'Absender abgelehnt');
    for (const r of to) { send(`RCPT TO:<${r}>`); await expect([250, 251], `Empfänger ${r} abgelehnt`); }
    send('DATA'); await expect([354], 'Nachricht nicht angenommen');
    const head = [`From: ${from}`, `To: ${to.join(', ')}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${randomUUID()}@${helo}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'Auto-Submitted: auto-generated'];
    sock.write(head.join('\r\n') + '\r\n\r\n' + wrap(b64(text)) + '\r\n.\r\n'); await expect([250], 'Nachricht abgelehnt');
    try { send('QUIT'); } catch {}
    return { accepted: to.length };
  } finally { sock.destroy(); }
}

/** Technische Netzwerkfehler in verständliche Sätze übersetzen */
export function explain(e) {
  if (e instanceof SmtpError) return e;
  const c = e?.code ?? '';
  if (c === 'ECONNREFUSED') return new SmtpError('Der Mailserver nimmt unter dieser Adresse und diesem Port keine Verbindung an. Bitte Adresse und Port prüfen.', 'connect');
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new SmtpError('Der Name des Mailservers wird nicht gefunden. Bitte die Schreibweise prüfen oder die IP-Adresse eintragen.', 'connect');
  if (c === 'ETIMEDOUT' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return new SmtpError('Der Mailserver ist aus diesem Netz nicht erreichbar (Firewall?). Bitte die IT fragen.', 'connect');
  if (/CERT|SELF.SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(`${c} ${e?.message}`)) return new SmtpError('Das Zertifikat des Mailservers wird nicht anerkannt. Die IT kann es erneuern, oder du schaltest „Zertifikat nicht prüfen“ ein (weniger sicher).', 'tls');
  if (/wrong version number|EPROTO|ssl/i.test(`${c} ${e?.message}`)) return new SmtpError('Die Verschlüsselung passt nicht zum Port. Üblich: Port 465 mit „TLS“, Port 587 mit „STARTTLS“.', 'tls');
  return new SmtpError('Die Verbindung zum Mailserver ist fehlgeschlagen.', 'connect');
}
