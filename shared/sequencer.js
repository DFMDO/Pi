// Was zeigt der Player gerade? Reine Funktionen, die im Browser (Chromium-Seite),
// im Lite-Player (mpv-Steuerung) und in den Tests identisch laufen.
import { epochToLocal } from './time.js';

/** Aktuelle Playlist + Ende des Zeitfensters (null = bis auf Weiteres). */
export function resolvePlaylist(plan, now) {
  if (!plan) return { playlistId: null, until: null, scheduleId: null, source: 'none' };
  const seg = plan.segments?.find((s) => now >= s.start && now < s.end);
  if (seg?.source) return { playlistId: seg.source.content.id, until: seg.end, scheduleId: seg.source.scheduleId, source: 'termin' };
  // Standardliste; nächste Terminkante als Wechselzeitpunkt
  const next = plan.segments?.find((s) => s.start > now && s.source);
  return { playlistId: plan.defaultPlaylistId ?? null, until: next?.start ?? null, scheduleId: null, source: plan.defaultPlaylistId ? 'standard' : 'none' };
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
