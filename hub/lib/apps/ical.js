// iCal (.ics) lesen: Teilmenge von RFC 5545, die für einen Veranstaltungskalender reicht – ohne fremde Bibliothek.
// Unterstützt: VEVENT mit DTSTART/DTEND (UTC „Z“, TZID, schwebend, ganztägig), SUMMARY, LOCATION, STATUS:CANCELLED, DURATION,
// RRULE (DAILY, WEEKLY+BYDAY, MONTHLY+BYMONTHDAY/BYDAY mit Ordnungszahl, YEARLY; INTERVAL, COUNT, UNTIL), EXDATE, RECURRENCE-ID (geänderte Einzeltermine).
// Nicht unterstützt (wird übergangen, nie abgebrochen): BYSETPOS, BYWEEKNO, RDATE, Sekundenregeln.
import { addDays, dayDiff, dowOf, TZ } from '../../../shared/time.js';

const WIN_TZ = { 'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'GMT Standard Time': 'Europe/London', UTC: 'UTC' };
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY = 86400000;

const dtfCache = new Map();
function dtf(tz) { if (!dtfCache.has(tz)) dtfCache.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })); return dtfCache.get(tz); }
const okTz = (tz) => { try { dtf(tz); return true; } catch { return false; } };
export const resolveTz = (tz) => { const t = WIN_TZ[tz] ?? tz; return t && okTz(t) ? t : TZ; };
function offsetAt(tz, epoch) { const p = {}; for (const { type, value } of dtf(tz).formatToParts(new Date(epoch))) p[type] = Number(value); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epoch / 1000) * 1000; }
/** Ortszeit in einer Zeitzone → Epoch (Lücken/Doppelungen wie in shared/time.js) */
export function zonedToEpoch(date, time, tz = TZ) {
  const [y, m, d] = date.split('-').map(Number), [hh, mm, ss = 0] = time.split(':').map(Number); const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offs = new Set([offsetAt(tz, guess - DAY), offsetAt(tz, guess + DAY)]), valid = [];
  for (const o of offs) { const c = guess - o; if (offsetAt(tz, c) === o) valid.push(c); }
  return valid.length ? Math.min(...valid) : guess - offsetAt(tz, guess - DAY);
}
function epochLocal(epoch, tz = TZ) { const o = offsetAt(tz, epoch), iso = new Date(epoch + o).toISOString(); return { date: iso.slice(0, 10), time: iso.slice(11, 19) }; }

