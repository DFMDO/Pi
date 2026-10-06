// Erzeugt docs/openapi.json (OpenAPI 3.1) aus den echten Routen des Hubs – so stimmt die Doku immer mit dem Code überein.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../hub/app.js';
import { ensureCertificate } from '../hub/lib/tls.js';

const dir = mkdtempSync(join(tmpdir(), 'oa-')); const tls = ensureCertificate(join(dir, 'tls'), ['DNS:localhost']);
const app = await buildApp({ dataDir: dir, tls }); await app.ready();
const paths = {};
for (const r of app.apiRoutes) for (const m of r.method.filter((x) => !['HEAD', 'OPTIONS'].includes(x))) {
  const url = r.url.replace(/:(\w+)/g, '{$1}'), c = r.config;
  const auth = c.public ? 'öffentlich (nur im Einrichtungs-/Pairing-Ablauf)' : c.device ? 'Geräte-Token (Bearer)' : c.perm ? `Sitzung + Recht „${c.perm}“` : 'Sitzung (angemeldet)';
  (paths[url] ??= {})[m.toLowerCase()] = { summary: auth, 'x-berechtigung': c.perm ?? null,
    parameters: [...url.matchAll(/\{(\w+)\}/g)].map((p) => ({ name: p[1], in: 'path', required: true, schema: { type: 'string' } })),
    ...(r.schema?.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.schema.body } } } } : {}),
    responses: { 200: { description: 'Erfolg' }, 400: { description: 'Eingabe ungültig (verständlicher Text im Feld "error")' }, ...(c.public ? {} : { 401: { description: 'Nicht angemeldet' } }), ...(c.perm ? { 403: { description: 'Berechtigung fehlt' } } : {}) } };
}
const doc = { openapi: '3.1.0', info: { title: 'DFM Signage Hub API', version: JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url))).version, description: 'Alle Routen liegen unter /api/v1. Anmeldung per Cookie (__Host-dfm_sid) mit CSRF-Header X-CSRF-Token bei schreibenden Aufrufen; Player nutzen ein Bearer-Token. WebSocket: siehe docs/websocket.md.' }, servers: [{ url: 'https://dfm-signage.local' }], paths: Object.fromEntries(Object.entries(paths).sort()) };
writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n'); console.log(`openapi.json: ${Object.keys(paths).length} Pfade`);
await app.close(); process.exit(0);
