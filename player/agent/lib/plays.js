// Wiedergabe-Zähler des Bildschirms: zählt jede Einblendung und die gezeigte Zeit je Tag und Medium (keine Besucherdaten).
// Funktioniert ohne Hub; gemeldet wird gesammelt. Eine Meldung wird so lange wiederholt, bis der Hub sie bestätigt (Hub erkennt Doppeltes an der Nummer).
// Auf die SD-Karte wird höchstens alle 5 Minuten geschrieben (Schonung); bei Stromausfall gehen dadurch höchstens wenige Minuten verloren.
import { readJson, writeJson } from './store.js';

const day = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const ID = /^[0-9a-f-]{36}$/, MAX_ENTRIES = 20000;

export function createPlayCounter({ file = null, now = () => Date.now(), saveEveryMs = 300000 } = {}) {
  const st = (file && readJson(file, null)) || {}; let seq = Number.isInteger(st.seq) ? st.seq : 0, pending = st.pending && typeof st.pending === 'object' ? st.pending : {}, inflight = st.inflight ?? null, open = null, dirty = false, lastSave = 0;
  const add = (map, d, id, name, kind, n, s) => { const e = ((map[d] ??= {})[id] ??= { n: 0, s: 0, name, kind }); e.n += n; e.s += s; if (name) { e.name = name; e.kind = kind; } };
  const entries = () => Object.values(pending).reduce((a, m) => a + Object.keys(m).length, 0);
  /** Das gerade laufende Element beenden: gezeigte Zeit, höchstens Länge + 5 s (falls danach nichts mehr gemeldet wurde, etwa Standby) */
  function close(t = now()) { if (!open) return; const secs = Math.max(0, Math.min(Math.round((t - open.since) / 1000), (open.duration || 60) + 5)); if (secs > 0) add(pending, open.day, open.id, open.name, open.kind, 0, secs); open = null; dirty = true; }
  /** Ein neues Element wird gezeigt (item = { mediaId, name, kind, duration }) – oder null/ohne Medium: nur das vorige beenden (z. B. Bildschirm aus) */
  function start(item, t = now()) {
    close(t); if (!item || !ID.test(String(item.mediaId ?? ''))) return;
    const d = day(t); open = { id: item.mediaId, name: String(item.name ?? '').slice(0, 120), kind: String(item.kind ?? '').slice(0, 12), since: t, day: d, duration: Number(item.duration) > 0 ? Number(item.duration) : 0 };
    add(pending, d, open.id, open.name, open.kind, 1, 0); dirty = true;
    if (entries() > MAX_ENTRIES) for (const old of Object.keys(pending).sort().slice(0, 5)) delete pending[old]; // monatelang ohne Hub: die ältesten Tage zuerst aufgeben
  }
  /** Nächste Meldung an den Hub (null, wenn nichts zu melden ist). Solange die letzte unbestätigt ist, wird sie unverändert wiederholt. */
  function payload(t = now()) {
    if (open && t - open.since > ((open.duration || 60) + 10) * 1000) close(t); // läuft sicher nicht mehr (kein neuer Status gekommen)
    if (inflight) return inflight; if (!Object.keys(pending).length) return null;
    seq += 1; inflight = { id: seq, days: pending }; pending = {}; dirty = true; return inflight;
  }
  function ack(id) { if (inflight && inflight.id === id) { inflight = null; dirty = true; } }
  function save(force = false, t = now()) { if (!file || !dirty || (!force && t - lastSave < saveEveryMs)) return false; lastSave = t; dirty = false; try { writeJson(file, { seq, pending, inflight }, 0o600); return true; } catch { dirty = true; return false; } }
  function stop() { close(); save(true); }
  return { start, close, payload, ack, save, stop, peek: () => ({ seq, pending, inflight, open }) };
}
