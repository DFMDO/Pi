// Aus Datenbankzeilen werden Zeitpläne, Abspiellisten und Manifeste für Geräte.
import { buildTimeline, findConflicts } from '../../shared/schedule.js';
import { deviceWarnings } from './health.js';
import { careWarnings } from './pflege.js';
import { parseJson } from '../../shared/guard.js';
import { WALL_MIN_VERSION } from '../../shared/wall.js';

export const DAY = 86400000;
export const PROFILES = ['lite', 'standard', 'pro'];
/** Bildschirme ab dieser Version verstehen das Planfeld „inserts“ (Einschübe); ältere würden den Plan wegen des unbekannten Feldes ablehnen */
export const INSERTS_MIN_VERSION = '0.2.26';
export const verGte = (v, min) => { const a = String(v ?? '').split('.').map(Number), b = String(min).split('.').map(Number); if (a.length < 3 || a.some((x) => !Number.isInteger(x))) return false; for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return true; };
/** Gleichtakt/Videowand-Angaben für diesen Bildschirm (null, wenn seine Gruppe nicht im Gleichtakt läuft oder der Bildschirm zu alt ist) */
export function wallFor(db, device, version) {
  if (!device.group_id || !verGte(version, WALL_MIN_VERSION)) return null;
  const g = db.prepare('SELECT * FROM device_groups WHERE id=?').get(device.group_id);
  if (!g || g.sync_mode === 'off' || !g.sync_epoch) return null;
  if (g.sync_mode !== 'videowand') return { mode: 'gleichtakt', epoch: g.sync_epoch };
  const c = device.wall_col, r = device.wall_row;
  if (!Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c >= g.wall_cols || r >= g.wall_rows) return { mode: 'gleichtakt', epoch: g.sync_epoch }; // ohne gültige Kachel: gleicher Takt, ganzes Bild
  return { mode: 'videowand', epoch: g.sync_epoch, cols: g.wall_cols, rows: g.wall_rows, col: c, row: r };
}
const versionOf = (device) => { try { return JSON.parse(device.state_json ?? '{}').version ?? ''; } catch { return ''; } };
/** Wiedergabe-Art, die der Bildschirm WIRKLICH bekommt: im Gleichtakt/Videowand immer mpv (nur dort gibt es Zuschnitt und genaue Zeit) */
export const effectiveRenderer = (db, device) => (wallFor(db, device, versionOf(device)) ? 'mpv' : rendererOf(device));

/** Aktive Einschübe, die diesen Bildschirm betreffen */
export function insertsFor(db, device) {
  return db.prepare('SELECT * FROM inserts WHERE enabled=1 ORDER BY created_at, id').all()
    .filter((i) => i.scope === 'all' || (i.scope === 'device' && i.target_id === device.id) || (i.scope === 'group' && i.target_id && i.target_id === device.group_id))
    .map((i) => ({ id: i.id, mediaId: i.media_id, everyS: i.every_min * 60, seconds: i.seconds, ...(i.valid_from ? { validFrom: i.valid_from } : {}), ...(i.valid_to ? { validTo: i.valid_to } : {}) }));
}

export const rowToSchedule = (r) => ({
  state: r.state ?? 'published', draftOf: r.draft_of ?? null, note: r.note ?? null, createdBy: r.created_by ?? null,
  id: r.id, targetType: r.target_type, targetId: r.target_id, content: { type: r.content_type, id: r.content_id },
  startLocal: r.start_local, endLocal: r.end_local, rrule: r.rrule, exdates: JSON.parse(r.exdates || '[]'),
  priority: r.priority, validFrom: r.valid_from, validTo: r.valid_to,
});
/** Standard: NUR veröffentlichte Termine (Player, Live-Ansicht, Konflikte). Entwürfe nur mit { drafts: true } (Kalender/Vorschau). */
export const loadSchedules = (db, { drafts = false } = {}) => db.prepare(drafts ? 'SELECT * FROM schedules' : "SELECT * FROM schedules WHERE state='published'").all().map(rowToSchedule);

