// Einschübe: „Alle 5 Minuten das Sponsor-Logo für 10 Sekunden“. Der Bildschirm mischt die Folie selbst in seine Liste ein (auch ohne Hub).
import { h, dialog, confirmDlg, toast, field, empty } from '../ui.js';
import { get, post, put, del, can } from '../api.js';

const STATUS = { aktiv: ['ok', '✔', 'läuft'], aus: ['', '⏸', 'aus'], abgelaufen: ['', '–', 'abgelaufen'], zukunft: ['pending', '⏳', 'startet später'], fehler: ['bad', '✖', 'Fehler'] };
const KIND = { video: 'Video', text: 'Folie', image: 'Bild', pdfpage: 'PDF-Seite' };
const dmy = (s) => (s ? s.split('-').reverse().join('.') : '');

async function editor(ins, route) {
  const [md, groups, devices] = await Promise.all([get('/media'), get('/groups'), get('/devices')]);
  const r = ins ?? { name: '', enabled: true, media: { id: '' }, everyMin: 5, seconds: 10, scope: 'all', validFrom: '', validTo: '' };
  const name = h('input', { value: r.name, maxlength: 60, placeholder: 'zum Beispiel: Sponsor-Logo', 'aria-label': 'Name' }), on = h('input', { type: 'checkbox', checked: r.enabled !== false, id: 'ins-on' });
  const media = h('select', { 'aria-label': 'Was zeigen' }, h('option', { value: '' }, '– bitte wählen –'), md.map((m) => h('option', { value: m.id, selected: m.id === r.media.id ? '' : null }, `${KIND[m.kind] ?? 'Datei'}: ${m.name}`)));
  const every = h('input', { type: 'number', min: 1, max: 240, value: r.everyMin, 'aria-label': 'Abstand in Minuten', style: 'width:6em' }), secs = h('input', { type: 'number', min: 3, max: 120, value: r.seconds, 'aria-label': 'Sekunden', style: 'width:6em' });
  const scope = h('select', { 'aria-label': 'Wo' }, [['all', 'Alle Bildschirme'], ['group', 'Eine Gruppe'], ['device', 'Ein Bildschirm']].map(([k, t]) => h('option', { value: k, selected: k === r.scope ? '' : null }, t)));
  const target = h('select', { 'aria-label': 'Ziel' }), targetField = field('Welche(r)?', target), fill = () => { targetField.hidden = scope.value === 'all'; target.replaceChildren(...(scope.value === 'group' ? groups : devices.filter((d) => d.status.level !== 'pending')).map((x) => h('option', { value: x.id, selected: x.id === r.targetId ? '' : null }, x.name))); };
  scope.addEventListener('change', fill); fill();
  const from = h('input', { type: 'date', value: r.validFrom ?? '', 'aria-label': 'Von' }), to = h('input', { type: 'date', value: r.validTo ?? '', 'aria-label': 'Bis' });
  const body = h('div', {}, field('Name', name), field('Was soll eingeschoben werden?', media, 'Ein Bild, ein Video oder eine Folie. Ein Video läuft immer zu Ende.'),
    h('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, h('span', {}, 'Alle'), every, h('span', {}, 'Minuten für'), secs, h('span', {}, 'Sekunden')), h('p', { class: 'hint' }, 'Der Einschub darf höchstens die Hälfte der Zeit belegen. Er wird zwischen zwei Elementen eingeschoben, danach geht die Liste dort weiter, wo sie war.'),
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, field('Wo?', scope), targetField), h('details', {}, h('summary', {}, 'Nur in einem Zeitraum (optional)'), h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, field('Von', from), field('Bis', to))),
    h('label', { class: 'row', for: 'ins-on' }, on, h('b', {}, ' Einschub ist eingeschaltet')));
  dialog(ins ? 'Einschub ändern' : 'Neuer Einschub', body, [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => {
    if (!media.value) { toast('Bitte wähle, was gezeigt werden soll.', 'err'); return false; }
    const payload = { name: name.value, mediaId: media.value, everyMin: Number(every.value), seconds: Number(secs.value), scope: scope.value, ...(scope.value === 'all' ? {} : { targetId: target.value }), enabled: on.checked, validFrom: from.value, validTo: to.value };
    try { ins ? await put(`/inserts/${ins.id}`, payload) : await post('/inserts', payload); toast('Gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

export async function einschuebePage({ route }) {
  const l = await get('/inserts'), write = can('schedules.write'), edit = (x) => editor(x, route).catch((e) => toast(e.message, 'err'));
  const root = h('div', {}, h('h1', {}, 'Einschübe'), h('p', { class: 'lead' }, 'Eine Folie erscheint regelmäßig zwischendurch, zum Beispiel „alle 5 Minuten das Sponsor-Logo für 10 Sekunden“ – ohne sie in jede Abspielliste einzeln einzubauen.'), h('p', { class: 'hint' }, l.hint));
  if (write) root.append(h('p', {}, h('button', { class: 'btn', onclick: () => edit(null) }, '＋ Neuer Einschub')));
  root.append(l.inserts.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' }, l.inserts.map((i) => { const [cls, icon, label] = STATUS[i.status] ?? ['', '', i.status];
    return h('article', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, i.name), h('span', { class: 'sp' }), h('span', { class: 'status ' + cls }, h('span', { 'aria-hidden': 'true' }, icon), label)),
      h('p', {}, h('b', {}, `„${i.media.name ?? '(gelöscht)'}“`), ` alle ${i.everyMin} Minuten für ${i.seconds} Sekunden auf ${i.targetName}`), (i.validFrom || i.validTo) ? h('p', { class: 'hint' }, `Zeitraum: ${i.validFrom ? 'ab ' + dmy(i.validFrom) : ''} ${i.validTo ? 'bis ' + dmy(i.validTo) : ''}`) : null,
      h('p', { class: 'hint' }, i.statusText), i.oldScreens ? h('p', { class: 'notice' }, `▲ ${i.oldScreens} von ${i.screens} Bildschirmen haben noch eine ältere Version und zeigen diesen Einschub erst nach dem Update (ab 0.2.26).`) : null,
      write ? h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, h('button', { class: 'btn sec', onclick: () => edit(i) }, 'Ändern'),
        h('button', { class: 'btn sec', onclick: async (e) => { e.currentTarget.disabled = true; try { await put(`/inserts/${i.id}`, { name: i.name, mediaId: i.media.id, everyMin: i.everyMin, seconds: i.seconds, scope: i.scope, ...(i.scope === 'all' ? {} : { targetId: i.targetId }), enabled: !i.enabled, validFrom: i.validFrom ?? '', validTo: i.validTo ?? '' }); } catch (er) { toast(er.message, 'err'); } route(); } }, i.enabled ? 'Ausschalten' : 'Einschalten'),
        h('button', { class: 'btn link', onclick: async () => { if (await confirmDlg('Einschub löschen?', `„${i.name}“ wird gelöscht. Die Folie selbst bleibt in der Bibliothek.`, 'Ja, löschen')) { try { await del(`/inserts/${i.id}`); toast('Gelöscht.'); } catch (er) { toast(er.message, 'err'); } route(); } } }, 'Löschen')) : null); }))
    : empty('Noch kein Einschub', 'Lege einen an, zum Beispiel für ein Sponsor-Logo oder einen Hinweis „Bitte Ticket bereithalten“.'));
  return root;
}
