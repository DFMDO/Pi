// Zusätzliche Bilder für die Übersicht (Erweiterung 0.2): Live mit Vorschaubildern, Schnellaktionen, Szenen, Entwürfe, Betrieb, Empfang,
// Wochenbericht, Vorlagen, QR, Prüfung, Wandmodus, Handy, Playerseite mit Laufband. Alles Demo-Daten.  Aufruf: node tools/make-screenshots-extra.js
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { makeHub, PW } from '../hub/test/helpers.js';
import { createLocalServer } from '../player/agent/lib/localserver.js';

const EXE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome'].find(existsSync);
const OUT = new URL('../docs/bilder/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' });
const base = `https://127.0.0.1:${h.app.server.address().port}`, a = await h.as('admin'), now = Date.now();
h.db.prepare("INSERT OR REPLACE INTO settings VALUES('wizard.done','true')").run();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const slide = (t, b, bg = '#1a1a1a', fg = '#fff') => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${bg}"/><rect width="18" height="540" fill="#c8102e"/><text x="70" y="230" font-family="DejaVu Sans" font-weight="700" font-size="58" fill="${fg}">${esc(t)}</text><text x="70" y="310" font-family="DejaVu Sans" font-size="30" fill="${fg}">${esc(b)}</text></svg>`)).jpeg({ quality: 80 }).toBuffer();
const mk = async (n, t, b, tpl) => (await a('POST', '/api/v1/media/text', { name: n, title: t, body: b, template: tpl })).json().id;
const m = { willkommen: await mk('Willkommen', 'Willkommen im Deutschen Fußballmuseum', 'Schön, dass du da bist!', 'standard'), sommer: await mk('Sommer-Aktion', 'Sommer-Aktion im Museumsshop', 'Alle Trikots 20 % günstiger', 'highlight'),
  fuehrung: await mk('Führungen heute', 'Führungen heute', '11:00 Öffentliche Führung\n14:00 Familienführung', 'standard'), eroeffnung: await mk('Eröffnung Sonderausstellung', 'Eröffnung: 1954 – Das Wunder von Bern', 'Heute 18 Uhr im Foyer', 'highlight'), tickets: await mk('Tickets', 'Bitte Tickets bereithalten', 'Danke!', 'hinweis') };
