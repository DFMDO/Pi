import { h, dialog, confirmDlg, toast, field, empty, fmtBytes } from '../ui.js';
import { get, post, patch, del, api, state, can } from '../api.js';
import { templateDlg, qrDlg, importDlg } from './tools.js';
import { quizDlg, cleanupDlg } from './alltag.js';
import { icon } from '../icons.js';

const KIND = { image: 'Bild', video: 'Video', text: 'Text', pdfpage: 'PDF-Seite' };
export async function mediaPage({ route }) {
  const [items, storage] = await Promise.all([get('/media'), get('/system/storage').catch(() => null)]);
  if (location.hash.includes('text=1')) { history.replaceState(null, '', '#/medien'); setTimeout(() => textDlg(route), 50); }
  const search = h('input', { type: 'search', placeholder: 'Suchen …', 'aria-label': 'Medien suchen', oninput: () => draw() });
  const grid = h('div', { class: 'mediaGrid' });
  const draw = () => { const q = search.value.toLowerCase(); grid.replaceChildren(...items.filter((m) => !q || m.name.toLowerCase().includes(q) || m.folder.toLowerCase().includes(q) || m.tags.join(' ').includes(q)).map(card)); };
  const KIND_ICON = { image: 'image', video: 'video', text: 'edit', pdfpage: 'file' };
  const card = (m) => {
    const live = !!m.stream, pending = m.variants.some((v) => v.status === 'pending' || v.status === 'running'), failed = m.variants.some((v) => v.status === 'failed');
    return h('div', { class: 'card mediaCard' },
      h('div', { class: 'shot' }, thumb(m), h('span', { class: 'kindbadge' + (m.expired ? ' bad' : '') }, icon(live ? 'video' : KIND_ICON[m.kind] ?? 'image'), m.expired ? 'Abgelaufen' : live ? 'Live-Bild' : KIND[m.kind])),
      h('div', { class: 'mbody' }, h('b', { class: 'mname' }, m.name),
        [m.size ? fmtBytes(m.size) : null, m.folder || null].some(Boolean) ? h('div', { class: 'hint' }, [m.size ? fmtBytes(m.size) : null, m.folder || null].filter(Boolean).join(' · ')) : null,
        live ? h('div', { class: 'hint' }, m.text?.stream?.url ?? '') : null,
        m.expired ? h('div', { class: 'notice bad' }, '⛔ Abgelaufen – wird nicht mehr gezeigt') : m.validUntil ? h('div', { class: 'hint' }, `Gültig bis ${m.validUntil.split('-').reverse().join('.')}${m.license ? ' · ' + m.license : ''}`) : null,
        ...m.hints.map((t) => h('div', { class: 'hint warn' }, 'ℹ ' + t)), failed ? h('div', { class: 'hint bad' }, '⚠ Dieses Medium konnte nicht für alle Bildschirme vorbereitet werden.') : null,
        pending ? h('div', { class: 'hint' }, '⏳ Wird für die Bildschirme vorbereitet …') : null),
      can('media.write') ? h('div', { class: 'mfoot' }, h('button', { class: 'btn link', title: 'Umbenennen, Urheber, Lizenz und Gültigkeit', onclick: () => rename(m, route) }, '📝 Bearbeiten'), live ? h('button', { class: 'btn link', onclick: () => streamAddr(m, route) }, '🔗 Adresse') : null,
        h('span', { class: 'sp' }), h('button', { class: 'btn link iconbtn', 'aria-label': 'Löschen', title: 'Löschen', style: 'color:var(--dfm-bad)', onclick: () => remove(m, route) }, '🗑')) : null);
  };
  draw();
  return h('div', {}, h('h1', {}, 'Bilder & Videos'), h('p', { class: 'lead' }, 'Lade Bilder, Videos oder PDFs hoch und lege Text-Ankündigungen an. Danach kannst du sie in Abspiellisten und Termine einbauen.'),
    storage?.warn ? h('div', { class: 'notice' }, '⚠ ' + storage.text) : null,
    can('media.write') ? h('div', { class: 'toolbar' },
      h('div', { class: 'tgroup' }, h('span', { class: 'tlabel' }, 'Hochladen'), h('div', { class: 'tbtns' }, h('button', { class: 'btn big', 'data-tour': 'upload', onclick: () => uploadDlg(route) }, '⬆️ Bild oder Video hochladen'))),
      h('div', { class: 'tgroup' }, h('span', { class: 'tlabel' }, 'Neu erstellen'), h('div', { class: 'tbtns' }, h('button', { class: 'btn sec', onclick: () => textDlg(route) }, '📝 Text-Ankündigung erstellen'), h('button', { class: 'btn sec', onclick: () => templateDlg(route) }, '🧩 Vorlage verwenden'),
        h('button', { class: 'btn sec', onclick: () => quizDlg(route) }, '❓ Frage & Antwort'), h('button', { class: 'btn sec', onclick: () => qrDlg(route) }, '🔳 QR-Code erstellen'), h('button', { class: 'btn sec', onclick: () => streamDlg(route) }, '📹 Live-Bild (Kamera)'))),
      h('div', { class: 'tgroup' }, h('span', { class: 'tlabel' }, 'Verwalten'), h('div', { class: 'tbtns' }, can('import.run') ? h('button', { class: 'btn sec', onclick: () => importDlg(route) }, '📁 Ordner / USB-Stick importieren') : null, h('button', { class: 'btn sec', onclick: () => cleanupDlg(route) }, '🧹 Aufräumen')))) : null,
    h('div', { class: 'searchbox' }, icon('search'), search),
    items.length ? grid : empty('Noch nichts hochgeladen', 'Lade dein erstes Bild hoch. Erlaubt sind Bilder (JPG, PNG, WebP), Videos (MP4, MOV, MKV) und PDF.', can('media.write') ? h('button', { class: 'btn big', onclick: () => uploadDlg(route) }, '⬆️ Bild oder Video hochladen') : null, '🖼️'),
    trashSection(route));
}
const thumb = (m) => (m.stream ? h('div', { class: 'textthumb t-hinweis' }, m.text?.title ?? m.name, h('small', {}, 'Kamerabild – wird live gezeigt'))
  : m.kind === 'text' ? h('div', { class: 'textthumb t-' + (m.text?.template ?? 'standard') }, m.text?.title ?? m.name, m.text?.body ? h('small', {}, m.text.body) : null)
  : m.kind === 'video' ? h('div', { class: 'shotempty' }, '🎞️', h('span', {}, 'Video'))
  : h('img', { alt: m.name, loading: 'lazy', src: `/api/v1/media/${m.id}/file`, onerror: (e) => e.target.replaceWith(h('div', { class: 'shotempty' }, '⏳', h('span', {}, 'Wird vorbereitet …'))) }));
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
/** Live-Bild: Kamera oder Stream im eigenen Netz als Folie – nur auf Bildschirmen mit „Video-optimiert“ */
function streamDlg(route) {
  const name = h('input', { maxlength: 100, placeholder: 'z. B. Kamera Eingang' }), url = h('input', { maxlength: 300, placeholder: 'rtsp://192.168.1.50/stream1', 'aria-label': 'Adresse des Live-Bilds', autocomplete: 'off' }), title = h('input', { maxlength: 120 }), body = h('textarea', { maxlength: 300, rows: 2 });
  dialog('📹 Live-Bild anlegen', h('div', {}, h('p', { class: 'notice' }, 'Das Live-Bild läuft nur auf Bildschirmen mit der Wiedergabe „Video-optimiert“ (Bildschirm bearbeiten → Wiedergabe). Andere Bildschirme überspringen es. Erlaubt sind nur Geräte im Museumsnetz.'),
    field('Name (nur für dich)', name), field('Adresse der Kamera oder des Streams', url, 'Sie steht in der Anleitung der Kamera. Am sichersten ist die IP-Adresse der Kamera (zum Beispiel 192.168.1.50). Wenn Benutzer und Passwort nötig sind, stehen sie vor dem @ in der Adresse; sie werden nie angezeigt, aber an die Bildschirme gesendet – bitte ein Konto nur mit Leserechten verwenden.'),
    field('Ersatzfolie: Überschrift', title, 'Wird gezeigt, wenn das Live-Bild nicht ankommt. Leer lassen = der Name.'), field('Ersatzfolie: Text', body)),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await post('/media/stream', { name: name.value, url: url.value, ...(title.value ? { title: title.value } : {}), ...(body.value ? { body: body.value } : {}) }); toast('Das Live-Bild wurde gespeichert. Du findest es unter „Bilder & Videos“ und kannst es in Abspiellisten einbauen.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
function streamAddr(m, route) {
  const url = h('input', { maxlength: 300, placeholder: 'rtsp://192.168.1.50/stream1', 'aria-label': 'Neue Adresse', autocomplete: 'off' });
  dialog('Adresse des Live-Bilds ändern', h('div', {}, h('p', { class: 'hint' }, `Bisher: ${m.text?.stream?.url ?? '–'}`), field('Neue Adresse', url)),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await patch(`/media/${m.id}/stream`, { url: url.value }); toast('Die Adresse wurde geändert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
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
