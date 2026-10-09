// Was zeigt der Player gerade? Reine Funktionen, die im Browser (Chromium-Seite),
// im Lite-Player (mpv-Steuerung) und in den Tests identisch laufen.
import { epochToLocal } from './time.js';

/** Rangfolge der Übersteuerungen (Art kommt vom Hub; fehlt sie, gilt „von Hand“): Notfall vor Tor-Jubel vor Hand-Übersteuerung vor Regel. Ältere Player kennen die Art nicht und sortieren wie bisher. */
const RANK = { notfall: 100, tor: 60, manual: 50, regel: 10 };
export const overrideRank = (o) => (RANK[o?.kind] ?? 50) + Math.max(0, Math.min(9, Number(o?.prio) || 0)) / 10; // prio ordnet Regeln untereinander

/**
 * Aktuelle Playlist + Ende des Zeitfensters (null = bis auf Weiteres).
 * Auflösungsreihenfolge (A3): 0. Halt (Wartung/noch nicht bereit) → 1. Übersteuerung/Schnellaktion → 2. aktive Termine (Gerät vor Gruppe, Priorität,
 * später gestartet; schon im Plan berechnet) → 3. Sondertag-Regel statt Standard → 4. Standard-Abspielliste → 5. Standby.
 */
export function resolvePlaylist(plan, now) {
  if (!plan) return { playlistId: null, until: null, scheduleId: null, source: 'none' };
  if (plan.hold) return { playlistId: null, until: null, scheduleId: null, source: plan.hold };
  const ov = (plan.overrides ?? []).filter((o) => o.until > now && !(o.from > now)).sort((a, b) => overrideRank(b) - overrideRank(a) || (b.scope === 'all') - (a.scope === 'all') || b.createdAt - a.createdAt)[0];
  if (ov) return { playlistId: ov.playlistId, until: ov.until, scheduleId: null, source: 'uebersteuerung', override: ov };
  const seg = plan.segments?.find((s) => now >= s.start && now < s.end);
  const nextOv = (plan.overrides ?? []).filter((o) => o.from > now).map((o) => o.from).sort((a, b) => a - b)[0];
  const cap = (t) => (nextOv != null ? Math.min(t ?? Infinity, nextOv) : t);
  if (seg?.source) return { playlistId: seg.source.content.id, until: cap(seg.end), scheduleId: seg.source.scheduleId, source: 'termin' };
  const next = plan.segments?.find((s) => s.start > now && s.source);
  const day = epochToLocal(now).date, sd = (plan.specialDays ?? []).find((d) => day >= d.from && day <= (d.to ?? d.from));
  if (sd) {
    const midnight = epochToLocal(now).date; void midnight;
    const until = cap(next?.start ?? null);
    return sd.rule === 'off' ? { playlistId: null, until, scheduleId: null, source: 'schliesstag', off: true, specialDay: sd } : { playlistId: sd.playlistId ?? plan.defaultPlaylistId ?? null, until, scheduleId: null, source: 'sondertag', specialDay: sd };
  }
  return { playlistId: plan.defaultPlaylistId ?? null, until: cap(next?.start ?? null), scheduleId: null, source: plan.defaultPlaylistId ? 'standard' : 'none' };
}

/**
 * Einschübe („alle N Minuten diese Folie für S Sekunden“): Welcher Einschub ist jetzt fällig?
 * last: Map Einschub-Nummer → Zeitpunkt der letzten Einblendung (wird hier gepflegt: der erste Einschub erscheint frühestens nach einer vollen Wartezeit).
 * Einschübe erscheinen nur im normalen Betrieb (Standard, Termin, Sondertag, Regel) – nie bei Notfall, Tor-Jubel, Hand-Aktionen, Wartung oder Schließtag.
 */
export function dueInsert(plan, r, now, last) {
  const list = plan?.inserts; if (!Array.isArray(list) || !list.length || !r) return null;
  const normal = r.source === 'standard' || r.source === 'termin' || r.source === 'sondertag' || (r.source === 'uebersteuerung' && r.override?.kind === 'regel'); if (!normal) return null;
  const day = epochToLocal(now).date; let best = null, bestOver = -1;
  for (const i of list) {
    if ((i.validFrom && day < i.validFrom) || (i.validTo && day > i.validTo)) continue;
    if (!last.has(i.id)) { last.set(i.id, now); continue; }
    const over = now - last.get(i.id) - i.everyS * 1000; if (over >= 0 && over > bestOver) { best = i; bestOver = over; }
  }
  return best;
}
/** Der Einschub als abspielbares Element (null, wenn das Medium fehlt, abgelaufen oder nicht darstellbar ist) */
export function insertItem(ins, manifest, opts) {
  const p = { playlists: { __einschub: { items: [{ mediaId: ins.mediaId, duration: ins.seconds, transition: 'fade' }] } } };
  return playableItems(p, '__einschub', manifest, opts).items[0] ?? null;
}

/** Kinds, die ein Renderer darstellen kann. Lite (mpv) hat keinen Browser. */
const RENDERABLE = { lite: new Set(['image', 'video', 'pdfpage', 'text-image']), standard: new Set(['image', 'video', 'pdfpage', 'text']), pro: new Set(['image', 'video', 'pdfpage', 'text']) };

/**
 * Abspielbare Elemente: Gültigkeit, geladene Medien, darstellbare Typen.
 * Nicht darstellbare/fehlende Elemente werden übersprungen (und gemeldet).
 */
export function playableItems(plan, playlistId, manifest, { profile = 'standard', now = Date.now(), have = () => true } = {}) {
  const pl = plan?.playlists?.[playlistId]; if (!pl) return { items: [], skipped: [] };
  const today = epochToLocal(now).date, byId = new Map((manifest?.items ?? []).map((m) => [m.id, m]));
  const items = [], skipped = [];
  for (const it of pl.items) {
    const m = byId.get(it.mediaId);
    if (it.validFrom && today < it.validFrom) continue;
    if (it.validTo && today > it.validTo) continue;
    if (!m) { skipped.push({ mediaId: it.mediaId, reason: 'nicht im Manifest' }); continue; }
    if (m.validUntil && today > m.validUntil) { skipped.push({ mediaId: it.mediaId, reason: 'Lizenz abgelaufen' }); continue; } // Ablaufdatum gilt auch offline
    if (m.pending) { skipped.push({ mediaId: it.mediaId, reason: 'wird noch vorbereitet' }); continue; }
    const kind = m.kind === 'text' && !m.text ? 'text-image' : m.kind; // Lite: Text kommt als Bild
    if (!RENDERABLE[profile]?.has(kind)) { skipped.push({ mediaId: it.mediaId, reason: 'für dieses Gerät nicht darstellbar' }); continue; }
    if (m.kind !== 'text' || !m.text) { if (!have(m)) { skipped.push({ mediaId: it.mediaId, reason: 'noch nicht geladen' }); continue; } }
    items.push({ ...it, kind: m.kind, name: m.name, text: m.text, sha256: m.sha256, durationS: m.durationS, transition: profile === 'lite' ? 'cut' : it.transition });
  }
  return { items, skipped };
}

/** Einfaches Durchschalten: nächster Index (Ring). */
export const nextIndex = (i, n) => (n ? (i + 1) % n : 0);
