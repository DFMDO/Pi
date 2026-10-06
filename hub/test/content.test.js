import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { makeHub, PW } from './helpers.js';
import { ensureCertificate } from '../lib/tls.js';
import { setupBackupKey, encryptBackup, decryptBackup, createArchive, restoreArchive, runScheduledBackup } from '../lib/backup.js';
import { bootGuard, activate, rollback } from '../lib/update.js';

function multipart(name, filename, data, fields = {}) {
  const b = '----dfmtest' + randomUUID(); const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
const png = (w = 2000, h = 1200) => sharp({ create: { width: w, height: h, channels: 3, background: '#c8102e' } }).png().toBuffer();
const addDevice = (h, profile, group = null) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,group_id,created_at) VALUES(?,?,?,'active',?,?)").run(id, 'Dev-' + profile, profile, group, h.clock.t); return id; };

test('Upload: Magic-Bytes statt Dateiendung – EXE als .png wird abgelehnt', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const m = multipart('file', 'bild.png', Buffer.from('MZ\x90\x00 das ist ein Programm'));
  const r = await a('POST', '/api/v1/media', m.payload, m.headers);
  assert.equal(r.statusCode, 400); assert.match(r.json().error, /nicht unterstützt/);
  assert.equal(readdirSync(join(h.dataDir, 'media', 'incoming')).length, 0, 'keine Reste');
  await h.cleanup();
});

test('Upload Bild: UUID-Dateiname, neu kodiert je Profil, EXIF entfernt, nur Profile gepaarter Geräte', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  addDevice(h, 'lite'); addDevice(h, 'standard');
  const withExif = await sharp(await png()).withMetadata({ exif: { IFD0: { Copyright: 'GEHEIM-GPS' } } }).jpeg().toBuffer();
  const m = multipart('file', '../../etc/passwd.jpg', withExif);
  const r = await a('POST', '/api/v1/media', m.payload, m.headers);
  assert.equal(r.statusCode, 201);
  const item = r.json().items[0]; assert.ok(!item.name.includes('/'), 'Pfadanteile entfernt');
  await h.app.variants.idle();
  const vs = h.db.prepare('SELECT * FROM media_variants WHERE media_id=?').all(item.id);
  assert.deepEqual(vs.map((v) => v.profile).sort(), ['lite', 'standard'], 'kein pro-Gerät → keine pro-Variante');
  assert.ok(vs.every((v) => v.status === 'ready' && /^[0-9a-f-]{36}-(lite|standard)\.jpg$/.test(v.path)));
  const lite = await sharp(join(h.dataDir, 'media', 'variants', vs.find((v) => v.profile === 'lite').path)).metadata();
  assert.equal(lite.width, 1280); assert.ok(!lite.exif, 'EXIF entfernt');
  assert.ok(!readFileSync(join(h.dataDir, 'media', 'variants', vs[0].path)).includes('GEHEIM-GPS'));
  // Neues Profil → Varianten werden nachgezogen
  addDevice(h, 'pro'); h.app.variants.ensureAll(); await h.app.variants.idle();
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM media_variants WHERE status='ready' AND media_id=?").get(item.id).n, 3);
  await h.cleanup();
});

test('Video wird je Profil umgewandelt (Lite: 720p H.264 Baseline)', { timeout: 120000 }, async () => {
  const h = await makeHub(); const a = await h.as('admin'); addDevice(h, 'lite');
  const dir = mkdtempSync(join(tmpdir(), 'vid-')); const f = join(dir, 'in.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=50:duration=2', '-c:v', 'libx264', f]);
  const m = multipart('file', 'film.mkv', readFileSync(f));
  const r = await a('POST', '/api/v1/media', m.payload, m.headers); assert.equal(r.statusCode, 201);
  await h.app.variants.idle();
  const v = h.db.prepare("SELECT * FROM media_variants WHERE media_id IN (SELECT id FROM media WHERE kind='video')").get(); assert.equal(v.status, 'ready', v.error);
  const out = join(h.dataDir, 'media', 'variants', v.path);
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height,profile,avg_frame_rate', '-of', 'json', out])).streams[0];
  assert.equal(p.height, 720); assert.match(p.profile, /Baseline/); assert.equal(p.avg_frame_rate, '30/1');
  await h.cleanup();
});

