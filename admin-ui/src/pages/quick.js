// Schnellaktionen und Szenen (Z.2): sofortige Aktionen mit eigener Bestätigung, laufen nicht über den Entwurfsmodus.
import { h, dialog, confirmDlg, toast, field } from '../ui.js';
import { get, post, del, put, can } from '../api.js';
import { presentationDialog } from './praesentation.js';

const DURS = [['30', '30 Minuten'], ['60', '1 Stunde'], ['120', '2 Stunden'], ['eod', 'bis Tagesende']];
const durBody = (v) => (v === 'eod' ? { endOfDay: true } : { minutes: Number(v) });
async function contentSelect() {
  const [pl, md] = await Promise.all([get('/playlists'), get('/media')]);
  return h('select', { 'aria-label': 'Inhalt' }, pl.filter((x) => x.state === 'published' && !x.draftOf).map((p) => h('option', { value: 'playlist:' + p.id }, 'Abspielliste: ' + p.name)), md.map((m) => h('option', { value: 'media:' + m.id }, `${m.kind === 'video' ? 'Video' : m.kind === 'text' ? 'Text' : 'Bild'}: ${m.name}`)));
}
const parse = (v) => { const [type, ...id] = v.split(':'); return { type, id: id.join(':') }; };

export async function quickActions(route) {
  const [ov, scenes, devices] = await Promise.all([get('/overrides'), get('/scenes'), get('/devices')]);
  const box = h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { style: 'margin-top:0' }, 'Schnellaktionen'));
  for (const o of ov) box.append(h('div', { class: 'notice' }, '⚡ ', o.text, ' ', h('button', { class: 'btn link', onclick: async () => { await del(`/overrides/${o.id}`); toast('Zurück zum normalen Plan.'); route(); } }, 'Zurück zum normalen Plan')));
  box.append(h('div', { class: 'row' },
    h('button', { class: 'btn big', onclick: async () => { const c = await contentSelect(); const d = h('select', { 'aria-label': 'Dauer' }, DURS.map(([k, t]) => h('option', { value: k }, t)));
      dialog('Jetzt auf allen Bildschirmen zeigen', h('div', {}, h('p', { class: 'notice' }, 'Das übersteuert alle Termine und Szenen auf ALLEN Bildschirmen. Danach springen sie automatisch zum normalen Plan zurück.'), field('Was soll laufen?', c), field('Wie lange?', d)),
        [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Auf allen Bildschirmen zeigen', cls: 'danger', fn: async () => { try { const r = await post('/overrides', { scope: 'all', content: parse(c.value), confirm: true, ...durBody(d.value) }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]); } }, '📢 Jetzt auf allen Bildschirmen zeigen'),
    h('button', { class: 'btn big sec', onclick: async () => { const c = await contentSelect(); const d = h('select', { 'aria-label': 'Dauer' }, DURS.map(([k, t]) => h('option', { value: k }, t)));
      const s = h('select', { 'aria-label': 'Bildschirm' }, devices.filter((x) => x.status.level !== 'pending').map((x) => h('option', { value: x.id }, x.name)));
      dialog('Auf einem Bildschirm zeigen', h('div', {}, field('Bildschirm', s), field('Was soll laufen?', c), field('Wie lange?', d)), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Zeigen', fn: async () => { try { const r = await post('/overrides', { scope: 'device', targetId: s.value, content: parse(c.value), ...durBody(d.value) }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]); } }, '🖥️ Auf einem Bildschirm zeigen'),
    can('media.write') && can('playlists.write') ? h('button', { class: 'btn big sec', onclick: () => presentationDialog(route) }, '📑 Präsentation zeigen (PowerPoint)') : null));
  const pub = scenes.filter((s) => s.state === 'published');
  if (pub.length) box.append(h('h3', {}, 'Szenen'), h('div', { class: 'row' }, pub.map((s) => s.active
    ? h('button', { class: 'btn', onclick: async () => { await post(`/scenes/${s.id}/stop`); toast(`Szene „${s.name}“ beendet.`); route(); } }, `⏹ ${s.name} beenden`)
    : h('button', { class: 'btn sec', onclick: async () => { const d = h('select', { 'aria-label': 'Dauer' }, DURS.map(([k, t]) => h('option', { value: k }, t)));
        dialog(`Szene „${s.name}“ starten`, h('div', {}, h('p', {}, `Die Szene übernimmt ${s.items.length} Bildschirm(e) bzw. Gruppen:`), h('ul', {}, s.items.map((i) => h('li', {}, `${i.targetName}: ${i.contentName}`))), field('Wie lange?', d)),
          [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Szene starten', fn: async () => { try { const r = await post(`/scenes/${s.id}/start`, { confirm: true, ...durBody(d.value) }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]); } }, `▶ ${s.name}`))));
  return box;
}

/** Szenen verwalten (Entwurf/Veröffentlichen wie bei Terminen) */
export async function scenesPage({ route }) {
  const [scenes, devices, groups, drafts] = await Promise.all([get('/scenes'), get('/devices'), get('/groups'), get('/drafts')]);
  const cards = scenes.map((s) => h('article', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, s.name), s.state === 'draft' ? h('span', { class: 'status warn' }, '✎ Entwurf') : h('span', { class: 'status ok' }, '✔ Veröffentlicht'), h('span', { class: 'sp' }),
    can('scenes.write') ? [h('button', { class: 'btn', onclick: () => edit(s) }, 'Bearbeiten'), s.state === 'draft' && drafts.canPublish ? h('button', { class: 'btn', onclick: async () => { await post(`/scenes/${s.id}/publish`); toast('Veröffentlicht.'); route(); } }, 'Veröffentlichen') : null,
      h('button', { class: 'btn sec', onclick: async () => { if (await confirmDlg('Szene löschen?', `„${s.name}“ wird gelöscht.`, 'Löschen')) { await del(`/scenes/${s.id}`); route(); } } }, 'Löschen')] : null),
    h('ul', {}, s.items.map((i) => h('li', {}, `${i.targetName}: ${i.contentName}`)))));
  async function edit(s) {
    const items = (s?.items ?? []).map((i) => ({ scope: i.scope, targetId: i.targetId, content: i.content })); const name = h('input', { value: s?.name ?? '', maxlength: 80 }), box = h('div', {});
    const c = await contentSelect(), t = h('select', { 'aria-label': 'Ziel' }, h('option', { value: 'all:' }, 'Alle Bildschirme'), groups.map((g) => h('option', { value: 'group:' + g.id }, 'Gruppe: ' + g.name)), devices.filter((d) => d.status.level !== 'pending').map((d) => h('option', { value: 'device:' + d.id }, d.name)));
    const label = (i) => `${i.scope === 'all' ? 'Alle Bildschirme' : (i.scope === 'group' ? groups.find((g) => g.id === i.targetId)?.name : devices.find((d) => d.id === i.targetId)?.name) ?? '?'} → ${i.content.type === 'playlist' ? 'Liste' : 'Medium'}`;
    const draw = () => box.replaceChildren(...items.map((i, n) => h('div', { class: 'row' }, h('span', { class: 'sp' }, label(i)), h('button', { class: 'btn sec', 'aria-label': 'Entfernen', onclick: () => { items.splice(n, 1); draw(); } }, '✕'))), items.length ? null : h('p', { class: 'hint' }, 'Noch keine Zeile.'));
    draw();
    dialog(s ? 'Szene bearbeiten' : 'Neue Szene', h('div', {}, field('Name, z. B. „Eröffnung“', name), box, h('div', { class: 'row' }, t, c, h('button', { class: 'btn sec', type: 'button', onclick: () => { const [scope, ...id] = t.value.split(':'); items.push({ scope, targetId: scope === 'all' ? undefined : id.join(':'), content: parse(c.value) }); draw(); } }, '➕ Zeile hinzufügen'))),
      [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Als Entwurf speichern', cls: drafts.canPublish ? 'sec' : '', fn: async () => save(false) }, ...(drafts.canPublish ? [{ text: 'Speichern und veröffentlichen', fn: async () => save(true) }] : [])]);
    async function save(publish) { try { const b = { name: name.value, items, publish }; if (s) await put(`/scenes/${s.id}`, b); else await post('/scenes', b); toast(publish ? 'Szene veröffentlicht.' : 'Als Entwurf gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } }
  }
  return h('div', {}, h('h1', {}, 'Szenen'), h('p', { class: 'lead' }, 'Eine Szene legt für mehrere Bildschirme fest, was läuft – zum Beispiel für die Eröffnung oder einen Schulklassen-Tag. Mit einem Klick starten, mit einem Klick beenden.'),
    can('scenes.write') ? h('p', {}, h('button', { class: 'btn big', onclick: () => edit(null) }, '➕ Neue Szene')) : null, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr))' }, cards.length ? cards : [h('p', {}, 'Es gibt noch keine Szenen.')]));
}
