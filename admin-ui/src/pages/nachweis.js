// Betrieb → Wiedergabe: Wie oft und wie lange lief welches Medium auf welchem Bildschirm? (Nachweis z. B. für Sponsoren), mit CSV für Excel.
import { h, empty } from '../ui.js';
import { get } from '../api.js';

const berlin = (ms) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const hm = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${String(m % 60).padStart(2, '0')} Min.`; };
const KIND = { image: 'Bild', video: 'Video', text: 'Text', pdfpage: 'PDF-Seite' };
const TITLES = { media: ['Medium', 'Art'], device: ['Bildschirm'], day: ['Tag'] };

export async function playsView() {
  const now = Date.now(); let from = berlin(now - 29 * 86400000), to = berlin(now), group = 'media', deviceId = '';
  const first = await get('/reports/plays'); const fromIn = h('input', { type: 'date', value: from, 'aria-label': 'Von' }), toIn = h('input', { type: 'date', value: to, 'aria-label': 'Bis' });
  const grp = h('select', { 'aria-label': 'Gruppieren' }, [['media', 'Nach Medium'], ['device', 'Nach Bildschirm'], ['day', 'Nach Tag']].map(([k, t]) => h('option', { value: k }, t)));
  const dev = h('select', { 'aria-label': 'Bildschirm' }, h('option', { value: '' }, 'Alle Bildschirme'), first.devices.map((d) => h('option', { value: d.id }, d.name)));
  const csv = h('a', { class: 'btn sec', href: '#', download: '' }, '⬇️ CSV für Excel'), out = h('div', {});
  const qs = () => `from=${from}&to=${to}&group=${group}${deviceId ? '&deviceId=' + deviceId : ''}`;
  const load = async () => {
    from = fromIn.value || from; to = toIn.value || to; group = grp.value; deviceId = dev.value; csv.href = `/api/v1/reports/plays.csv?${qs()}`;
    let r; try { r = await get('/reports/plays?' + qs()); } catch (e) { out.replaceChildren(h('div', { class: 'notice bad' }, e.message)); return; }
    if (!r.rows.length) { out.replaceChildren(empty('Keine Zahlen für diesen Zeitraum', 'Die Bildschirme melden ihre Zähler alle 5 Minuten an den Hub. Seit der Einführung dieser Funktion (Version 0.2.23) wird mitgezählt. Frühere Zeiträume sind leer.')); return; }
    const first2 = TITLES[r.group];
    out.replaceChildren(h('p', {}, h('b', {}, `${r.totals.plays.toLocaleString('de-DE')} Einblendungen`), `, zusammen ${hm(r.totals.seconds)} Laufzeit (${r.from.split('-').reverse().join('.')} bis ${r.to.split('-').reverse().join('.')})`),
      h('table', {}, h('thead', {}, h('tr', {}, [...first2, 'Einblendungen', 'Laufzeit', r.group === 'day' ? 'Bildschirme' : r.group === 'media' ? 'Bildschirme' : ''].filter((x, i, a) => x || i < a.length - 1).map((x) => h('th', {}, x)))),
        h('tbody', {}, r.rows.map((x) => h('tr', {}, r.group === 'media' ? [h('td', {}, x.name, x.removed ? h('span', { class: 'hint' }, ' (nicht mehr in der Bibliothek)') : null), h('td', {}, KIND[x.kind] ?? x.kind)] : r.group === 'device' ? h('td', {}, x.name) : h('td', {}, x.day.split('-').reverse().join('.')),
          h('td', {}, x.plays.toLocaleString('de-DE')), h('td', {}, hm(x.seconds)), r.group === 'device' ? null : h('td', {}, String(x.devices)))))), h('p', { class: 'hint' }, r.hint));
  };
  const preset = (label, f, t) => h('button', { class: 'chip', onclick: () => { fromIn.value = f; toIn.value = t; load(); } }, label);
  const d = new Date(), y = d.getFullYear(), m = d.getMonth(), pad = (n) => String(n).padStart(2, '0'), lastDay = new Date(y, m, 0).getDate();
  const bar = h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px' }, preset('Letzte 7 Tage', berlin(now - 6 * 86400000), berlin(now)), preset('Letzte 30 Tage', berlin(now - 29 * 86400000), berlin(now)), preset('Dieser Monat', `${y}-${pad(m + 1)}-01`, berlin(now)), preset('Letzter Monat', `${m === 0 ? y - 1 : y}-${pad(m === 0 ? 12 : m)}-01`, `${m === 0 ? y - 1 : y}-${pad(m === 0 ? 12 : m)}-${pad(lastDay)}`));
  const ctl = h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px' }, h('label', {}, 'Von '), fromIn, h('label', {}, 'bis '), toIn, grp, dev, h('button', { class: 'btn', onclick: load }, 'Anzeigen'), csv);
  [grp, dev].forEach((x) => x.addEventListener('change', load));
  const root = h('div', {}, h('p', { class: 'hint' }, 'Zeigt, wie oft jedes Bild, Video und jede Folie auf den Bildschirmen lief. Es werden nur Zähler gespeichert, keine Besucherdaten.'), bar, ctl, out); await load(); return root;
}
