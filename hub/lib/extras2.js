// Erweiterungen (Phase 10/11): Vorlagen + Lesbarkeit, QR-Code, Feiertage/Sondertage, Zonen + Laufband, Inbetriebnahme-Test,
// Medien-Massenimport, Datenschutz (Aufbewahrung), Wochenvorlagen/Duplizieren, Passwort-Rücksetzung per Wiederherstellungscode.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, lstatSync, realpathSync, openSync, readSync, closeSync, copyFileSync, createReadStream, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve, sep, basename, extname } from 'node:path';
import sharp from 'sharp';
import { parseJson } from '../../shared/guard.js';
import { BUILTIN, renderTemplate, readability, buildQrPayload, isInternalHost, renderQr, qrChecks } from './templates.js';
import { detectKind, probeVideo, mediaHints, SHARP_OPTS, LIMITS } from './variants.js';
import { epochToLocal, localToEpoch, addDays, dowOf } from '../../shared/time.js';
import { sha256hex, hashPassword, checkPasswordPolicy } from './crypto.js';
import { createLimiter } from './ratelimit.js';
import { deviceStatus } from './devices.js';
import { resolvePlaylist } from '../../shared/sequencer.js';
import { schedulePayload, DAY } from './plan.js';
import { signalQuality } from './health.js';

const pexec = promisify(execFile);
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const iso = (d) => d.toISOString().slice(0, 10);
/** Ostersonntag (Gauß) → bewegliche Feiertage in NRW */
function easter(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return new Date(Date.UTC(y, mo - 1, da)); }
const plus = (d, n) => new Date(d.getTime() + n * DAY);
export function holidaysNRW(y) {
  const e = easter(y), fixed = (m, d) => iso(new Date(Date.UTC(y, m - 1, d)));
  return [[fixed(1, 1), 'Neujahr'], [iso(plus(e, -2)), 'Karfreitag'], [iso(plus(e, 1)), 'Ostermontag'], [fixed(5, 1), 'Tag der Arbeit'], [iso(plus(e, 39)), 'Christi Himmelfahrt'], [iso(plus(e, 50)), 'Pfingstmontag'], [iso(plus(e, 60)), 'Fronleichnam'],
    [fixed(10, 3), 'Tag der Deutschen Einheit'], [fixed(11, 1), 'Allerheiligen'], [fixed(12, 25), '1. Weihnachtstag'], [fixed(12, 26), '2. Weihnachtstag']].sort((a, b) => a[0].localeCompare(b[0]));
}

