// Gesundheits-Prognose (0.2.24): Schätzung aus dem Messwerte-Verlauf – Speicherplatz, Arbeitsspeicher-Leck, Temperatur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { createMetrics, HUB } from '../lib/metrics.js';
import { analyze, linreg, prognoseReport } from '../lib/prognose.js';

const rows = (n, f) => Array.from({ length: n }, (_, h) => ({ h: 1000 + h, n: 60, a: null, d: null, c: null, ...f(h) }));
const one = (list, kind) => list.find((i) => i.kind === kind);

test('Prognose: Gerade durch die Messwerte (Steigung und Passgenauigkeit)', () => {
  const f = linreg([0, 1, 2, 3, 4], [10, 8, 6, 4, 2]); assert.ok(Math.abs(f.slope + 2) < 1e-9); assert.ok(f.r2 > 0.999);
  assert.ok(linreg([0, 1, 2, 3], [5, 20, 3, 18]).r2 < 0.2, 'Zickzack passt nicht zu einer Geraden'); assert.equal(linreg([1, 2], [1, 2]), null); assert.equal(linreg([1, 1, 1], [1, 2, 3]), null);
  assert.equal(linreg([0, 1, 2], [5, 5, 5]).r2, 1, 'waagerecht = perfekt stabil');
});

test('Prognose Speicherplatz: voll in etwa 8 Tagen (kritisch), in etwa 3 Wochen (Hinweis), stabil, unregelmäßig, zu wenig Daten', () => {
  const disk = (perDay, start = 8000) => analyze(rows(72, (h) => ({ d: start - (perDay / 24) * h })), { name: 'Hub' });
  const bad = one(disk(700), 'speicher'); assert.equal(bad.level, 'bad'); assert.match(bad.text, /sinkt um etwa 700 MB pro Tag/); assert.match(bad.text, /in etwa 8 Tagen voll/); assert.ok(bad.hint); assert.ok(Math.abs(bad.estimate.daysLeft - 8.5) < 0.2);
  const warn = one(disk(400), 'speicher'); assert.equal(warn.level, 'warn'); assert.match(warn.text, /in etwa 2 Wochen voll/);
  const ok = one(disk(60), 'speicher'); assert.equal(ok.level, 'ok'); assert.match(ok.text, /in etwa \d+ Monaten voll/); assert.equal(ok.hint, null);
  assert.equal(one(disk(0), 'speicher').level, 'ok'); assert.match(one(disk(0), 'speicher').text, /bleibt stabil \(8000 MB frei\)/);
  const noisy = one(analyze(rows(72, (h) => ({ d: 8000 - 40 * h + (h % 2 ? 3000 : -3000) })), { name: 'Hub' }), 'speicher'); assert.equal(noisy.level, 'info'); assert.match(noisy.text, /unregelmäßig/);
  const few = analyze(rows(10, () => ({ d: 5000, a: 500, c: 50 })), { name: 'Hub' }); assert.deepEqual(few.map((i) => i.level), ['wait', 'wait', 'wait']); assert.match(few[0].text, /erst 10 von 24 Stunden/);
  assert.equal(one(analyze(rows(72, () => ({ a: 400, c: 50 })), { name: 'Pi' }), 'speicher').level, 'wait', 'Bildschirm ohne Speicherplatz-Werte');
  assert.equal(analyze(rows(5, () => ({})), { name: 'x', canDisk: false }).some((i) => i.kind === 'speicher'), false);
});

test('Prognose Arbeitsspeicher: Leck seit dem letzten Neustart, Neustart-Sprung wird erkannt, stabiler Verlauf', () => {
  const leak = one(analyze(rows(24, (h) => ({ a: 700 - 20 * h, d: 5000 })), { name: 'Pi' }), 'arbeitsspeicher'); assert.equal(leak.level, 'bad'); assert.match(leak.text, /sinkt seit dem letzten Neustart um etwa 480 MB pro Tag/); assert.match(leak.text, /in etwa 9 Stunden knapp/);
  const slow = one(analyze(rows(30, (h) => ({ a: 700 - 5 * h })), { name: 'Pi' }), 'arbeitsspeicher'); assert.equal(slow.level, 'info', 'langsam: nur zur Kenntnis'); assert.equal(slow.hint, null);
  const rebooted = one(analyze(rows(30, (h) => ({ a: h < 20 ? 700 - 20 * h : 690 - (h % 3) })), { name: 'Pi' }), 'arbeitsspeicher'); assert.equal(rebooted.level, 'ok', 'nach dem Neustart wieder stabil'); assert.match(rebooted.text, /stabil/);
  const early = one(analyze(rows(30, (h) => ({ a: h < 27 ? 700 - 20 * h : 690 })), { name: 'Pi' }), 'arbeitsspeicher'); assert.equal(early.level, 'wait', 'direkt nach dem Neustart noch zu wenige Werte');
});

