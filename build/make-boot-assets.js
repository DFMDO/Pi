// Erzeugt Bilder für Boot-Splash und Lite-Player (mpv hat keinen Browser): Standby, Warten, Uhrzeit, Hilfe.
// Läuft auf dem Entwicklungsrechner beim Image-Bau. Farben kommen aus assets/dfm-theme.css.
import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), out = process.argv[2] ?? join(root, 'build', 'work', 'assets');
mkdirSync(out, { recursive: true });
const css = readFileSync(join(root, 'assets', 'dfm-theme.css'), 'utf8'), v = (n, d) => (new RegExp(`--dfm-${n}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css) ?? [])[1] ?? d;
const BG = v('secondary', '#1a1a1a'), RED = v('primary', '#c8102e');
const logoSvg = readFileSync(join(root, 'assets', 'dfm-logo.svg'));
const logo = (w) => sharp(logoSvg, { density: 300 }).resize({ width: w }).png().toBuffer();
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function screen(name, text, W = 1920, H = 1080) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${BG}"/>${text ? `<text x="${W / 2}" y="${H * 0.78}" text-anchor="middle" font-family="Inter, DejaVu Sans, sans-serif" font-size="48" fill="#fff">${esc(text)}</text>` : ''}</svg>`;
  await sharp(Buffer.from(svg)).composite([{ input: await logo(Math.round(W * 0.28)), gravity: 'center' }]).png({ compressionLevel: 9 }).toFile(join(out, name));
}
await screen('standby.png', '');
await screen('wartet.png', 'Einen Moment bitte – der Bildschirm startet gleich.');
await screen('uhrzeit.png', 'Die Uhrzeit wird eingestellt. Einen Moment bitte.');
await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#000000' } }).png().toFile(join(out, 'schwarz.png'));
await screen('hilfe.png', 'Dieser Bildschirm wartet auf Verbindung. Bitte die Museums-IT informieren.');
await sharp(await logo(360)).toFile(join(out, 'logo.png'));
await sharp({ create: { width: 16, height: 8, channels: 3, background: RED } }).png().toFile(join(out, 'bar.png'));
console.log('Bilder erzeugt in', out);