const unfold = (t) => t.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '');
const unesc = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
function parseLine(l) {
  const i = (() => { let q = false; for (let k = 0; k < l.length; k++) { if (l[k] === '"') q = !q; else if (l[k] === ':' && !q) return k; } return -1; })(); if (i < 0) return null;
  const left = l.slice(0, i), value = l.slice(i + 1), parts = left.split(';'), name = parts[0].toUpperCase(), params = {};
  for (const p of parts.slice(1)) { const [k, ...v] = p.split('='); params[k.toUpperCase()] = v.join('=').replace(/^"|"$/g, ''); }
  return { name, params, value };
}
/** DTSTART/DTEND-Wert → { allDay, epoch, tz, date, time } */
function parseDate(value, params) {
  const v = value.trim(); let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)) || params.VALUE === 'DATE') { m = m ?? /^(\d{4})(\d{2})(\d{2})/.exec(v); if (!m) return null; const date = `${m[1]}-${m[2]}-${m[3]}`; return { allDay: true, date, time: '00:00:00', tz: TZ, epoch: zonedToEpoch(date, '00:00:00', TZ) }; }
  if (!(m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v))) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}:${m[6]}`;
  if (m[7]) { const epoch = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); const l = epochLocal(epoch, TZ); return { allDay: false, epoch, tz: TZ, date: l.date, time: l.time, utc: true }; }
  const tz = resolveTz(params.TZID); return { allDay: false, epoch: zonedToEpoch(date, time, tz), tz, date, time };
}
function parseDuration(s) { const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim()); if (!m) return null; const ms = ((+m[2] || 0) * 7 + (+m[3] || 0)) * DAY + (+m[4] || 0) * 3600000 + (+m[5] || 0) * 60000 + (+m[6] || 0) * 1000; return m[1] ? -ms : ms; }
function parseRule(s) {
  const r = {}; for (const part of s.split(';')) { const [k, v] = part.split('='); if (k && v) r[k.toUpperCase()] = v; }
  const byday = (r.BYDAY ?? '').split(',').filter(Boolean).map((x) => { const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.toUpperCase()); return m ? { n: m[1] ? Number(m[1]) : 0, dow: DOW[m[2]] } : null; }).filter(Boolean);
  return { freq: (r.FREQ ?? '').toUpperCase(), interval: Math.max(1, Number(r.INTERVAL) || 1), count: r.COUNT ? Number(r.COUNT) : null, until: r.UNTIL ?? null, byday, bymonthday: (r.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number) };
}

/** ICS-Text → Liste von Terminen */
export function parseIcs(text) {
  const lines = unfold(String(text)).split('\n'), events = []; let cur = null;
  for (const raw of lines) {
    const l = raw.trimEnd(); if (!l) continue;
    if (/^BEGIN:VEVENT$/i.test(l)) { cur = { exdates: [], extra: {} }; continue; }
    if (/^END:VEVENT$/i.test(l)) { if (cur?.start) events.push(finish(cur)); cur = null; continue; }
    if (!cur) continue; const p = parseLine(l); if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unesc(p.value).trim(); break;
      case 'LOCATION': cur.location = unesc(p.value).trim(); break;
      case 'STATUS': cur.cancelled = /CANCELLED/i.test(p.value); break;
      case 'DTSTART': cur.start = parseDate(p.value, p.params); break;
      case 'DTEND': cur.end = parseDate(p.value, p.params); break;
      case 'DURATION': cur.duration = parseDuration(p.value); break;
      case 'RRULE': cur.rule = parseRule(p.value); break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) cur.exdates.push(d.date); } break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(p.value, p.params); break;
      default: break;
    }
  }
  return events;
}
function finish(e) {
  const start = e.start; let end = e.end?.epoch ?? (e.duration != null ? start.epoch + e.duration : null);
  if (end == null || end <= start.epoch) end = start.allDay ? start.epoch + DAY : start.epoch; // ohne Ende: ganztägig bzw. Zeitpunkt
  return { uid: e.uid ?? null, title: e.title || '(ohne Titel)', location: e.location ?? '', cancelled: !!e.cancelled, allDay: start.allDay, utc: !!start.utc, startDate: start.date, startTime: start.time, tz: start.tz, start: start.epoch, durationMs: end - start.epoch, rule: e.rule ?? null, exdates: e.exdates, recurrenceId: e.recurrenceId ?? null };
}

const weekStart = (date) => addDays(date, -((dowOf(date) + 6) % 7));
const ymd = (d) => d.split('-').map(Number);
function nthWeekdayMatches(date, n, dow) { if (dowOf(date) !== dow) return false; const [y, m, d] = ymd(date); if (n > 0) return Math.ceil(d / 7) === n; const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Math.ceil((dim - d + 1) / 7) === -n; }
function ruleMatches(ev, date) {
  const r = ev.rule, s = ev.startDate; const diff = dayDiff(s, date); if (diff < 0) return false;
  const [sy, sm, sd] = ymd(s), [y, m, d] = ymd(date);
  switch (r.freq) {
    case 'DAILY': return diff % r.interval === 0;
    case 'WEEKLY': { if (Math.floor(dayDiff(weekStart(s), weekStart(date)) / 7) % r.interval !== 0) return false; return r.byday.length ? r.byday.some((b) => b.dow === dowOf(date)) : dowOf(date) === dowOf(s); }
    case 'MONTHLY': { if (((y - sy) * 12 + (m - sm)) % r.interval !== 0) return false;
      if (r.bymonthday.length) return r.bymonthday.some((x) => (x > 0 ? x === d : new Date(Date.UTC(y, m, 0)).getUTCDate() + x + 1 === d));
      if (r.byday.length) return r.byday.some((b) => (b.n ? nthWeekdayMatches(date, b.n, b.dow) : b.dow === dowOf(date)));
      return d === sd; }
    case 'YEARLY': return (y - sy) % r.interval === 0 && m === sm && d === sd;
    default: return false;
  }
}
const untilDate = (u) => { if (!u) return null; const p = parseDate(u.length === 8 ? u : u, {}); return p ? (p.utc ? epochLocal(p.epoch, TZ).date : p.date) : null; };

/** Alle Termine, die am Kalendertag `date` (YYYY-MM-DD, Europe/Berlin) stattfinden – sortiert, ohne abgesagte. */
export function eventsOnDate(events, date) {
  const dayStart = zonedToEpoch(date, '00:00:00', TZ), dayEnd = zonedToEpoch(addDays(date, 1), '00:00:00', TZ);
  const overridden = new Set(events.filter((e) => e.recurrenceId).map((e) => `${e.uid}|${e.recurrenceId.date}`));
  const out = [];
  for (const e of events) {
    if (e.cancelled) continue;
    if (!e.rule) { const endMs = e.start + e.durationMs, inDay = e.durationMs === 0 ? (e.start >= dayStart && e.start < dayEnd) : (e.start < dayEnd && endMs > dayStart); if (inDay) out.push(occ(e, e.start)); continue; }
    if (overridden.has(`${e.uid}|${date}`) && !e.recurrenceId) continue;
    const until = untilDate(e.rule.until); if (until && date > until) continue;
    let matched = false;
    if (e.rule.count) { let n = 0; for (let d = e.startDate, guard = 0; d <= date && guard < 4000; d = addDays(d, 1), guard++) { if (ruleMatches(e, d) && !e.exdates.includes(d)) { n++; if (d === date) { matched = n <= e.rule.count; } if (n >= e.rule.count) break; } } }
    else matched = ruleMatches(e, date) && !e.exdates.includes(date);
    if (matched) out.push(occ(e, e.allDay ? zonedToEpoch(date, '00:00:00', e.tz) : e.utc ? e.start + dayDiff(e.startDate, date) * DAY /* UTC-Termine behalten ihre UTC-Zeit (auch über Sommer-/Winterzeit) */ : zonedToEpoch(date, e.startTime, e.tz)));
  }
  return out.sort((a, b) => (b.allDay - a.allDay) || a.start - b.start || a.title.localeCompare(b.title, 'de'));
}
const occ = (e, start) => ({ title: e.title, location: e.location, allDay: e.allDay, start, end: start + e.durationMs });