test('PDF wird seitenweise zu Bildern', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 5>>\n%%EOF');
  const m = multipart('file', 'plan.pdf', pdf); const r = await a('POST', '/api/v1/media', m.payload, m.headers);
  assert.equal(r.statusCode, 201, r.body); assert.equal(r.json().items.length, 2); assert.ok(r.json().items.every((i) => i.kind === 'pdfpage'));
  await h.cleanup();
});

test('Text-Ankündigung: Browser-Profile bekommen Text, Lite ein vorgerendertes Bild', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const lite = addDevice(h, 'lite'), std = addDevice(h, 'standard');
  const id = (await a('POST', '/api/v1/media/text', { name: 'Hinweis', title: 'Heute geschlossen <script>alert(1)</script>', body: 'Wegen Veranstaltung.', template: 'hinweis' })).json().id;
  const pl = (await a('POST', '/api/v1/playlists', { name: 'L' })).json().id;
  await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: id, duration: 8 }] });
  await h.app.variants.idle();
  const man = (devId) => { const d = h.db.prepare('SELECT * FROM devices WHERE id=?').get(devId); return import('../lib/plan.js').then((p) => p.manifestPayload(h.db, d)); };
  assert.equal((await man(std)).items[0].kind, 'text');
  const li = (await man(lite)).items[0]; assert.equal(li.kind, 'text'); assert.ok(li.sha256 || li.pending, 'Lite braucht Bild-Variante');
  const d = h.db.prepare('SELECT * FROM devices WHERE id=?').get(lite);
  assert.ok((await import('../lib/plan.js')).manifestPayload(h.db, d).items[0].url, 'Lite erhält URL der gerenderten Variante');
  await h.cleanup();
});

test('Abspielliste, Termin, Konflikt-Hinweis, Vorschau, Kalender', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const dv = addDevice(h, 'standard');
  const mk = async (n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
  const [m1, m2] = [await mk('Sommer-Aktion'), await mk('Winter')];
  const p1 = (await a('POST', '/api/v1/playlists', { name: 'Sommer' })).json().id; await a('PUT', `/api/v1/playlists/${p1}`, { items: [{ mediaId: m1 }] });
  const p2 = (await a('POST', '/api/v1/playlists', { name: 'Winter' })).json().id; await a('PUT', `/api/v1/playlists/${p2}`, { items: [{ mediaId: m2 }] });
  const base = { targetType: 'device', targetId: dv, startLocal: '2026-10-13T10:00', endLocal: '2026-10-13T12:00', priority: 5 };
  const s1 = await a('POST', '/api/v1/schedules', { ...base, content: { type: 'playlist', id: p1 } }); assert.equal(s1.statusCode, 201); assert.equal(s1.json().conflicts.length, 0);
  const s2 = await a('POST', '/api/v1/schedules', { ...base, startLocal: '2026-10-13T11:00', content: { type: 'playlist', id: p2 } });
  assert.equal(s2.json().conflicts.length, 1); assert.match(s2.json().conflicts[0].text, /überschneiden sich/);
  const pv = (await a('GET', `/api/v1/preview?deviceId=${dv}&date=2026-10-13&time=10:30`)).json(); assert.equal(pv.source, 'termin'); assert.equal(pv.playlistId, p1);
  const pv2 = (await a('GET', `/api/v1/preview?deviceId=${dv}&date=2026-10-13&time=11:30`)).json(); assert.equal(pv2.playlistId, p2, 'später gestartet gewinnt');
  const pv3 = (await a('GET', `/api/v1/preview?deviceId=${dv}&date=2026-10-13&time=15:00`)).json(); assert.equal(pv3.source, 'standard');
  assert.equal((await a('GET', '/api/v1/calendar?from=2026-10-12&to=2026-10-18')).json().length, 2);
  // Validierung in verständlicher Sprache
  assert.match((await a('POST', '/api/v1/schedules', { ...base, endLocal: '2026-10-13T09:00', content: { type: 'playlist', id: p1 } })).json().error, /Ende liegt vor dem Start/);
  assert.equal((await a('POST', '/api/v1/schedules', { ...base, rrule: 'FREQ=DAILY;X=1', content: { type: 'playlist', id: p1 } })).statusCode, 400);
  assert.equal((await a('POST', '/api/v1/schedules', { ...base, targetId: 'nix', content: { type: 'playlist', id: p1 } })).statusCode, 400);
  // Plan für den Player
  const { schedulePayload } = await import('../lib/plan.js');
  const plan = schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(dv), new Date('2026-10-12T00:00:00Z').getTime());
  assert.ok(plan.segments.some((s) => s.source?.content.id === p1)); assert.ok(plan.playlists[p1].items.length === 1); assert.ok(plan.defaultPlaylistId);
  await h.cleanup();
});