test('Prognose Temperatur: oft über 70 °C kritisch, oft über 60 °C und Erwärmung als Hinweis, sonst unauffällig', () => {
  const t = (f, n = 72) => one(analyze(rows(n, (h) => ({ c: f(h) })), { name: 'Pi' }), 'temperatur');
  const hot = t(() => 72); assert.equal(hot.level, 'bad'); assert.match(hot.text, /24 von 24 Stunden über 70 °C/); assert.match(hot.hint, /Kühlkörper/);
  const warm = t(() => 64); assert.equal(warm.level, 'warn'); assert.match(warm.text, /über 60 °C/);
  const warming = t((h) => (h < 48 ? 45 : 58)); assert.equal(warming.level, 'warn'); assert.match(warming.text, /wird wärmer/);
  const fine = t(() => 52); assert.equal(fine.level, 'ok'); assert.match(fine.text, /unauffällig/); assert.equal(t(() => 62, 12).level, 'wait');
  assert.equal(t((h) => (h >= 60 ? 71 : 50)).level, 'bad', 'ab 10 % der letzten 24 Stunden über 70 °C');
});

const seed = (h, src, hours, f) => { const ins = h.db.prepare('INSERT INTO metrics(ts,src,mem_avail,mem_total,swap_used,load1,temp,disk_free) VALUES(?,?,?,?,?,?,?,?)'); for (let m = 0; m < hours * 60; m += 10) { const x = f(m / 60); ins.run(h.clock.t - (hours * 60 - m) * 60000, src, x.a ?? null, 900, 0, 0.5, x.c ?? null, x.d ?? null); } };

test('Prognose: Bericht aus der Datenbank (Hub und Bildschirme), Sortierung nach Dringlichkeit, Route mit Rechten', async () => {
  const h = await makeHub({}); const a = await h.as('admin'), e = await h.as('edi'), v = await h.as('vera'); const dev = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,created_at) VALUES(?,'Foyer links','standard','active',?,?)").run(dev, h.clock.t, h.clock.t);
  h.db.prepare('DELETE FROM metrics').run(); /* der Hub hat beim Start schon einen echten Messwert geschrieben */ seed(h, HUB, 72, (x) => ({ d: 9000 - 30 * x, a: 600, c: 50 })); seed(h, dev, 72, (x) => ({ a: 400 - 0.1 * (x % 5), c: 66 }));
  const r = prognoseReport(h.db, h.clock.t); assert.equal(r.items.length, 6); assert.equal(r.bad, 1); assert.equal(r.warn, 1);
  assert.deepEqual(r.items.slice(0, 2).map((i) => [i.name, i.kind, i.level]), [['Hub', 'speicher', 'bad'], ['Foyer links', 'temperatur', 'warn']], 'Dringendes zuerst');
  assert.match(r.items[0].text, /in etwa \d+ Tagen voll/); assert.ok(r.items.some((i) => i.name === 'Foyer links' && i.kind === 'speicher' && i.level === 'wait'));
  const res = await e('GET', '/api/v1/prognose'); assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().items.length, 6); assert.match(res.json().hint, /Schätzungen/);
  const only = (await a('GET', '/api/v1/prognose?nurProbleme=1')).json(); assert.deepEqual(only.items.map((i) => i.level), ['bad', 'warn']);
  assert.equal((await v('GET', '/api/v1/prognose')).statusCode, 403); assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/prognose' })).statusCode, 401);
  await h.cleanup();
});

test('Messwerte: freier Speicherplatz wird mit aufgezeichnet (Hub aus dem Dateisystem, Bildschirme aus dem Heartbeat) und im Verlauf geliefert', async () => {
  const h = await makeHub({}); let t = 1_700_000_000_000; const m = createMetrics({ db: h.db, now: () => t, dataDir: h.dataDir });
  assert.equal(m.recordHub(), true); const hubRow = h.db.prepare("SELECT disk_free FROM metrics WHERE src='hub' AND ts=?").get(t); assert.ok(hubRow.disk_free > 0, 'Platz des Datenträgers in MB');
  t += 60000; assert.equal(m.recordDevice('abc', { ramTotalMB: 900, ramUsedMB: 500, cpuTemp: 55, load1: 1, diskFreeMB: 4321 }), true);
  const q = m.query('abc', 1); assert.equal(q.points.at(-1).diskFreeMB, 4321); assert.equal(q.points.at(-1).tempC, 55);
  t += 60000; const none = createMetrics({ db: h.db, now: () => t }); none.recordHub(); assert.equal(h.db.prepare("SELECT disk_free FROM metrics WHERE src='hub' AND ts=?").get(t).disk_free, null, 'ohne Datenordner kein Wert');
  await h.cleanup();
});
