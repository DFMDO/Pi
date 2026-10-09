import { h, dialog, confirmDlg, toast, field, empty, fmtBytes } from '../ui.js';
import { get, post, patch, del, api, state, can } from '../api.js';
import { templateDlg, qrDlg, importDlg } from './tools.js';
import { quizDlg, cleanupDlg } from './alltag.js';

const KIND = { image: 'Bild', video: 'Video', text: 'Text', pdfpage: 'PDF-Seite' };
export async function mediaPage({ route }) {
  const [items, storage] = await Promise.all([get('/media'), get('/system/storage').catch(() => null)]);
  if (location.hash.includes('text=1')) { history.replaceState(null, '', '#/medien'); setTimeout(() => textDlg(route), 50); }
  const search = h('input', { type: 'search', placeholder: 'Suchen …', 'aria-label': 'Medien suchen', oninput: () => draw() });
  const grid = h('div', { class: 'mediaGrid' });
  const draw = () => { const q = search.value.toLowerCase(); grid.replaceChildren(...items.filter((m) => !q || m.name.toLowerCase().includes(q) || m.folder.toLowerCase().includes(q) || m.tags.join(' ').includes(q)).map(card)); };
  const card = (m) => h('div', { class: 'card mediaCard' }, h('div', { class: 'shot' }, thumb(m)), h('b', {}, m.name), h('div', { class: 'hint' }, `${KIND[m.kind]}${m.size ? ' · ' + fmtBytes(m.size) : ''}${m.folder ? ' · ' + m.folder : ''}`),
    m.expired ? h('div', { class: 'notice bad' }, '⛔ Abgelaufen – wird nicht mehr gezeigt') : m.validUntil ? h('div', { class: 'hint' }, `Gültig bis ${m.validUntil.split('-').reverse().join('.')}${m.license ? ' · ' + m.license : ''}`) : null,
    ...m.hints.map((t) => h('div', { class: 'hint warn' }, 'ℹ ' + t)), ...m.variants.filter((v) => v.status === 'failed').map((v) => h('div', { class: 'hint bad' }, '⚠ Dieses Medium konnte nicht für alle Bildschirme vorbereitet werden.')),
    m.variants.some((v) => v.status === 'pending' || v.status === 'running') ? h('div', { class: 'hint' }, '⏳ Wird für die Bildschirme vorbereitet …') : null,
    can('media.write') ? h('div', { class: 'row' }, h('button', { class: 'btn link', onclick: () => rename(m, route) }, 'Umbenennen & Lizenz'), h('button', { class: 'btn link', style: 'color:var(--dfm-bad)', onclick: () => remove(m, route) }, 'Löschen')) : null);
  draw();
  return h('div', {}, h('h1', {}, 'Bilder & Videos'), h('p', { class: 'lead' }, 'Lade Bilder, Videos oder PDFs hoch und lege Text-Ankündigungen an. Danach kannst du sie in Abspiellisten und Termine einbauen.'),
    storage?.warn ? h('div', { class: 'notice' }, '⚠ ' + storage.text) : null,
    can('media.write') ? h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn big', 'data-tour': 'upload', onclick: () => uploadDlg(route) }, '⬆️ Bild oder Video hochladen'), h('button', { class: 'btn sec', onclick: () => templateDlg(route) }, '🧩 Vorlage verwenden'), h('button', { class: 'btn sec', onclick: () => qrDlg(route) }, '🔳 QR-Code erstellen'), can('import.run') ? h('button', { class: 'btn sec', onclick: () => importDlg(route) }, '📁 Ordner / USB-Stick importieren') : null, h('button', { class: 'btn sec', onclick: () => textDlg(route) }, '📝 Text-Ankündigung erstellen'), h('button', { class: 'btn sec', onclick: () => quizDlg(route) }, '❓ Frage & Antwort'), h('button', { class: 'btn sec', onclick: () => cleanupDlg(route) }, '🧹 Aufräumen'), h('span', { class: 'sp' }), search) : search,
    items.length ? grid : empty('Noch nichts hochgeladen', 'Lade dein erstes Bild hoch. Erlaubt sind Bilder (JPG, PNG, WebP), Videos (MP4, MOV, MKV) und PDF.', can('media.write') ? h('button', { class: 'btn big', onclick: () => uploadDlg(route) }, 'Bild oder Video hochladen') : null),
    trashSection(route));
}
const thumb = (m) => (m.kind === 'text' ? h('div', { style: 'padding:8px;font-weight:700' }, m.text?.title ?? m.name) : m.kind === 'video' ? h('span', {}, '🎬 Video') : h('img', { alt: m.name, loading: 'lazy', src: `/api/v1/media/${m.id}/file`, onerror: (e) => e.target.replaceWith(document.createTextNode('Wird vorbereitet …')) }));
function uploadDlg(route) {
  const f = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/x-matroska,application/pdf' }), list = h('div', {}), folder = h('input', { placeholder: 'z. B. Sommer-Aktion', maxlength: 60 });
  const d = dialog('Bild oder Video hochladen', h('div', {}, h('p', {}, 'Wähle eine oder mehrere Dateien aus. Du kannst die Dateien auch hierher ziehen.'), f, field('Ordner (optional)', folder), list), [{ text: 'Schließen', cls: 'sec', fn: () => route() }]);
  const send = async (file) => {
    const row = h('p', {}, `⏳ ${file.name} …`); list.append(row); const fd = new FormData(); fd.append('folder', folder.value); fd.append('file', file);
    try { const r = await api('POST', '/media', fd); row.textContent = `✔ ${file.name} wurde hochgeladen und wird für die Bildschirme vorbereitet.`; r.items.forEach((m) => m.hints.forEach((t) => list.append(h('p', { class: 'hint' }, 'ℹ ' + t)))); }
    catch (e) { row.textContent = `✖ ${file.name}: ${e.message}`; row.className = 'bad'; }
  };
  f.onchange = () => [...f.files].forEach(send); d.addEventListener('dragover', (e) => e.preventDefault()); d.addEventListener('drop', (e) => { e.preventDefault(); [...e.dataTransfer.files].forEach(send); });
}
function textDlg(route) {
  const name = h('input', { maxlength: 100 }), title = h('input', { maxlength: 120 }), body = h('textarea', { maxlength: 1000 }), tpl = h('select', {}, h('option', { value: 'standard' }, 'Dunkel mit rotem Streifen'), h('option', { value: 'hinweis' }, 'Hinweis (gelb)'), h('option', { value: 'highlight' }, 'Highlight (rot)'));
  const prev = h('div', { class: 'shot', style: 'margin-top:8px' }, 'Vorschau'); const upd = () => { prev.replaceChildren(h('div', { style: `padding:12px;text-align:left;width:100%;height:100%;${{ standard: 'background:#1a1a1a;color:#fff;border-left:10px solid #c8102e', hinweis: 'background:#f2a900;color:#1a1a1a', highlight: 'background:#c8102e;color:#fff' }[tpl.value]}` }, h('b', { style: 'font-size:1.2rem' }, title.value || 'Überschrift'), h('div', {}, body.value))); };
  [title, body, tpl].forEach((x) => x.addEventListener('input', upd)); upd();
  dialog('Text-Ankündigung erstellen', h('div', {}, field('Name (nur für dich)', name, 'So findest du die Ankündigung später wieder.'), field('Überschrift', title), field('Text', body), field('Aussehen', tpl), prev),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await post('/media/text', { name: name.value || title.value, title: title.value, body: body.value, template: tpl.value }); toast('Die Ankündigung wurde gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
function rename(m, route) {
  const n = h('input', { value: m.name, maxlength: 100 }), au = h('input', { value: m.author ?? '', maxlength: 120, placeholder: 'z. B. Foto: Max Mustermann' }), li = h('input', { value: m.license ?? '', maxlength: 200, placeholder: 'z. B. CC BY 4.0, Agenturvertrag' }), vu = h('input', { type: 'date', value: m.validUntil ?? '' });
  dialog('Umbenennen und Lizenz', h('div', {}, field('Neuer Name', n), field('Urheber', au), field('Lizenz', li), field('Gültig bis', vu, 'Zwei Wochen vorher gibt es eine Warnung. Nach diesem Tag wird das Medium automatisch nicht mehr gezeigt – auch auf Bildschirmen ohne Verbindung zum Hub.')),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await patch(`/media/${m.id}`, { name: n.value, author: au.value || null, license: li.value || null, validUntil: vu.value || null }); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
async function remove(m, route) {
  try { await del(`/media/${m.id}`); toast(`„${m.name}“ liegt jetzt im Papierkorb.`, 'ok'); route(); }
  catch (e) { if (e.data?.needsConfirm && await confirmDlg(`„${m.name}“ löschen?`, e.message, 'Trotzdem löschen')) { await del(`/media/${m.id}?force=1`); toast('Gelöscht. Du findest es 30 Tage im Papierkorb.'); route(); } else if (!e.data?.needsConfirm) toast(e.message, 'err'); }
}
function trashSection(route) {
  const box = h('details', { style: 'margin-top:28px' }, h('summary', {}, 'Papierkorb (30 Tage)'));
  get('/trash').then((t) => box.append(t.length ? h('ul', {}, t.map((x) => h('li', {}, `${x.name} `, h('button', { class: 'btn link', onclick: async () => { await post(`/trash/${x.id}/restore`); toast('Wiederhergestellt.'); route(); } }, 'Wiederherstellen')))) : h('p', { class: 'hint' }, 'Der Papierkorb ist leer.')));
  return box;
}