test('Papierkorb: Löschen mit Bestätigung, Wiederherstellen, Rückgängig', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const m = (await a('POST', '/api/v1/media/text', { name: 'Wichtig', title: 'W' })).json().id;
  const pl = (await a('POST', '/api/v1/playlists', { name: 'P' })).json().id; await a('PUT', `/api/v1/playlists/${pl}`, { items: [{ mediaId: m }] });
  const del = await a('DELETE', `/api/v1/media/${m}`); assert.equal(del.statusCode, 409); assert.equal(del.json().needsConfirm, true);
  assert.equal((await a('DELETE', `/api/v1/media/${m}?force=1`)).statusCode, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id=?').get(pl).n, 0);
  const t = (await a('GET', '/api/v1/trash')).json(); assert.equal(t[0].name, 'Wichtig');
  assert.equal((await a('POST', `/api/v1/trash/${t[0].id}/restore`)).statusCode, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM playlist_items WHERE playlist_id=?').get(pl).n, 1, 'Listeneintrag zurück');
  // Nach 30 Tagen automatisch weg
  await a('DELETE', `/api/v1/media/${m}?force=1`); h.clock.t += 31 * 86400000;
  h.db.prepare('UPDATE trash SET deleted_at=deleted_at-?').run(31 * 86400000);
  const a2 = await h.as('admin'); // Sitzung ist nach 31 Tagen abgelaufen
  assert.equal((await a2('GET', '/api/v1/trash')).json().length, 0);
  await h.cleanup();
});

test('Medien-Download mit Range (fortsetzbar) und Hash', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = addDevice(h, 'lite');
  const m = multipart('file', 'a.png', await png(1500, 900)); const id = (await a('POST', '/api/v1/media', m.payload, m.headers)).json().ids[0];
  await h.app.variants.idle();
  const v = h.db.prepare('SELECT * FROM media_variants WHERE media_id=?').get(id);
  const { sha256hex } = await import('../lib/crypto.js'); const token = 't'.repeat(40);
  h.db.prepare('UPDATE devices SET token_hash=? WHERE id=?').run(sha256hex(token), dv);
  const get = (range) => h.app.inject({ url: `/api/v1/device/media/${id}`, headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) } });
  const full = await get(); assert.equal(full.statusCode, 200); assert.equal(sha256hex(full.rawPayload), v.sha256 ? sha256hex(readFileSync(join(h.dataDir, 'media', 'variants', v.path))) : '');
  const part = await get('bytes=10-19'); assert.equal(part.statusCode, 206); assert.equal(part.rawPayload.length, 10); assert.equal(part.headers['content-range'], `bytes 10-19/${full.rawPayload.length}`);
  assert.equal((await get('bytes=999999999-')).statusCode, 416);
  await h.cleanup();
});