const todayBerlin = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
/** Medien mit abgelaufenem „gültig bis“ (Lizenz) werden automatisch aus der Wiedergabe genommen */
export const isExpired = (validUntil, t = Date.now()) => !!validUntil && validUntil < todayBerlin(t);
export const MAX_NEST = 3, MAX_FLAT_ITEMS = 500;
/** Notfall mit Fluchtweg-Plan: so lange steht erst die Meldung, dann der Plan des Bildschirms (Sekunden) */
export const ESCAPE_TEXT_S = 10, ESCAPE_PLAN_S = 15;
const later = (a, b) => (a && b ? (a > b ? a : b) : a ?? b), earlier = (a, b) => (a && b ? (a < b ? a : b) : a ?? b);
/**
 * Die Einträge einer Abspielliste als FLACHE Liste. Verschachtelte Listen (Tabelle playlist_includes) werden an ihrer Stelle aufgelöst; das „gültig von/bis“ der
 * Einfügung wirkt auf alle Einträge der eingefügten Liste. Schleifen und zu tiefe Verschachtelung werden übersprungen (der Player bekommt nie etwas davon zu sehen).
 */
export function playlistItems(db, id, t = Date.now(), depth = 0, ancestors = new Set()) {
  const media = db.prepare('SELECT i.pos AS pos, i.media_id AS mediaId, i.duration_s AS duration, i.transition, i.valid_from AS validFrom, i.valid_to AS validTo FROM playlist_items i JOIN media m ON m.id=i.media_id WHERE i.playlist_id=? AND (m.valid_until IS NULL OR m.valid_until >= ?)').all(id, todayBerlin(t));
  const subs = depth < MAX_NEST ? db.prepare("SELECT i.pos AS pos, i.sub_id AS subId, i.valid_from AS validFrom, i.valid_to AS validTo FROM playlist_includes i JOIN playlists p ON p.id=i.sub_id AND p.state='published' WHERE i.playlist_id=?").all(id) : [];
  const out = [], here = new Set([...ancestors, id]);
  for (const e of [...media, ...subs].sort((a, b) => a.pos - b.pos)) {
    if (e.subId === undefined) { const { pos, ...it } = e; out.push(it); continue; }
    if (here.has(e.subId)) continue; // Schleife
    for (const it of playlistItems(db, e.subId, t, depth + 1, here)) out.push({ ...it, validFrom: later(it.validFrom, e.validFrom) ?? null, validTo: earlier(it.validTo, e.validTo) ?? null });
  }
  return out.slice(0, MAX_FLAT_ITEMS);
}

