// Notfall-Meldung: ein fertiger Text auf ALLEN Bildschirmen, mit einem Klick und einer Rückfrage. Admins können die Texte ändern.
import { h, dialog, confirmDlg, toast, field } from '../ui.js';
import { get, post, put, can } from '../api.js';

const DURS = [['30', '30 Minuten'], ['60', '1 Stunde'], ['120', '2 Stunden'], ['eod', 'bis Tagesende']];
const durBody = (v) => (v === 'eod' ? { endOfDay: true } : { minutes: Number(v) });

export async function notfallDlg(route) {
  const info = await get('/emergency'); let chosen = info.presets[0]?.id ?? 'custom';
  const list = h('div', { class: 'preset-list', role: 'group', 'aria-label': 'Text der Meldung' });
  const title = h('input', { maxlength: 60, placeholder: 'Überschrift', 'aria-label': 'Eigene Überschrift' }), text = h('textarea', { maxlength: 300, rows: 3, placeholder: 'Eigener Text (höchstens 300 Zeichen)', 'aria-label': 'Eigener Text' });
  const custom = h('div', { hidden: chosen !== 'custom' ? '' : null }, field('Überschrift', title), field('Text', text));
  const dur = h('select', { 'aria-label': 'Wie lange zeigen' }, DURS.map(([k, t]) => h('option', { value: k }, t)));
  const draw = () => { list.replaceChildren(...info.presets.map((p) => h('button', { type: 'button', class: 'preset', 'aria-pressed': String(chosen === p.id), onclick: () => { chosen = p.id; custom.hidden = true; draw(); } }, h('b', {}, p.title), h('span', { class: 'hint' }, p.text))),
    h('button', { type: 'button', class: 'preset', 'aria-pressed': String(chosen === 'custom'), onclick: () => { chosen = 'custom'; custom.hidden = false; draw(); title.focus(); } }, h('b', {}, '✏️ Eigener Text'))); };
  draw();
  const body = h('div', {},
    info.active ? h('div', { class: 'notice bad', role: 'alert' }, h('b', {}, `🚨 Es läuft schon eine Meldung: „${info.active.title}“ (von ${info.active.by}). `), h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; try { const r = await post('/emergency/stop'); toast(r.text); d.close(); route(); } catch (x) { toast(x.message, 'err'); e.target.disabled = false; } } }, 'Meldung jetzt beenden')) : null,
    h('p', { class: 'notice' }, 'Die Meldung erscheint SOFORT auf ', h('b', {}, 'allen Bildschirmen'), ' und ersetzt alles andere. Das ist eine Durchsage am Bildschirm, ', h('b', {}, 'keine Alarmanlage'), ' und kein Ersatz für Lautsprecher oder Brandschutz.'),
    list, custom, field('Wie lange zeigen?', dur),
    can('settings.manage') ? h('p', {}, h('button', { class: 'btn link', type: 'button', onclick: () => { d.close(); editTexts(info, route); } }, 'Texte ändern (nur Admins)')) : null);
  const d = dialog('🚨 Notfall-Meldung', body, [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Auf ALLEN Bildschirmen zeigen', cls: 'danger', fn: async () => {
    const b = chosen === 'custom' ? { title: title.value, text: text.value } : { presetId: chosen };
    if (chosen === 'custom' && !text.value.trim()) { toast('Bitte schreibe einen Text.', 'err'); return false; }
    const label = chosen === 'custom' ? (title.value || 'Wichtige Mitteilung') : info.presets.find((p) => p.id === chosen)?.title;
    if (!(await confirmDlg('Wirklich jetzt auf allen Bildschirmen zeigen?', `„${label}“ erscheint sofort auf allen Bildschirmen und ersetzt alles andere.`, 'Ja, jetzt zeigen'))) return false;
    try { const r = await post('/emergency/start', { ...b, confirm: true, ...durBody(dur.value) }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

/** Admin: die Beispieltexte durch eigene ersetzen (bis zu 6) */
function editTexts(info, route) {
  const rows = []; const box = h('div', {});
  const add = (p = { title: '', text: '' }) => { const t = h('input', { value: p.title, maxlength: 60, 'aria-label': 'Überschrift' }), x = h('textarea', { maxlength: 300, rows: 2, 'aria-label': 'Text' }, p.text); rows.push({ t, x }); box.append(h('div', { class: 'card', style: 'margin-bottom:8px' }, field('Überschrift', t), field('Text', x))); };
  (info.presets.length ? info.presets : [{ title: '', text: '' }]).forEach(add);
  dialog('Notfall-Texte ändern', h('div', {}, h('p', { class: 'hint' }, 'Diese Texte stehen im Notfall zur Auswahl. Bitte mit der Leitung und dem Brandschutz abstimmen. Leere Einträge werden weggelassen.'), box, h('button', { class: 'btn sec', type: 'button', onclick: () => { if (rows.length < 6) add(); else toast('Mehr als 6 Texte sind nicht möglich.', 'err'); } }, '➕ Text hinzufügen')),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await put('/emergency/presets', { presets: rows.map(({ t, x }) => ({ title: t.value, text: x.value })).filter((p) => p.title.trim() && p.text.trim()) }); toast('Gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
