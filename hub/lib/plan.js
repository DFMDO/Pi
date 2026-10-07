// Aus Datenbankzeilen werden Zeitpläne, Abspiellisten und Manifeste für Geräte.
import { buildTimeline, findConflicts } from '../../shared/schedule.js';
import { deviceWarnings } from './health.js';

export const DAY = 86400000;
export const PROFILES = ['lite', 'standard', 'pro'];

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
function playlistItems(db, id, t = Date.now()) {
  return db.prepare('SELECT i.media_id AS mediaId, i.duration_s AS duration, i.transition, i.valid_from AS validFrom, i.valid_to AS validTo FROM playlist_items i JOIN media m ON m.id=i.media_id WHERE i.playlist_id=? AND (m.valid_until IS NULL OR m.valid_until >= ?) ORDER BY i.pos').all(id, todayBerlin(t));
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
  const overrides = db.prepare('SELECT * FROM overrides WHERE ended_at IS NULL AND until > ?').all(now)
    .filter((o) => o.scope === 'all' || (o.scope === 'device' && o.target_id === device.id) || (o.scope === 'group' && o.target_id && o.target_id === device.group_id))
    .map((o) => ({ id: o.id, scope: o.scope, playlistId: use({ type: o.content_type, id: o.content_id }).id, until: o.until, createdAt: o.created_at, label: o.label, by: o.created_by_name }));
  // Sondertage (Z.6): Feiertage/Schließtage/Betriebsferien der nächsten 14 Tage
  const d0 = new Date(from + 2 * 3600000).toISOString().slice(0, 10), d1 = new Date(to + 2 * 3600000).toISOString().slice(0, 10);
  const specialDays = db.prepare('SELECT * FROM special_days WHERE date <= ? AND COALESCE(date_to, date) >= ? ORDER BY CASE source WHEN \'custom\' THEN 0 ELSE 1 END, date').all(d1, d0)
    .filter((r) => r.rule === 'off' || r.content_id).map((r) => ({ from: r.date, to: r.date_to ?? r.date, name: r.name, kind: r.kind, rule: r.rule, playlistId: r.rule === 'off' || !r.content_id ? null : use({ type: r.content_type ?? 'playlist', id: r.content_id }).id }));
  const hold = device.maintenance_since ? 'wartung' : device.ready === 0 ? 'nicht_bereit' : null;
  const tickers = db.prepare("SELECT text,valid_from AS validFrom,valid_to AS validTo FROM tickers WHERE state='published' AND (target_type='all' OR (target_type='device' AND target_id=?) OR (target_type='group' AND target_id=?))").all(device.id, device.group_id ?? '');
  const stg = Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key LIKE 'maintenance.%'").all().map((r) => [r.key, r.value]));
  return { generatedAt: now, from, to, segments, playlists, defaultPlaylistId: def, orientation: device.orientation, renderer: rendererOf(device), fit: device.fit_json ? JSON.parse(device.fit_json) : null, overrides, specialDays, hold, tickers,
    layout: device.profile === 'lite' ? null : device.layout_json ? JSON.parse(device.layout_json) : null,
    maintenance: { nightlyReboot: (stg['maintenance.nightlyReboot'] ?? 'true') === 'true' ? (stg['maintenance.rebootAt'] ?? '03:30') : null },
    display: device.display_json ? JSON.parse(device.display_json) : null, sync: { window: st['sync.window'] ?? '', bandwidthKbps: Number(st['sync.bandwidthKbps'] ?? 0) } };
}

/** Wiedergabe-Art: Lite immer mpv (kein Browser); sonst wie eingestellt, Standard ist der Browser */
export const rendererOf = (d) => (d.profile === 'lite' || d.renderer === 'mpv' ? 'mpv' : 'browser');

/** Alle Medien, die dieser Player braucht (nur Variante seines Profils). */
export function manifestPayload(db, device, now = Date.now()) {
  const ids = new Set();
  for (const r of db.prepare("SELECT DISTINCT media_id FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id WHERE p.state='published'").all()) ids.add(r.media_id);
  for (const r of db.prepare("SELECT content_id FROM schedules WHERE content_type='media' AND state='published'").all()) ids.add(r.content_id);
  for (const r of db.prepare("SELECT content_id FROM overrides WHERE content_type='media' AND ended_at IS NULL AND until > ?").all(now)) ids.add(r.content_id);
  for (const r of db.prepare("SELECT content_id FROM special_days WHERE content_type='media' AND content_id IS NOT NULL").all()) ids.add(r.content_id);
  for (const r of db.prepare("SELECT media_id FROM playlist_items i JOIN playlists p ON p.id=i.playlist_id WHERE p.id IN (SELECT content_id FROM overrides WHERE content_type='playlist' AND ended_at IS NULL AND until > ?)").all(now)) ids.add(r.media_id);
  const items = [];
  for (const id of ids) {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(id);
    if (!m || isExpired(m.valid_until, now)) continue;
    if (m.kind === 'text' && rendererOf(device) === 'browser') { /* mpv kann keinen Text setzen → dort vorgerendertes Bild */ items.push({ id, kind: 'text', name: m.name, text: JSON.parse(m.text_json || '{}'), validUntil: m.valid_until ?? null }); continue; }
    const v = db.prepare("SELECT * FROM media_variants WHERE media_id=? AND profile=? AND status='ready'").get(id, device.profile);
    items.push(v ? { id, kind: m.kind, name: m.name, sha256: v.sha256, size: v.size, durationS: m.duration_s, url: `/api/v1/device/media/${id}`, validUntil: m.valid_until ?? null }
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
    else if (s.content.type === 'playlist' && !db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id=?').get(s.content.id)) out.push({ kind: 'liste_leer', ids: [s.id], text: 'Ein Termin zeigt eine leere Abspielliste.' });
  }
  for (const m of db.prepare('SELECT name,valid_until,license FROM media WHERE valid_until IS NOT NULL').all()) {
    const days = Math.round((Date.parse(m.valid_until + 'T00:00:00Z') - Date.parse(todayBerlin(now) + 'T00:00:00Z')) / DAY);
    if (days < 0) out.push({ kind: 'abgelaufen', ids: [], text: `„${m.name}“ ist abgelaufen (${m.license ? 'Lizenz: ' + m.license + '; ' : ''}gültig bis ${m.valid_until.split('-').reverse().join('.')}) und wird nicht mehr gezeigt.` });
    else if (days <= 14) out.push({ kind: 'laeuft_ab', ids: [], text: `„${m.name}“ läuft in ${days} ${days === 1 ? 'Tag' : 'Tagen'} ab (gültig bis ${m.valid_until.split('-').reverse().join('.')}). Danach wird es nicht mehr gezeigt.` });
  }
  for (const d of db.prepare("SELECT * FROM devices WHERE status='active'").all()) {
    const st = d.state_json ? JSON.parse(d.state_json) : null;
    for (const w of deviceWarnings(d, st, now)) out.push({ kind: w.kind, ids: [d.id], text: w.text });
    if (st?.syncState && st.syncState.done < st.syncState.total) out.push({ kind: 'medien_laden', ids: [d.id], text: `„${d.name}“ lädt noch Medien (${st.syncState.done} von ${st.syncState.total}).` });
  }
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