async function extras2Plugin(app, { db, audit, mediaDir, dataDir, variants, now = () => Date.now(), importRoots, usbDir = process.env.DFM_USB_DIR ?? '/media/usb' }) {
  const A = (req, action, target, detail, security = false) => audit.log({ user: req.user, action, target, ip: req.ip, detail, security });
  const settings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
  const dv = () => app.devices;
  const stOf = (d) => { try { return d.state_json ? JSON.parse(d.state_json) : null; } catch { return null; } };
  const target = (devId) => { const d = devId ? dv().getDevice(devId) : null; const rot = d && (d.orientation === 90 || d.orientation === 270); const s = settings(); return { name: d?.name ?? 'Bildschirm', width: rot ? 1080 : 1920, height: rot ? 1920 : 1080, diagonalInch: Number(s['screen.diagonalInch'] ?? 43), distanceM: Number(s['screen.distanceM'] ?? 3) }; };

  // ======================= Vorlagen (Z.5) =======================
  const customTpls = () => db.prepare("SELECT * FROM templates ORDER BY name").all().map((t) => ({ id: t.id, name: t.name, custom: true, state: t.state, style: t.base, ...JSON.parse(t.fields_json) }));
  const allTpls = () => [...BUILTIN.map((t) => ({ id: t.id, name: t.name, style: t.style, dyn: !!t.dyn, fields: t.fields, custom: false, state: 'published' })), ...customTpls()];
  const findTpl = (id) => BUILTIN.find((t) => t.id === id) ?? customTpls().find((t) => t.id === id && t.state === 'published');
  app.get('/api/v1/templates', { config: { perm: 'templates.use' } }, async () => allTpls().map(({ render, ...t }) => t));
  const tplBody = { type: 'object', required: ['fields'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 100 }, fields: { type: 'object', maxProperties: 20 }, deviceId: { type: 'string', maxLength: 40 }, distanceM: { type: 'number', minimum: 0.5, maximum: 30 } } };
  const resolveTpl = (req, reply) => { const t = findTpl(req.params.id); if (!t) { reply.code(404).send({ error: 'Diese Vorlage gibt es nicht.' }); return null; } return t; };
  app.post('/api/v1/templates/:id/check', { config: { perm: 'templates.use' }, schema: { body: tplBody } }, async (req, reply) => { // Lesbarkeit prüfen, ohne zu speichern
    const t = resolveTpl(req, reply); if (!t) return; try { const r = renderTemplate(t, req.body.fields, now()); const tg = target(req.body.deviceId); return { preview: r, readability: readability(r, { ...tg, ...(req.body.distanceM ? { distanceM: req.body.distanceM } : {}) }) }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.post('/api/v1/templates/:id/create', { config: { perm: 'templates.use' }, schema: { body: tplBody } }, async (req, reply) => { // Keine Vorlage ohne Prüfung: Ergebnis enthält immer die Lesbarkeit
    const t = resolveTpl(req, reply); if (!t) return; let r; try { r = renderTemplate(t, req.body.fields, now()); } catch (e) { return reply.code(400).send({ error: e.message }); }
    const tg = target(req.body.deviceId), rd = readability(r, { ...tg, ...(req.body.distanceM ? { distanceM: req.body.distanceM } : {}) });
    const id = randomUUID(); db.prepare("INSERT INTO media(id,name,kind,text_json,created_by,created_at) VALUES(?,?,'text',?,?,?)").run(id, (req.body.name || t.name).slice(0, 100), JSON.stringify({ ...r, tpl: { id: t.id, fields: req.body.fields } }), req.user.id, now());
    variants.ensureAll(); A(req, 'vorlage.erstellt', t.name); return reply.code(201).send({ id, readability: rd, text: rd.length ? 'Gespeichert. Bitte lies die Hinweise zur Lesbarkeit.' : 'Gespeichert. Die Lesbarkeit ist in Ordnung.' });
  });
  // Eigene Vorlagen / Layoutänderungen: nur Admins; sie müssen die Lesbarkeitsprüfung bestehen
  const customBody = { type: 'object', required: ['name', 'style', 'titleTpl', 'fields'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, style: { enum: ['standard', 'hinweis', 'highlight'] }, titleTpl: { type: 'string', maxLength: 200 }, bodyTpl: { type: 'string', maxLength: 600 },
    publish: { type: 'boolean' }, fields: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', required: ['key', 'label'], additionalProperties: false, properties: { key: { type: 'string', pattern: '^\\w{1,20}$' }, label: { type: 'string', maxLength: 100 }, def: { type: 'string', maxLength: 200 }, max: { type: 'integer', minimum: 1, maximum: 600 }, type: { enum: ['text', 'lines', 'date'] } } } } } };
  function checkCustom(b) { const t = { ...b, titleTpl: b.titleTpl, bodyTpl: b.bodyTpl ?? '', style: b.style }; const r = renderTemplate(t, Object.fromEntries(b.fields.map((f) => [f.key, f.def ?? ''])), now()); const rd = readability(r, {}); return { r, rd, bad: rd.find((x) => x.kind === 'kontrast' && x.level === 'error') }; }
  app.post('/api/v1/templates', { config: { perm: 'templates.manage' }, schema: { body: customBody } }, async (req, reply) => {
    let c; try { c = checkCustom(req.body); } catch (e) { return reply.code(400).send({ error: e.message }); } if (c.bad) return reply.code(400).send({ error: c.bad.text });
    const id = randomUUID(), { name, style, publish, ...rest } = req.body; db.prepare('INSERT INTO templates VALUES(?,?,?,?,?,?,?)').run(id, name, style, JSON.stringify(rest), publish ? 'published' : 'draft', req.user.id, now()); A(req, 'vorlage.angelegt', name); return reply.code(201).send({ id, readability: c.rd });
  });
  app.post('/api/v1/templates/:id/publish', { config: { perm: 'templates.manage' } }, async (req, reply) => { if (!db.prepare("UPDATE templates SET state='published' WHERE id=?").run(req.params.id).changes) return reply.code(404).send({ error: 'Vorlage nicht gefunden.' }); A(req, 'vorlage.veroeffentlicht', req.params.id); return { ok: true }; });
  app.delete('/api/v1/templates/:id', { config: { perm: 'templates.manage' } }, async (req, reply) => { if (!db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id).changes) return reply.code(404).send({ error: 'Vorlage nicht gefunden.' }); A(req, 'vorlage.geloescht', req.params.id); return { ok: true }; });
  app.post('/api/v1/readability', { config: { perm: 'templates.use' }, schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 1000 }, template: { enum: ['standard', 'hinweis', 'highlight'] }, deviceId: { type: 'string', maxLength: 40 } } } } },
    async (req) => ({ readability: readability({ title: req.body.title, body: req.body.body ?? '', template: req.body.template ?? 'standard' }, target(req.body.deviceId)) }));
  /** Täglich: Countdown/Datum neu berechnen (die Texte stehen als Medien in der Bibliothek) */
  function refreshDynamic() {
    let n = 0; for (const m of db.prepare("SELECT id,text_json FROM media WHERE kind='text' AND text_json LIKE '%\"tpl\"%'").all()) {
      const tj = JSON.parse(m.text_json), t = tj.tpl && BUILTIN.find((x) => x.id === tj.tpl.id); if (!t?.dyn) continue;
      const r = renderTemplate(t, tj.tpl.fields, now()); if (r.title !== tj.title || r.body !== tj.body) { db.prepare('UPDATE media SET text_json=? WHERE id=?').run(JSON.stringify({ ...tj, ...r }), m.id); db.prepare("DELETE FROM media_variants WHERE media_id=?").run(m.id); n++; }
    }
    if (n) { variants.ensureAll(); app.pushAll(); } return n;
  }

  // ======================= QR-Code-Element (Z.12) =======================
  const qrBody = { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { enum: ['url', 'wifi', 'contact', 'text'] }, url: { type: 'string', maxLength: 500 }, ssid: { type: 'string', maxLength: 40 }, password: { type: 'string', maxLength: 80 }, security: { enum: ['WPA', 'nopass'] },
    name: { type: 'string', maxLength: 100 }, phone: { type: 'string', maxLength: 40 }, email: { type: 'string', maxLength: 120 }, org: { type: 'string', maxLength: 100 }, text: { type: 'string', maxLength: 500 }, heading: { type: 'string', maxLength: 80 }, caption: { type: 'string', maxLength: 200 }, mediaName: { type: 'string', maxLength: 100 },
    deviceId: { type: 'string', maxLength: 40 }, distanceM: { type: 'number', minimum: 0.5, maximum: 30 } } };
  async function qrFrom(req, reply) {
    const b = req.body; let p; try { p = buildQrPayload(b); } catch (e) { reply.code(400).send({ error: e.message }); return null; }
    const warns = []; const allow = (settings()['qr.allowedHosts'] ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (p.host) {
      if (isInternalHost(p.host)) warns.push({ level: 'warn', kind: 'intern', text: 'Diese Adresse zeigt ins interne Netz. Besucher erreichen nur öffentliche Adressen und können sie nicht öffnen.' });
      if (allow.length && req.user.role !== 'admin' && !allow.some((a) => p.host.toLowerCase() === a || p.host.toLowerCase().endsWith('.' + a))) { reply.code(403).send({ error: `Diese Adresse ist nicht erlaubt. Erlaubt sind: ${allow.join(', ')}. Bitte einen Admin fragen.` }); return null; }
    }
    const tg = target(b.deviceId), r = await renderQr({ ...p, heading: b.heading ?? '', text: b.caption ?? '' }, { width: tg.width, height: tg.height });
    return { p, r, warnings: [...warns, ...qrChecks(r, { ...tg, ...(b.distanceM ? { distanceM: b.distanceM } : {}) })] };
  }
  app.post('/api/v1/qr/check', { config: { perm: 'qr.write' }, schema: { body: qrBody } }, async (req, reply) => { const x = await qrFrom(req, reply); if (!x) return; return { decoded: x.r.decoded, matches: x.r.matches, warnings: x.warnings, plain: x.p.plain, preview: 'data:image/png;base64,' + (await sharp(x.r.png).resize({ width: 640 }).png().toBuffer()).toString('base64') }; });
  app.post('/api/v1/qr/create', { config: { perm: 'qr.write' }, schema: { body: qrBody } }, async (req, reply) => {
    const x = await qrFrom(req, reply); if (!x) return; if (x.warnings.some((w) => w.level === 'error')) return reply.code(400).send({ error: x.warnings.find((w) => w.level === 'error').text, warnings: x.warnings });
    const id = randomUUID(), file = randomUUID(); mkdirSync(join(mediaDir, 'original'), { recursive: true }); writeFileSync(join(mediaDir, 'original', file), x.r.png);
    db.prepare('INSERT INTO media(id,name,kind,original_path,size,width,height,folder,tags,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, (req.body.mediaName || `QR-Code: ${req.body.heading || x.p.plain}`).slice(0, 100), 'image', file, x.r.png.length, x.r.width, x.r.height, 'QR-Codes', 'qr', req.user.id, now());
    variants.ensureAll(); A(req, 'qr.erstellt', id, { art: req.body.kind }); return reply.code(201).send({ id, warnings: x.warnings, decoded: x.r.matches });
  });

  // ======================= Feiertage, Schließtage, Sondertage (Z.6) =======================
  function seedHolidays() {
    const y0 = new Date(now()).getUTCFullYear(); let n = 0;
    for (let y = y0 - 1; y <= y0 + 2; y++) for (const [date, name] of holidaysNRW(y)) {
      if (db.prepare("SELECT 1 FROM special_days WHERE date=? AND source='builtin'").get(date)) continue;
      const rule = settings()['special.feiertag.rule'] ?? 'playlist'; // Regel für alle Feiertage (siehe apply-rule)
      db.prepare("INSERT INTO special_days(id,date,date_to,name,kind,rule,content_type,content_id,source,created_at) VALUES(?,?,NULL,?,'feiertag',?,?,?,'builtin',?)").run(randomUUID(), date, name, rule, settings()['special.feiertag.ctype'] ?? null, settings()['special.feiertag.cid'] ?? null, now()); n++;
    }
    return n;
  }
  seedHolidays();
  const sdView = (r) => ({ id: r.id, date: r.date, dateTo: r.date_to, name: r.name, kind: r.kind, rule: r.rule, content: r.content_id ? { type: r.content_type, id: r.content_id } : null, builtin: r.source === 'builtin', hasEffect: r.rule === 'off' || !!r.content_id,
    contentName: r.content_id ? (db.prepare(`SELECT name FROM ${r.content_type === 'media' ? 'media' : 'playlists'} WHERE id=?`).get(r.content_id)?.name ?? '?') : null });
  app.get('/api/v1/special-days', { config: { perm: 'schedules.read' }, schema: { querystring: { type: 'object', properties: { year: { type: 'string', pattern: '^\\d{4}$' } } } } }, async (req) => {
    const y = req.query.year ?? String(new Date(now()).getUTCFullYear()); return db.prepare("SELECT * FROM special_days WHERE substr(date,1,4)=? OR substr(COALESCE(date_to,date),1,4)=? ORDER BY date").all(y, y).map(sdView);
  });
  const sdSchema = { type: 'object', required: ['date', 'name'], additionalProperties: false, properties: { date: { type: 'string', pattern: DATE }, dateTo: { type: ['string', 'null'], pattern: DATE }, name: { type: 'string', minLength: 1, maxLength: 80 }, kind: { enum: ['sondertag', 'ferien', 'schliesstag', 'feiertag'] }, rule: { enum: ['playlist', 'off', 'notice'] },
    content: { type: ['object', 'null'], additionalProperties: false, properties: { type: { enum: ['playlist', 'media'] }, id: { type: 'string', maxLength: 40 } } } } };
  function sdCheck(b) { if (b.dateTo && b.dateTo < b.date) return 'Das Ende liegt vor dem Beginn.'; if ((b.rule ?? 'playlist') !== 'off') { if (!b.content) return null; const t = b.content.type === 'media' ? 'media' : 'playlists'; if (!db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(b.content.id)) return 'Diesen Inhalt gibt es nicht.'; if (t === 'playlists' && db.prepare('SELECT state FROM playlists WHERE id=?').get(b.content.id).state !== 'published') return 'Diese Abspielliste ist noch ein Entwurf. Bitte veröffentliche sie zuerst.'; } return null; }
  app.post('/api/v1/special-days', { config: { perm: 'schedules.write' }, schema: { body: sdSchema } }, async (req, reply) => {
    const bad = sdCheck(req.body); if (bad) return reply.code(400).send({ error: bad }); const b = req.body, id = randomUUID();
    db.prepare("INSERT INTO special_days VALUES(?,?,?,?,?,?,?,?,'custom',?)").run(id, b.date, b.dateTo ?? null, b.name, b.kind ?? 'sondertag', b.rule ?? 'playlist', b.content?.type ?? null, b.content?.id ?? null, now()); A(req, 'sondertag.angelegt', b.name); app.pushAll(); return reply.code(201).send({ id });
  });
  app.put('/api/v1/special-days/:id', { config: { perm: 'schedules.write' }, schema: { body: sdSchema } }, async (req, reply) => {
    const bad = sdCheck(req.body); if (bad) return reply.code(400).send({ error: bad }); const b = req.body;
    if (!db.prepare('UPDATE special_days SET date=?, date_to=?, name=?, kind=?, rule=?, content_type=?, content_id=? WHERE id=?').run(b.date, b.dateTo ?? null, b.name, b.kind ?? 'sondertag', b.rule ?? 'playlist', b.content?.type ?? null, b.content?.id ?? null, req.params.id).changes) return reply.code(404).send({ error: 'Sondertag nicht gefunden.' });
    A(req, 'sondertag.geaendert', req.params.id); app.pushAll(); return { ok: true };
  });
  app.delete('/api/v1/special-days/:id', { config: { perm: 'schedules.write' } }, async (req, reply) => { if (!db.prepare('DELETE FROM special_days WHERE id=?').run(req.params.id).changes) return reply.code(404).send({ error: 'Sondertag nicht gefunden.' }); A(req, 'sondertag.geloescht', req.params.id); app.pushAll(); return { ok: true }; });
  app.post('/api/v1/special-days/apply-rule', { config: { perm: 'schedules.write' }, schema: { body: { type: 'object', required: ['kind', 'rule'], additionalProperties: false, properties: { kind: { enum: ['feiertag'] }, rule: { enum: ['playlist', 'off', 'notice'] }, content: { type: ['object', 'null'], additionalProperties: false, properties: { type: { enum: ['playlist', 'media'] }, id: { type: 'string', maxLength: 40 } } } } } } }, async (req, reply) => {
    const bad = sdCheck({ date: '2000-01-01', rule: req.body.rule, content: req.body.content }); if (bad) return reply.code(400).send({ error: bad }); if (req.body.rule !== 'off' && !req.body.content) return reply.code(400).send({ error: 'Bitte wähle einen Inhalt für diese Regel.' });
    const c = req.body.content; for (const [k, v] of [['special.feiertag.rule', req.body.rule], ['special.feiertag.ctype', c?.type ?? ''], ['special.feiertag.cid', c?.id ?? '']]) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, v);
    const n = db.prepare("UPDATE special_days SET rule=?, content_type=?, content_id=? WHERE kind='feiertag' AND source='builtin'").run(req.body.rule, c?.type ?? null, c?.id ?? null).changes; A(req, 'sondertag.regel_gesetzt', 'feiertag', { regel: req.body.rule }); app.pushAll(); return { ok: true, changed: n };
  });

  // ======================= Zonen-Layouts und Laufband (Z.7) =======================
  const PRESETS = { ticker: { zones: 2, name: 'Hauptbereich + Laufband' }, 'ticker-clock': { zones: 3, name: 'Hauptbereich + Laufband + Uhr/Datum' }, 'ticker-clock-info': { zones: 4, name: 'Hauptbereich + Infospalte + Laufband + Uhr/Datum' } };
  app.get('/api/v1/layouts', { config: { perm: 'devices.read' } }, async () => ({ presets: Object.entries(PRESETS).map(([id, p]) => ({ id, ...p })), note: 'Zonen gibt es nur auf Standard- und Pro-Geräten. Auf Lite-Geräten läuft automatisch der Inhalt im Vollbild.' }));
  app.put('/api/v1/devices/:id/layout', { config: { perm: 'devices.manage' }, schema: { body: { type: 'object', required: ['preset'], additionalProperties: false, properties: { preset: { type: ['string', 'null'] }, info: { type: 'string', maxLength: 300 } } } } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    if (req.body.preset && !PRESETS[req.body.preset]) return reply.code(400).send({ error: 'Dieses Layout gibt es nicht.' });
    if (req.body.preset && d.profile === 'lite') return reply.code(400).send({ error: 'Lite-Geräte können keine Zonen darstellen. Dort läuft der Inhalt im Vollbild.' });
    db.prepare('UPDATE devices SET layout_json=? WHERE id=?').run(req.body.preset ? JSON.stringify({ preset: req.body.preset, info: req.body.info ?? '' }) : null, d.id); dv().pushPlan(dv().getDevice(d.id)); A(req, 'layout.geaendert', d.id, { layout: req.body.preset }); return { ok: true };
  });
  const tkSchema = { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 200 }, validFrom: { type: ['string', 'null'], pattern: DATE }, validTo: { type: ['string', 'null'], pattern: DATE }, targetType: { enum: ['all', 'device', 'group'] }, targetId: { type: 'string', maxLength: 40 } } };
  app.get('/api/v1/tickers', { config: { perm: 'schedules.read' } }, async () => db.prepare('SELECT id,text,valid_from AS validFrom,valid_to AS validTo,target_type AS targetType,target_id AS targetId FROM tickers ORDER BY created_at DESC').all());
  app.post('/api/v1/tickers', { config: { perm: 'tickers.write' }, schema: { body: tkSchema } }, async (req, reply) => {
    const b = req.body; if (b.validFrom && b.validTo && b.validTo < b.validFrom) return reply.code(400).send({ error: 'Das Ende liegt vor dem Beginn.' }); const id = randomUUID();
    db.prepare("INSERT INTO tickers VALUES(?,?,?,?,?,?,'published',?,?)").run(id, b.text, b.validFrom ?? null, b.validTo ?? null, b.targetType ?? 'all', b.targetId ?? null, req.user.id, now()); A(req, 'laufband.angelegt', id); app.pushAll(); return reply.code(201).send({ id });
  });
  app.delete('/api/v1/tickers/:id', { config: { perm: 'tickers.write' } }, async (req, reply) => { if (!db.prepare('DELETE FROM tickers WHERE id=?').run(req.params.id).changes) return reply.code(404).send({ error: 'Meldung nicht gefunden.' }); A(req, 'laufband.geloescht', req.params.id); app.pushAll(); return { ok: true }; });

  // ======================= Inbetriebnahme-Test (Z.14) =======================
  const waitCmd = async (id, ms) => { const t0 = Date.now(); for (;;) { const c = db.prepare('SELECT status,result_json FROM commands WHERE id=?').get(id); if (c && c.status !== 'queued' && c.status !== 'sent') return c; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 150)); } };
  const reportRow = (r) => ({ id: r.id, ts: r.ts, userName: r.user_name, result: r.result, items: parseJson(r.items_json, []), device: r.device_json ? JSON.parse(r.device_json) : null });
  app.get('/api/v1/devices/:id/commissioning', { config: { perm: 'devices.read' } }, async (req) => db.prepare('SELECT * FROM commissioning_reports WHERE device_id=? ORDER BY ts DESC LIMIT 50').all(req.params.id).map(reportRow));
  app.get('/api/v1/commissioning/:rid', { config: { perm: 'devices.read' } }, async (req, reply) => { const r = db.prepare('SELECT * FROM commissioning_reports WHERE id=?').get(req.params.rid); return r ? reportRow(r) : reply.code(404).send({ error: 'Protokoll nicht gefunden.' }); });
  const MAXSKEW = 120000;
  app.post('/api/v1/devices/:id/commissioning/run', { config: { perm: 'devices.manage' }, schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: { answers: { type: 'object', additionalProperties: { type: 'boolean' } }, noWait: { type: 'boolean' } } } } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d || d.status !== 'active') return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    const answers = req.body?.answers ?? {}, items = [], t = now(), online = deviceStatus(d, t).level === 'ok', hw = parseJson(d.hw_json, {});
    const item = (id, title, status, text, hint, extra = {}) => items.push({ id, title, status, text, ...(hint ? { hint } : {}), ...extra });
    // 1 Verbindung
    let diag = null, rtt = null;
    if (online && dv().sockets.get(d.id)?.readyState === 1) {
      const id = randomUUID(), t0 = Date.now(); db.prepare('INSERT INTO commands(id,device_id,type,args_json,created_at) VALUES(?,?,?,?,?)').run(id, d.id, 'diagnose', JSON.stringify({ testvideo: !!d.profile, quick: true }), t);
      dv().sendTo(d.id, 'command', { id, command: 'diagnose', args: { testvideo: true, quick: true } }); if (!answers._seen) dv().sendTo(d.id, 'command', { id: 'tp-' + randomUUID(), command: 'testpattern', args: { on: true, seconds: 180 } });
      const c = await waitCmd(id, req.body?.noWait ? 1500 : 60000); rtt = Date.now() - t0; if (c?.status === 'done') diag = JSON.parse(c.result_json);
    }
    const st = diag ?? stOf(d) ?? {};
    if (!online) item('verbindung', 'Verbindung zum Hub', 'fail', 'Der Bildschirm antwortet nicht.', 'Bitte Strom und WLAN prüfen. Der Hub ist nur im selben Netz erreichbar.');
    else item('verbindung', 'Verbindung zum Hub', 'ok', `Verbunden und gesichert (Fingerabdruck geprüft)${rtt != null ? `, Antwortzeit ${rtt} ms` : ''}.`);
    // 2 WLAN
    const q = signalQuality(st.signalDbm), thr = diag?.throughputMBs, rec = st.reconnects ?? 0;
    if (st.signalDbm == null) item('wlan', 'WLAN-Qualität', 'skip', 'Der Bildschirm ist per Kabel verbunden oder meldet kein Signal.');
    else if (q.level === 'zu_schwach') item('wlan', 'WLAN-Qualität', 'fail', `Signal ${q.label.toLowerCase()} (${st.signalDbm} dBm).`, 'Das WLAN-Signal ist schwach. Stelle den Bildschirm näher an den Access Point.');
    else if (q.level === 'schwach' || (thr != null && thr < 0.5) || rec > 5) item('wlan', 'WLAN-Qualität', 'warn', `Signal ${q.label.toLowerCase()}${thr != null ? `, ${thr} MB/s zum Hub` : ''}, ${rec} Wiederverbindungen.`, 'Das WLAN-Signal ist grenzwertig. Näher an den Access Point stellen oder ein Netzwerkkabel nutzen.');
    else item('wlan', 'WLAN-Qualität', 'ok', `Signal ${q.label.toLowerCase()}${thr != null ? `, ${thr} MB/s zum Hub` : ''}.`);
    // 3 Uhrzeit
    const skew = st.epoch ? Math.abs(st.epoch - t) : null;
    if (st.timeSynced === false || (skew != null && skew > MAXSKEW)) item('uhrzeit', 'Uhrzeit', 'fail', skew != null && skew > MAXSKEW ? `Die Uhr geht ${Math.round(skew / 60000)} Minuten falsch.` : 'Die Uhr ist nicht abgeglichen.', 'Termine würden zur falschen Zeit starten. Bitte die Uhr des Hubs prüfen (Startseite) und den Bildschirm neu starten.');
    else item('uhrzeit', 'Uhrzeit', 'ok', 'Die Uhr stimmt mit dem Hub überein.');
    // 4 Netzteil, Temperatur, Speicher
    const th = st.throttled, p = [];
    if (th != null && (th & 0x1)) p.push('fail:Unterspannung erkannt'); else if (th != null && (th & 0x10000)) p.push('warn:Unterspannung trat früher auf'); if ((st.cpuTemp ?? 0) >= 80) p.push('fail:zu heiß'); else if ((st.cpuTemp ?? 0) >= 72) p.push('warn:sehr warm'); if (st.diskFreeMB != null && st.diskFreeMB < 200) p.push('warn:wenig freier Speicher');
    const worst = p.some((x) => x.startsWith('fail')) ? 'fail' : p.length ? 'warn' : 'ok';
    item('netzteil', 'Netzteil, Temperatur, Speicher', worst, p.length ? p.map((x) => x.split(':')[1]).join(', ') + '.' : `In Ordnung (${st.cpuTemp ?? '–'} °C, ${st.diskFreeMB ?? '–'} MB frei).`, worst === 'ok' ? null : 'Bitte das Original-Netzteil verwenden, für Luft sorgen und nicht benötigte Medien entfernen.');
    // 5 Videotest
    const tv = diag?.testvideo; if (!diag) item('video', 'Videotest', 'skip', 'Der Videotest braucht eine bestehende Verbindung.'); else if (!tv || tv.error) item('video', 'Videotest', 'warn', 'Das Testvideo konnte nicht abgespielt werden.', 'Bitte später erneut prüfen.');
    else if ((tv.percent ?? 0) > 5) item('video', 'Videotest', 'fail', `${tv.percent} % der Bilder gingen verloren.`, 'Das Gerät schafft Videos in diesem Profil nicht flüssig. Bitte das Profil „Lite“ wählen oder ein stärkeres Gerät verwenden.'); else if ((tv.percent ?? 0) > 1) item('video', 'Videotest', 'warn', `${tv.percent} % verlorene Bilder.`); else item('video', 'Videotest', 'ok', 'Das Testvideo lief flüssig, keine verlorenen Bilder.');
    // 6 Bildtest (Mensch)
    const ask = (id, title, text, ok, fail) => { if (answers[id] === true) item(id, title, 'ok', ok); else if (answers[id] === false) item(id, title, 'fail', fail.text, fail.hint); else item(id, title, 'ask', text, null, { question: true }); };
    ask('bild', 'Bildtest', 'Der Bildschirm zeigt jetzt ein Testbild. Sind Farben, Raster, Ränder und die Ausrichtung („OBEN“ ist oben) in Ordnung?', 'Das Testbild wurde bestätigt.', { text: 'Das Testbild wurde als fehlerhaft gemeldet.', hint: 'Bitte Ausrichtung, Overscan oder HDMI-Kabel prüfen.' });
    // 7 Ton (nur wenn erkannt)
    if (hw.audio || st.audio) ask('ton', 'Ton', 'Hörst du den Testton?', 'Der Ton wurde bestätigt.', { text: 'Kein Ton hörbar.', hint: 'Bitte Lautstärke und HDMI-Ton prüfen.' }); else item('ton', 'Ton', 'skip', 'Keine Tonausgabe erkannt.');
    // 8 Synchronisation
    const ss = st.syncState; if (!ss || (ss.total ?? 0) === 0) item('sync', 'Synchronisation', online ? 'ok' : 'skip', online ? 'Es sind noch keine Medien zu laden.' : 'Nicht geprüft.'); else if (ss.done >= ss.total) item('sync', 'Synchronisation', 'ok', `Alle ${ss.total} Medien sind geladen.`); else item('sync', 'Synchronisation', 'warn', `${ss.done} von ${ss.total} Medien geladen.`, 'Bitte kurz warten und noch einmal prüfen.');
    const pending = items.some((i) => i.status === 'ask'), failed = items.some((i) => i.status === 'fail'), warn = items.some((i) => i.status === 'warn');
    const result = pending && !failed ? 'pending' : failed ? 'fail' : warn ? 'warn' : 'ok'; let reportId = null;
    if (result !== 'pending') {
      reportId = randomUUID(); const device = { name: d.name, model: d.model, profile: d.profile, serial: d.serial ?? hw.serial ?? null, mac: d.mac ?? hw.mac ?? null, version: st.version ?? null, signalDbm: st.signalDbm ?? null, tempC: st.cpuTemp ?? null };
      db.prepare('INSERT INTO commissioning_reports VALUES(?,?,?,?,?,?,?)').run(reportId, d.id, t, req.user.name, result, JSON.stringify(items), JSON.stringify(device));
      if (result !== 'fail') { db.prepare('UPDATE devices SET ready=1 WHERE id=?').run(d.id); dv().pushPlan(dv().getDevice(d.id)); }
      dv().sendTo(d.id, 'command', { id: 'tp-' + randomUUID(), command: 'testpattern', args: { on: false } });
      A(req, 'inbetriebnahme.' + result, d.id);
      if (diag?.throughputMBs) db.prepare('INSERT INTO wifi_history(device_id,ts,signal_dbm,quality,bssid,ssid,channel,band,reconnects,throughput_kbps) VALUES(?,?,?,?,?,?,?,?,?,?)').run(d.id, t, st.signalDbm ?? null, q.level, st.wifi?.bssid ?? null, st.wifi?.ssid ?? null, st.wifi?.channel ?? null, st.wifi?.band ?? null, rec, Math.round(diag.throughputMBs * 8192));
    }
    return { result, items, reportId, ts: t, userName: req.user.name, ready: result === 'ok' || result === 'warn' };
  });
  app.post('/api/v1/devices/:id/commissioning/skip', { config: { perm: 'devices.manage' } }, async (req, reply) => {
    const d = dv().getDevice(req.params.id); if (!d) return reply.code(404).send({ error: 'Bildschirm nicht gefunden.' });
    db.prepare('INSERT INTO commissioning_reports VALUES(?,?,?,?,?,?,?)').run(randomUUID(), d.id, now(), req.user.name, 'skipped', JSON.stringify([{ id: 'skip', title: 'Prüfung', status: 'skip', text: 'Bewusst übersprungen durch ' + req.user.name }]), JSON.stringify({ name: d.name, model: d.model }));
    db.prepare('UPDATE devices SET ready=1 WHERE id=?').run(d.id); dv().pushPlan(dv().getDevice(d.id)); A(req, 'inbetriebnahme.uebersprungen', d.id, null, true); return { ok: true };
  });

  // ======================= Medien-Massenimport (Z.10) =======================
  const roots = importRoots ?? (process.env.DFM_IMPORT_ROOTS ? process.env.DFM_IMPORT_ROOTS.split(':') : ['/media', '/mnt', join(dataDir, 'import')]); mkdirSync(join(dataDir, 'import'), { recursive: true });
  const scans = new Map(), jobs = new Map(), sha = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });
  const safeDir = (p) => { let real; try { real = realpathSync(resolve(String(p))); } catch { return null; } return roots.some((r) => { let rr; try { rr = realpathSync(r); } catch { return false; } return real === rr || real.startsWith(rr + sep); }) ? real : null; };
  const nice = (f) => basename(f, extname(f)).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 100) || 'Datei';
  async function walk(root, depth = 0, out = []) { if (depth > 4 || out.length >= 2000) return out; for (const e of readdirSync(root, { withFileTypes: true })) { const p = join(root, e.name); let st; try { st = lstatSync(p); } catch { continue; } if (st.isSymbolicLink()) continue; if (st.isDirectory()) await walk(p, depth + 1, out); else if (st.isFile() && out.length < 2000) out.push({ p, size: st.size }); } return out; }
  async function haveHashes() { const have = new Map(); for (const m of db.prepare("SELECT id,name,original_path,sha256 FROM media WHERE original_path IS NOT NULL").all()) { let h = m.sha256; if (!h && existsSync(join(mediaDir, 'original', m.original_path))) { h = await sha(join(mediaDir, 'original', m.original_path)); db.prepare('UPDATE media SET sha256=? WHERE id=?').run(h, m.id); } if (h) have.set(h, m.name); } return have; }
  app.get('/api/v1/import/roots', { config: { perm: 'import.run' } }, async () => ({ roots: roots.filter((r) => { try { return existsSync(r); } catch { return false; } }), hint: 'Ein eingesteckter USB-Stick wird automatisch schreibgeschützt unter /media/usb eingebunden. Netzwerkfreigaben bindet der Techniker unter /mnt ein. Der Hub liest dort nur.' }));
  /** Steckt ein USB-Stick mit Dateien? (Der Hub bindet ihn schreibgeschützt unter /media/usb ein.) */
  app.get('/api/v1/import/usb', { config: { perm: 'import.run' } }, async () => { try { const real = realpathSync(usbDir); if (!roots.some((r) => { try { const rr = realpathSync(r); return real === rr || real.startsWith(rr + sep); } catch { return false; } })) return { present: false, path: usbDir }; const n = readdirSync(usbDir).filter((x) => !x.startsWith('.')).length; return { present: n > 0, path: real, entries: n }; } catch { return { present: false, path: usbDir }; } });
  app.post('/api/v1/import/scan', { config: { perm: 'import.run' }, schema: { body: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string', maxLength: 300 } } } } }, async (req, reply) => {
    const dir = safeDir(req.body.path); if (!dir) return reply.code(400).send({ error: `Dieser Ordner ist nicht freigegeben. Erlaubt sind nur Ordner unter: ${roots.join(', ')}.` });
    const files = await walk(dir), have = await haveHashes(), items = [], seen = new Map();
    for (const f of files) {
      const fd = openSync(f.p, 'r'); const head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0); closeSync(fd); const kind = detectKind(head); const rel = relative(dir, f.p);
      if (!kind) { items.push({ rel, kind: null, size: f.size, supported: false, note: 'Dieses Format wird nicht unterstützt.' }); continue; }
      if (f.size > LIMITS[kind]) { items.push({ rel, kind, size: f.size, supported: false, note: 'Die Datei ist zu groß.' }); continue; }
      const h = await sha(f.p); const dup = have.get(h) ?? (seen.has(h) ? seen.get(h) : null); seen.set(h, nice(f.p));
      let w = null, hh = null; if (kind === 'image') { try { const m = await sharp(f.p, SHARP_OPTS).metadata(); w = m.width; hh = m.height; } catch { items.push({ rel, kind, size: f.size, supported: false, note: 'Das Bild kann nicht gelesen werden.' }); continue; } }
      items.push({ rel, kind, size: f.size, supported: true, ...(kind === 'pdf' ? { note: 'Wird seitenweise in Bilder umgewandelt (höchstens 60 Seiten).' } : {}), name: nice(f.p), folder: relative(dir, join(f.p, '..')).split(sep).join('/').slice(0, 60), sha256: h, duplicateOf: dup, width: w, height: hh, hints: mediaHints(kind, w, hh), include: !dup });
    }
    const id = randomUUID(); scans.set(id, { dir, items, user: req.user.id, ts: now() }); for (const [k, v] of scans) if (now() - v.ts > 3600000) scans.delete(k); // Vorschau: noch NICHTS übernommen
    A(req, 'import.vorschau', dir, { dateien: items.length }); return { scanId: id, dir, items, summary: { total: items.length, importable: items.filter((i) => i.supported && !i.duplicateOf).length, duplicates: items.filter((i) => i.duplicateOf).length, unsupported: items.filter((i) => !i.supported).length } };
  });
  app.post('/api/v1/import/commit', { config: { perm: 'import.run' }, schema: { body: { type: 'object', required: ['scanId', 'confirmed', 'items'], additionalProperties: false, properties: { scanId: { type: 'string', maxLength: 40 }, confirmed: { type: 'boolean' }, items: { type: 'array', maxItems: 2000, items: { type: 'object', required: ['rel'], additionalProperties: false, properties: { rel: { type: 'string', maxLength: 400 }, name: { type: 'string', maxLength: 100 }, folder: { type: 'string', maxLength: 60 } } } } } } } }, async (req, reply) => {
    const sc = scans.get(req.body.scanId); if (!sc || sc.user !== req.user.id) return reply.code(404).send({ error: 'Diese Vorschau ist abgelaufen. Bitte den Ordner noch einmal einlesen.' });
    if (!req.body.confirmed) return reply.code(400).send({ error: 'Bitte bestätige die Vorschau. Vorher wird nichts übernommen.' });
    const byRel = new Map(sc.items.filter((i) => i.supported).map((i) => [i.rel, i])); const todo = req.body.items.filter((i) => byRel.has(i.rel)); const jobId = randomUUID(), job = { id: jobId, total: todo.length, done: 0, failed: 0, errors: [], finished: false, ids: [] }; jobs.set(jobId, job);
    (async () => { for (const t of todo) { const it = byRel.get(t.rel); try {
      const src = join(sc.dir, t.rel), real = realpathSync(src); if (!real.startsWith(sc.dir + sep)) throw new Error('Pfad nicht erlaubt');
      if (it.kind === 'pdf') { // PDF → je Seite ein Bild (wie beim Hochladen)
        const outdir = join(mediaDir, 'incoming', randomUUID()); mkdirSync(outdir, { recursive: true }); const base = (t.name || it.name).replace(/\.pdf$/i, '').slice(0, 80);
        try { await pexec('pdftoppm', ['-scale-to', '1920', '-png', '-l', '60', real, join(outdir, 'p')], { timeout: 120000 }); } catch { rmSync(outdir, { recursive: true, force: true }); throw new Error('Das PDF konnte nicht umgewandelt werden (passwortgeschützt oder beschädigt?)'); }
        for (const [n, pf] of readdirSync(outdir).sort().entries()) { const file = randomUUID(); renameSync(join(outdir, pf), join(mediaDir, 'original', file)); const meta = await sharp(join(mediaDir, 'original', file), SHARP_OPTS).metadata(); const id = randomUUID();
          db.prepare("INSERT INTO media(id,name,kind,original_path,sha256,size,width,height,folder,created_by,created_at) VALUES(?,?,'pdfpage',?,?,?,?,?,?,?,?)").run(id, `${base} – Seite ${n + 1}`, file, n === 0 ? it.sha256 : null, statSync(join(mediaDir, 'original', file)).size, meta.width ?? null, meta.height ?? null, (t.folder ?? it.folder ?? '').slice(0, 60), req.user.id, now()); job.ids.push(id); }
        rmSync(outdir, { recursive: true, force: true }); job.done++; continue;
      }
      const file = randomUUID(); copyFileSync(real, join(mediaDir, 'original', file));
      let dur = null, w = it.width, h2 = it.height; if (it.kind === 'video') { const pr = await probeVideo(join(mediaDir, 'original', file)); dur = pr.duration; w = pr.width; h2 = pr.height; }
      const id = randomUUID(); db.prepare('INSERT INTO media(id,name,kind,original_path,sha256,size,duration_s,width,height,folder,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, (t.name || it.name).slice(0, 100), it.kind, file, it.sha256, it.size, dur, w ?? null, h2 ?? null, (t.folder ?? it.folder ?? '').slice(0, 60), req.user.id, now()); job.ids.push(id); job.done++;
    } catch (e) { job.failed++; job.errors.push(`${t.rel}: ${e.message}`); } } job.finished = true; variants.ensureAll(); audit.log({ user: req.user, action: 'import.abgeschlossen', target: sc.dir, detail: { uebernommen: job.done, fehler: job.failed } }); scans.delete(req.body.scanId); })();
    return reply.code(202).send({ jobId, total: job.total });
  });
  app.get('/api/v1/import/jobs/:id', { config: { perm: 'import.run' } }, async (req, reply) => jobs.get(req.params.id) ?? reply.code(404).send({ error: 'Vorgang nicht gefunden.' }));

  // ======================= Duplizieren, Wochenvorlagen (Z.13) =======================
  const INS = 'INSERT INTO schedules(id,target_type,target_id,content_type,content_id,start_local,end_local,rrule,exdates,priority,valid_from,valid_to,created_by,created_at,state,draft_of,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
  const shiftDate = (dt, days) => `${addDays(dt.slice(0, 10), days)}${dt.slice(10)}`;
  const dupRow = (s, days, req) => { const id = randomUUID(); db.prepare(INS).run(id, s.target_type, s.target_id, s.content_type, s.content_id, shiftDate(s.start_local, days), shiftDate(s.end_local, days), s.rrule, '[]', s.priority, null, null, req.user.id, now(), 'draft', null, s.note); return id; };
  app.post('/api/v1/schedules/:id/duplicate', { config: { perm: 'schedules.write' }, schema: { body: { type: ['object', 'null'], additionalProperties: false, properties: { days: { type: 'integer', minimum: -366, maximum: 366 } } } } }, async (req, reply) => {
    const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id); if (!s) return reply.code(404).send({ error: 'Termin nicht gefunden.' }); const id = dupRow(s, req.body?.days ?? 1, req); A(req, 'termin.dupliziert', id); return reply.code(201).send({ id });
  });
  const weekOf = (date) => addDays(date, -((dowOf(date) + 6) % 7));
  const inWeek = (s, mon) => s.state === 'published' && !s.rrule && s.start_local.slice(0, 10) >= mon && s.start_local.slice(0, 10) <= addDays(mon, 6);
  app.post('/api/v1/schedules/duplicate-week', { config: { perm: 'schedules.write' }, schema: { body: { type: 'object', required: ['fromWeek', 'toWeek'], additionalProperties: false, properties: { fromWeek: { type: 'string', pattern: DATE }, toWeek: { type: 'string', pattern: DATE } } } } }, async (req) => {
    const a = weekOf(req.body.fromWeek), b = weekOf(req.body.toWeek), diff = Math.round((Date.parse(b) - Date.parse(a)) / DAY); const rows = db.prepare('SELECT * FROM schedules').all().filter((s) => inWeek(s, a)); for (const s of rows) dupRow(s, diff, req);
    A(req, 'woche.dupliziert', a, { nach: b, anzahl: rows.length }); return { ok: true, created: rows.length, text: `${rows.length} Termine wurden als Entwürfe in die Woche ab ${b.split('-').reverse().join('.')} kopiert.` };
  });
  app.get('/api/v1/week-templates', { config: { perm: 'schedules.read' } }, async () => db.prepare('SELECT id,name,items_json FROM week_templates ORDER BY name').all().map((t) => ({ id: t.id, name: t.name, count: parseJson(t.items_json, []).length })));
  app.post('/api/v1/week-templates', { config: { perm: 'schedules.write' }, schema: { body: { type: 'object', required: ['name', 'week'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, week: { type: 'string', pattern: DATE } } } } }, async (req) => {
    const mon = weekOf(req.body.week), rows = db.prepare('SELECT * FROM schedules').all().filter((s) => inWeek(s, mon)).map((s) => ({ targetType: s.target_type, targetId: s.target_id, content: { type: s.content_type, id: s.content_id }, dayOffset: Math.round((Date.parse(s.start_local.slice(0, 10)) - Date.parse(mon)) / DAY), from: s.start_local.slice(11), to: s.end_local.slice(11), endOffset: Math.round((Date.parse(s.end_local.slice(0, 10)) - Date.parse(s.start_local.slice(0, 10))) / DAY), priority: s.priority }));
    const id = randomUUID(); db.prepare('INSERT INTO week_templates VALUES(?,?,?,?,?)').run(id, req.body.name, JSON.stringify(rows), req.user.id, now()); A(req, 'wochenvorlage.gespeichert', req.body.name); return { id, count: rows.length };
  });
  app.post('/api/v1/week-templates/:id/apply', { config: { perm: 'schedules.write' }, schema: { body: { type: 'object', required: ['week'], additionalProperties: false, properties: { week: { type: 'string', pattern: DATE } } } } }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM week_templates WHERE id=?').get(req.params.id); if (!t) return reply.code(404).send({ error: 'Wochenvorlage nicht gefunden.' }); const mon = weekOf(req.body.week); let n = 0, skipped = 0;
    for (const i of parseJson(t.items_json, [])) { const okT = db.prepare(`SELECT 1 FROM ${i.targetType === 'device' ? 'devices' : 'device_groups'} WHERE id=?`).get(i.targetId), okC = db.prepare(`SELECT 1 FROM ${i.content.type === 'playlist' ? 'playlists' : 'media'} WHERE id=?`).get(i.content.id); if (!okT || !okC) { skipped++; continue; }
      const d = addDays(mon, i.dayOffset); db.prepare(INS).run(randomUUID(), i.targetType, i.targetId, i.content.type, i.content.id, `${d}T${i.from}`, `${addDays(d, i.endOffset ?? 0)}T${i.to}`, null, '[]', i.priority, null, null, req.user.id, now(), 'draft', null, null); n++; }
    A(req, 'wochenvorlage.angewendet', t.name, { woche: mon, anzahl: n }); return { ok: true, created: n, skipped, text: `${n} Termine als Entwürfe angelegt${skipped ? `, ${skipped} übersprungen (Bildschirm oder Inhalt gibt es nicht mehr)` : ''}.` };
  });
  app.delete('/api/v1/week-templates/:id', { config: { perm: 'schedules.write' } }, async (req, reply) => { if (!db.prepare('DELETE FROM week_templates WHERE id=?').run(req.params.id).changes) return reply.code(404).send({ error: 'Wochenvorlage nicht gefunden.' }); return { ok: true }; });

  // ======================= Datenschutz und Aufbewahrung (Z.11) =======================
  /** Alte Daten automatisch löschen (Einstellungen: retention.*). Das Audit-Log wird mit Ankerhash gekürzt, damit die Kette prüfbar bleibt. */
  function retentionTick() {
    const s = settings(), t = now(), days = (k, d) => Math.max(1, Number(s[k] ?? d)); let n = 0;
    n += db.prepare('DELETE FROM overrides WHERE COALESCE(ended_at, until) < ?').run(t - days('retention.overrideDays', 30) * DAY).changes;
    db.prepare('DELETE FROM override_kind WHERE id NOT IN (SELECT id FROM overrides)').run();
    n += db.prepare("DELETE FROM commands WHERE (status IN ('done','failed') AND created_at < ?) OR (status IN ('queued','sent') AND created_at < ?)").run(t - 30 * DAY, t - 7 * DAY).changes; // erledigte nach 30 Tagen, nie zugestellte oder unbeantwortete nach 7 Tagen
    n += db.prepare('DELETE FROM wifi_history WHERE ts < ?').run(t - days('retention.historyDays', 90) * DAY).changes;
    n += db.prepare('DELETE FROM device_events WHERE ts < ?').run(t - days('retention.historyDays', 180) * DAY).changes;
    n += db.prepare("DELETE FROM special_days WHERE source='custom' AND COALESCE(date_to,date) < ?").run(iso(new Date(t - days('retention.overrideDays', 30) * DAY))).changes;
    n += db.prepare("DELETE FROM tickers WHERE valid_to IS NOT NULL AND valid_to < ?").run(iso(new Date(t - days('retention.overrideDays', 30) * DAY))).changes;
    const a = purgeAudit(days('retention.auditDays', 365)); return { removed: n, audit: a };
  }
  function purgeAudit(keepDays) {
    const cutoff = now() - Math.max(30, keepDays) * DAY; const last = db.prepare('SELECT id,hash FROM audit_log WHERE ts < ? ORDER BY id DESC LIMIT 1').get(cutoff); if (!last) return 0; let n = 0;
    db.transaction(() => { db.exec('DROP TRIGGER audit_no_delete'); n = db.prepare('DELETE FROM audit_log WHERE id <= ?').run(last.id).changes; db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('audit.anchor', last.hash);
      db.exec("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit_log ist unveränderbar'); END;"); })(); return n;
  }
  app.post('/api/v1/system/retention-run', { config: { perm: 'settings.manage' } }, async (req) => { const r = retentionTick(); A(req, 'datenpflege.ausgefuehrt', null, r); return r; });
  let lastDay = '';
  function dailyTick() { const d = epochToLocal(now()).date; if (d === lastDay) return; lastDay = d; try { retentionTick(); refreshDynamic(); seedHolidays(); } catch {} }
  const t2 = setInterval(dailyTick, 600000); t2.unref(); app.addHook('onClose', async () => clearInterval(t2)); setTimeout(dailyTick, 5000).unref();
  app.decorate('extras2', { retentionTick, purgeAudit, refreshDynamic, seedHolidays });

  // ======================= Passwort zurücksetzen mit Wiederherstellungscode (Z.9) =======================
  const resetLim = createLimiter({ max: 5, baseMs: 60000, now });
  app.post('/api/v1/auth/reset-with-recovery', { config: { public: true }, schema: { body: { type: 'object', required: ['name', 'code', 'password'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 100 }, code: { type: 'string', maxLength: 40 }, password: { type: 'string', maxLength: 300 } } } } }, async (req, reply) => {
    const w = Math.max(resetLim.wait(req.ip), resetLim.wait('u:' + req.body.name.toLowerCase())); if (w) return reply.code(429).send({ error: `Zu viele Versuche. Bitte warte ${w} Sekunden.` });
    const u = db.prepare('SELECT * FROM users WHERE name=?').get(req.body.name); const hash = sha256hex(req.body.code.replace(/\s/g, '').toLowerCase()); const rec = JSON.parse(u?.recovery_hashes ?? '[]');
    const FAIL = 'Name oder Wiederherstellungscode stimmen nicht.';
    if (!u || !rec.includes(hash)) { resetLim.fail(req.ip); resetLim.fail('u:' + req.body.name.toLowerCase()); audit.log({ action: 'passwort.reset_fehlgeschlagen', target: req.body.name, ip: req.ip, security: true }); return reply.code(401).send({ error: FAIL }); }
    const bad = checkPasswordPolicy(req.body.password, u.name); if (bad) return reply.code(400).send({ error: bad });
    db.prepare('UPDATE users SET pw_hash=?, recovery_hashes=?, failed=0, locked_until=0 WHERE id=?').run(await hashPassword(req.body.password), JSON.stringify(rec.filter((x) => x !== hash)), u.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    audit.log({ user: u, action: 'passwort.reset_mit_code', target: u.name, ip: req.ip, security: true }); return { ok: true, remaining: rec.length - 1, text: 'Das Passwort wurde geändert. Dieser Wiederherstellungscode ist jetzt verbraucht.' };
  });
  void localToEpoch; void resolvePlaylist; void schedulePayload;
}
extras2Plugin[Symbol.for('skip-override')] = true;
export default extras2Plugin;
