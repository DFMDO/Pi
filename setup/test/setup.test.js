import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ssidOk, wpaOk, normalizeHubAddress, validateDraft, fpOk } from '../lib/validate.js';
import { parseWifiQr, wifiQr, parseCard, parseSetupFile } from '../lib/parse.js';
import { createNm, splitT } from '../lib/nm.js';
import { createController, randPassword, randPin, IDLE_MS } from '../lib/controller.js';
import { createServers } from '../setup.js';
import { writeFinalConfig } from '../lib/config.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../../hub/lib/crypto.js';

test('Validierung: SSID, Passwort, Hub-Adresse (SSRF-Schutz)', () => {
  assert.ok(ssidOk('Museum-Signage')); assert.ok(!ssidOk('')); assert.ok(!ssidOk('x'.repeat(33))); assert.ok(!ssidOk('a\nb')); assert.ok(ssidOk('ä'.repeat(16)) && !ssidOk('ä'.repeat(17)));
  assert.ok(wpaOk('12345678')); assert.ok(!wpaOk('1234567')); assert.ok(!wpaOk('x'.repeat(64))); assert.ok(wpaOk('a'.repeat(64)));
  assert.equal(normalizeHubAddress('dfm-signage.local'), 'https://dfm-signage.local');
  assert.equal(normalizeHubAddress('https://192.168.1.10:8443/'), 'https://192.168.1.10:8443');
  for (const bad of ['http://evil.com', 'example.com', '8.8.8.8', '1.1.1.1:443', 'a b', 'x.local; rm -rf /', '', 'dfm-signage.local:99999', '$(id).local', 'http://169.254.169.254.evil.com'])
    assert.equal(normalizeHubAddress(bad), null, bad);
  assert.equal(normalizeHubAddress('169.254.169.254'), 'https://169.254.169.254', 'Link-Local ist lokal erlaubt');
  assert.ok(fpOk('A3F2 91C0 7B44 D8E1 5C6A 0F73 B2E9 1D88 4A21 CC09 E7F5 3B60 92D1 08AE 6C47 F13B'));
});

test('WLAN-QR: Standardformat inkl. Escapes', () => {
  assert.deepEqual(parseWifiQr('WIFI:T:WPA;S:Mein\\;WLAN;P:pass\\:wort12;;'), { ssid: 'Mein;WLAN', password: 'pass:wort12', hidden: false });
  assert.deepEqual(parseWifiQr('WIFI:S:Offen;T:nopass;;'), { ssid: 'Offen', password: '', hidden: false });
  assert.equal(parseWifiQr('WIFI:T:WPA;S:x;P:kurz;;'), null); assert.equal(parseWifiQr('http://evil'), null); assert.equal(parseWifiQr('WIFI:' + 'A'.repeat(500)), null);
  const q = wifiQr({ ssid: 'DFM-Setup-ab12', password: 'geheim12345' }); assert.equal(q, 'WIFI:T:WPA;S:DFM-Setup-ab12;P:geheim12345;;');
  assert.deepEqual(parseWifiQr(wifiQr({ ssid: 'a;b,c:d', password: 'p;a,s:s"w\\ord1' })), { ssid: 'a;b,c:d', password: 'p;a,s:s"w\\ord1', hidden: false }, 'Roundtrip mit Sonderzeichen');
});