/** Paket für einen Player: Zeitplan der nächsten 14 Tage + benötigte Abspiellisten. */
export function schedulePayload(db, device, now = Date.now(), days = 14) {
  const st = Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('sync.window','sync.bandwidthKbps')").all().map((r) => [r.key, r.value]));
  const from = now - 3600000, to = now + days * DAY;
  const tl = buildTimeline(loadSchedules(db), { deviceId: device.id, groupId: device.group_id }, from, to);
  const playlists = {};
  const def = db.prepare("SELECT id FROM playlists WHERE is_default=1 AND state='published'").get()?.id ?? null;
  const use = (c) => {
    if (c.type === 'media') { // Einzelnes Medium wie eine Ein-Elemente-Liste behandeln
      const id = 'media:' + c.id;
      playlists[id] ??= { name: 'Einzelnes Medium', items: [{ mediaId: c.id, duration: 10, transition: 'fade' }] };
      return { type: 'playlist', id };
    }
    playlists[c.id] ??= { name: db.prepare('SELECT name FROM playlists WHERE id=?').get(c.id)?.name ?? '', items: playlistItems(db, c.id, now) };
    return c;
  };
  const segments = tl.map((s) => ({ start: s.start, end: s.end, source: s.source ? { ...s.source, content: use(s.source.content) } : null }));
  if (def) playlists[def] = { name: db.prepare('SELECT name FROM playlists WHERE id=?').get(def).name, items: playlistItems(db, def, now) };
  // Übersteuerungen/Schnellaktionen (Z.2): nur aktive, die dieses Gerät betreffen. Wirken auch offline bis zu ihrem Ablauf (der Player prüft „until“ selbst).
  const kinds = new Map(db.prepare('SELECT id,kind,prio FROM override_kind').all().map((r) => [r.id, r]));
  /** Liste einer Übersteuerung. Notfall-Meldung + Fluchtweg-Plan dieses Bildschirms ergeben eine eigene Liste „Meldung, dann Plan“ (nur in diesem Plan) */
  const overrideList = (o) => {
    if (kinds.get(o.id)?.kind === 'notfall' && o.content_type === 'media' && device.escape_media_id && db.prepare('SELECT 1 FROM media WHERE id=?').get(device.escape_media_id)) {
      const id = `notfall:${o.content_id}:${device.escape_media_id}`;
      playlists[id] ??= { name: 'Notfall-Meldung mit Fluchtweg-Plan', items: [{ mediaId: o.content_id, duration: ESCAPE_TEXT_S, transition: 'cut' }, { mediaId: device.escape_media_id, duration: ESCAPE_PLAN_S, transition: 'cut' }] };
      return id;
    }
    return use({ type: o.content_type, id: o.content_id }).id;
  };
  const overrides = db.prepare('SELECT * FROM overrides WHERE ended_at IS NULL AND until > ?').all(now)
    .filter((o) => o.scope === 'all' || (o.scope === 'device' && o.target_id === device.id) || (o.scope === 'group' && o.target_id && o.target_id === device.group_id))
    .map((o) => ({ id: o.id, scope: o.scope, playlistId: overrideList(o), until: o.until, createdAt: o.created_at, label: o.label, by: o.created_by_name, kind: kinds.get(o.id)?.kind ?? 'manual', ...(kinds.get(o.id)?.prio ? { prio: kinds.get(o.id).prio } : {}) }));
  // Sondertage (Z.6): Feiertage/Schließtage/Betriebsferien der nächsten 14 Tage
  const d0 = new Date(from + 2 * 3600000).toISOString().slice(0, 10), d1 = new Date(to + 2 * 3600000).toISOString().slice(0, 10);
  const specialDays = db.prepare('SELECT * FROM special_days WHERE date <= ? AND COALESCE(date_to, date) >= ? ORDER BY CASE source WHEN \'custom\' THEN 0 ELSE 1 END, date').all(d1, d0)
    .filter((r) => r.rule === 'off' || r.content_id).map((r) => ({ from: r.date, to: r.date_to ?? r.date, name: r.name, kind: r.kind, rule: r.rule, playlistId: r.rule === 'off' || !r.content_id ? null : use({ type: r.content_type ?? 'playlist', id: r.content_id }).id }));
  const hold = device.maintenance_since ? 'wartung' : device.ready === 0 ? 'nicht_bereit' : null;
  const tickers = db.prepare("SELECT text,valid_from AS validFrom,valid_to AS validTo FROM tickers WHERE state='published' AND (target_type='all' OR (target_type='device' AND target_id=?) OR (target_type='group' AND target_id=?))").all(device.id, device.group_id ?? '');
  const stg = Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key LIKE 'maintenance.%'").all().map((r) => [r.key, r.value]));
  let version = ''; try { version = JSON.parse(device.state_json ?? '{}').version ?? ''; } catch {}
  const wall = wallFor(db, device, version);
  const inserts = !wall && verGte(version, INSERTS_MIN_VERSION) ? insertsFor(db, device) : []; // im Gleichtakt keine Einschübe (sie würden sich unterscheiden)
  return { generatedAt: now, from, to, segments, playlists, defaultPlaylistId: def, orientation: device.orientation, renderer: wall ? 'mpv' : rendererOf(device), fit: device.fit_json ? JSON.parse(device.fit_json) : null, overrides, specialDays, hold, tickers,
    layout: device.profile === 'lite' ? null : device.layout_json ? JSON.parse(device.layout_json) : null,
    maintenance: { nightlyReboot: (stg['maintenance.nightlyReboot'] ?? 'true') === 'true' ? (stg['maintenance.rebootAt'] ?? '03:30') : null },
    ...(inserts.length ? { inserts } : {}),
    ...(wall ? { wall } : {}),
    display: parseJson(device.display_json, null), sync: { window: st['sync.window'] ?? '', bandwidthKbps: Number(st['sync.bandwidthKbps'] ?? 0) } };
}

