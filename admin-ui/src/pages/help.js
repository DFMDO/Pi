// Anleitung in der Oberfläche: durchsuchbare Kapitel (help-content.js), Rundgang „Zeig mir, wie das geht“ und der Link „Anleitung zu dieser Seite“ (main.js).
// Alles ohne Internet. Texte werden nie als HTML eingefügt: **fett** wird beim Anzeigen in <b> umgewandelt.
import { h, $ } from '../ui.js';
import { CATEGORIES, CHAPTERS, searchChapters } from './help-content.js';

/** „**fett**“ → <b>; alles andere bleibt Text */
const rich = (s) => String(s).split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((p) => (p.startsWith('**') ? h('b', {}, p.slice(2, -2)) : p));

function chapter(c, open) {
  const body = h('div', { class: 'cbody' },
    ...(c.text ?? []).map((t) => h('p', {}, ...rich(t))),
    c.steps?.length ? h('ol', { class: 'howto' }, c.steps.map((s) => h('li', {}, ...rich(s)))) : null,
    ...(c.tips ?? []).map((t) => h('div', { class: 'callout' }, h('span', { class: 'ci', 'aria-hidden': 'true' }, '💡'), h('p', {}, ...rich(t)))),
    ...(c.warns ?? []).map((t) => h('div', { class: 'callout warn', role: 'note' }, h('span', { class: 'ci', 'aria-hidden': 'true' }, '⚠️'), h('p', {}, ...rich(t)))),
    c.terms ? h('dl', { class: 'terms' }, c.terms.flatMap(([a, b]) => [h('dt', {}, a), h('dd', {}, b)])) : null,
    c.open?.length ? h('div', { class: 'actions' }, c.open.map(([href, label]) => h('a', { class: 'btn sec', href }, label))) : null);
  return h('details', { class: 'card chapter', id: 'h-' + c.id, open: open ? '' : null },
    h('summary', {}, h('span', { class: 'cicon', 'aria-hidden': 'true' }, c.icon), h('span', { class: 'ctitle' }, h('b', {}, c.title), h('span', {}, c.intro))), body);
}

