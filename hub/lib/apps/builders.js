// Die fünf Apps: Jede macht aus Daten eine fertige Textfolie { title, body, compact }. Reine Funktionen (gut testbar), das Holen der Daten steckt in index.js.
import { epochToLocal, addDays, TZ } from '../../../shared/time.js';
import { parseIcs, eventsOnDate } from './ical.js';

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const num = (x, d = 0) => Number(x).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// ---------------------------------------------------------------- Wetter (Deutscher Wetterdienst über Bright Sky)
const COND = { fog: 'Nebel', rain: 'Regen', sleet: 'Schneeregen', snow: 'Schnee', hail: 'Hagel', thunderstorm: 'Gewitter' };
const SEVERITY = ['dry', 'fog', 'rain', 'sleet', 'snow', 'hail', 'thunderstorm'];
const sky = (c) => (c == null ? 'trocken' : c <= 12.5 ? 'klar' : c <= 37.5 ? 'heiter' : c <= 62.5 ? 'wolkig' : c <= 87.5 ? 'stark bewölkt' : 'bedeckt');
export function describeHour(h) { return h.condition && COND[h.condition] ? COND[h.condition] : sky(h.cloud_cover); }
function dayLine(label, hours) {
  if (!hours.length) return null;
  const temps = hours.map((h) => h.temperature).filter((x) => x != null), rain = hours.reduce((s, h) => s + (h.precipitation ?? 0), 0);
  const worst = hours.reduce((w, h) => (SEVERITY.indexOf(h.condition) > SEVERITY.indexOf(w) ? h.condition : w), 'dry');
  const clouds = hours.map((h) => h.cloud_cover).filter((x) => x != null), avgCloud = clouds.length ? clouds.reduce((a, b) => a + b, 0) / clouds.length : null;
  const what = worst !== 'dry' ? COND[worst] : sky(avgCloud);
  const range = temps.length ? `${num(Math.round(Math.min(...temps)))} bis ${num(Math.round(Math.max(...temps)))} °C` : '';
  return `${label}: ${[range, what].filter(Boolean).join(', ')}${worst !== 'dry' && rain >= 0.2 ? ` (${num(rain, 1)} mm)` : ''}`;
}
/** hourly: Antwort von /weather (Array stündlicher Werte, timestamp mit lokalem Versatz), current: Antwort von /current_weather (oder null) */
export function buildWeather({ hourly, current, nowMs, place }) {
  const today = epochToLocal(nowMs).date, tomorrow = addDays(today, 1), by = (d) => hourly.filter((h) => String(h.timestamp).slice(0, 10) === d);
  const nowH = hourly.reduce((best, h) => (!best || Math.abs(Date.parse(h.timestamp) - nowMs) < Math.abs(Date.parse(best.timestamp) - nowMs) ? h : best), null);
  const cur = current?.temperature != null ? current : nowH;
  const lines = [];
  if (cur?.temperature != null) lines.push(`Jetzt: ${num(Math.round(cur.temperature))} °C, ${describeHour(current?.condition ? current : nowH ?? current)}`);
  const t = dayLine('Heute', by(today)), m = dayLine('Morgen', by(tomorrow)); if (t) lines.push(t); if (m) lines.push(m);
  if (!lines.length) throw new Error('Der Wetterdienst hat keine Daten für diesen Ort geliefert.');
  return { title: `Wetter in ${place}`, body: lines.join('\n') + '\n\nQuelle: Deutscher Wetterdienst', compact: false };
}

