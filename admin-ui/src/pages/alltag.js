// Alltagshilfen: Frage-&-Antwort-Folien, Aufräumen (unbenutzte Medien) und ein Foto vom Handy direkt auf den Bildschirmen zeigen.
import { h, dialog, confirmDlg, toast, field, fmtBytes } from '../ui.js';
import { api, get, post, del } from '../api.js';
import { waitUntilReady } from './praesentation.js';

const DURS = [['15', '15 Minuten'], ['30', '30 Minuten'], ['60', '1 Stunde'], ['120', '2 Stunden'], ['eod', 'bis Tagesende']];
const durBody = (v) => (v === 'eod' ? { endOfDay: true } : { minutes: Number(v) });

/** Frage & Antwort: zwei Folien (blau mit „?“, grün), die man in einer Abspielliste hintereinander legt */
export function quizDlg(route) {
  const q = h('input', { maxlength: 120, placeholder: 'Wer schoss das Tor im Wunder von Bern?', 'aria-label': 'Frage' }), a = h('input', { maxlength: 300, placeholder: 'Helmut Rahn', 'aria-label': 'Antwort' });
  const pq = h('div', { class: 'quizprev frage' }), pa = h('div', { class: 'quizprev antwort' });
  const upd = () => { pq.replaceChildren(h('b', {}, '? ' + (q.value || 'Hier steht die Frage'))); pa.replaceChildren(h('small', {}, 'Antwort'), h('b', {}, a.value || 'Hier steht die Antwort')); };
  [q, a].forEach((x) => x.addEventListener('input', upd)); upd();
  dialog('❓ Frage & Antwort', h('div', {}, h('p', { class: 'hint' }, 'Es entstehen zwei Folien im Ordner „Quiz“. Lege sie in einer Abspielliste hintereinander: erst die Frage (zum Beispiel 20 Sekunden), dann die Antwort (10 Sekunden).'),
    field('Frage', q), field('Antwort', a), h('div', { class: 'quizrow' }, pq, pa)),
  [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Folien anlegen', fn: async () => {
    if (!q.value.trim() || !a.value.trim()) { toast('Bitte gib eine Frage und eine Antwort ein.', 'err'); return false; }
    try { await post('/media/quiz', { question: q.value, answer: a.value }); toast('Die Folien „Frage“ und „Antwort“ liegen jetzt im Ordner „Quiz“.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

const ago = (m) => (m.ageDays < 1 ? 'heute hochgeladen' : m.ageDays === 1 ? 'seit gestern' : `seit ${m.ageDays} Tagen`);

/** Aufräumen: Medien, die in keiner Liste, keinem Termin, keiner Szene und keiner App mehr vorkommen */
export async function cleanupDlg(route) {
  const r = await get('/media/unused');
  if (!r.items.length) { dialog('🧹 Aufräumen', h('p', {}, '✔ Alles aufgeräumt. Jedes Bild, Video und jede Folie wird irgendwo benutzt.'), [{ text: 'Schließen', cls: 'sec' }]); return; }
  const sum = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const rows = r.items.map((m) => ({ m, c: h('input', { type: 'checkbox', checked: !m.recent, 'aria-label': `„${m.name}“ löschen` }) }));
  const upd = () => { const sel = rows.filter(({ c }) => c.checked), bytes = sel.reduce((s, { m }) => s + m.size, 0); sum.textContent = sel.length ? `${sel.length} ausgewählt${bytes ? ` (${fmtBytes(bytes)} Speicher)` : ''}.` : 'Nichts ausgewählt.'; };
  rows.forEach(({ c }) => c.addEventListener('change', upd)); upd();
  const kind = { image: 'Bild', video: 'Video', text: 'Text', pdfpage: 'PDF-Seite' };
  dialog('🧹 Aufräumen', h('div', {}, h('p', {}, `Diese ${r.items.length} Dateien kommen in keiner Abspielliste, keinem Termin, keiner Szene und keiner App mehr vor. Gelöschtes bleibt 30 Tage im Papierkorb.`),
    h('p', { class: 'hint' }, 'Frisch hochgeladene Dateien sind nicht vorausgewählt: Vielleicht legst du sie gleich noch in eine Liste.'),
    h('ul', { class: 'cleanlist' }, rows.map(({ m, c }) => h('li', {}, h('label', {}, c, ' ', h('b', {}, m.name)), h('span', { class: 'hint' }, ` ${kind[m.kind] ?? ''}${m.size && m.kind !== 'text' ? ' · ' + fmtBytes(m.size) : ''}${m.folder ? ' · Ordner ' + m.folder : ''} · ${ago(m)}`), m.expired ? h('span', { class: 'status warn' }, ' ⏰ abgelaufen') : null))), sum),
  [{ text: 'Schließen', cls: 'sec' }, { text: 'Ausgewählte löschen', cls: 'danger', fn: async () => {
    const sel = rows.filter(({ c }) => c.checked).map(({ m }) => m); if (!sel.length) { toast('Nichts ausgewählt.', 'err'); return false; }
    if (!(await confirmDlg('Wirklich löschen?', `${sel.length} Dateien kommen in den Papierkorb. Dort kannst du sie 30 Tage lang zurückholen.`, 'In den Papierkorb'))) return false;
    let ok = 0, skipped = 0; for (const m of sel) { try { await del(`/media/${m.id}`); ok++; } catch { skipped++; } } // 409 = inzwischen doch benutzt: bleibt stehen
    toast(`${ok} Dateien liegen jetzt im Papierkorb.${skipped ? ` ${skipped} wurden übersprungen, weil sie inzwischen benutzt werden.` : ''}`); route(); } }]);
}

/** Foto vom Handy: aufnehmen oder auswählen → hochladen → sofort auf einem/allen Bildschirmen zeigen (übersteuert den Plan zeitweise) */
export async function photoDialog(route) {
  const devices = (await get('/devices')).filter((d) => d.status.level !== 'pending');
  if (!devices.length) { toast('Es ist noch kein Bildschirm verbunden.', 'err'); return; }
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Foto aufnehmen oder auswählen' });
  const dur = h('select', { 'aria-label': 'Wie lange zeigen' }, DURS.map(([k, t]) => h('option', { value: k, selected: k === '30' ? '' : null }, t)));
  const target = h('select', { 'aria-label': 'Auf welchen Bildschirmen' }, h('option', { value: 'all' }, 'Auf ALLEN Bildschirmen'), devices.map((d) => h('option', { value: d.id }, d.name)));
  const status = h('p', { role: 'status', 'aria-live': 'polite', class: 'hint' }, ''), prev = h('div', { class: 'photoprev' }); let url = null;
  file.addEventListener('change', () => { if (url) URL.revokeObjectURL(url); const f = file.files?.[0]; url = f ? URL.createObjectURL(f) : null; prev.replaceChildren(url ? h('img', { src: url, alt: 'Vorschau des Fotos' }) : null); });
  const d = dialog('📷 Foto vom Handy zeigen', h('div', {}, h('p', { class: 'hint' }, 'Foto aufnehmen oder aus der Galerie wählen. Es erscheint sofort auf den Bildschirmen und springt danach automatisch zum normalen Plan zurück.'),
    field('Foto', file), prev, field('Wie lange zeigen?', dur), field('Wo zeigen?', target),
    h('p', { class: 'hint' }, 'Das Foto bleibt im Ordner „Handy-Fotos“ unter „Bilder & Videos“. Mit „🧹 Aufräumen“ wirfst du es später wieder weg. Meldet der Hub „Format nicht unterstützt“ (iPhone), stelle in den Kamera-Einstellungen „Formate → Kompatibelste“ ein.'), status),
  [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Hochladen und zeigen', cls: 'danger', fn: async (dlg) => {
    const f = file.files?.[0]; if (!f) { toast('Bitte wähle zuerst ein Foto aus.', 'err'); return false; }
    const lock = (v) => { for (const b of dlg.querySelectorAll('button')) b.disabled = v; };
    try {
      lock(true); status.textContent = 'Foto wird hochgeladen …';
      const fd = new FormData(); fd.append('folder', 'Handy-Fotos'); fd.append('file', f); const up = await api('POST', '/media', fd);
      const ok = await waitUntilReady(up.ids, () => { status.textContent = 'Foto wird für die Bildschirme vorbereitet …'; }, { everyMs: 1000, maxMs: 120000 });
      if (!ok) toast('Das Foto ist noch nicht für alle Bildschirme fertig und erscheint nach und nach.', 'err');
      const r = await post('/overrides', { scope: target.value === 'all' ? 'all' : 'device', ...(target.value === 'all' ? {} : { targetId: target.value }), content: { type: 'media', id: up.ids[0] }, confirm: true, ...durBody(dur.value) });
      toast(r.text); route();
    } catch (e) { toast(e.message, 'err'); lock(false); status.textContent = ''; return false; } } }]);
  d.addEventListener('close', () => { if (url) URL.revokeObjectURL(url); });
}