/** Wiedergabe-Art: Lite immer mpv (kein Browser); sonst wie eingestellt, Standard ist der Browser */
export const rendererOf = (d) => (d.profile === 'lite' || d.renderer === 'mpv' ? 'mpv' : 'browser');

/** Alle Medien, die dieser Player braucht (nur Variante seines Profils). */
export function manifestPayload(db, device, now = Date.now()) {
  const ids = new Set(); const renderer = effectiveRenderer(db, device);
  for (const r of db.prepare("SELECT DISTINCT media_id FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id WHERE p.state='published'").all()) ids.add(r.media_id);
  for (const r of db.prepare("SELECT content_id FROM schedules WHERE content_type='media' AND state='published'").all()) ids.add(r.content_id);
  for (const r of db.prepare("SELECT content_id FROM overrides WHERE content_type='media' AND ended_at IS NULL AND until > ?").all(now)) ids.add(r.content_id);
  for (const r of db.prepare("SELECT content_id FROM special_days WHERE content_type='media' AND content_id IS NOT NULL").all()) ids.add(r.content_id);
  for (const r of db.prepare("SELECT media_id FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id WHERE p.id IN (SELECT content_id FROM overrides WHERE content_type='playlist' AND ended_at IS NULL AND until > ?)").all(now)) ids.add(r.media_id);
  // Vorab laden, was später per Automatik erscheinen kann: die Tor-Jubel-Folie (solange die Live-App an ist) und die Inhalte eingeschalteter Regeln
  if (db.prepare("SELECT 1 FROM apps WHERE type='livespiel' AND enabled=1").get()) { const tor = db.prepare("SELECT value FROM settings WHERE key='live.torMediaId'").get()?.value; if (tor) ids.add(tor); }
  for (const r of db.prepare('SELECT content_type,content_id FROM rules WHERE enabled=1').all()) {
    if (r.content_type === 'media') ids.add(r.content_id);
    else for (const i of db.prepare('SELECT media_id FROM playlist_items WHERE playlist_id=?').all(r.content_id)) ids.add(i.media_id);
  }
  for (const r of db.prepare('SELECT media_id FROM inserts WHERE enabled=1').all()) ids.add(r.media_id); // Einschübe: Medium vorab laden
  if (device.escape_media_id) ids.add(device.escape_media_id); // Fluchtweg-Plan dieses Bildschirms: immer vorab laden (die Notfall-Meldung darf nie auf einen Download warten)
  const items = [];
  for (const id of ids) {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(id);
    if (!m || isExpired(m.valid_until, now)) continue;
    const tj = m.kind === 'text' ? parseJson(m.text_json, {}) : null, { stream: st, ...tText } = tj ?? {}, stream = st?.url ? { url: st.url } : null; // Live-Bild: Adresse als eigenes Feld, nicht im Text
    if (m.kind === 'text' && renderer === 'browser') { /* mpv kann keinen Text setzen → dort vorgerendertes Bild */ items.push({ id, kind: 'text', name: m.name, text: tText, ...(stream ? { stream } : {}), validUntil: m.valid_until ?? null }); continue; }
    const v = db.prepare("SELECT * FROM media_variants WHERE media_id=? AND profile=? AND status='ready'").get(id, device.profile);
    items.push(v ? { id, kind: m.kind, name: m.name, sha256: v.sha256, size: v.size, durationS: m.duration_s, url: `/api/v1/device/media/${id}`, ...(stream ? { stream } : {}), ...(m.width > 0 && m.height > 0 ? { aspect: Math.round((m.width / m.height) * 10000) / 10000 } : {}), validUntil: m.valid_until ?? null }
      : { id, kind: m.kind, name: m.name, pending: true });
  }
  return { generatedAt: now, items };
}

