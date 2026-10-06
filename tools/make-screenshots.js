// Erzeugt die Bilder für das Anwenderhandbuch (echte Screenshots der echten Oberflächen mit Demo-Daten).
// Aufruf: node tools/make-screenshots.js     (benötigt Chromium; Ausgabe: docs/bilder/*.png)
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { makeHub, PW, multipart } from '../hub/test/helpers.js';
import { createController } from '../setup/lib/controller.js';
import { createServers } from '../setup/setup.js';
import { checkPasswordPolicy, hashPassword } from '../hub/lib/crypto.js';

const EXE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome'].find(existsSync);
const OUT = new URL('../docs/bilder/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' });
const base = `https://127.0.0.1:${h.app.server.address().port}`; const admin = await h.as('admin');
h.db.prepare("INSERT OR REPLACE INTO settings VALUES('wizard.done','true')").run();
const now = Date.now(), dev = (name, lvl, m, g) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,model,group_id,created_at,state_json) VALUES(?,?,?,'active',?,?,?,?,?)").run(id, name, 'pro', now - lvl, m, g, now, JSON.stringify({ cpuTemp: 48.5, ramUsedMB: 612, ramTotalMB: 3796, signalDbm: -54, syncState: { done: 4, total: 4 }, nowPlaying: { name: 'Sommer-Aktion' } })); return id; };
const grp = (await admin('POST', '/api/v1/groups', { name: 'Foyer', color: '#2a6f97' })).json().id;
const shop = dev('Shop-Screen', 5000, 'Raspberry Pi 4 Model B', null), foyer = dev('Foyer-Eingang', 5 * 60000, 'Raspberry Pi 4 Model B', grp), cafe = dev('Café', 30 * 3600000, 'Raspberry Pi 3 Model B+', null);
const mk = async (n, t, b, tpl) => (await admin('POST', '/api/v1/media/text', { name: n, title: t, body: b, template: tpl })).json().id;
const [m1, m2, m3] = [await mk('Sommer-Aktion', 'Sommer-Aktion im Museumsshop', 'Alle Trikots 20 % günstiger – nur diese Woche.', 'highlight'), await mk('Willkommen', 'Willkommen im Deutschen Fußballmuseum', 'Schön, dass du da bist!', 'standard'), await mk('Hinweis Einlass', 'Bitte Tickets bereithalten', 'Der Einlass erfolgt am Haupteingang.', 'hinweis')];
for (const [c, col] of [['#c8102e', '#c8102e'], ['#1a1a1a', '#1a1a1a']]) { const b = multipart('file', `Stadion-${col.slice(1)}.jpg`, await sharp({ create: { width: 1920, height: 1080, channels: 3, background: c } }).jpeg().toBuffer()); await admin('POST', '/api/v1/media', b.payload, b.headers); }
const pl = h.db.prepare('SELECT id FROM playlists WHERE is_default=1').get().id;
await admin('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m2, duration: 10 }, { mediaId: m3, duration: 8 }], publish: true });
const p2 = (await admin('POST', '/api/v1/playlists', { name: 'Sommer-Aktion' })).json().id; await admin('PUT', `/api/v1/playlists/${p2}`, { items: [{ mediaId: m1, duration: 12 }, { mediaId: m2, duration: 8 }], publish: true });
const d0 = new Date(); const mon = new Date(d0); mon.setDate(d0.getDate() - ((d0.getDay() + 6) % 7)); const day = (n) => { const x = new Date(mon); x.setDate(mon.getDate() + n); return x.toISOString().slice(0, 10); };
await admin('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: shop, content: { type: 'playlist', id: p2 }, startLocal: `${day(1)}T10:00`, endLocal: `${day(1)}T14:00`, priority: 6, rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
await admin('POST', '/api/v1/schedules', { publish: true, targetType: 'group', targetId: grp, content: { type: 'playlist', id: pl }, startLocal: `${day(2)}T09:00`, endLocal: `${day(2)}T12:00`, priority: 5 });
await admin('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: cafe, content: { type: 'media', id: m3 }, startLocal: `${day(4)}T08:00`, endLocal: `${day(4)}T18:00`, priority: 4 });
await h.app.variants.idle();
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' })).newPage();
const snap = async (name, opt = {}) => { await page.waitForTimeout(500); await page.screenshot({ path: OUT + name + '.png', ...opt }); console.log('✔', name); };
await page.goto(base); await snap('01-anmelden');
await page.getByLabel('Benutzername').fill('admin'); await page.getByLabel('Passwort').fill(PW); await page.getByRole('button', { name: 'Anmelden' }).click(); await page.getByRole('heading', { name: 'Startseite' }).waitFor();
await snap('02-startseite', { fullPage: true });
await page.getByRole('link', { name: /Bildschirme/ }).click(); await page.getByRole('heading', { name: 'Bildschirme' }).waitFor(); await snap('03-bildschirme', { fullPage: true });
await page.getByRole('button', { name: /Neuen Bildschirm verbinden/ }).click(); await page.getByText('Einrichtungscode:').waitFor(); await snap('04-bildschirm-verbinden'); await page.getByRole('button', { name: 'Fertig' }).click();
await page.getByRole('link', { name: /Bilder & Videos/ }).click(); await page.getByRole('heading', { name: 'Bilder & Videos' }).waitFor(); await snap('05-medien', { fullPage: true });
await page.getByRole('button', { name: /Text-Ankündigung erstellen/ }).click(); await page.getByLabel('Überschrift').fill('Heute länger geöffnet'); await page.getByLabel('Text', { exact: true }).fill('Bis 20 Uhr für dich da.'); await snap('06-text-ankuendigung'); await page.getByRole('button', { name: 'Abbrechen' }).click();
await page.getByRole('link', { name: /Abspiellisten/ }).click(); await page.getByRole('heading', { name: 'Abspiellisten' }).waitFor(); await page.getByRole('button', { name: 'Bearbeiten' }).first().click(); await snap('07-abspielliste'); await page.getByRole('button', { name: 'Abbrechen' }).click();
await page.getByRole('link', { name: /Kalender/ }).click(); await page.getByRole('heading', { name: 'Kalender' }).waitFor(); await page.waitForTimeout(600); await snap('08-kalender', { fullPage: true });
await page.getByRole('button', { name: /Neuer Termin/ }).click(); const dlg = page.getByRole('dialog'); await dlg.getByLabel('Datum').fill(day(5)); await dlg.getByRole('button', { name: 'Vorschau ansehen' }).click(); await dlg.getByText(/So sieht der Bildschirm/).waitFor(); await snap('09-termin-planen'); await page.keyboard.press('Escape');
await page.getByRole('link', { name: /Hilfe/ }).click(); await page.getByRole('heading', { name: /Hilfe/ }).waitFor(); await snap('10-hilfe');
await page.getByRole('link', { name: 'Erweitert' }).click(); await page.getByRole('heading', { name: 'Erweitert' }).waitFor(); await snap('11-erweitert', { fullPage: true });
// Handy-Einrichtung + Bildschirmanzeige
let t = 1e6; const nm = { scan: async () => [{ ssid: 'Museum-Signage', signal: 82, secure: true }, { ssid: 'Museum-Gast', signal: 55, secure: true }, { ssid: 'FRITZ!Box 7590', signal: 31, secure: true }], startHotspot: async () => true, stopHotspot: async () => {}, connect: async () => ({ ok: true }), disconnect: async () => {}, wifiConnected: async () => false, stations: async () => 0 };
const ctl = createController({ nm, suffix: 'k7m4', now: () => t, hashPassword, policy: checkPasswordPolicy, hw: { model: 'Raspberry Pi 4 Model B', profile: 'pro' }, writeConfig: async () => {}, discoverHub: async () => null });
await ctl.startMode(); const { portal, display } = createServers(ctl); await new Promise((r) => portal.listen(0, '127.0.0.1', r)); await new Promise((r) => display.listen(0, '127.0.0.1', r));
const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); await tv.goto(`http://127.0.0.1:${display.address().port}`); await tv.waitForTimeout(1500); await tv.screenshot({ path: OUT + '20-bildschirm-schritt1.png' }); console.log('✔ 20');
nm.stations = async () => 1; await ctl.tick(); await tv.waitForTimeout(1500); await tv.screenshot({ path: OUT + '21-bildschirm-schritt2.png' }); console.log('✔ 21');
const ph = await (await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage(); const P = `http://127.0.0.1:${portal.address().port}`;
await ph.goto(P); await ph.waitForTimeout(400); await ph.screenshot({ path: OUT + '22-handy-pin.png' });
await ph.getByLabel('PIN').fill(ctl.state.pin); await ph.getByRole('button', { name: 'Weiter' }).click(); await ph.getByRole('heading', { name: 'WLAN wählen' }).waitFor(); await ph.getByRole('button', { name: /Museum-Signage/ }).click(); await ph.waitForTimeout(300); await ph.screenshot({ path: OUT + '23-handy-wlan.png' });
await ph.getByLabel('WLAN-Passwort').fill('wlanpasswort1'); await ph.getByRole('button', { name: 'WLAN prüfen und weiter' }).click(); await ph.getByRole('heading', { name: 'Was ist dieses Gerät?' }).waitFor({ timeout: 20000 }); await ph.getByRole('button', { name: /Bildschirm \(Player\)/ }).click(); await ph.screenshot({ path: OUT + '24-handy-rolle.png' });
await ph.getByRole('button', { name: 'Weiter' }).click(); await ph.getByLabel(/Einrichtungscode/).fill('K7M4-X9RD'); await ph.waitForTimeout(300); await ph.screenshot({ path: OUT + '25-handy-details.png' });
await browser.close(); portal.closeAllConnections(); display.closeAllConnections(); await h.cleanup(); process.exit(0);
