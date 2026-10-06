// Aus Datenbankzeilen werden Zeitpläne, Abspiellisten und Manifeste für Geräte.
import { buildTimeline, findConflicts } from '../../shared/schedule.js';

export const DAY = 86400000;
export const PROFILES = ['lite', 'standard', 'pro'];

export const rowToSchedule = (r) => ({
  id: r.id, targetType: r.target_type, targetId: r.target_id, content: { type: r.content_type, id: r.content_id },
  startLocal: r.start_local, endLocal: r.end_local, rrule: r.rrule, exdates: JSON.parse(r.exdates || '[]'),
  priority: r.priority, validFrom: r.valid_from, validTo: r.valid_to,
});
export const loadSchedules = (db) => db.prepare('SELECT * FROM schedules').all().map(rowToSchedule);

function playlistItems(db, id) {
  return db.prepare('SELECT media_id AS mediaId, duration_s AS duration, transition, valid_from AS validFrom, valid_to AS validTo FROM playlist_items WHERE playlist_id=? ORDER BY pos').all(id);
}

/** Paket für einen Player: Zeitplan der nächsten 14 Tage + benötigte Abspiellisten. */
export function schedulePayload(db, device, now = Date.now(), days = 14) {
  const from = now - 3600000, to = now + days * DAY;
  const tl = buildTimeline(loadSchedules(db), { deviceId: device.id, groupId: device.group_id }, from, to);
  const playlists = {};
  const def = db.prepare('SELECT id FROM playlists WHERE is_default=1').get()?.id ?? null;
  const use = (c) => {
    if (c.type === 'media') { // Einzelnes Medium wie eine Ein-Elemente-Liste behandeln
      const id = 'media:' + c.id;
      playlists[id] ??= { name: 'Einzelnes Medium', items: [{ mediaId: c.id, duration: 10, transition: 'fade' }] };
      return { type: 'playlist', id };
    }
    playlists[c.id] ??= { name: db.prepare('SELECT name FROM playlists WHERE id=?').get(c.id)?.name ?? '', items: playlistItems(db, c.id) };
    return c;
  };
  const segments = tl.map((s) => ({ start: s.start, end: s.end, source: s.source ? { ...s.source, content: use(s.source.content) } : null }));
  if (def) playlists[def] = { name: db.prepare('SELECT name FROM playlists WHERE id=?').get(def).name, items: playlistItems(db, def) };
  return { generatedAt: now, from, to, segments, playlists, defaultPlaylistId: def, orientation: device.orientation };
}

/** Alle Medien, die dieser Player braucht (nur Variante seines Profils). */
export function manifestPayload(db, device, now = Date.now()) {
  const ids = new Set();
  for (const r of db.prepare('SELECT DISTINCT media_id FROM playlist_items').all()) ids.add(r.media_id);
  for (const r of db.prepare("SELECT content_id FROM schedules WHERE content_type='media'").all()) ids.add(r.content_id);
  const items = [];
  for (const id of ids) {
    const m = db.prepare('SELECT * FROM media WHERE id=?').get(id);
    if (!m) continue;
    if (m.kind === 'text' && device.profile !== 'lite') { items.push({ id, kind: 'text', name: m.name, text: JSON.parse(m.text_json || '{}') }); continue; }
    const v = db.prepare("SELECT * FROM media_variants WHERE media_id=? AND profile=? AND status='ready'").get(id, device.profile);
    items.push(v ? { id, kind: m.kind, name: m.name, sha256: v.sha256, size: v.size, durationS: m.duration_s, url: `/api/v1/device/media/${id}` }
      : { id, kind: m.kind, name: m.name, pending: true });
  }
  return { generatedAt: now, items };
}

/** Hinweise für die Startseite (Konflikte, fehlende Inhalte, Medien nicht geladen). */
export function warnings(db, now = Date.now()) {
  const out = [];
  const scheds = loadSchedules(db);
  const names = Object.fromEntries([...db.prepare('SELECT id,name FROM devices').all(), ...db.prepare('SELECT id,name FROM device_groups').all()].map((r) => [r.id, r.name]));
  for (const c of findConflicts(scheds, now, now + 14 * DAY)) out.push({ kind: 'konflikt', ids: [c.a, c.b],
    text: `Zwei Termine für „${names[scheds.find((s) => s.id === c.a).targetId] ?? 'Bildschirm'}“ überschneiden sich. Der später gestartete gewinnt. Gib einem der Termine eine höhere Priorität, wenn du das ändern willst.` });
  for (const s of scheds) {
    const t = s.content.type === 'playlist' ? 'playlists' : 'media';
    if (!db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(s.content.id)) out.push({ kind: 'inhalt_fehlt', ids: [s.id], text: 'Ein Termin zeigt einen Inhalt, den es nicht mehr gibt.' });
    else if (s.content.type === 'playlist' && !db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id=?').get(s.content.id)) out.push({ kind: 'liste_leer', ids: [s.id], text: 'Ein Termin zeigt eine leere Abspielliste.' });
  }
  for (const d of db.prepare("SELECT * FROM devices WHERE status='active'").all()) {
    const st = d.state_json ? JSON.parse(d.state_json) : null;
    if (st?.syncState && st.syncState.done < st.syncState.total) out.push({ kind: 'medien_laden', ids: [d.id], text: `„${d.name}“ lädt noch Medien (${st.syncState.done} von ${st.syncState.total}).` });
  }
  return out;
}
