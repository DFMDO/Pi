// Ende-zu-Ende-Test im echten Chromium: Admin-UI, Einrichtungsseite, Playerseite.
// Prüft zugleich das Prinzip „lokal“: Jede Anfrage an einen fremden Host lässt den Test scheitern,
// und der Browser darf das Internet gar nicht erst erreichen (Host-Resolver blockiert alles außer localhost).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import sharp from 'sharp';
import { makeHub, PW, multipart } from '../hub/test/helpers.js';
import { createController } from '../setup/lib/controller.js';
import { createServers } from '../setup/setup.js';
import { Agent } from '../player/agent/agent.js';
import { checkPasswordPolicy, hashPassword } from '../hub/lib/crypto.js';

const EXE = [process.env.DFM_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome'].filter(Boolean).find(existsSync);
const ARGS = ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--ignore-certificate-errors'];
const skip = !EXE && 'Chromium nicht vorhanden';

function watch(page, hosts) {
  const bad = [], errors = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) bad.push(r.url()); });
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(400|401|403|404|409)/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { bad, errors };
}

test('Admin-UI: Anmelden, Text anlegen, Liste, Termin per Satz, Bedienung per Tastatur – ohne externe Anfragen', { skip, timeout: 120000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `https://127.0.0.1:${h.app.server.address().port}`;
  h.db.prepare("INSERT OR REPLACE INTO settings VALUES('wizard.done','true')").run();
  const devId = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,model,created_at) VALUES(?,?,?,'active',?,?,?)").run(devId, 'Shop-Screen', 'standard', Date.now(), 'Raspberry Pi 4', Date.now());
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS }); const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const w = watch(page);
  await page.goto(base); await page.getByLabel('Benutzername').fill('admin'); await page.getByLabel('Passwort').fill('falsch'); await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.getByText('Benutzername oder Passwort stimmt nicht.').waitFor();
  await page.getByLabel('Passwort').fill(PW); await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.getByRole('heading', { name: 'Startseite' }).waitFor();
  assert.ok(await page.getByText('Shop-Screen: läuft').count(), 'Klartextsatz mit Status');
  assert.ok(await page.locator('.status', { hasText: 'Läuft' }).count(), 'Status als Text (nicht nur Farbe)');
  // Text-Ankündigung
  await page.getByRole('link', { name: /Bilder & Videos/ }).click(); await page.getByRole('button', { name: /Text-Ankündigung erstellen/ }).click();
  await page.getByLabel('Überschrift').fill('Sommer <b>Aktion</b>'); await page.getByLabel('Text', { exact: true }).fill('Alles 20 % günstiger'); await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByText('Die Ankündigung wurde gespeichert.').waitFor();
  assert.equal(await page.locator('b b').count(), 0, 'HTML wird nicht interpretiert (XSS)'); assert.ok(await page.getByText('Sommer <b>Aktion</b>').count(), 'Text erscheint wörtlich');
  // Termin per Satz
  await page.getByRole('link', { name: /Kalender/ }).click(); await page.getByRole('button', { name: /Neuer Termin/ }).click();
  const dlg = page.getByRole('dialog'); await dlg.getByLabel('Datum').fill('2030-05-07'); await dlg.getByLabel('Von').fill('10:00'); await dlg.getByLabel('Bis').fill('12:00');
  await dlg.getByRole('button', { name: 'Vorschau ansehen' }).click(); await dlg.getByText(/So sieht der Bildschirm am Dienstag um 10:00 Uhr heute aus/).waitFor();
  await dlg.getByRole('button', { name: 'Speichern und veröffentlichen' }).click(); await page.getByText('Jetzt veröffentlichen?').waitFor(); await page.getByRole('dialog').last().getByRole('button', { name: 'Veröffentlichen', exact: true }).click(); await page.getByText(/Veröffentlicht\. Die Bildschirme/).waitFor();
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM schedules').get().n, 1);
  assert.equal(h.db.prepare('SELECT start_local FROM schedules').get().start_local, '2030-05-07T10:00');
  // Tastatur: Fokus sichtbar, Tab-Reihenfolge erreicht Navigation
  await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement !== document.body));
  // Mindestgröße der Klickflächen (44×44 px)
  const small = await page.$$eval('button, a.btn, nav a, select, input:not([type=checkbox]):not([type=radio]):not([type=file])', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && (r.height < 43.5 || r.width < 43.5) && getComputedStyle(e).visibility !== 'hidden'; }).map((e) => e.outerHTML.slice(0, 80)));
  assert.deepEqual(small.filter((s) => !/skip|class="help"/.test(s)), [], 'Klickflächen mindestens 44×44 px');
  assert.deepEqual(w.bad, [], 'keine Anfragen an externe Hosts'); assert.deepEqual(w.errors, [], 'keine Konsolenfehler');
  await browser.close(); await h.cleanup();
});