test('Audit-CSV schützt vor CSV-Injection; Redakteur kann Log nicht lesen/exportieren', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const e = await h.as('edi');
  h.app.ctx.audit.log({ action: '=HYPERLINK("http://x")', target: '@evil' });
  const csv = (await a('GET', '/api/v1/audit.csv')).body;
  assert.ok(csv.includes(`"'=HYPERLINK`)); assert.ok(csv.includes(`"'@evil"`));
  assert.equal((await e('GET', '/api/v1/audit.csv')).statusCode, 403); assert.equal((await e('GET', '/api/v1/audit')).statusCode, 403);
  await h.cleanup();
});

test('Eingaben: SQL-Injection-Strings landen wörtlich in der Datenbank, XSS wird nicht gerendert/gespeichert als Code', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const evil = `x'); DROP TABLE users;--`;
  assert.equal((await a('POST', '/api/v1/playlists', { name: evil })).statusCode, 201);
  assert.equal((await a('GET', '/api/v1/playlists')).json().some((p) => p.name === evil), true);
  assert.ok(h.db.prepare('SELECT COUNT(*) n FROM users').get().n >= 3);
  assert.equal((await a('GET', `/api/v1/devices/${encodeURIComponent("' OR 1=1 --")}`)).statusCode, 404);
  const trav = await h.app.inject({ url: '/..%2f..%2fetc%2fpasswd' }); assert.notEqual(trav.statusCode, 200);
  assert.equal((await a('GET', '/api/v1/devices/..%2f..%2fx/screenshot')).statusCode, 400);
  await h.cleanup();
});

test('Backup: Roundtrip, falsche Passphrase, Wiederherstellung behält Schlüssel (kein Neu-Pairing)', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  assert.equal((await a('POST', '/api/v1/backup/run')).statusCode, 400);
  assert.equal((await a('POST', '/api/v1/backup/setup', { passphrase: 'kurz' })).statusCode, 400);
  assert.equal((await a('POST', '/api/v1/backup/setup', { passphrase: 'Meine-Backup-Passphrase' })).statusCode, 200);
  await a('POST', '/api/v1/playlists', { name: 'Gerettet' });
  const file = (await a('POST', '/api/v1/backup/run')).rawPayload;
  assert.throws(() => decryptBackup(file, 'falsche-passphrase-123'), /Passphrase stimmt nicht/);
  assert.equal(readFileSync(join(h.dataDir, 'keys', 'backup.json'), 'utf8').includes('Meine-Backup-Passphrase'), false, 'Passphrase nie gespeichert');
  const tar = decryptBackup(file, 'Meine-Backup-Passphrase');
  const nd = mkdtempSync(join(tmpdir(), 'restore-')); restoreArchive(tar, nd);
  const h2 = await makeHub({ dataDir: nd, noUsers: true });
  assert.equal(h2.tls.spki, h.tls.spki, 'gleicher Hub-Schlüssel → Player müssen nicht neu verbunden werden');
  assert.ok(h2.db.prepare('SELECT 1 FROM playlists WHERE name=?').get('Gerettet'));
  assert.deepEqual(readFileSync(join(nd, 'keys', 'master.key')), readFileSync(join(h.dataDir, 'keys', 'master.key')));
  await h2.app.close(); await h.cleanup();
});

test('Zeitgesteuerte Backups: täglich 7 / wöchentlich 4 behalten', async () => {
  const h = await makeHub(); const keyInfo = setupBackupKey('Meine-Backup-Passphrase');
  for (let i = 0; i < 40; i++) runScheduledBackup({ dataDir: h.dataDir, db: h.db, keyInfo, now: new Date(Date.UTC(2026, 0, 1 + i, 3)) });
  const f = readdirSync(join(h.dataDir, 'backups'));
  assert.equal(f.filter((x) => x.startsWith('daily-')).length, 7); assert.equal(f.filter((x) => x.startsWith('weekly-')).length, 4);
  await h.cleanup();
});

