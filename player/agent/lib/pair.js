// Sicheres Pairing (Spec 4.3): Trust-on-first-use, HMAC über Fingerabdruck, Gerät und Nonce.
// Der Einmalcode geht nie im Klartext über das Netz.
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { request, PinError } from './pinned.js';

export const normalizeCode = (c) => String(c).replace(/[\s-]/g, '').toUpperCase();
export const pairMac = (code, spki, deviceId, nonce, secretHash) =>
  createHmac('sha256', normalizeCode(code)).update([spki, deviceId, nonce, secretHash].join('|')).digest('hex');
export const normalizeFingerprint = (f) => String(f).replace(/[\s:-]/g, '').toLowerCase();

export class PairError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

/**
 * @param expectedFp optionaler Fingerabdruck aus Startkarte/QR/Konfigurationsdatei – MUSS dann übereinstimmen
 * @returns { token, spki }
 */
export async function pairWithHub({ hubUrl, code, expectedFp, deviceId, name, model, profile, hw, pollMs = 2000, timeoutMs = 3600000, onStatus = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let seen = null;
  const peer = (s) => { seen = s; };
  const exp = expectedFp ? normalizeFingerprint(expectedFp) : null;
  const call = async (path, body, pin) => {
    try { return await request({ url: hubUrl + path, method: 'POST', body, pin, onPeer: peer }); }
    catch (e) { if (e instanceof PinError) throw new PairError('Der Fingerabdruck des Hubs stimmt nicht. Die Verbindung wurde aus Sicherheitsgründen abgebrochen.', 'fingerprint'); throw e; }
  };
  // Schritt 1: Erstkontakt (TOFU). Ist ein Fingerabdruck vorgegeben, wird sofort gegen ihn geprüft.
  const ch = await call('/api/v1/pair/challenge', {}, exp);
  if (ch.status !== 200) throw new PairError(ch.json()?.error ?? 'Der Hub hat die Anfrage abgelehnt.', 'challenge');
  if (!seen) throw new PairError('Keine sichere Verbindung zum Hub.', 'tls');
  const spki = seen;
  // Schritt 2: Anfrage mit HMAC. Das Abholgeheimnis ist per Hash an die Anfrage gebunden.
  const secret = randomBytes(32).toString('hex'), secretHash = createHash('sha256').update(secret).digest('hex');
  const nonce = ch.json().nonce;
  const rq = await call('/api/v1/pair/request', { nonce, deviceId, name, model, profile, hw, secretHash, hmac: pairMac(code, spki, deviceId, nonce, secretHash) }, spki);
  if (rq.status !== 200) throw new PairError(rq.json()?.error ?? 'Der Code wurde nicht akzeptiert.', rq.status === 403 ? 'code' : 'request');
  // Schritt 3: warten, bis der Admin im Hub „Ja, das ist mein Bildschirm“ klickt
  onStatus('waiting');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await call('/api/v1/pair/status', { deviceId, secret }, spki);
    const j = st.json();
    if (st.status === 200 && j.status === 'approved') {
      if (j.spki !== spki) throw new PairError('Der Hub meldet einen anderen Schlüssel.', 'fingerprint');
      return { token: j.token, spki };
    }
    if (st.status === 200 && j.status === 'rejected') throw new PairError('Der Hub hat diesen Bildschirm abgelehnt.', 'rejected');
    if (st.status >= 400 && st.status !== 429) throw new PairError(j?.error ?? 'Verbindung fehlgeschlagen.', 'status');
    await sleep(pollMs);
  }
  throw new PairError('Der Hub hat den Bildschirm nicht rechtzeitig bestätigt.', 'timeout');
}
