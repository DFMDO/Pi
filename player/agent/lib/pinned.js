// TLS-Pinning: Die Verbindung zum Hub wird nur akzeptiert, wenn der SHA-256-Hash
// des öffentlichen Schlüssels (SPKI) dem gemerkten Wert entspricht. Es gibt keine
// Zertifizierungsstelle und keine Ausnahme. Die Prüfung läuft VOR dem ersten
// gesendeten Byte (createConnection mit Callback), damit weder Token noch Code
// an einen falschen Server gehen.
import https from 'node:https';
import tls from 'node:tls';
import { createHash } from 'node:crypto';

export const spkiOf = (x509) => createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

export class PinError extends Error {
  constructor(expected, seen) { super('Der Hub hat einen anderen Schlüssel als erwartet.'); this.code = 'PIN_MISMATCH'; this.expected = expected; this.seen = seen; }
}

/**
 * @param pin   erwarteter SPKI-Hash (hex) oder null = Erstkontakt (TOFU), dann meldet onPeer den gesehenen Wert
 */
export function pinnedAgent(pin, onPeer) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  agent.createConnection = (options, cb) => {
    const sock = tls.connect({ ...options, rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: /^[\d.:]+$/.test(options.host ?? '') ? undefined : options.servername ?? options.host });
    sock.once('error', (e) => cb(e));
    sock.once('secureConnect', () => {
      const seen = spkiOf(sock.getPeerX509Certificate());
      onPeer?.(seen);
      if (pin && seen !== pin) { const e = new PinError(pin, seen); sock.destroy(); return cb(e); }
      sock.removeAllListeners('error'); cb(null, sock);
    });
  };
  return agent;
}

/** Kleiner HTTPS-Client mit Pinning. Gibt { status, headers, body(Buffer), json() } zurück. */
export function request({ url, pin, method = 'GET', headers = {}, body, token, onPeer, timeout = 20000, sink }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let data = body; if (body && typeof body === 'object' && !Buffer.isBuffer(body)) { data = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h, agent: pinnedAgent(pin, onPeer), timeout }, (res) => {
      if (sink) { res.pipe(sink); sink.on('finish', () => resolve({ status: res.statusCode, headers: res.headers })); sink.on('error', reject); return; }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json: () => JSON.parse(buf.toString('utf8') || 'null') });
      }); res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