test('Startkarte und Konfigurationsdatei', () => {
  const j = Buffer.from(JSON.stringify({ v: 1, s: 'Signage', p: 'wlanpasswort', h: 'dfm-signage.local', f: 'ab'.repeat(32), c: 'K7M4X9RD' })).toString('base64url');
  assert.deepEqual(parseCard(`http://10.42.0.1/#c=${j}`), { wifi: { ssid: 'Signage', password: 'wlanpasswort' }, hubAddress: 'https://dfm-signage.local', fingerprint: 'ab'.repeat(32), pairCode: 'K7M4X9RD' });
  assert.equal(parseCard('http://10.42.0.1/#c=' + Buffer.from('{"v":1,"h":"evil.com"}').toString('base64url')), null);
  const txt = '# Kommentar\nwlan_name = Signage\nwlan_passwort = "geheimes pw"\nrolle = player\ngeraetename = Shop-Screen\nhub_adresse = dfm-signage.local\neinrichtungscode = K7M4-X9RD\n';
  const r = parseSetupFile(txt); assert.deepEqual(r.errors, []); assert.equal(r.config.role, 'player'); assert.equal(r.config.wifi.password, 'geheimes pw'); assert.equal(r.config.hubAddress, 'https://dfm-signage.local');
  assert.ok(parseSetupFile('rolle = chef\nquatsch = 1\nkaputt').errors.length >= 3);
  assert.deepEqual(parseSetupFile('{"rolle":"hub","wlan_name":"A","wlan_passwort":"12345678"}', true).errors, []);
  assert.ok(parseSetupFile('{kaputt', true).errors[0].includes('JSON'));
});

test('nmcli: Eingaben bleiben EIN Argument (keine Shell-Injection über SSID/Passwort)', async () => {
  const calls = []; const nm = createNm({ run: async (c, a) => { calls.push([c, ...a]); return { code: 0, stdout: '', stderr: '' }; } });
  const evil = { ssid: '$(reboot) `id`; rm -rf / "x"', password: "p'a\"ss;&|$wort1" };
  await nm.startHotspot(evil); await nm.connect({ ...evil, hidden: false });
  for (const c of calls) { assert.equal(c[0], 'nmcli'); assert.ok(!c.some((a) => a.includes(' ') && a.startsWith('nmcli')), 'nie zusammengesetzte Befehle'); }
  assert.ok(calls.some((c) => c.includes(evil.ssid))); assert.ok(calls.some((c) => c.includes(evil.password)));
  assert.ok(calls.filter((c) => c.includes(evil.ssid)).every((c) => c.filter((a) => a === evil.ssid).length === 1));
  assert.deepEqual(splitT('Mein\\:WLAN:75:WPA2:2412'), ['Mein:WLAN', '75', 'WPA2', '2412']);
  const nm2 = createNm({ run: async (c, a) => (a.includes('list') ? { code: 0, stderr: '', stdout: 'Netz A:80:WPA2:2412\nNetz A:40:WPA2:5200\nOffen:60::2437\nFirma:50:WPA2 802.1X:2412\n' } : { code: 0, stdout: '', stderr: '' }) });
  const nets = await nm2.scan(); assert.equal(nets.length, 3); assert.equal(nets[0].signal, 80); assert.equal(nets.find((n) => n.ssid === 'Offen').secure, false); assert.equal(nets.find((n) => n.ssid === 'Firma').enterprise, true);
});

function fakeNm(opts = {}) {
  const log = []; let stations = 0;
  return { log, setStations: (n) => { stations = n; }, scan: async () => [{ ssid: 'Signage', signal: 70, secure: true }], startHotspot: async (h) => { log.push(['hotspot', h]); return true; }, stopHotspot: async () => { log.push(['stop']); },
    connect: async (w) => { log.push(['connect', w.ssid]); return opts.fail ? { ok: false, reason: opts.fail } : { ok: true }; }, disconnect: async () => log.push(['disconnect']), wifiConnected: async () => false, stations: async () => stations, hasLan: async () => false };
}
const fakeRnd = (() => { let i = 0; return (n) => (i++ * 7 + 3) % n; })();
async function makeCtl(o = {}) {
  let t = 1_000_000; const nm = fakeNm(o), written = [], done = [];
  const ctl = createController({ nm, suffix: 'ab12', now: () => t, rnd: o.rnd ?? fakeRnd, hashPassword, policy: checkPasswordPolicy, hw: { model: o.model ?? 'Raspberry Pi 4 Model B', profile: o.profile ?? 'pro' }, writeConfig: async (c, e) => written.push([c, e]), onDone: (c) => done.push(c), discoverHub: async () => o.hub ?? null });
  await ctl.startMode(); return { ctl, nm, written, done, adv: (ms) => { t += ms; }, flush: () => new Promise((r) => setTimeout(r, 1500)) };
}