test('Rechte in der Oberfläche: Rolle Anzeige sieht nur die Live-Ansicht', { skip, timeout: 60000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' });
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS }); const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await page.goto(`https://127.0.0.1:${h.app.server.address().port}`); await page.getByLabel('Benutzername').fill('vera'); await page.getByLabel('Passwort').fill(PW); await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.getByRole('heading', { name: 'Live' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Kalender' }).count(), 0); assert.equal(await page.getByRole('link', { name: 'Bilder & Videos' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /Neuen Bildschirm verbinden/ }).count(), 0); assert.equal(await page.getByRole('link', { name: 'Benutzer' }).count(), 0); assert.equal(await page.getByRole('link', { name: 'Erweitert' }).count(), 0);
  await browser.close(); await h.cleanup();
});

test('Einrichtungsseite am Handy (iPhone-Größe): komplette Hub-Einrichtung, SSID-Injection wirkungslos, keine externen Anfragen', { skip, timeout: 120000 }, async () => {
  let t = 1e6; const log = [], written = [];
  const nm = { scan: async () => [{ ssid: '<img src=x onerror=window.__xss=1>', signal: 80, secure: true }, { ssid: 'Museum-Signage', signal: 60, secure: true }], startHotspot: async () => true, stopHotspot: async () => {}, connect: async (w) => (log.push(w), { ok: true }), disconnect: async () => {}, wifiConnected: async () => false, stations: async () => 1, hasLan: async () => false };
  const ctl = createController({ nm, suffix: 'ab12', now: () => t, hashPassword, policy: checkPasswordPolicy, hw: { model: 'Raspberry Pi 4 Model B', profile: 'pro' }, writeConfig: async (c, e) => written.push([c, e]) });
  await ctl.startMode(); const { portal, display } = createServers(ctl);
  await new Promise((r) => portal.listen(0, '127.0.0.1', r)); await new Promise((r) => display.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS }); const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' });
  const page = await ctx.newPage(); const w = watch(page); const P = `http://127.0.0.1:${portal.address().port}`;
  await page.goto(P); await page.getByLabel('PIN').fill('000000'); await page.getByRole('button', { name: 'Weiter' }).click(); await page.getByText(/Die PIN stimmt nicht/).waitFor();
  await page.getByLabel('PIN').fill(ctl.state.pin); await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByRole('heading', { name: 'WLAN wählen' }).waitFor(); assert.equal(await page.evaluate(() => window.__xss), undefined, 'SSID wird nicht als HTML ausgeführt');
  await page.getByRole('button', { name: /Museum-Signage/ }).click(); await page.getByLabel('WLAN-Passwort').fill('wlanpasswort1');
  await page.getByRole('button', { name: 'WLAN prüfen und weiter' }).click();
  await page.getByRole('heading', { name: 'Was ist dieses Gerät?' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: /Hauptbildschirm-Rechner/ }).click(); await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByLabel('Dein Name').fill('Chefin'); await page.locator('#ap').fill('kurz'); await page.getByRole('button', { name: 'Weiter' }).click(); await page.getByRole('alert').getByText(/mindestens 12 Zeichen/).waitFor();
  await page.locator('#ap').fill('Ein-gutes-langes-Passwort'); await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByRole('heading', { name: 'Fertig!' }).waitFor({ timeout: 30000 });
  assert.equal(written.length, 1); assert.equal(written[0][0].role, 'hub'); assert.ok(log.length >= 1);
  const small = await page.$$eval('button, input:not([type=checkbox])', (els) => els.filter((e) => e.getBoundingClientRect().height && e.getBoundingClientRect().height < 43.5).length); assert.equal(small, 0, 'große Buttons auf dem Handy');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); assert.equal(overflow, false, 'kein horizontales Scrollen');
  assert.deepEqual(w.bad, []); assert.deepEqual(w.errors, []);
  // Bildschirmanzeige: nie schwarz, zeigt Inhalt
  const dp = await ctx.newPage(); await dp.goto(`http://127.0.0.1:${display.address().port}`); await dp.getByText(/Fertig|Einen Moment|Schritt/).first().waitFor();
  await browser.close(); portal.closeAllConnections(); display.closeAllConnections(); portal.close(); display.close();
});