const plist = async (name, items, def) => { const id = def ? h.db.prepare('SELECT id FROM playlists WHERE is_default=1').get().id : (await a('POST', '/api/v1/playlists', { name, publish: true })).json().id; await a('PUT', `/api/v1/playlists/${id}`, { name, items: items.map((x) => ({ mediaId: x, duration: 10 })), publish: true }); return id; };
const std = await plist('Standard', [m.willkommen, m.fuehrung, m.tickets], true), shopL = await plist('Shop', [m.sommer, m.willkommen]), eroL = await plist('Eröffnung', [m.eroeffnung]);
const g1 = (await a('POST', '/api/v1/groups', { name: 'Erdgeschoss', color: '#2a6f97' })).json().id, g2 = (await a('POST', '/api/v1/groups', { name: '1. Obergeschoss', color: '#5a8f29' })).json().id;
const DEV = [['Foyer-Eingang', g1, 'EG', 'Foyer', 5e3, m.willkommen, {}], ['Kasse', g1, 'EG', 'Kassenbereich', 8e3, m.tickets, {}], ['Shop-Screen', g1, 'EG', 'Museumsshop', 4e3, m.sommer, {}], ['Ausstellung 1954', g2, '1.OG', 'Raum 1954', 6e3, m.fuehrung, { throttled: 0x50005 }], ['Café', g2, '1.OG', 'Café', 12e3, m.willkommen, { signalDbm: -79 }], ['Treppenhaus', g2, '1.OG', 'Treppe', 13 * 60e3, m.fuehrung, {}]];
const ids = {};
for (const [name, g, floor, loc, age, cur, extra] of DEV) {
  const id = randomUUID(); ids[name] = id;
  const st = { version: '0.2.0', cpuTemp: 51.2, ramUsedMB: 640, ramTotalMB: 3796, signalDbm: -58, diskFreeMB: 18000, throttled: 0, timeSynced: true, uptimeS: 86400, reconnects: 1, wifi: { ssid: 'DFM-Signage', bssid: '24:a4:3c:11:22:' + String(10 + Object.keys(ids).length), channel: 6, band: '2,4 GHz' }, syncState: { done: 5, total: 5 },
    playerStatus: { current: { mediaId: cur, name: h.db.prepare('SELECT name FROM media WHERE id=?').get(cur).name, kind: 'text', since: now - 4000, duration: 10 }, next: { mediaId: m.fuehrung, name: 'Führungen heute' }, source: 'standard', ts: now }, ...extra };
  h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,model,group_id,created_at,state_json,floor,location,serial,installed_at) VALUES(?,?,'pro','active',?,?,?,?,?,?,?,?,?)").run(id, name, now - age, 'Raspberry Pi 4 Model B', g, now - 40 * 864e5, JSON.stringify(st), floor, loc, '10000000' + id.slice(0, 8), '2026-09-01');
  const t = JSON.parse(h.db.prepare('SELECT text_json FROM media WHERE id=?').get(cur).text_json);
  h.app.devices.shots.set(id, { buf: await slide(t.title.slice(0, 30), (t.body ?? '').split('\n')[0], t.template === 'highlight' ? '#c8102e' : t.template === 'hinweis' ? '#f2a900' : '#1a1a1a', t.template === 'hinweis' ? '#1a1a1a' : '#fff'), mime: 'image/jpeg', ts: age > 60e3 ? now - age : now - 3000 });
  for (let i = 0; i < 48; i++) h.db.prepare('INSERT INTO wifi_history(device_id,ts,signal_dbm,quality,bssid,ssid,channel,band,reconnects) VALUES(?,?,?,?,?,?,?,?,?)').run(id, now - (48 - i) * 30 * 60e3, (extra.signalDbm ?? -58) + Math.round(Math.sin(i / 3) * 4), 'gut', st.wifi.bssid, 'DFM-Signage', 6, '2,4 GHz', i < 30 ? 0 : 2);
}
h.db.prepare('INSERT INTO device_events(device_id,ts,kind,detail) VALUES(?,?,?,NULL),(?,?,?,NULL)').run(ids['Café'], now - 3 * 864e5, 'offline', ids['Café'], now - 3 * 864e5 + 25 * 60e3, 'online');
h.db.prepare("UPDATE devices SET layout_json=? WHERE id=?").run(JSON.stringify({ preset: 'ticker-clock' }), ids['Foyer-Eingang']);
await a('POST', '/api/v1/tickers', { text: 'Heute 18 Uhr: Eröffnung der Sonderausstellung „1954 – Das Wunder von Bern“ im Foyer' });
// Szenen, Übersteuerung, Termine (auch Entwurf)
const sc = (await a('POST', '/api/v1/scenes', { name: 'Eröffnung', items: [{ scope: 'group', targetId: g1, content: { type: 'playlist', id: eroL } }], publish: true })).json().id; void sc;
await a('POST', '/api/v1/scenes', { name: 'Schulklassen-Tag', items: [{ scope: 'all', content: { type: 'media', id: m.willkommen } }] });
await a('POST', '/api/v1/overrides', { scope: 'device', targetId: ids['Shop-Screen'], content: { type: 'playlist', id: shopL }, minutes: 120 });
const d0 = new Date(); const mon = new Date(d0); mon.setDate(d0.getDate() - ((d0.getDay() + 6) % 7)); const day = (n) => { const x = new Date(mon); x.setDate(mon.getDate() + n); return x.toISOString().slice(0, 10); };
await a('POST', '/api/v1/schedules', { publish: true, targetType: 'group', targetId: g1, content: { type: 'playlist', id: eroL }, startLocal: `${day(3)}T17:00`, endLocal: `${day(3)}T21:00`, priority: 7 });
await a('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: ids['Shop-Screen'], content: { type: 'playlist', id: shopL }, startLocal: `${day(1)}T10:00`, endLocal: `${day(1)}T14:00`, rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' });
await a('POST', '/api/v1/schedules', { targetType: 'group', targetId: g2, content: { type: 'media', id: m.fuehrung }, startLocal: `${day(4)}T09:00`, endLocal: `${day(4)}T13:00` }); // Entwurf
await h.app.variants.idle();

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--ignore-certificate-errors'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' }), page = await ctx.newPage();
const snap = async (p, name, opt = {}) => { await p.waitForTimeout(700); await p.screenshot({ path: OUT + name + '.png', ...opt }); console.log('✔', name); };
const go = async (link, head) => { await page.getByRole('link', { name: link }).first().click(); await page.getByRole('heading', { name: head, exact: true }).first().waitFor(); };
await page.goto(base); await page.getByLabel('Benutzername').fill('admin'); await page.getByLabel('Passwort').fill(PW); await page.getByRole('button', { name: 'Anmelden' }).click(); await page.getByRole('heading', { name: 'Startseite' }).waitFor();
await snap(page, '30-startseite-schnellaktionen');
await go(/Live/, 'Live'); await page.locator('.liveshot img').first().waitFor(); await snap(page, '31-live', { fullPage: true });
await page.locator('.livetile', { hasText: 'Shop-Screen' }).click(); await page.getByRole('dialog').getByText('Herkunft').waitFor(); await snap(page, '32-live-einzelansicht'); await page.keyboard.press('Escape');
await go(/Szenen/, 'Szenen'); await snap(page, '33-szenen');
await go(/Kalender/, 'Kalender'); await page.waitForTimeout(800); await snap(page, '34-kalender-entwurf', { fullPage: true });
await page.getByRole('button', { name: /Feiertage/ }).click(); await page.getByRole('dialog').waitFor(); await snap(page, '35-feiertage'); await page.keyboard.press('Escape');
await go(/Betrieb/, 'Betrieb'); await page.getByText('Netzteil').first().waitFor(); await snap(page, '36-betrieb-gesundheit', { fullPage: true });
await page.getByRole('tab', { name: /WLAN-Empfang/ }).click(); await page.getByText(/Funkmessung/).waitFor(); await snap(page, '37-wlan-empfang', { fullPage: true });
await page.getByRole('tab', { name: /Wochenbericht/ }).click(); await page.getByText('Verfügbarkeit').first().waitFor(); await snap(page, '38-wochenbericht');
await page.getByRole('tab', { name: /Laufband/ }).click(); await page.getByText('Zonen-Layout je Bildschirm').waitFor(); await snap(page, '39-laufband-zonen', { fullPage: true });
await go(/Bilder & Videos/, 'Bilder & Videos'); await page.getByRole('button', { name: /Vorlage verwenden/ }).click(); await page.getByRole('dialog').getByText(/Lesbarkeit in Ordnung|Text ist/).first().waitFor(); await snap(page, '40-vorlage'); await page.getByRole('button', { name: 'Abbrechen' }).click();
await page.getByRole('button', { name: /QR-Code erstellen/ }).click(); await page.getByLabel('Adresse (http/https)').fill('https://www.fussballmuseum.de/tickets'); await page.getByLabel('Überschrift').fill('Tickets online kaufen'); await page.getByRole('dialog').getByText('Gegenprobe bestanden').waitFor(); await snap(page, '41-qr-code'); await page.keyboard.press('Escape');
// Prüfung mit simuliertem Bildschirm
const did = ids['Kasse']; h.app.devices.sockets.set(did, { readyState: 1, send(raw) { const x = JSON.parse(raw); if (x.command === 'diagnose') setTimeout(() => h.db.prepare("UPDATE commands SET status='done', result_json=? WHERE id=?").run(JSON.stringify({ cpuTemp: 49, signalDbm: -56, timeSynced: true, epoch: Date.now(), diskFreeMB: 18000, throttled: 0, throughputMBs: 3.8, testvideo: { percent: 0 }, syncState: { done: 5, total: 5 }, version: '0.2.0' }), x.id), 50); } });
await go(/Betrieb/, 'Betrieb'); await page.locator('article', { hasText: 'Kasse' }).getByRole('button', { name: 'Bildschirm prüfen' }).click(); await page.getByRole('dialog').getByText('Bildtest').waitFor(); await snap(page, '42-bildschirm-pruefen');
await page.getByRole('dialog').getByRole('button', { name: 'Ja', exact: true }).click(); await page.getByRole('dialog').getByText('Bestanden').waitFor(); await snap(page, '43-pruefung-bestanden'); await page.keyboard.press('Escape');
await go(/Benutzer/, 'Benutzer'); await snap(page, '44-benutzer-rollen', { fullPage: true });
// Wandmodus
const tk = (await a('POST', '/api/v1/live-tokens', { name: 'Technikraum' })).json().token;
const wall = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, locale: 'de-DE' })).newPage(); await wall.goto(`${base}/#/wand`); await wall.getByLabel('Zugangs-Token').fill(tk); await wall.getByRole('button', { name: 'Öffnen' }).click(); await wall.locator('.liveshot img').first().waitFor(); await snap(wall, '45-wandmodus');
// Handy
const ph = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, locale: 'de-DE' })).newPage(); await ph.goto(base); await ph.getByLabel('Benutzername').fill('vera'); await ph.getByLabel('Passwort').fill(PW); await ph.getByRole('button', { name: 'Anmelden' }).click(); await ph.locator('.liveshot img').first().waitFor(); await ph.locator('main h1').scrollIntoViewIfNeeded(); await ph.evaluate(() => document.querySelector('main').scrollIntoView()); await snap(ph, '46-handy-live');
// Playerseite mit Laufband und Uhr
const plan = { segments: [], playlists: { p: { name: 'Standard', items: [{ mediaId: 'w', duration: 30, transition: 'fade' }] } }, defaultPlaylistId: 'p', layout: { preset: 'ticker-clock' }, tickers: [{ text: 'Heute 18 Uhr: Eröffnung der Sonderausstellung „1954 – Das Wunder von Bern“ im Foyer  •  Führungen um 11 und 14 Uhr' }] };
const srv = createLocalServer({ getPlan: () => plan, getManifest: () => ({ items: [{ id: 'w', kind: 'text', name: 'Willkommen', text: { title: 'Willkommen im Deutschen Fußballmuseum', body: 'Schön, dass du da bist!', template: 'standard' } }] }), getHealth: () => ({ cached: [], profile: 'pro' }), mediaDir: mkdtempSync(tmpdir() + '/m'), port: 0 }); const port = await srv.listen();
const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); await tv.goto(`http://127.0.0.1:${port}/player/`); await tv.locator('.text h1').waitFor(); await tv.waitForTimeout(2500); await snap(tv, '47-bildschirm-laufband');
srv.emit('identify', { name: 'Foyer-Eingang', location: 'EG · Foyer', number: '7F3A', seconds: 10 }); await tv.locator('.ident').waitFor(); await snap(tv, '48-bildschirm-erkennen');
await browser.close(); await srv.close(); await h.cleanup(); process.exit(0);
