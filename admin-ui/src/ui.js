// Kleine UI-Helfer: Elemente bauen (nie innerHTML mit Fremdtext → kein XSS), Hinweise, Dialoge.
import './app.css';
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; /* per CSSOM: erlaubt unter strenger CSP */ else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v; else if (k === 'checked') e.checked = !!v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
export const $ = (sel, el = document) => el.querySelector(sel);
export function toast(msg, kind = 'ok', undo) {
  const t = h('div', { class: 'toast' + (kind === 'err' ? ' err' : ''), role: kind === 'err' ? 'alert' : 'status' }, msg, undo ? h('button', { class: 'btn link', style: 'color:#fff', onclick: () => { undo(); t.remove(); } }, 'Rückgängig') : null);
  document.getElementById('toasts').append(t); setTimeout(() => t.remove(), undo ? 9000 : 5000);
}
export function dialog(title, body, actions = []) {
  const d = h('dialog', { 'aria-labelledby': 'dlgt' }, h('h2', { id: 'dlgt', style: 'margin-top:0' }, title), body,
    h('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, actions.map((a) => h('button', { class: 'btn ' + (a.cls ?? ''), type: 'button', onclick: async () => { if (a.fn) { const r = await a.fn(d); if (r === false) return; } d.close(); } }, a.text))));
  d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
}
export const confirmDlg = (title, text, okText = 'Ja, ausführen', danger = true) => new Promise((res) => {
  let done = false; const fin = (v) => { done = true; res(v); };
  const d = dialog(title, h('p', {}, text), [{ text: 'Abbrechen', cls: 'sec', fn: () => fin(false) }, { text: okText, cls: danger ? 'danger' : '', fn: () => fin(true) }]);
  d.addEventListener('close', () => { if (!done) res(false); });
});
/** (?)-Hilfe an jedem Feld: kurze Erklärung zum Auf- und Zuklappen */
export function help(text) {
  let box = null;
  const b = h('button', { type: 'button', class: 'help', 'aria-label': 'Erklärung anzeigen', 'aria-expanded': 'false', onclick: () => {
    if (box) { box.remove(); box = null; b.setAttribute('aria-expanded', 'false'); return; }
    box = h('div', { class: 'helptext', role: 'note' }, text); b.closest('label, .field, div')?.after(box); b.setAttribute('aria-expanded', 'true'); } }, h('span', { 'aria-hidden': 'true' }, '?'));
  return b;
}
let fid = 0;
/** Beschriftung fest mit dem Feld verknüpft (Screenreader lesen den Text beim Eingabefeld vor) */
export function field(label, input, helpText) {
  const id = input?.id || `f${++fid}`; if (input?.setAttribute && !input.id) input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), helpText ? help(helpText) : null, input);
}
export const fmtDate = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
export const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
export const statusEl = (s) => h('span', { class: 'status ' + s.level }, h('span', { 'aria-hidden': 'true' }, s.icon), s.label); // Symbol + Text, nie nur Farbe
export const empty = (title, text, action) => h('div', { class: 'empty' }, h('h2', {}, title), h('p', {}, text), action);