test('Playerseite: zeigt Termine aus dem lokalen Plan, kein Hub nötig, keine externen Anfragen, Besucher sehen keine Technikmeldung', { skip, timeout: 120000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pl-')); process.env.DFM_FAKE_TIMESYNC = '1';
  const img = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#0a7' } }).jpeg().toBuffer(); const mid = randomUUID();
  const { mkdirSync, writeFileSync: wf } = await import('node:fs'); mkdirSync(join(dataDir, 'cache', 'media'), { recursive: true }); wf(join(dataDir, 'cache', 'media', mid), img);
  const now = Date.now(); const pl = 'p1';
  wf(join(dataDir, 'cache', 'plan.json'), JSON.stringify({ generatedAt: now, from: now - 1e6, to: now + 1e9, segments: [{ start: now - 1e6, end: now + 1e9, source: { scheduleId: 's', content: { type: 'playlist', id: pl }, priority: 5 } }], defaultPlaylistId: null,
    playlists: { [pl]: { name: 'Test', items: [{ mediaId: 't1', duration: 2, transition: 'fade' }, { mediaId: mid, duration: 2, transition: 'cut' }] } } }));
  wf(join(dataDir, 'cache', 'manifest.json'), JSON.stringify({ items: [{ id: 't1', kind: 'text', name: 'T', text: { title: 'Hallo <i>Museum</i>', body: 'Willkommen', template: 'standard' } }, { id: mid, kind: 'image', name: 'Bild', sha256: 'x', size: img.length, url: '/x' }] }));
  wf(join(dataDir, 'agent.json'), JSON.stringify({ hubUrl: 'https://127.0.0.1:1', hubSpki: 'ab'.repeat(32), token: 'x'.repeat(40), profile: 'standard' }));
  const agent = new Agent({ dataDir, port: 0, pollMs: 1000 }); await agent.start();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS }); const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); const w = watch(page);
  await page.goto(`http://127.0.0.1:${agent.boundPort}/player/`);
  await page.getByText('Hallo <i>Museum</i>').waitFor({ timeout: 10000 });
  await page.locator('.layer img').waitFor({ timeout: 10000 });
  const body = await page.evaluate(() => document.body.innerText); assert.ok(!/fehler|offline|verbindung|error/i.test(body), 'keine Technikmeldung über den Inhalten: ' + body);
  assert.equal(await page.locator('i', { hasText: 'Museum' }).count(), 0, 'Text wird nicht als HTML interpretiert');
  assert.deepEqual(w.bad, []); assert.deepEqual(w.errors, []);
  await browser.close(); await agent.stop();
});

