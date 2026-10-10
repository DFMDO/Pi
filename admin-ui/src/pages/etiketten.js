// Geräte-Etiketten zum Drucken: Name, Standort, kurze Nummer (wie beim „Diesen Bildschirm erkennen“) und ein QR-Code, der die Live-Ansicht dieses Bildschirms öffnet.
// Gedruckt wird über den Browser (Strg+P); der Rest der Seite wird dabei ausgeblendet.
import { h, dialog, field } from '../ui.js';
import { api } from '../api.js';

const SIZES = { klein: ['Klein: 21 Etiketten je A4-Seite (63,5 × 38,1 mm)', 'lab-s'], gross: ['Groß: 8 Etiketten je A4-Seite (99,1 × 67,7 mm)', 'lab-l'] };
const KEY = 'dfm-etikett-text';
const load = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const store = (v) => { try { localStorage.setItem(KEY, v); } catch {} };

export function labelsDlg(devices) {
  const list = devices.filter((d) => d.status.level !== 'pending' && d.status.label !== 'Gesperrt'), origin = location.origin;
  const boxes = list.map((d) => ({ d, c: h('input', { type: 'checkbox', checked: true, 'aria-label': d.name }) }));
  const size = h('select', { 'aria-label': 'Größe' }, Object.entries(SIZES).map(([k, [t]]) => h('option', { value: k }, t))), text = h('input', { maxlength: 60, value: load(), placeholder: 'zum Beispiel: Störung? Haustechnik: Tel. 123', 'aria-label': 'Zeile für Hinweise' });
  const sheet = h('div', { class: 'labels lab-s', 'aria-label': 'Vorschau der Etiketten' });
  async function draw() {
    store(text.value); sheet.className = 'labels ' + SIZES[size.value][1]; const nodes = [];
    for (const { d, c } of boxes) {
      if (!c.checked) continue;
      const qr = h('div', { class: 'lab-qr', role: 'img', 'aria-label': `QR-Code für ${d.name}` });
      try { qr.innerHTML = await api('POST', '/qr', { text: `${origin}/#/live/${d.id}` }, { raw: true }).then((x) => x.text()); } catch { qr.textContent = '(QR nicht verfügbar)'; } // SVG vom eigenen Hub, kein Nutzertext
      nodes.push(h('div', { class: 'lab' }, qr, h('div', { class: 'lab-txt' }, h('b', { class: 'lab-name' }, d.name), h('div', {}, [...new Set([d.groupName, d.location].filter(Boolean))].join(' · ') || ' '), h('div', { class: 'lab-nr' }, 'Nr. ' + d.id.slice(0, 4).toUpperCase()), h('div', { class: 'lab-small' }, d.model ?? ''), text.value ? h('div', { class: 'lab-small' }, text.value) : null)));
    }
    sheet.replaceChildren(...(nodes.length ? nodes : [h('p', { class: 'hint' }, 'Kein Bildschirm ausgewählt.')]));
  }
  [size, text].forEach((x) => x.addEventListener(x === text ? 'input' : 'change', draw)); boxes.forEach(({ c }) => c.addEventListener('change', draw));
  const controls = h('div', { class: 'noprint' }, h('p', { class: 'hint' }, 'Der QR-Code öffnet die Live-Ansicht des Bildschirms (nach der Anmeldung). Er enthält diese Adresse der Verwaltung: ', origin, '. Wenn die IT dem Hub später eine andere Adresse gibt, müssen die Etiketten neu gedruckt werden.'),
    h('div', { class: 'row', style: 'flex-wrap:wrap;gap:8px' }, ...boxes.map(({ d, c }) => h('label', { class: 'chip' }, c, ' ', d.name))), field('Größe', size), field('Zeile für Hinweise (optional)', text, 'Erscheint auf jedem Etikett. Wird in diesem Browser gemerkt.'));
  document.body.classList.add('print-labels');
  const d = dialog('🏷️ Etiketten drucken', h('div', {}, controls, sheet), [{ text: 'Schließen', cls: 'sec' }, { text: 'Drucken', fn: () => { window.print(); return false; } }]);
  d.addEventListener('close', () => document.body.classList.remove('print-labels')); draw(); return d;
}