// ---------------------------------------------------------------- Fußball (OpenLigaDB)
const LEAGUE = { bl1: 'Bundesliga', bl2: '2. Bundesliga', bl3: '3. Liga', dfb: 'DFB-Pokal' };
export const LEAGUES = Object.keys(LEAGUE);
export function buildMatchday(matches, { league = 'bl1', favorite = 'Dortmund' } = {}) {
  if (!Array.isArray(matches) || !matches.length) throw new Error('Für diese Liga liegen gerade keine Spiele vor.');
  const sorted = [...matches].sort((a, b) => Date.parse(a.matchDateTimeUTC ?? a.matchDateTime) - Date.parse(b.matchDateTimeUTC ?? b.matchDateTime)), fav = favorite.toLowerCase();
  const lines = sorted.map((m) => {
    const name = (t) => cut(t?.shortName || t?.teamName || '?', 18), res = (m.matchResults ?? []).find((r) => r.resultTypeID === 2) ?? (m.matchResults ?? []).at(-1);
    const start = epochToLocal(Date.parse(m.matchDateTimeUTC ?? m.matchDateTime + 'Z'));
    const score = res ? `${res.pointsTeam1}:${res.pointsTeam2}${m.matchIsFinished ? '' : ' (läuft)'}` : `${WD[start.dow]} ${start.time}`;
    const star = [m.team1?.teamName, m.team1?.shortName, m.team2?.teamName, m.team2?.shortName].some((n) => n && n.toLowerCase().includes(fav)) ? '★ ' : '';
    return `${star}${name(m.team1)} – ${name(m.team2)}   ${score}`;
  });
  return { title: `${LEAGUE[league] ?? 'Liga'} – ${matches[0].group?.groupName ?? 'Spieltag'}`, body: lines.join('\n'), compact: lines.length > 6 };
}

// ---------------------------------------------------------------- Nachrichten (RSS / Atom)
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, d, x, n) => (d ? String.fromCodePoint(Number(d)) : x ? String.fromCodePoint(parseInt(x, 16)) : ENT[n] ?? m));
export function parseFeed(xml) {
  const items = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  return items.map((it) => { const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(it); if (!m) return null; let t = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); t = decode(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return t ? { title: t } : null; }).filter(Boolean);
}
export function buildNews(xml, { title = 'Neuigkeiten', maxItems = 5 } = {}) {
  const items = parseFeed(xml).slice(0, maxItems); if (!items.length) throw new Error('In diesem Feed wurden keine Meldungen gefunden. Ist das wirklich eine RSS- oder Atom-Adresse?');
  return { title, body: items.map((i) => '• ' + cut(i.title, 90)).join('\n'), compact: items.length > 4 };
}

// ---------------------------------------------------------------- Datum & Öffnungszeiten
export const DAYS = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'];
export const HOURS_RE = /^$|^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (s) => { const [h, m] = s.split(':').map(Number); return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`; };
export function buildToday(nowMs, { hours = {}, closedDates = [], lastEntryMin = 0 } = {}) {
  const l = epochToLocal(nowMs), title = new Date(nowMs).toLocaleDateString('de-DE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const h = (hours[DAYS[l.dow]] ?? '').trim(), closed = closedDates.includes(l.date);
  if (closed || !h) return { title, body: 'Heute ist das Museum geschlossen.', compact: false };
  const [from, to] = h.split('-'); const lines = [`Heute geöffnet von ${hhmm(from)} bis ${hhmm(to)} Uhr`];
  if (lastEntryMin > 0) { const [th, tm] = to.split(':').map(Number), mins = th * 60 + tm - lastEntryMin; lines.push(`Letzter Einlass: ${hhmm(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`)} Uhr`); }
  return { title, body: lines.join('\n'), compact: false };
}

// ---------------------------------------------------------------- Tagesprogramm (aus dem Event-Kalender, iCal)
export function buildProgram(ics, nowMs, { title = 'Heute im Museum', locationFilter = '', maxEvents = 7 } = {}) {
  const date = epochToLocal(nowMs).date, f = locationFilter.trim().toLowerCase();
  let evs = eventsOnDate(parseIcs(ics), date); if (f) evs = evs.filter((e) => e.location.toLowerCase().includes(f));
  const shown = evs.slice(0, maxEvents), more = evs.length - shown.length;
  const body = evs.length ? shown.map((e) => `${e.allDay ? 'ganztägig' : epochToLocal(e.start).time}  ${cut(e.title, 60)}${e.location ? ` (${cut(e.location, 24)})` : ''}`).join('\n') + (more > 0 ? `\n… und ${more} weitere` : '') : 'Heute keine besonderen Veranstaltungen.';
  return { title, body, compact: shown.length > 5 };
}