test('Oberfläche responsiv: iPad hochkant und Handy – kein horizontales Scrollen, Navigation erreichbar', { skip, timeout: 90000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' }); h.db.prepare("INSERT OR REPLACE INTO settings VALUES('wizard.done','true')").run();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS });
  for (const [name, vp] of [['iPad', { width: 768, height: 1024 }], ['iPad quer', { width: 1024, height: 768 }], ['Handy', { width: 390, height: 844 }]]) {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: vp })).newPage();
    await page.goto(`https://127.0.0.1:${h.app.server.address().port}`); await page.getByLabel('Benutzername').fill('admin'); await page.getByLabel('Passwort').fill(PW); await page.getByRole('button', { name: 'Anmelden' }).click();
    await page.getByRole('heading', { name: 'Startseite' }).waitFor();
    for (const link of ['Kalender', 'Bilder & Videos', 'Bildschirme']) { await page.getByRole('link', { name: new RegExp(link) }).click(); await page.waitForTimeout(300); const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert.ok(wide <= 1, `${name}: ${link} läuft ${wide}px über`); }
  }
  await browser.close(); await h.cleanup();
});

test('Zusatzseiten (Live mit 10 Bildschirmen, Betrieb, Szenen, Vorlage, QR, Wandmodus): schnell, ≥16 px, ≥44 px, keine externen Anfragen, Handy ohne Querscrollen', { skip, timeout: 180000 }, async () => {
  const h = await makeHub({ useTls: true }); await h.app.listen({ port: 0, host: '127.0.0.1' }); const base = `https://127.0.0.1:${h.app.server.address().port}`;
  h.db.prepare("INSERT OR REPLACE INTO settings VALUES('wizard.done','true')").run();
  for (let i = 0; i < 10; i++) h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,model,created_at) VALUES(?,?,?,'active',?,?,?)").run(randomUUID(), `Bildschirm ${i + 1}`, 'standard', Date.now(), 'Raspberry Pi 4', Date.now());
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS }); const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage(); const w = watch(page);
  await page.goto(base); await page.getByLabel('Benutzername').fill('admin'); await page.getByLabel('Passwort').fill(PW); await page.getByRole('button', { name: 'Anmelden' }).click(); await page.getByRole('heading', { name: 'Startseite' }).waitFor();
  assert.ok(await page.getByText('Schnellaktionen').count(), 'Schnellaktionen auf der Startseite');
  const t0 = Date.now(); await page.getByRole('link', { name: /Live/ }).click(); await page.getByRole('heading', { name: 'Live' }).waitFor(); await page.locator('.livetile').nth(9).waitFor(); const ms = Date.now() - t0;
  assert.equal(await page.locator('.livetile').count(), 10); assert.ok(ms < 3000, `Kachelansicht mit 10 Bildschirmen in ${ms} ms (< 3000)`); console.log(`# Live-Kachelansicht (10 Bildschirme) in ${ms} ms`);
  await page.locator('.livetile').first().click(); await page.getByRole('dialog').getByText('Herkunft').waitFor(); await page.keyboard.press('Escape');
  const small = await page.$$eval('button, a.btn, select', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && r.height < 43.5 && !e.closest('dialog:not([open])'); }).map((e) => e.textContent.slice(0, 30)));
  assert.deepEqual(small, [], 'Klickflächen auf der Live-Seite mindestens 44 px hoch');
  for (const [link, head] of [[/Betrieb/, 'Betrieb'], [/Szenen/, 'Szenen']]) { await page.getByRole('link', { name: link }).click(); await page.getByRole('heading', { name: head, exact: true }).waitFor(); }
  await page.getByRole('link', { name: /Bilder & Videos/ }).click(); await page.getByRole('button', { name: /Vorlage verwenden/ }).click(); await page.getByRole('dialog').getByText('Lesbarkeit in Ordnung').waitFor(); await page.getByRole('button', { name: 'Abbrechen' }).click();
  await page.getByRole('button', { name: /QR-Code erstellen/ }).click(); await page.getByLabel('Adresse (http/https)').fill('javascript:alert(1)'); await page.getByRole('dialog').getByText('Nur Adressen mit http').waitFor();
  await page.getByLabel('Adresse (http/https)').fill('https://dfm.example/tickets'); await page.getByRole('dialog').getByText('Gegenprobe bestanden').waitFor(); await page.keyboard.press('Escape');
  // Wandmodus: Token, keine Anmeldung nötig
  const tk = (await (await ctx.request.post(`${base}/api/v1/live-tokens`, { data: { name: 'Technikraum' }, headers: { 'x-csrf-token': await page.evaluate(() => fetch('/api/v1/auth/me').then((r) => r.json()).then((x) => x.csrf)) } })).json()).token; assert.ok(tk);
  const wall = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } })).newPage(); const w2 = watch(wall); await wall.goto(`${base}/#/wand`); await wall.getByLabel('Zugangs-Token').fill(tk); await wall.getByRole('button', { name: 'Öffnen' }).click(); await wall.locator('.livetile').nth(9).waitFor();
  assert.equal(await wall.getByRole('link', { name: 'Benutzer' }).count(), 0, 'Wandmodus ohne Navigation');
  // Handy
  const ph = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true })).newPage(); const w3 = watch(ph); await ph.goto(base); await ph.getByLabel('Benutzername').fill('admin'); await ph.getByLabel('Passwort').fill(PW); await ph.getByRole('button', { name: 'Anmelden' }).click(); await ph.getByRole('heading', { name: 'Startseite' }).waitFor();
  await ph.goto(`${base}/#/live`); await ph.locator('.livetile').first().waitFor(); assert.equal(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Handy: kein horizontales Scrollen');
  const fs = await ph.$$eval('.livetile .now, .livetile b', (els) => Math.min(...els.map((e) => parseFloat(getComputedStyle(e).fontSize)))); assert.ok(fs >= 16, `Schrift ≥ 16 px (ist ${fs})`);
  assert.deepEqual([...w.bad, ...w2.bad, ...w3.bad], [], 'keine externen Anfragen'); assert.deepEqual([...w.errors, ...w2.errors, ...w3.errors], [], 'keine Konsolenfehler');
  await browser.close(); await h.cleanup();
});

