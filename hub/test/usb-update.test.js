// Update vom USB-Stick: Pakete auf dem Stick werden vorab geprüft (Signatur Pflicht), installiert wird nur nach Bestätigung und nur aus dem Stick-Ordner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { makeHub } from './helpers.js';

function makePackage(dir, version, priv, out) {
  const src = join(dir, 'src-' + version); mkdirSync(join(src, 'hub'), { recursive: true }); writeFileSync(join(src, 'hub', 'VERSION'), version);
  execFileSync('tar', ['-C', src, '-cf', join(dir, 'payload.tar'), '.']); const payload = readFileSync(join(dir, 'payload.tar'));
  const manifest = Buffer.from(JSON.stringify({ version, payloadSha256: createHash('sha256').update(payload).digest('hex'), created: '2026-10-10T08:00:00Z', notes: 'Test' }));
  writeFileSync(join(dir, 'manifest.json'), manifest); writeFileSync(join(dir, 'manifest.sig'), sign(null, manifest, priv));
  execFileSync('tar', ['-C', dir, '-cf', out, 'manifest.json', 'manifest.sig', 'payload.tar']);
}
async function setup() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), evil = generateKeyPairSync('ed25519');
  const root = mkdtempSync(join(tmpdir(), 'dfm-usbu-')), usb = join(root, 'usb'), work = join(root, 'work'); mkdirSync(usb); mkdirSync(work);
  const verFile = join(root, 'version'); writeFileSync(verFile, '1.0.0\n'); process.env.DFM_VERSION_FILE = verFile; // „aktuell installierte Version“
  const h = await makeHub({ updateKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), usbDir: usb });
  return { h, usb, work, root, priv: privateKey, evil: evil.privateKey, done: async () => { delete process.env.DFM_VERSION_FILE; await h.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

test('USB-Update: ohne Stick leere Liste; mit Stick werden Pakete vorab geprüft (neu, alt, falsch signiert, kaputt) und Fremdes ignoriert', async () => {
  const s = await setup(); const a = await s.h.as('admin');
  try {
    assert.deepEqual((await a('GET', '/api/v1/update/usb')).json(), { current: '1.0.0', packages: [] }, 'leerer Stick');
    makePackage(s.work, '1.0.1', s.priv, join(s.usb, 'neu.dfmpkg')); makePackage(s.work, '0.9.0', s.priv, join(s.usb, 'alt.dfmpkg')); makePackage(s.work, '1.0.2', s.evil, join(s.usb, 'falsch.dfmpkg'));
    writeFileSync(join(s.usb, 'kaputt.dfmpkg'), 'das ist kein Paket'); writeFileSync(join(s.usb, 'notiz.txt'), 'x'); writeFileSync(join(s.usb, '._neu.dfmpkg'), 'mac-rest');
    const r = (await a('GET', '/api/v1/update/usb')).json(); assert.equal(r.current, '1.0.0');
    assert.deepEqual(r.packages.map((p) => p.name), ['alt.dfmpkg', 'falsch.dfmpkg', 'kaputt.dfmpkg', 'neu.dfmpkg'], 'nur .dfmpkg, nicht versteckte Mac-Reste');
    const by = Object.fromEntries(r.packages.map((p) => [p.name, p]));
    assert.equal(by['neu.dfmpkg'].valid, true, by['neu.dfmpkg'].error); assert.equal(by['neu.dfmpkg'].version, '1.0.1'); assert.equal(by['neu.dfmpkg'].newer, 1); assert.equal(by['neu.dfmpkg'].notes, 'Test');
    assert.equal(by['alt.dfmpkg'].valid, true, by['alt.dfmpkg'].error); assert.equal(by['alt.dfmpkg'].newer, -1, 'älter als installiert');
    assert.equal(by['falsch.dfmpkg'].valid, false); assert.match(by['falsch.dfmpkg'].error, /Signatur/);
    assert.equal(by['kaputt.dfmpkg'].valid, false); assert.equal(by['kaputt.dfmpkg'].error, 'Das ist kein gültiges Update-Paket.', 'rohe tar-Meldung wird nicht durchgereicht');
    assert.equal((await (await s.h.as('edi'))('GET', '/api/v1/update/usb')).statusCode, 403, 'nur mit Update-Recht'); assert.equal((await s.h.app.inject({ method: 'GET', url: '/api/v1/update/usb' })).statusCode, 401);
  } finally { await s.done(); }
});

function canSymlink() { const d = mkdtempSync(join(tmpdir(), 'dfm-sl-')); try { symlinkSync('x', join(d, 'l')); return true; } catch { return false; } finally { rmSync(d, { recursive: true, force: true }); } }
test('USB-Update: Installation nur nach Bestätigung, nur gültig signierte Pakete aus dem Stick-Ordner, Protokoll nennt die Quelle', async (t) => {
  const s = await setup(); const a = await s.h.as('admin'); const post = (b) => a('POST', '/api/v1/update/usb/install', b);
  try {
    makePackage(s.work, '1.0.1', s.priv, join(s.usb, 'neu.dfmpkg')); makePackage(s.work, '1.0.2', s.evil, join(s.usb, 'falsch.dfmpkg')); writeFileSync(join(s.usb, 'kaputt.dfmpkg'), 'x');
    assert.equal((await post({ name: 'neu.dfmpkg', confirmed: false })).statusCode, 400, 'ohne Bestätigung nichts');
    assert.equal((await (await s.h.as('edi'))('POST', '/api/v1/update/usb/install', { name: 'neu.dfmpkg', confirmed: true })).statusCode, 403);
    for (const bad of ['../neu.dfmpkg', 'a/b.dfmpkg', '..\\neu.dfmpkg', 'neu.txt', 'x'.repeat(120) + '.dfmpkg']) assert.equal((await post({ name: bad, confirmed: true })).statusCode, 400, bad.slice(0, 30));
    assert.equal((await post({ name: 'gibtsnicht.dfmpkg', confirmed: true })).statusCode, 404);
    const f = await post({ name: 'falsch.dfmpkg', confirmed: true }); assert.equal(f.statusCode, 400); assert.match(f.json().error, /Signatur/);
    assert.equal((await post({ name: 'kaputt.dfmpkg', confirmed: true })).json().error, 'Das ist kein gültiges Update-Paket.');
    const appDir = join(s.h.dataDir, 'app'); assert.throws(() => readlinkSync(join(appDir, 'current')), 'nach Fehlversuchen ist nichts aktiviert');
    try { symlinkSync(join(s.root, 'work', 'payload.tar'), join(s.usb, 'link.dfmpkg')); assert.equal((await post({ name: 'link.dfmpkg', confirmed: true })).statusCode, 400, 'Verknüpfung aus dem Stick heraus wird abgelehnt'); } catch (e) { if (e.code !== 'EPERM') throw e; /* Windows ohne Symlink-Recht */ }
    if (!canSymlink()) return t.skip('Dieser Rechner erlaubt keine Symlinks (Windows): das Aktivieren der neuen Version lässt sich nur unter Linux prüfen');
    const ok = await post({ name: 'neu.dfmpkg', confirmed: true }); assert.equal(ok.statusCode, 200, ok.body); assert.equal(ok.json().version, '1.0.1');
    assert.equal(readlinkSync(join(appDir, 'current')), '1.0.1'); assert.equal(readFileSync(join(appDir, '1.0.1', 'hub', 'VERSION'), 'utf8'), '1.0.1');
    assert.equal(readFileSync(join(s.h.dataDir, 'updates', 'current.dfmpkg')).length, readFileSync(join(s.usb, 'neu.dfmpkg')).length, 'Paket liegt zur Verteilung an die Bildschirme im Hub');
    const log = (await a('GET', '/api/v1/audit?security=1')).json(); assert.ok(log.some((x) => x.action === 'update.eingespielt'), 'Sicherheitsereignis'); assert.ok(log.filter((x) => x.action === 'update.abgelehnt').length >= 2);
    assert.equal((await a('GET', '/api/v1/update/usb')).json().current, '1.0.1', 'laufende Version nennt jetzt das neue Update');
  } finally { await s.done(); }
});

test('USB-Update: kein Stick = verständliche Meldung', async () => {
  const s = await setup(); const a = await s.h.as('admin');
  try {
    rmSync(s.usb, { recursive: true, force: true });
    assert.deepEqual((await a('GET', '/api/v1/update/usb')).json().packages, []); const r = await a('POST', '/api/v1/update/usb/install', { name: 'neu.dfmpkg', confirmed: true });
    assert.equal(r.statusCode, 404); assert.match(r.json().error, /USB-Stick/);
  } finally { await s.done(); }
});