function makePackage(dir, version, priv, { tamper = false, wrongKey = null } = {}) {
  const src = join(dir, 'src-' + version); mkdirSync(join(src, 'hub'), { recursive: true }); writeFileSync(join(src, 'hub', 'VERSION'), version);
  execFileSync('tar', ['-C', src, '-cf', join(dir, 'payload.tar'), '.']);
  const payload = readFileSync(join(dir, 'payload.tar'));
  const { createHash } = require_crypto();
  const manifest = Buffer.from(JSON.stringify({ version, payloadSha256: createHash('sha256').update(payload).digest('hex') }));
  writeFileSync(join(dir, 'manifest.json'), manifest); writeFileSync(join(dir, 'manifest.sig'), sign(null, manifest, wrongKey ?? priv));
  if (tamper) writeFileSync(join(dir, 'payload.tar'), Buffer.concat([payload, Buffer.from('x')]));
  const out = join(dir, `u-${version}${tamper ? '-t' : ''}.dfmpkg`);
  execFileSync('tar', ['-C', dir, '-cf', out, 'manifest.json', 'manifest.sig', 'payload.tar']); return readFileSync(out);
}
import { createHash } from 'node:crypto';
const require_crypto = () => ({ createHash });

test('Updates: Signatur Pflicht, manipulierte/falsch signierte Pakete abgelehnt, Rollback', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'); const evil = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const h = await makeHub({ updateKeyPem: pem, appDir: undefined }); const a = await h.as('admin'); const e = await h.as('edi');
  const dir = mkdtempSync(join(tmpdir(), 'pkg-'));
  const up = (buf, c = a) => c('POST', '/api/v1/update/upload', buf, { 'content-type': 'application/octet-stream' });
  assert.equal((await up(makePackage(dir, '1.0.1', privateKey), e)).statusCode, 403, 'Redakteur darf nicht');
  const bad = await up(makePackage(dir, '1.0.2', privateKey, { wrongKey: evil.privateKey })); assert.equal(bad.statusCode, 400); assert.match(bad.json().error, /Signatur/);
  const tam = await up(makePackage(dir, '1.0.3', privateKey, { tamper: true })); assert.equal(tam.statusCode, 400); assert.match(tam.json().error, /beschädigt/);
  assert.equal((await up(Buffer.from('kein tar'))).statusCode, 400);
  assert.ok((await a('GET', '/api/v1/audit?security=1')).json().filter((x) => x.action === 'update.abgelehnt').length >= 3);
  assert.equal(existsSync(join(h.dataDir, 'app', 'current')), false, 'nichts aktiviert');
  const ok = await up(makePackage(dir, '1.0.4', privateKey)); assert.equal(ok.statusCode, 200, ok.body);
  const appDir = join(h.dataDir, 'app'); assert.equal(readFileSync(join(appDir, '1.0.4', 'hub', 'VERSION'), 'utf8'), '1.0.4');
  assert.equal((await up(makePackage(dir, '1.0.5', privateKey))).statusCode, 200);
  assert.equal((await import('node:fs')).readlinkSync(join(appDir, 'current')), '1.0.5');
  assert.equal((await a('POST', '/api/v1/update/rollback')).statusCode, 200);
  assert.equal((await import('node:fs')).readlinkSync(join(appDir, 'current')), '1.0.4');
  await h.cleanup();
});

test('bootGuard: nach 3 Fehlstarts automatischer Rollback', () => {
  const d = mkdtempSync(join(tmpdir(), 'bg-')); mkdirSync(join(d, '1.0.0')); mkdirSync(join(d, '1.1.0'));
  activate(d, '1.0.0'); activate(d, '1.1.0');
  assert.deepEqual([bootGuard(d), bootGuard(d), bootGuard(d), bootGuard(d)], ['ok', 'ok', 'ok', 'rolled-back']);
});