test('Playerseite: Erkennen, Testbild, Laufband, Uhr – und „aus“ am Schließtag (schwarz)', { skip, timeout: 120000 }, async () => {
  const h = await makeHub({ useTls: true }); const { createLocalServer } = await import('../player/agent/lib/localserver.js');
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  let plan = { segments: [], playlists: {}, defaultPlaylistId: null, tickers: [{ text: 'Heute Familientag im Museum' }], layout: { preset: 'ticker-clock' }, specialDays: [] };
  const srv = createLocalServer({ getPlan: () => plan, getManifest: () => ({ items: [] }), getHealth: () => ({ cached: [] }), mediaDir: tmpdir(), port: 0 }); const port = await srv.listen();
  const browser = await chromium.launch({ executablePath: EXE, args: ARGS }); const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage(); const w = watch(page);
  await page.goto(`http://127.0.0.1:${port}/player/`); await page.locator('.ticker span').waitFor(); assert.match(await page.locator('.ticker').innerText(), /Familientag/); assert.ok(await page.locator('.clock b').innerText());
  srv.emit('identify', { name: 'Shop-Screen', location: 'Shop · EG', number: 'A1B2', seconds: 10 }); await page.locator('.ident h1').waitFor(); assert.equal(await page.locator('.ident h1').innerText(), 'Shop-Screen'); assert.equal(await page.locator('.ident .num').innerText(), 'A1B2');
  srv.emit('testpattern', { on: true }); await page.locator('.pattern .arrow').waitFor(); assert.match(await page.locator('.pattern .res').innerText(), /1280 × 720/); srv.emit('testpattern', { on: false }); await page.locator('#overlay').waitFor({ state: 'hidden' });
  plan = { ...plan, specialDays: [{ from: day, to: day, rule: 'off', playlistId: null, name: 'Geschlossen' }] }; srv.emit('plan'); await page.waitForFunction(() => document.body.classList.contains('black'), null, { timeout: 8000 });
  assert.deepEqual(w.bad, []); assert.deepEqual(w.errors, []); await browser.close(); await srv.close(); await h.cleanup();
});
