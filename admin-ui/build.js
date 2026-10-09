// Baut die Admin-Oberfläche statisch: ein JS-, ein CSS-Bündel (Hash im Namen), alles lokal,
// dazu .br/.gz-Vorkompression. Läuft nur auf dem Entwicklungsrechner.
import { build } from 'esbuild';
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url)), dist = join(here, 'dist'), root = join(here, '..');
rmSync(dist, { recursive: true, force: true }); mkdirSync(join(dist, 'assets'), { recursive: true });
// Zentrale Design-Variablen aus /assets in das Bündel einbinden
writeFileSync(join(here, 'src', 'theme.generated.css'), readFileSync(join(root, 'assets', 'dfm-theme.css')));
// Hintergrund-Thread für „Bildschirm teilen“: eigene Datei (CSP erlaubt nur Skripte vom eigenen Server), ihr Name wird ins Hauptbündel eingetragen
const wk = await build({ entryPoints: { 'share-worker': join(here, 'src', 'share-worker.js') }, bundle: true, minify: true, format: 'iife', target: 'es2022', outdir: join(dist, 'assets'), entryNames: '[name].[hash]', metafile: true, write: true, legalComments: 'none' });
const workerFile = Object.keys(wk.metafile.outputs).map((f) => f.split('/').pop()).find((f) => f.endsWith('.js'));
const r = await build({ define: { __SHARE_WORKER__: JSON.stringify('/assets/' + workerFile) }, entryPoints: { app: join(here, 'src', 'main.js') }, bundle: true, minify: true, format: 'esm', target: 'es2022', outdir: join(dist, 'assets'), entryNames: '[name].[hash]', metafile: true, write: true, loader: { '.css': 'css' }, legalComments: 'none' });
const out = Object.keys(r.metafile.outputs).map((f) => f.split('/').pop());
const js = out.find((f) => f.endsWith('.js')), css = out.find((f) => f.endsWith('.css'));
copyFileSync(join(root, 'assets', 'dfm-logo.svg'), join(dist, 'logo.svg'));
copyFileSync(join(root, 'assets', 'browser-warnung.svg'), join(dist, 'browser-warnung.svg'));
const html = readFileSync(join(here, 'src', 'index.html'), 'utf8').replace('%JS%', `/assets/${js}`).replace('%CSS%', css ? `/assets/${css}` : '');
writeFileSync(join(dist, 'index.html'), html);
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk(dist)) if (/\.(js|css|html|svg)$/.test(f)) { const b = readFileSync(f); writeFileSync(f + '.gz', gzipSync(b, { level: 9 })); writeFileSync(f + '.br', brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })); }
const gz = walk(dist).filter((f) => f.endsWith('.js.gz') || f.endsWith('.css.gz') || f.endsWith('index.html.gz')).reduce((n, f) => n + statSync(f).size, 0);
console.log(`Admin-UI gebaut: ${js}${css ? ', ' + css : ''} – Startseite gesamt ${(gz / 1024).toFixed(1)} KB gzip`);
if (gz > 300 * 1024) { console.error('Startseite > 300 KB gzip!'); process.exit(1); }
