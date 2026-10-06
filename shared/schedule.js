// Zeitplan-Logik (läuft identisch auf Hub und Player, damit der Player
// auch ohne Hub korrekt weiterspielt).
//
// Termin: { id, targetType:'device'|'group', targetId, content:{type,id},
//   startLocal:'YYYY-MM-DDTHH:mm', endLocal:'YYYY-MM-DDTHH:mm',
//   rrule: null | 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU;UNTIL=YYYYMMDD;COUNT=n',
//   exdates:['YYYY-MM-DD'], priority:1-10, validFrom?:'YYYY-MM-DD', validTo?:'YYYY-MM-DD' }
import { localToEpoch, addDays, dayDiff, dowOf, epochToLocal } from './time.js';

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_ITER = 4000;

export function parseRrule(rule) {
  if (!rule) return null;
  const o = { freq: null, interval: 1, byday: null, until: null, count: null };
  for (const part of rule.split(';')) {
    const [k, v] = part.split('=');
    if (k === 'FREQ') {
      if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(v)) throw new Error('Wiederholung nicht unterstützt: ' + v);
      o.freq = v;
    } else if (k === 'INTERVAL') o.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (k === 'BYDAY') {
      o.byday = v.split(',').map((x) => { if (!(x in DOW)) throw new Error('Ungültiger Wochentag: ' + x); return DOW[x]; });
    } else if (k === 'UNTIL') o.until = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    else if (k === 'COUNT') o.count = parseInt(v, 10);
    else throw new Error('Wiederholungsregel nicht unterstützt: ' + k);
  }
  if (!o.freq) throw new Error('FREQ fehlt');
  return o;
}

/** Datum der Wochenbeginn (Montag) für Intervall-Rechnung. */
function weekStart(date) { return addDays(date, -((dowOf(date) + 6) % 7)); }

/** Alle lokalen Starttage eines Termins zwischen fromDate und toDate (inkl.). */
function* occurrenceDates(s, rule, fromDate, toDate) {
  const startDate = s.startLocal.slice(0, 10);
  if (!rule) { if (startDate >= fromDate && startDate <= toDate) yield startDate; return; }
  let count = 0, iter = 0;
  const startDow = dowOf(startDate);
  const last = rule.until && rule.until < toDate ? rule.until : toDate;
  for (let d = startDate; d <= last; d = addDays(d, 1)) {
    if (++iter > MAX_ITER) return;
    let hit = false;
    if (rule.freq === 'DAILY') hit = dayDiff(startDate, d) % rule.interval === 0;
    else if (rule.freq === 'WEEKLY') {
      const days = rule.byday ?? [startDow];
      hit = days.includes(dowOf(d)) && (dayDiff(weekStart(startDate), weekStart(d)) / 7) % rule.interval === 0;
    } else { // MONTHLY: gleicher Tag im Monat
      const [sy, sm, sd] = startDate.split('-').map(Number), [y, m, dd] = d.split('-').map(Number);
      hit = dd === sd && ((y - sy) * 12 + (m - sm)) % rule.interval === 0;
    }
    if (!hit) continue;
    count++;
    if (rule.count && count > rule.count) return;
    if (d >= fromDate) yield d;
  }
}

/** Konkrete Zeitfenster [startMs,endMs) eines Termins im Bereich [fromMs,toMs]. */
export function expand(s, fromMs, toMs) {
  const rule = parseRrule(s.rrule);
  const [sd, st] = s.startLocal.split('T');
  const [ed, et] = s.endLocal.split('T');
  const spanDays = dayDiff(sd, ed);
  if (spanDays < 0 || (spanDays === 0 && et <= st)) throw new Error('Ende liegt vor dem Start');
  const from = addDays(epochToLocal(fromMs).date, -(spanDays + 1));
  const to = addDays(epochToLocal(toMs).date, 1);
  const out = [];
  const ex = new Set(s.exdates ?? []);
  for (const d of occurrenceDates(s, rule, from, to)) {
    if (ex.has(d)) continue;
    if (s.validFrom && d < s.validFrom) continue;
    if (s.validTo && d > s.validTo) continue;
    const start = localToEpoch(d, st);
    const end = localToEpoch(addDays(d, spanDays), et);
    if (end > fromMs && start < toMs) out.push({ start, end, s });
  }
  return out;
}

function betterThan(a, b) {
  // 1) direkt zugewiesen vor Gruppe, 2) höhere Priorität, 3) später gestartet, 4) stabil nach id
  const ta = a.s.targetType === 'device' ? 1 : 0, tb = b.s.targetType === 'device' ? 1 : 0;
  if (ta !== tb) return ta > tb;
  if (a.s.priority !== b.s.priority) return a.s.priority > b.s.priority;
  if (a.start !== b.start) return a.start > b.start;
  return String(a.s.id) > String(b.s.id);
}

/**
 * Zeitleiste eines Geräts: lückenlose Segmente [from,to) mit Quelle.
 * source=null bedeutet: Standard-Abspielliste (der Player fällt bei leerer
 * Liste auf das DFM-Standby-Bild zurück).
 */
export function buildTimeline(schedules, { deviceId, groupId }, fromMs, toMs) {
  const mine = schedules.filter((s) => (s.targetType === 'device' && s.targetId === deviceId)
    || (s.targetType === 'group' && groupId != null && s.targetId === groupId));
  const wins = mine.flatMap((s) => expand(s, fromMs, toMs));
  const cuts = new Set([fromMs, toMs]);
  for (const w of wins) { if (w.start > fromMs && w.start < toMs) cuts.add(w.start); if (w.end > fromMs && w.end < toMs) cuts.add(w.end); }
  const pts = [...cuts].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    let best = null;
    for (const w of wins) if (w.start <= a && w.end >= b && (!best || betterThan(w, best))) best = w;
    const source = best ? { scheduleId: best.s.id, content: best.s.content, priority: best.s.priority } : null;
    const prev = segs[segs.length - 1];
    if (prev && prev.end === a && (prev.source?.scheduleId ?? null) === (source?.scheduleId ?? null)) prev.end = b;
    else segs.push({ start: a, end: b, source });
  }
  return segs;
}

/** Was läuft zum Zeitpunkt t? (reine Funktion, offline nutzbar) */
export function currentSegment(timeline, t) {
  return timeline.find((s) => t >= s.start && t < s.end) ?? null;
}

/** Konflikte: überlappende Termine gleicher Ebene und Priorität am selben Ziel. */
export function findConflicts(schedules, fromMs, toMs) {
  const wins = schedules.flatMap((s) => expand(s, fromMs, toMs));
  const out = [];
  for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) {
    const a = wins[i], b = wins[j];
    if (a.s.id === b.s.id) continue;
    if (a.s.targetType !== b.s.targetType || a.s.targetId !== b.s.targetId) continue;
    if (a.s.priority !== b.s.priority) continue;
    if (a.start < b.end && b.start < a.end) out.push({ a: a.s.id, b: b.s.id, start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) });
  }
  return out;
}