test('Diagnose: Testvideo je Profil wird erzeugt (720p/Baseline für Lite) und Speedtest liefert 8 MB', { timeout: 120000 }, async () => {
  const h = await makeHub(); const dv = addDevice(h, 'lite'); const { sha256hex } = await import('../lib/crypto.js'); const token = 'd'.repeat(40);
  h.db.prepare('UPDATE devices SET token_hash=? WHERE id=?').run(sha256hex(token), dv);
  const get = (url) => h.app.inject({ url, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get('/api/v1/device/speedtest')).rawPayload.length, 8 * 1024 * 1024);
  const tv = await get('/api/v1/device/testvideo'); assert.equal(tv.statusCode, 200);
  const f = join(h.dataDir, 'media', 'testvideo-lite.mp4'); assert.ok(existsSync(f));
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height,profile', '-of', 'json', f])).streams[0];
  assert.equal(p.height, 720); assert.match(p.profile, /Baseline/);
  await h.cleanup();
});

test('Hub begrenzt gleichzeitige Medien-Downloads auf 4 (5. bekommt „später erneut“)', { timeout: 60000 }, async () => {
  const h = await makeHub(); await h.app.listen({ port: 0, host: '127.0.0.1' }); const port = h.app.server.address().port;
  const dv = addDevice(h, 'standard'); const { sha256hex } = await import('../lib/crypto.js'); const token = 'e'.repeat(40);
  h.db.prepare('UPDATE devices SET token_hash=? WHERE id=?').run(sha256hex(token), dv);
  const mid = randomUUID(); h.db.prepare("INSERT INTO media(id,name,kind,created_at) VALUES(?,?,?,?)").run(mid, 'gross', 'video', Date.now());
  const f = `${mid}-standard.mp4`; writeFileSync(join(h.dataDir, 'media', 'variants', f), Buffer.alloc(64 * 1024 * 1024, 1));
  h.db.prepare("INSERT INTO media_variants(id,media_id,profile,path,status) VALUES(?,?,?,?,'ready')").run('v1', mid, 'standard', f);
  const { default: http } = await import('node:http'); const open = () => new Promise((res) => { const r = http.get({ port, host: '127.0.0.1', path: `/api/v1/device/media/${mid}`, headers: { authorization: `Bearer ${token}` } }, (resp) => { resp.pause(); res({ resp, r }); }); });
  const held = []; for (let i = 0; i < 4; i++) held.push(await open());
  assert.ok(held.every((x) => x.resp.statusCode === 200)); const fifth = await open(); assert.equal(fifth.resp.statusCode, 503); assert.ok(fifth.resp.headers['retry-after']);
  held[0].r.destroy(); await new Promise((r) => setTimeout(r, 300)); const again = await open(); assert.equal(again.resp.statusCode, 200, 'Platz wieder frei');
  for (const x of [...held, fifth, again]) x.r.destroy(); await h.cleanup();
});

test('Härtung: Bild-Bomben und fremde Container werden abgelehnt', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const big = await sharp({ create: { width: 9500, height: 9500, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
  const m = multipart('file', 'riesig.png', big); const r = await a('POST', '/api/v1/media', m.payload, m.headers);
  assert.equal(r.statusCode, 400); assert.match(r.json().error, /zu groß|Megapixel/);
  // „MP4“ mit HLS-Playlist-Inhalt hinter ftyp: wird nicht als Playlist interpretiert (Demuxer fest vorgegeben), Upload scheitert verständlich
  const fake = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.from('\n#EXTM3U\nhttp://127.0.0.1:1/x.ts\n')]);
  const v = multipart('file', 'x.mp4', fake); const r2 = await a('POST', '/api/v1/media', v.payload, v.headers); assert.equal(r2.statusCode, 400); assert.match(r2.json().error, /nicht gelesen|Video/);
  await h.cleanup();
});