test('PIN: 5 Fehlversuche → neue PIN, alte Sitzung ungültig', async () => {
  const { ctl } = await makeCtl(); const old = ctl.state.pin;
  const ok = ctl.enterPin(old); assert.ok(ok.ok); assert.ok(ctl.authed(ok.session));
  const { ctl: c2 } = await makeCtl(); const pin = c2.state.pin; const wrong = pin === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.equal(c2.enterPin(wrong).ok, false);
  const fifth = c2.enterPin(wrong); assert.equal(fifth.locked, true); assert.equal(c2.enterPin(pin).locked, true, 'gesperrt, auch mit richtiger PIN');
});

test('Hotspot: zufälliges Passwort ohne verwechselbare Zeichen, SSID mit Suffix; zwei Starts unterscheiden sich', async () => {
  const a = await makeCtl({ rnd: (n) => Math.floor(Math.random() * n) }), b = await makeCtl({ rnd: (n) => Math.floor(Math.random() * n) });
  assert.match(a.ctl.state.ssid, /^DFM-Setup-ab12$/); assert.match(a.ctl.state.password, /^[a-hj-km-np-z2-9]{12}$/);
  assert.notEqual(a.ctl.state.password, b.ctl.state.password); assert.match(randPin(), /^\d{6}$/);
  assert.deepEqual(a.nm.log[0][0], 'hotspot'); assert.equal(a.nm.log[0][1].ssid, 'DFM-Setup-ab12');
});

test('Bildschirm: Schritt 1 (WLAN-QR) → Schritt 2 sobald Handy verbunden (PIN nur dann sichtbar)', async () => {
  const { ctl, nm } = await makeCtl();
  let d = await ctl.display(); assert.equal(d.phase, 'step1'); assert.match(d.qr, /^WIFI:T:WPA;S:DFM-Setup-ab12;P:/); assert.equal(d.pin, undefined);
  nm.setStations(1); await ctl.tick(); d = await ctl.display(); assert.equal(d.phase, 'step2'); assert.equal(d.qr, 'http://10.42.0.1/'); assert.match(d.pin, /^\d{6}$/);
});

test('Timeout: nach 15 Minuten Inaktivität neuer Modus mit neuem Passwort/PIN', async () => {
  const { ctl, adv } = await makeCtl({ rnd: (n) => Math.floor(Math.random() * n) }); const [pw, pin] = [ctl.state.password, ctl.state.pin]; const s = ctl.enterPin(pin).session;
  adv(IDLE_MS - 1000); await ctl.tick(); assert.equal(ctl.state.password, pw);
  adv(2000); await ctl.tick(); assert.notEqual(ctl.state.password, pw); assert.equal(ctl.authed(s), false, 'alte Sitzung ungültig');
});

test('WLAN-Test: falsches Passwort → verständliche Meldung, Modus bleibt aktiv', async () => {
  const { ctl, nm, flush } = await makeCtl({ fail: 'auth' }); const s = ctl.enterPin(ctl.state.pin).session;
  assert.equal((await ctl.testWifi(s, { ssid: 'Signage', password: 'falsch1234' })).ok, true); await flush();
  assert.deepEqual(ctl.result(s), { state: 'wifi-failed', error: 'Das Passwort scheint falsch zu sein. Bitte prüfe es und versuche es noch einmal.' });
  assert.equal(ctl.state.phase, 'step1'); assert.equal(nm.log.filter((l) => l[0] === 'hotspot').length, 2, 'Hotspot wieder an, gleiche Zugangsdaten');
  assert.equal((await ctl.testWifi('falsche-session', { ssid: 'x', password: 'xxxxxxxx' })).status, 401);
  assert.equal((await ctl.testWifi(s, { ssid: 'x'.repeat(40), password: 'xxxxxxxx' })).ok, false);
});

