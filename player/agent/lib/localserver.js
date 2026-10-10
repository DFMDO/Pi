// Lokaler Server NUR auf 127.0.0.1: liefert dem Browser (Chromium-Kiosk) die Playerseite,
// den gespeicherten Plan und die zwischengespeicherten Medien. Chromium spricht nie
// direkt mit dem Hub – so braucht der Browser keine Zertifikatsausnahme und das
// Pinning bleibt allein im Agent.
import http from 'node:http';
import { createReadStream, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const STATIC = new Map([
  ['/player/', [join(ROOT, 'player', 'chromium', 'index.html'), 'text/html; charset=utf-8']],
  ['/player/player.js', [join(ROOT, 'player', 'chromium', 'player.js'), 'text/javascript; charset=utf-8']],
  ['/player/player.css', [join(ROOT, 'player', 'chromium', 'player.css'), 'text/css; charset=utf-8']],
  ['/shared/sequencer.js', [join(ROOT, 'shared', 'sequencer.js'), 'text/javascript; charset=utf-8']],
  ['/shared/time.js', [join(ROOT, 'shared', 'time.js'), 'text/javascript; charset=utf-8']],
  ['/assets/dfm-logo.svg', [join(ROOT, 'assets', 'dfm-logo.svg'), 'image/svg+xml']],
]);
const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" };

function sniff(file) {
  const b = Buffer.alloc(12); const fd = openSync(file, 'r'); try { readSync(fd, b, 0, 12, 0); } finally { closeSync(fd); } // nur die ersten Bytes – nicht die ganze Datei in den Arbeitsspeicher laden
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'; if (b.subarray(1, 4).toString() === 'PNG') return 'image/png';
  if (b.subarray(4, 8).toString() === 'ftyp') return 'video/mp4'; return 'application/octet-stream';
}

/** Datei (oder Teil) senden; Lesefehler (Datei verschwindet) oder ein abgebrochener Abruf beenden nur diese eine Antwort, nie den Dienst */
function pipeFile(res, f, range) {
  const s = createReadStream(f, range); s.on('error', () => res.destroy()); res.on('close', () => s.destroy()); s.pipe(res);
}

export function createLocalServer({ getPlan, getManifest, getHealth, onStatus = () => {}, mediaDir, port = 8080 }) {
  const clients = new Set(); let frame = null, frameN = 0; // Bildschirm teilen: zuletzt empfangenes Bild
  const server = http.createServer((req, res) => {
    try { handle(req, res); } catch { try { if (!res.headersSent) res.writeHead(500, HEAD); res.end(); } catch { /* Verbindung schon weg */ } } // ein Fehler bei einer Anfrage darf nie den Agenten beenden
  });
  function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1'); const p = url.pathname;
    if (req.method === 'POST' && p === '/status') { // „Ist“-Meldung der Playerseite (nur Loopback, klein, nur JSON)
      let n = 0; const chunks = []; req.on('data', (c) => { n += c.length; if (n > 4096) req.destroy(); else chunks.push(c); });
      req.on('end', () => { try { onStatus(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204, HEAD).end(); } catch { res.writeHead(400, HEAD).end(); } }); return;
    }
    if (req.method !== 'GET') { res.writeHead(405, HEAD).end(); return; }
    if (STATIC.has(p)) { const [f, t] = STATIC.get(p); if (!existsSync(f)) { res.writeHead(404, HEAD).end(); return; } res.writeHead(200, { ...HEAD, 'Content-Type': t }); pipeFile(res, f); return; }
    if (p === '/share/frame.jpg') { if (!frame) { res.writeHead(404, HEAD).end(); return; } res.writeHead(200, { ...HEAD, 'Content-Type': 'image/jpeg', 'Content-Length': frame.length }); res.end(frame); return; }
    if (p === '/plan.json') return json(res, getPlan() ?? { segments: [], playlists: {}, defaultPlaylistId: null });
    if (p === '/manifest.json') return json(res, getManifest() ?? { items: [] });
    if (p === '/health') return json(res, getHealth());
    if (p === '/events') {
      res.writeHead(200, { ...HEAD, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write('retry: 2000\n\n');
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    const m = /^\/media\/([0-9a-f-]{36})$/.exec(p); // Kein Pfad aus Nutzereingabe: nur UUIDs
    if (m) {
      const f = join(mediaDir, m[1]); if (!existsSync(f)) { res.writeHead(404, HEAD).end(); return; }
      const size = statSync(f).size, type = sniff(f), r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (r && (r[1] || r[2])) {
        const s = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2])), e = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        if (s > e) { res.writeHead(416, { ...HEAD, 'Content-Range': `bytes */${size}` }).end(); return; }
        res.writeHead(206, { ...HEAD, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1, 'Cache-Control': 'no-store' }); pipeFile(res, f, { start: s, end: e }); return;
      }
      res.writeHead(200, { ...HEAD, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size }); pipeFile(res, f); return;
    }
    res.writeHead(404, HEAD).end();
  }
  const json = (res, o) => { res.writeHead(200, { ...HEAD, 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  return {
    listen: () => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { for (const c of clients) c.end(); server.close(() => r()); }),
    setFrame(buf) { frame = buf; frameN++; this.emit('share', { n: frameN }); },
    clearFrame() { const had = !!frame; frame = null; if (had) this.emit('shareend', {}); },
    emit: (event, data = {}) => { for (const c of clients) { try { c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { clients.delete(c); } } },
  };
}
