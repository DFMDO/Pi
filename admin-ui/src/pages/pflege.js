// Betrieb → Pflege: Erinnerungen an Reinigung, Netzteil und SD-Karte je Bildschirm. Der Hub weiß nur, wann etwas abgehakt wurde – es ist eine Erinnerung, keine Messung.
import { h, dialog, toast, field, empty } from '../ui.js';
import { get, post, put, can } from '../api.js';

const DAY = 86400000, tz = 'Europe/Berlin';
const date = (ms) => new Date(ms).toLocaleDateString('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' });
const iso = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: tz });
const span = (ms) => { const d = Math.round(Math.abs(ms) / DAY); return d < 2 ? '1 Tag' : d < 60 ? `${d} Tagen` : `${Math.round(d / 30)} Monaten`; };
const BASE = { erledigt: 'zuletzt erledigt', eingebaut: 'eingebaut', verbunden: 'verbunden' };
const STATUS = { faellig: ['bad', '✖'], bald: ['warn', '▲'], ok: ['ok', '✔'] };

function doneDlg(task, devices, route) {
  const day = h('input', { type: 'date', value: iso(), max: iso(), 'aria-label': 'Datum' }), names = devices.map((d) => `„${d.name}“`).join(', ');
  dialog('Erledigt?', h('div', {}, h('p', {}, h('b', {}, task.title)), h('p', {}, names), field('Wann wurde es gemacht?', day, 'Heute oder ein früherer Tag.')),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Ja, erledigt', fn: async () => { try { await post('/care/done', { task: task.id, deviceIds: devices.map((d) => d.id), date: day.value || iso() }); toast('Eingetragen.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

export async function pflegeView(route) {
  const c = await get('/care'), admin = can('devices.manage'), now = Date.now();
  if (!c.devices.length) return empty('Noch kein Bildschirm', 'Verbinde zuerst einen Bildschirm.');
  const rank = { faellig: 0, bald: 1, ok: 2 };
  const cards = c.tasks.filter((t) => t.enabled).map((t) => {
    const rows = c.devices.map((d) => ({ d, i: d.items.find((x) => x.task === t.id) })).filter((x) => x.i).sort((a, b) => rank[a.i.status] - rank[b.i.status] || a.i.dueAt - b.i.dueAt || a.d.name.localeCompare(b.d.name, 'de'));
    const due = rows.filter((x) => x.i.status === 'faellig').map((x) => x.d);
    return h('article', { class: 'card' }, h('h2', { style: 'margin-top:0' }, t.title), h('p', { class: 'hint' }, `Alle ${t.months} Monate. ${t.hint}`),
      h('ul', { style: 'list-style:none;padding:0;margin:0' }, rows.map(({ d, i }) => { const [cls, icon] = STATUS[i.status];
        return h('li', { class: 'row', style: 'gap:8px;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--dfm-line)' }, h('span', { class: 'status ' + cls }, h('span', { 'aria-hidden': 'true' }, icon), d.name), h('span', { class: 'sp' }),
          h('span', { class: 'hint' }, i.status === 'faellig' ? `fällig seit ${span(now - i.dueAt)}` : `fällig am ${date(i.dueAt)}`, ` · ${BASE[i.base]} ${date(i.baseAt)}${i.by ? ' von ' + i.by : ''}`),
          admin ? h('button', { class: 'btn sec', 'aria-label': `„${t.title}“ bei ${d.name} abhaken`, onclick: () => doneDlg(t, [d], route) }, '✔ Erledigt') : null); })),
      admin && due.length > 1 ? h('p', {}, h('button', { class: 'btn', onclick: () => doneDlg(t, due, route) }, `✔ Alle ${due.length} fälligen abhaken`)) : null);
  });
  const head = c.summary.faellig ? h('p', { class: 'notice bad', role: 'status' }, `✖ ${c.summary.faellig} Aufgabe${c.summary.faellig === 1 ? ' ist' : 'n sind'} fällig.`) : c.summary.bald ? h('p', { class: 'notice', role: 'status' }, `▲ ${c.summary.bald} Aufgabe${c.summary.bald === 1 ? '' : 'n'} in den nächsten 30 Tagen fällig.`) : h('p', { class: 'hint' }, '✔ Nichts fällig.');
  const months = {}, on = {}; for (const t of c.tasks) { months[t.id] = h('input', { type: 'number', min: 1, max: 60, value: t.months, 'aria-label': `Abstand in Monaten: ${t.title}`, style: 'width:5em' }); on[t.id] = h('input', { type: 'checkbox', checked: t.enabled, 'aria-label': `${t.title} erinnern` }); }
  const settings = can('settings.manage') ? h('details', { style: 'margin-top:16px' }, h('summary', {}, 'Abstände ändern (Admin)'), ...c.tasks.map((t) => h('div', { class: 'row', style: 'gap:8px;align-items:center;margin:6px 0' }, on[t.id], h('span', {}, t.title), h('span', { class: 'sp' }), months[t.id], h('span', {}, 'Monate'))),
    h('button', { class: 'btn', onclick: async () => { try { await put('/care/tasks', { tasks: Object.fromEntries(c.tasks.map((t) => [t.id, { months: Number(months[t.id].value), enabled: on[t.id].checked }])) }); toast('Gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Speichern')) : null;
  return h('div', {}, head, h('p', { class: 'hint' }, c.hint), h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(360px,1fr))' }, cards), settings);
}