export async function helpPage(_ctx = {}, { openId = null } = {}) {
  let cat = 'alle', query = '';
  const list = h('div', {}), cats = h('div', { class: 'chips helpcats', role: 'group', 'aria-label': 'Themen' });
  const search = h('input', { type: 'search', placeholder: 'Wonach suchst du? (zum Beispiel „Regen“, „Passwort“, „Video“)', 'aria-label': 'In der Anleitung suchen', autocomplete: 'off' });
  const draw = () => {
    cats.replaceChildren(...[['alle', '📚', 'Alles'], ...CATEGORIES].map(([k, i, t]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': cat === k, onclick: () => { cat = k; draw(); } }, `${i} ${t}`)));
    const hits = searchChapters(query).filter((c) => cat === 'alle' || c.cat === cat), searching = query.trim().length > 1;
    if (!hits.length) { list.replaceChildren(h('div', { class: 'card nohits' }, h('h2', {}, 'Dazu habe ich nichts gefunden'), h('p', {}, 'Versuche ein anderes Wort oder wähle oben „Alles“. Ein kurzes Stichwort wie „Video“ oder „Passwort“ funktioniert am besten.'))); return; }
    const parts = [];
    for (const [k, i, t] of CATEGORIES) {
      const mine = hits.filter((c) => c.cat === k); if (!mine.length) continue;
      parts.push(h('div', { class: 'helpcat', role: 'heading', 'aria-level': '2' }, `${i} ${t}`), ...mine.map((c) => chapter(c, c.id === openId || (searching && hits.length <= 3))));
    }
    list.replaceChildren(...parts);
  };
  search.addEventListener('input', () => { query = search.value; draw(); });
  draw();
  const quick = h('div', { class: 'helpquick' },
    h('button', { class: 'quick', type: 'button', onclick: startTour }, h('span', { class: 'qi', 'aria-hidden': 'true' }, '▶'), h('span', { class: 'qt' }, h('b', {}, 'Rundgang starten'), h('span', { class: 'hint' }, 'Zeigt dir Schritt für Schritt die wichtigsten Bereiche'))),
    h('a', { class: 'quick', href: '#/hilfe/erster-inhalt', style: 'text-decoration:none' }, h('span', { class: 'qi', 'aria-hidden': 'true' }, '✨'), h('span', { class: 'qt' }, h('b', {}, 'Das erste Bild zeigen'), h('span', { class: 'hint' }, 'In 5 Minuten von der Datei auf den Bildschirm'))),
    h('a', { class: 'quick', href: '#/hilfe/p-schwarz', style: 'text-decoration:none' }, h('span', { class: 'qi', 'aria-hidden': 'true' }, '🆘'), h('span', { class: 'qt' }, h('b', {}, 'Bildschirm schwarz?'), h('span', { class: 'hint' }, 'So findest du die Ursache'))));
  const root = h('div', {}, h('h1', {}, 'Anleitung & Hilfe'), h('p', { class: 'lead' }, 'Alles Wichtige in einfachen Worten – ohne Internet. Suche ein Stichwort oder öffne ein Thema. Auf jeder Seite führt dich der Link „Anleitung zu dieser Seite“ direkt zum passenden Kapitel.'),
    h('div', { class: 'helphead' }, h('div', { class: 'helpsearch' }, search)), quick, cats, list,
    h('h2', {}, 'Browser-Warnung: so geht es sicher'), h('img', { src: '/browser-warnung.svg', alt: 'Schematisch: Erweitert wählen, weiter zum Hub, Fingerabdruck vergleichen', style: 'width:100%;max-width:880px;border-radius:14px' }));
  if (openId) setTimeout(() => { const el = document.getElementById('h-' + openId); if (el) { el.open = true; el.scrollIntoView({ block: 'start', behavior: 'instant' }); } }, 60);
  return root;
}

/** Rundgang: hebt nacheinander Bereiche der Seitenleiste hervor und erklärt sie (Bereiche, die es für dich nicht gibt, werden übersprungen) */
export function startTour() {
  const all = [['[data-tour="#/"]', 'Auf der **Startseite** siehst du alle Bildschirme, Hinweise und die Schnellaktionen – inklusive der Notfall-Meldung.'], ['[data-tour="#/live"]', 'Unter **Live** siehst du, was gerade auf jedem Bildschirm läuft.'], ['[data-tour="#/medien"]', 'Hier lädst du **Bilder und Videos** hoch und erstellst Text-Ankündigungen, QR-Codes und Quiz-Folien.'], ['[data-tour="#/listen"]', 'In **Abspiellisten** legst du fest, in welcher Reihenfolge und wie lange etwas gezeigt wird.'], ['[data-tour="#/kalender"]', 'Im **Kalender** planst du, was wann auf welchem Bildschirm läuft.'], ['[data-tour="#/regeln"]', 'Mit **Regeln** wechselt der Inhalt von selbst – bei Regen, am Spieltag oder samstags.'], ['[data-tour="#/apps"]', 'Die **Apps** liefern fertige, sich selbst aktualisierende Folien: Wetter, Programm, Spielstand.'], ['[data-tour="#/bildschirme"]', 'Hier **verwaltest** du die Bildschirme und verbindest neue.'], ['[data-tour="#/betrieb"]', 'Unter **Betrieb** siehst du Gesundheit, Prognose, Pflege und Berichte.'], ['[data-tour="#/hilfe"]', 'Und hier ist die **Anleitung** mit Suche – jederzeit, auch ohne Internet.']];
  const steps = all.filter(([sel]) => $(sel));
  if (!steps.length) return;
  let i = 0, hl = null; const veil = h('div', { class: 'tour' }), box = h('div', { class: 'tourbox', role: 'dialog', 'aria-label': 'Rundgang' });
  const end = () => { hl?.classList.remove('tourhl'); veil.remove(); box.remove(); };
  const show = () => { hl?.classList.remove('tourhl'); const [sel, text] = steps[i]; hl = $(sel); hl?.classList.add('tourhl'); hl?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    box.replaceChildren(h('p', {}, h('b', {}, `Schritt ${i + 1} von ${steps.length}`)), h('p', {}, ...rich(text)), h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: end }, 'Beenden'), h('span', { class: 'sp' }), i ? h('button', { class: 'btn sec', onclick: () => { i--; show(); } }, 'Zurück') : null, h('button', { class: 'btn', onclick: () => { if (++i >= steps.length) end(); else show(); } }, i === steps.length - 1 ? 'Fertig' : 'Weiter'))); box.querySelector('.btn:last-child')?.focus(); };
  document.body.append(veil, box); show();
}