test('Komplettablauf Hub: Admin-Konto gehasht, Konfiguration atomar, Hotspot aus', async () => {
  const { ctl, nm, written, done, flush } = await makeCtl({ hub: null }); const s = ctl.enterPin(ctl.state.pin).session;
  await ctl.testWifi(s, { ssid: 'Signage', password: 'wlanpasswort' }); await flush(); assert.equal(ctl.result(s).state, 'wifi-ok');
  assert.equal((await ctl.finish(s, { role: 'hub', admin: { name: 'Chefin', password: 'kurz' }, site: 'DFM' })).ok, false);
  const bad = await ctl.finish(s, { role: 'hub', admin: { name: 'Chefin', password: 'passwort1234' }, site: 'DFM' }); assert.ok(bad.errors.some((e) => /bekannt/.test(e)));
  assert.equal((await ctl.finish(s, { role: 'hub', admin: { name: 'Chefin', password: 'Ein-gutes-langes-Passwort' }, site: 'Deutsches Fußballmuseum' })).ok, true); await flush();
  assert.equal(ctl.result(s).state, 'done'); assert.equal(written.length, 1); assert.equal(done.length, 1);
  const [cfg, extra] = written[0]; assert.equal(cfg.role, 'hub'); assert.ok(extra.hubBootstrap.admin.pwHash.startsWith('$argon2id$'));
  assert.ok(await verifyPassword(extra.hubBootstrap.admin.pwHash, 'Ein-gutes-langes-Passwort')); assert.ok(!JSON.stringify(written).includes('Ein-gutes-langes-Passwort'));
  assert.ok(nm.log.some((l) => l[0] === 'stop'));
});

test('Komplettablauf Player: Hub-Adresse, Code, Fingerabdruck; Hub-Warnung auf schwachem Gerät', async () => {
  const w = await makeCtl({ model: 'Raspberry Pi 3 Model B Plus', profile: 'standard', hub: { host: 'dfm-signage.local' } }); const s = w.ctl.enterPin(w.ctl.state.pin).session;
  assert.match(w.ctl.info(s).hubWarning, /schwach/); assert.equal((await makeCtl()).ctl.info((await makeCtl()).ctl.enterPin('x')?.session ?? ''), null);
  await w.ctl.testWifi(s, { ssid: 'Signage', password: 'wlanpasswort' }); await w.flush(); assert.deepEqual(w.ctl.result(s).hub, { host: 'dfm-signage.local' });
  assert.equal((await w.ctl.finish(s, { role: 'player', name: 'Shop-Screen', hubAddress: 'evil.com', pairCode: 'K7M4-X9RD' })).ok, false);
  assert.equal((await w.ctl.finish(s, { role: 'player', name: 'Shop-Screen', hubAddress: 'dfm-signage.local', pairCode: 'K7M4-X9RD', fingerprint: 'ab'.repeat(32).replace(/(.{4})/g, '$1 ').trim() })).ok, true); await w.flush();
  const [cfg, extra] = w.written[0]; assert.equal(extra.agent.hubUrl, 'https://dfm-signage.local'); assert.equal(extra.agent.pairing.code, 'K7M4X9RD'); assert.equal(extra.agent.hubSpki, 'ab'.repeat(32)); assert.equal(extra.agent.profile, 'standard'); assert.equal(cfg.name, 'Shop-Screen');
});