/** Hinweise für die Startseite (Konflikte, fehlende Inhalte, Medien nicht geladen). */
export function warnings(db, now = Date.now()) {
  const out = [];
  const scheds = loadSchedules(db); // nur Veröffentlichtes
  const names = Object.fromEntries([...db.prepare('SELECT id,name FROM devices').all(), ...db.prepare('SELECT id,name FROM device_groups').all()].map((r) => [r.id, r.name]));
  for (const c of findConflicts(scheds, now, now + 14 * DAY)) out.push({ kind: 'konflikt', ids: [c.a, c.b],
    text: `Zwei Termine für „${names[scheds.find((s) => s.id === c.a).targetId] ?? 'Bildschirm'}“ überschneiden sich. Der später gestartete gewinnt. Gib einem der Termine eine höhere Priorität, wenn du das ändern willst.` });
  for (const s of scheds) {
    const t = s.content.type === 'playlist' ? 'playlists' : 'media';
    if (!db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(s.content.id)) out.push({ kind: 'inhalt_fehlt', ids: [s.id], text: 'Ein Termin zeigt einen Inhalt, den es nicht mehr gibt.' });
    else if (s.content.type === 'playlist' && !db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id=? UNION SELECT 1 FROM playlist_includes WHERE playlist_id=?').get(s.content.id, s.content.id)) out.push({ kind: 'liste_leer', ids: [s.id], text: 'Ein Termin zeigt eine leere Abspielliste.' });
  }
  for (const m of db.prepare('SELECT name,valid_until,license FROM media WHERE valid_until IS NOT NULL').all()) {
    const days = Math.round((Date.parse(m.valid_until + 'T00:00:00Z') - Date.parse(todayBerlin(now) + 'T00:00:00Z')) / DAY);
    if (days < 0) out.push({ kind: 'abgelaufen', ids: [], text: `„${m.name}“ ist abgelaufen (${m.license ? 'Lizenz: ' + m.license + '; ' : ''}gültig bis ${m.valid_until.split('-').reverse().join('.')}) und wird nicht mehr gezeigt.` });
    else if (days <= 14) out.push({ kind: 'laeuft_ab', ids: [], text: `„${m.name}“ läuft in ${days} ${days === 1 ? 'Tag' : 'Tagen'} ab (gültig bis ${m.valid_until.split('-').reverse().join('.')}). Danach wird es nicht mehr gezeigt.` });
  }
  for (const d of db.prepare("SELECT * FROM devices WHERE status='active'").all()) {
    const st = parseJson(d.state_json, null);
    for (const w of deviceWarnings(d, st, now, { watch: db.prepare('SELECT * FROM watch_state WHERE device_id=?').get(d.id) })) out.push({ kind: w.kind, ids: [d.id], text: w.text });
    if (st?.syncState && st.syncState.done < st.syncState.total) out.push({ kind: 'medien_laden', ids: [d.id], text: `„${d.name}“ lädt noch Medien (${st.syncState.done} von ${st.syncState.total}).` });
  }
  for (const c of careWarnings(db, now)) out.push(c);
  for (const g of db.prepare("SELECT * FROM device_groups WHERE sync_mode != 'off'").all()) { // Gleichtakt / Videowand
    const members = db.prepare("SELECT * FROM devices WHERE group_id=? AND status='active' ORDER BY name").all(g.id);
    const label = g.sync_mode === 'videowand' ? 'Videowand' : 'Gleichtakt';
    for (const d of members) if (!verGte(versionOf(d), WALL_MIN_VERSION)) out.push({ kind: 'gleichtakt_alt', ids: [d.id], text: `„${d.name}“ hat noch eine ältere Version und läuft deshalb nicht mit (${label} der Gruppe „${g.name}“). Bitte erst das Update einspielen.` });
    if (g.sync_mode !== 'videowand') continue;
    const tiles = g.wall_cols * g.wall_rows, seen = new Map();
    for (const d of members) {
      const ok = Number.isInteger(d.wall_col) && Number.isInteger(d.wall_row) && d.wall_col < g.wall_cols && d.wall_row < g.wall_rows;
      if (!ok) { out.push({ kind: 'videowand_position', ids: [d.id], text: `„${d.name}“ hat in der Videowand „${g.name}“ keinen Platz. Es zeigt das ganze Bild. Bitte unter „Bearbeiten“ Spalte und Zeile eintragen.` }); continue; }
      const key = d.wall_col + ',' + d.wall_row; if (seen.has(key)) out.push({ kind: 'videowand_doppelt', ids: [d.id, seen.get(key)], text: `In der Videowand „${g.name}“ haben zwei Bildschirme denselben Platz (Spalte ${d.wall_col + 1}, Zeile ${d.wall_row + 1}).` }); else seen.set(key, d.id);
      if (d.orientation) out.push({ kind: 'videowand_gedreht', ids: [d.id], text: `„${d.name}“ ist gedreht. Eine Videowand funktioniert nur mit nicht gedrehten Bildschirmen.` });
    }
    if (members.length < tiles) out.push({ kind: 'videowand_luecke', ids: [], text: `Die Videowand „${g.name}“ hat ${tiles} Kacheln (${g.wall_cols} × ${g.wall_rows}), aber nur ${members.length} aktive Bildschirme. Es bleiben Teile des Bildes dunkel.` });
  }
  if (db.integrity && db.integrity !== 'ok') out.push({ kind: 'datenbank', ids: [], text: `Die Prüfung der Datenbank beim Start hat Fehler gemeldet (${String(db.integrity).slice(0, 120)}). Bitte jetzt ein Backup herunterladen (Erweitert → Sicherung) und die IT informieren.` });
  return out;
}

const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const dmy = (d) => d.split('-').reverse().join('.');
/** Zusammenfassung in Klartext für „Veröffentlichen“: „Ab sofort zeigt „Shop-Screen“ am Samstag, 10.10.2026 von 10:00 bis 12:00 Uhr „Sommer-Aktion“.“ */
export function summarizeSchedule(db, s) {
  const target = s.targetType === 'device' ? db.prepare('SELECT name FROM devices WHERE id=?').get(s.targetId)?.name : db.prepare('SELECT name FROM device_groups WHERE id=?').get(s.targetId)?.name;
  const content = s.content.type === 'playlist' ? db.prepare('SELECT name FROM playlists WHERE id=?').get(s.content.id)?.name : db.prepare('SELECT name FROM media WHERE id=?').get(s.content.id)?.name;
  const [d1, t1] = s.startLocal.split('T'), [d2, t2] = s.endLocal.split('T');
  const [y, m, d] = d1.split('-').map(Number), wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const who = `${s.targetType === 'group' ? 'die Gruppe ' : ''}„${target ?? 'Bildschirm'}“`;
  const when = d1 === d2 ? `am ${wd}, ${dmy(d1)} von ${t1} bis ${t2} Uhr` : `von ${wd}, ${dmy(d1)} ${t1} Uhr bis ${dmy(d2)} ${t2} Uhr`;
  const rep = !s.rrule ? '' : /FREQ=DAILY/.test(s.rrule) ? ', jeden Tag' : /FREQ=MONTHLY/.test(s.rrule) ? ', jeden Monat' : ', jede Woche';
  return `Ab sofort zeigt ${who} ${when}${rep} „${content ?? 'Inhalt'}“.`;
}
