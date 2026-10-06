// dfm-setup: Einrichtungsdienst. Zwei Server:
//   0.0.0.0:80      Einrichtungsseite + Captive Portal (nur im Setup-WLAN erreichbar)
//   127.0.0.1:8081  Bildschirm-Anzeige (QR, PIN, Passwort) – das Handy erreicht diese NICHT
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createController } from './lib/controller.js';
import { createNm } from './lib/nm.js';
import { isProbe, PORTAL_URL } from './lib/captive.js';
import { writeFinalConfig } from './lib/config.js';

const HERE = dirname(fileURLToPath(import.meta.url)), UI = join(HERE, 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
const FILES = new Map([['/', 'index.html'], ['/setup.js', 'setup.js'], ['/setup.css', 'setup.css'], ['/logo.svg', '../../assets/dfm-logo.svg'], ['/theme.css', '../../assets/dfm-theme.css']]);
const DISPLAY = new Map([['/', 'display.html'], ['/display.js', 'display.js'], ['/setup.css', 'setup.css'], ['/logo.svg', '../../assets/dfm-logo.svg'], ['/theme.css', '../../assets/dfm-theme.css']]);

/** HTTP-Schicht. `ctl` ist der Controller; wird in Tests mit Fake-Abhängigkeiten gebaut. */
export function createServers(ctl, { toSvg = (t) => QRCode.toString(t, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) } = {}) {
  const json = (res, code, o) => { res.writeHead(code, { ...HEAD, 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 20000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } }); });
  const sendFile = (res, map, p) => { const f = join(UI, map.get(p)); if (!existsSync(f)) { res.writeHead(404, HEAD).end(); return; } res.writeHead(200, { ...HEAD, 'Content-Type': TYPES[f.slice(f.lastIndexOf('.'))] ?? 'text/plain' }); res.end(readFileSync(f)); };

  const portal = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/favicon.ico') { res.writeHead(404, HEAD).end(); return; }
    if (isProbe(p)) { res.writeHead(302, { ...HEAD, Location: PORTAL_URL }).end(); return; }
    if (req.method === 'GET' && FILES.has(p)) return sendFile(res, FILES, p);
    if (p.startsWith('/api/')) {
      const tok = req.headers['x-setup-session']; const b = req.method === 'POST' ? await body(req) : {}; if (b === null) return json(res, 400, { error: 'Ungültige Eingabe.' });
      if (p === '/api/pin' && req.method === 'POST') { const r = ctl.enterPin(String(b.pin ?? '')); return json(res, r.ok ? 200 : r.locked ? 429 : 403, r); }
      if (!ctl.authed(tok)) return json(res, 401, { error: 'Bitte gib zuerst die PIN ein.' });
      if (p === '/api/info' && req.method === 'GET') return json(res, 200, ctl.info(tok));
      if (p === '/api/wifi' && req.method === 'POST') { const r = await ctl.testWifi(tok, b); return json(res, r.ok ? 200 : 400, r); }
      if (p === '/api/result' && req.method === 'GET') return json(res, 200, ctl.result(tok));
      if (p === '/api/role' && req.method === 'POST') return json(res, ctl.setRole(tok, b.role) ? 200 : 400, { ok: true });
      if (p === '/api/finish' && req.method === 'POST') { const r = await ctl.finish(tok, b); return json(res, r.ok ? 200 : 400, r); }
      return json(res, 404, { error: 'Nicht gefunden.' });
    }
    // Alles andere (beliebige Domain, die das Handy aufruft) → Einrichtungsseite
    if (req.method === 'GET') { res.writeHead(302, { ...HEAD, Location: PORTAL_URL }).end(); return; }
    res.writeHead(405, HEAD).end();
  });

  const display = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/state') { const d = await ctl.display(); if (d.qr) d.qrSvg = await toSvg(d.qr); delete d.qr; return json(res, 200, d); }
    if (FILES.has(p) || DISPLAY.has(p)) return sendFile(res, DISPLAY, p);
    res.writeHead(404, HEAD).end();
  });
  return { portal, display };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { hashPassword, checkPasswordPolicy } = await import('../hub/lib/crypto.js');
  const dev = JSON.parse(readFileSync(join(process.env.DFM_DATA ?? '/data', 'device.json'), 'utf8'));
  const ctl = createController({ nm: createNm(), suffix: dev.suffix, hw: dev.hw, hashPassword, policy: checkPasswordPolicy, writeConfig: writeFinalConfig, serialPin: dev.headless ? dev.serial.slice(-6).toUpperCase() : null,
    onDone: () => setTimeout(() => import('node:child_process').then((c) => c.execFile('systemctl', ['reboot'])), 6000), log: (...a) => console.error(...a) });
  await ctl.startMode();
  const { portal, display } = createServers(ctl);
  portal.listen(80, '0.0.0.0'); display.listen(8081, '127.0.0.1');
  setInterval(() => ctl.tick().catch(() => {}), 2000);
}
