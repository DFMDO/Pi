// Zeit-Hilfen für Europe/Berlin. Termine speichern lokale Zeit; hier wird
// lokale Zeit <-> Epoch-Millisekunden umgerechnet (inkl. Sommer-/Winterzeit).
export const TZ = 'Europe/Berlin';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Offset (ms) von Berlin gegenüber UTC zum Zeitpunkt epochMs. */
export function tzOffset(epochMs) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(epochMs))) p[type] = Number(value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch -> {date:'YYYY-MM-DD', time:'HH:mm', dow:0-6 (So=0)} in Berlin. */
export function epochToLocal(epochMs) {
  const d = new Date(epochMs + tzOffset(epochMs));
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), dow: d.getUTCDay() };
}

const DAY = 86400000;

/**
 * Lokale Zeit -> Epoch.
 * Nicht existierende Zeit (Lücke im März) wird wie in RFC 5545 mit dem Offset
 * vor dem Wechsel gedeutet (02:30 -> 03:30 Sommerzeit).
 * Doppelte Zeit (Oktober) -> erste Instanz (Sommerzeit).
 */
export function localToEpoch(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offBefore = tzOffset(guess - DAY);
  const offAfter = tzOffset(guess + DAY);
  const valid = [];
  for (const o of new Set([offBefore, offAfter])) {
    const cand = guess - o;
    if (tzOffset(cand) === o) valid.push(cand);
  }
  if (valid.length) return Math.min(...valid);
  return guess - offBefore; // Lücke
}

/** 'YYYY-MM-DD' + n Tage (reine Kalenderrechnung). */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayDiff(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / DAY);
}

export function dowOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
