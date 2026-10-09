// Einfaches Liniendiagramm als SVG (ohne Beschriftung im Bild): Zahlen und Zeiten stehen als normaler Text daneben – gut lesbar, barrierearm, CSP-konform.
import { h } from '../ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const when = (ms, hours) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', ...(hours > 30 ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) });
export const fmtNum = (v, d = 0) => (v == null ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** @param warn Schwelle, die als gestrichelte Linie eingezeichnet wird (z. B. 100 MB freier Speicher) */
export function lineChart({ points, key, title, unit, decimals = 0, warn = null, hours = 24 }) {
  const box = h('figure', { class: 'chartbox' }, h('figcaption', {}, h('b', {}, title)));
  const vals = points.filter((p) => p[key] != null);
  if (vals.length < 2) { box.append(h('p', { class: 'hint' }, 'Noch zu wenige Messwerte. Es wird etwa einmal pro Minute gemessen.')); return box; }
  const vs = vals.map((p) => p[key]), min = Math.min(...vs), max = Math.max(...vs), last = vs[vs.length - 1];
  let lo = min, hi = max; if (warn != null) { lo = Math.min(lo, warn); hi = Math.max(hi, warn); } if (hi - lo < 1) { hi += 1; lo -= 1; } const pad = (hi - lo) * 0.12; lo = Math.max(0, lo - pad); hi += pad;
  const W = 640, H = 170, T = 8, B = 8, t0 = vals[0].ts, t1 = vals[vals.length - 1].ts || t0 + 1;
  const x = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * W, y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${title}: zuletzt ${fmtNum(last, decimals)} ${unit}, niedrigster Wert ${fmtNum(min, decimals)}, höchster ${fmtNum(max, decimals)}` });
  for (const f of [0.25, 0.5, 0.75]) svg.append(svgEl('line', { x1: 0, x2: W, y1: T + f * (H - T - B), y2: T + f * (H - T - B), class: 'grid' }));
  if (warn != null) svg.append(svgEl('line', { x1: 0, x2: W, y1: y(warn), y2: y(warn), class: 'warnline' }));
  svg.append(svgEl('path', { d: vals.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' '), class: 'line' }));
  box.append(svg, h('div', { class: 'row chartfoot' }, h('span', {}, when(t0, hours)), h('span', { class: 'sp' }), h('span', {}, 'jetzt ' + when(t1, hours))),
    h('p', { class: 'chartnums' }, `Jetzt: ${fmtNum(last, decimals)} ${unit} · Niedrigster: ${fmtNum(min, decimals)} ${unit} · Höchster: ${fmtNum(max, decimals)} ${unit}`, warn != null ? h('span', { class: 'hint' }, ` · gestrichelt: Warnschwelle ${fmtNum(warn, decimals)} ${unit}`) : null));
  return box;
}
