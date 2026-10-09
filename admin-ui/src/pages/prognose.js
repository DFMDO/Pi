// Betrieb → Prognose: Wann wird der Speicher voll? Sinkt der freie Arbeitsspeicher stetig? Wird ein Gerät immer heißer? (Schätzung aus dem Verlauf)
import { h, empty } from '../ui.js';
import { get } from '../api.js';

const LEVEL = { ok: ['ok', '✔'], warn: ['warn', '▲'], bad: ['bad', '✖'], info: ['', 'ℹ'], wait: ['', '⏳'] };

export async function prognoseView() {
  const r = await get('/prognose'), by = new Map();
  for (const i of r.items) { if (!by.has(i.src)) by.set(i.src, { name: i.name, items: [] }); by.get(i.src).items.push(i); }
  const head = h('p', { class: r.bad ? 'notice bad' : r.warn ? 'notice' : 'hint', role: r.bad || r.warn ? 'status' : null }, r.bad ? `✖ ${r.bad} Punkt${r.bad === 1 ? '' : 'e'} brauch${r.bad === 1 ? 't' : 'en'} bald deine Aufmerksamkeit.` : r.warn ? `▲ ${r.warn} Hinweis${r.warn === 1 ? '' : 'e'} zum Vorbeugen.` : '✔ Nichts Auffälliges in den Messwerten.');
  if (!by.size) return empty('Noch keine Messwerte', 'Der Hub sammelt Messwerte, sobald er läuft. Nach 24 Stunden erscheint hier die erste Schätzung.');
  return h('div', {}, head, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' }, [...by.values()].map((g) => h('article', { class: 'card' }, h('h2', { style: 'margin-top:0' }, g.name),
    g.items.map((i) => { const [cls, icon] = LEVEL[i.level] ?? ['', '']; return h('div', { style: 'margin-bottom:10px' }, h('p', { style: 'margin:0' }, h('span', { class: 'status ' + cls }, h('span', { 'aria-hidden': 'true' }, icon), i.title), ' – ', i.text), i.hint ? h('p', { class: 'hint', style: 'margin:2px 0 0' }, i.hint) : null); })))),
  h('p', { class: 'hint' }, r.hint));
}
