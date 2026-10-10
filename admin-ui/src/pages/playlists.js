import { h, dialog, confirmDlg, toast, field, empty } from '../ui.js';
import { get, post, put, del, can } from '../api.js';
import { icon } from '../icons.js';

export async function playlistsPage({ route }) {
  const [all, media, dr] = await Promise.all([get('/playlists'), get('/media'), get('/drafts')]); const canPub = dr.canPublish;
  // Entwurf einer veröffentlichten Liste wird bei dieser angezeigt; eigenständige Entwürfe als eigene Karte
  const draftFor = Object.fromEntries(all.filter((p) => p.draftOf).map((p) => [p.draftOf, p])); const lists = all.filter((p) => !p.draftOf); const byId = Object.fromEntries(media.map((m) => [m.id, m])); const includable = lists.filter((p) => p.state === 'published');
  const dur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const cards = lists.map((p) => {
    const cur = draftFor[p.id] ?? p, hasDraft = p.state === 'draft' || !!draftFor[p.id], shown = cur.items.slice(0, 6), more = cur.items.length - shown.length;
    const publish = async () => { try { await post(`/playlists/${cur.id}/publish`); toast('Veröffentlicht. Die Bildschirme bekommen die Liste gleich.'); route(); } catch (e) { toast(e.message, 'err'); } };
    const discard = async () => { await post(`/playlists/${cur.id}/discard`); route(); };
    const remove = async () => { try { await del(`/playlists/${p.id}`); toast(`„${p.name}“ liegt im Papierkorb.`); route(); } catch (e) { if (e.data?.needsConfirm && await confirmDlg('Abspielliste löschen?', e.message, 'Löschen')) { await del(`/playlists/${p.id}?force=1`); route(); } else toast(e.message, 'err'); } };
    return h('article', { class: 'card listcard' + (hasDraft ? ' is-warn' : '') },
      h('div', { class: 'cardhead' }, h('h2', {}, p.name), p.isDefault ? h('span', { class: 'status ok' }, '✔ Standard') : null, p.state === 'draft' ? h('span', { class: 'status warn' }, '✎ Entwurf') : draftFor[p.id] ? h('span', { class: 'status warn' }, '✎ Änderungen als Entwurf') : null),
      h('div', { class: 'cardmeta' }, h('span', { class: 'metachip' }, icon('list'), `${cur.items.length} ${cur.items.length === 1 ? 'Element' : 'Elemente'}`), cur.items.length ? h('span', { class: 'metachip' }, icon('clock'), `Runde ${dur(cur.durationS)} Min.`) : null),
      p.isDefault ? h('p', { class: 'hint', style: 'margin:0 0 8px' }, 'Diese Liste läuft, wenn kein Termin etwas anderes festlegt.') : null,
      cur.items.length ? h('ul', { class: 'listitems' }, shown.map((i) => h('li', {}, h('span', { class: 't' }, i.playlistId ? `📂 Liste „${i.listName ?? '(gelöscht)'}“` : byId[i.mediaId]?.name ?? '(gelöscht)'), i.playlistId ? null : h('span', { class: 'd' }, `${i.duration} s`))), more > 0 ? h('li', { class: 'more' }, `… und ${more} weitere`) : null)
        : h('p', { class: 'hint' }, 'Diese Liste ist noch leer. Klicke auf „Bearbeiten“ und füge Bilder oder Videos hinzu.'),
      can('playlists.write') ? h('div', { class: 'cardactions' }, h('button', { class: 'btn', onclick: () => edit(cur, media, route, p.id, canPub, includable) }, '📝 Bearbeiten'), hasDraft && canPub ? h('button', { class: 'btn sec', onclick: publish }, '✔ Veröffentlichen') : null, h('span', { class: 'sp' }),
        hasDraft ? h('button', { class: 'btn link', onclick: discard }, '↩ Verwerfen') : null, p.isDefault ? null : h('button', { class: 'btn link', style: 'color:var(--dfm-bad)', onclick: remove }, '🗑 Löschen')) : null);
  });
  return h('div', {}, h('h1', {}, 'Abspiellisten'), h('p', { class: 'lead' }, 'Eine Abspielliste legt fest, welche Bilder und Videos nacheinander gezeigt werden. Du kannst auch ganze Listen ineinander einfügen (zum Beispiel „Ausstellung A“ in die Hauptliste).'),
    can('playlists.write') ? h('p', {}, h('button', { class: 'btn big', onclick: () => nameDlg(route) }, '➕ Neue Abspielliste')) : null, cards.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr))' }, cards) : empty('Noch keine Abspielliste', 'Eine Abspielliste ist eine Reihenfolge von Bildern, Videos und Texten.', can('playlists.write') ? h('button', { class: 'btn big', onclick: () => nameDlg(route) }, '➕ Neue Abspielliste') : null, '▶️'));
}
function nameDlg(route) {
  const n = h('input', { maxlength: 80 });
  dialog('Neue Abspielliste', field('Name, z. B. „Sommer-Aktion“', n), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Anlegen', fn: async () => { try { await post('/playlists', { name: n.value }); toast('Als Entwurf angelegt. Füge Inhalte hinzu und veröffentliche sie.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
function edit(p, media, route, origId, canPub, includable = []) {
  let items = p.items.map((i) => ({ ...i })), def = p.isDefault; const name = h('input', { value: p.name, maxlength: 80 }), box = h('div', {}); let dragFrom = null;
  const nameOf = (id) => media.find((m) => m.id === id)?.name ?? '(gelöscht)';
  const listName = (it) => it.listName ?? includable.find((x) => x.id === it.playlistId)?.name ?? '(gelöscht)';
  const others = includable.filter((x) => x.id !== origId);
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= items.length) return; [items[i], items[j]] = [items[j], items[i]]; draw(); };
  const draw = () => { box.replaceChildren(...(items.length ? items.map((it, i) => h('div', { class: 'dragitem', draggable: 'true', ondragstart: () => { dragFrom = i; }, ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); }, ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); if (dragFrom != null) { const [x] = items.splice(dragFrom, 1); items.splice(i, 0, x); dragFrom = null; draw(); } } },
    h('span', { class: 'handle', 'aria-hidden': 'true' }, '⠿'), h('span', { class: 'sp' }, it.playlistId ? `${i + 1}. 📂 Liste „${listName(it)}“` : `${i + 1}. ${nameOf(it.mediaId)}`),
    it.playlistId ? null : h('label', { class: 'hint', style: 'margin:0' }, 'Sekunden ', h('input', { class: 'inline', type: 'number', min: 1, max: 3600, value: it.duration, style: 'width:80px', 'aria-label': 'Dauer in Sekunden', onchange: (e) => { it.duration = Math.max(1, Number(e.target.value) || 10); } })),
    it.playlistId ? null : h('select', { class: 'inline', 'aria-label': 'Übergang', onchange: (e) => { it.transition = e.target.value; } }, h('option', { value: 'fade', selected: it.transition === 'fade' }, 'Überblenden'), h('option', { value: 'cut', selected: it.transition === 'cut' }, 'Harter Schnitt')),
    h('button', { class: 'btn sec', 'aria-label': 'Nach oben', onclick: () => move(i, -1) }, '↑'), h('button', { class: 'btn sec', 'aria-label': 'Nach unten', onclick: () => move(i, 1) }, '↓'), h('button', { class: 'btn sec', 'aria-label': 'Entfernen', onclick: () => { items.splice(i, 1); draw(); } }, '✕'),
    h('details', {}, h('summary', {}, 'Gültig von/bis'), h('label', {}, 'von ', h('input', { class: 'inline', type: 'date', value: it.validFrom ?? '', onchange: (e) => { it.validFrom = e.target.value || null; } })), h('label', {}, ' bis ', h('input', { class: 'inline', type: 'date', value: it.validTo ?? '', onchange: (e) => { it.validTo = e.target.value || null; } }))))) : [h('p', { class: 'hint' }, 'Noch nichts in der Liste. Füge unten etwas hinzu.')])); };
  const add = h('select', { 'aria-label': 'Medium hinzufügen', onchange: (e) => { if (e.target.value) { items.push({ mediaId: e.target.value, duration: 10, transition: 'fade' }); e.target.value = ''; draw(); } } }, h('option', { value: '' }, '➕ Bild, Video oder Text hinzufügen …'), media.map((m) => h('option', { value: m.id }, m.name)));
  const addList = others.length ? h('select', { 'aria-label': 'Liste einfügen', onchange: (e) => { if (e.target.value) { items.push({ playlistId: e.target.value, listName: others.find((x) => x.id === e.target.value)?.name }); e.target.value = ''; draw(); } } }, h('option', { value: '' }, '📂 Andere Abspielliste einfügen …'), others.map((x) => h('option', { value: x.id }, x.name))) : null;
  draw();
  dialog('Abspielliste bearbeiten', h('div', {}, field('Name', name), h('p', { class: 'hint' }, 'Ziehe die Einträge, um die Reihenfolge zu ändern – oder nutze die Pfeile.'), box, add, addList, h('label', {}, h('input', { type: 'checkbox', checked: def, onchange: (e) => { def = e.target.checked; } }), ' Als Standard-Abspielliste verwenden')),
    [{ text: 'Abbrechen', cls: 'sec' }, ...(canPub ? [{ text: 'Speichern und veröffentlichen', fn: async () => save(true) }] : []), { text: canPub ? 'Als Entwurf speichern' : 'Speichern', cls: canPub ? 'sec' : '', fn: async () => save(false) }]);
  async function save(publish) { try { await put(`/playlists/${p.id}`, { name: name.value, publish, ...(def ? { isDefault: true } : {}), items: items.map(({ mediaId, playlistId, duration, transition, validFrom, validTo }) => (playlistId ? { playlistId, validFrom: validFrom ?? null, validTo: validTo ?? null } : { mediaId, duration, transition, validFrom: validFrom ?? null, validTo: validTo ?? null })) }); toast(publish ? 'Veröffentlicht. Die Bildschirme bekommen die Änderung gleich.' : 'Als Entwurf gespeichert. Er läuft erst nach dem Veröffentlichen.'); route(); } catch (e) { toast(e.message, 'err'); return false; } }
}