test('HTTP: Captive-Portal-Sonden, PIN-Pflicht, Anzeige nur lokal getrennt, Injection in SSID/Passwort wirkungslos', async () => {
  const { ctl, nm, flush } = await makeCtl(); const { portal, display } = createServers(ctl, { toSvg: async () => '<svg/>' });
  await new Promise((r) => portal.listen(0, '127.0.0.1', r)); await new Promise((r) => display.listen(0, '127.0.0.1', r));
  const P = `http://127.0.0.1:${portal.address().port}`, D = `http://127.0.0.1:${display.address().port}`;
  for (const path of ['/generate_204', '/hotspot-detect.html', '/connecttest.txt', '/ncsi.txt', '/library/test/success.html', '/irgendwas/anderes']) {
    const r = await fetch(P + path, { redirect: 'manual' }); assert.equal(r.status, 302, path); assert.equal(r.headers.get('location'), 'http://10.42.0.1/');
  }
  assert.equal((await fetch(P + '/')).status, 200); assert.match((await (await fetch(P + '/')).text()), /DFM Signage einrichten/);
  assert.equal((await fetch(P + '/api/info')).status, 401); assert.equal((await fetch(P + '/api/wifi', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(P + '/state', { redirect: 'manual' })).status, 302, 'PIN/Passwort-Anzeige ist am Portal nicht erreichbar');
  const st = await (await fetch(D + '/state')).json(); assert.equal(st.phase, 'step1'); assert.ok(st.password);
  const bad = await fetch(P + '/api/pin', { method: 'POST', body: JSON.stringify({ pin: '1' }) }); assert.equal(bad.status, 403);
  const { session } = await (await fetch(P + '/api/pin', { method: 'POST', body: JSON.stringify({ pin: ctl.state.pin }) })).json();
  const H = { 'X-Setup-Session': session };
  assert.equal((await fetch(P + '/api/info', { headers: H })).status, 200);
  const evil = { ssid: '"; reboot #', password: '$(touch /tmp/pwned) `id` ; &&' };
  const r = await fetch(P + '/api/wifi', { method: 'POST', headers: H, body: JSON.stringify(evil) }); assert.equal(r.status, 200, 'gültige Zeichen werden akzeptiert und nur als Argument weitergereicht');
  assert.ok(nm.log.length >= 1);
  assert.equal((await fetch(P + '/api/wifi', { method: 'POST', headers: H, body: '{kaputt' })).status, 400);
  assert.equal((await fetch(P + '/api/role', { method: 'POST', headers: H, body: JSON.stringify({ role: 'root' }) })).status, 400);
  assert.ok(!existsSync('/tmp/pwned'));
  portal.closeAllConnections(); display.closeAllConnections(); portal.close(); display.close();
});

test('Konfiguration wird atomar geschrieben; config.json zuletzt', async () => {
  const d = mkdtempSync(join(tmpdir(), 'cfg-'));
  await writeFinalConfig({ v: 1, role: 'hub' }, { hubBootstrap: { admin: { name: 'a', pwHash: 'x' } } }, d);
  assert.ok(existsSync(join(d, 'hub-bootstrap.json')) && existsSync(join(d, 'config.json')));
  assert.equal((await import('node:fs')).statSync(join(d, 'hub-bootstrap.json')).mode & 0o777, 0o600);
});

test('„Nur WLAN ändern“ (Reset ohne Tastatur): keine Rolle/Konten nötig, Marker wird entfernt', async () => {
  let t = 1e6; const nm = fakeNm(), done = [], cleared = [];
  const ctl = createController({ nm, suffix: 'ab12', now: () => t, rnd: fakeRnd, hashPassword, policy: checkPasswordPolicy, hw: { model: 'Raspberry Pi 4', profile: 'pro' }, writeConfig: async () => assert.fail('keine Konfiguration überschreiben'), wifiOnly: true, onWifiOnlyDone: async () => cleared.push(1), onDone: (c) => done.push(c) });
  await ctl.startMode(); const s = ctl.enterPin(ctl.state.pin).session; assert.equal(ctl.info(s).wifiOnly, true);
  assert.equal((await ctl.finish(s, {})).ok, false, 'ohne WLAN-Wahl nicht möglich');
  await ctl.testWifi(s, { ssid: 'Neu', password: 'neuespasswort' }); await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await ctl.finish(s, {})).ok, true); await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(done, [{ wifiOnly: true }]); assert.equal(cleared.length, 1); assert.equal(ctl.state.phase, 'done');
});
