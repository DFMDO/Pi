import { h, statusEl, empty, fmtDate, fmtBytes } from '../ui.js';
import { get, state, can } from '../api.js';
import { pairDialog } from './devices.js';

/** Vorschaubild (Screenshot) eines Bildschirms; wenn keins da ist, ein ruhiger Platzhalter */
export const shot = (d) => { const box = h('div', { class: 'shot' }, 'Noch keine Vorschau'); if (d.status.level === 'ok') { const i = h('img', { alt: `Vorschau von ${d.name}`, src: `/api/v1/devices/${d.id}/screenshot?t=${Date.now() >> 14}` }); i.onload = () => box.replaceChildren(i); } return box; };

export async function homePage({ route }) {
  const [devices, warnings, storage, sched, playlists] = await Promise.all([get('/devices'), get('/warnings'), get('/system/storage').catch(() => null), get('/schedules'), get('/playlists')]);
  const active = devices.filter((d) => d.status.level !== 'pending'), pending = devices.filter((d) => d.status.level === 'pending');
  const quick = [['🖼️', 'Bild oder Video anzeigen', 'Datei hochladen und auf einem Bildschirm zeigen', '#/medien'], ['📝', 'Text-Ankündigung anzeigen', 'Aus einer DFM-Vorlage erstellen', '#/medien?text=1'], ['📅', 'Für einen bestimmten Tag planen', 'Zeitraum und Bildschirm wählen', '#/kalender']];
  const issues = [...warnings.map((w) => w.text), ...active.filter((d) => d.status.level === 'warn' || d.status.level === 'bad').map((d) => d.status.level === 'warn' ? `${d.name} hat gerade keine Verbindung. Der Bildschirm zeigt weiter die zuletzt geladenen Inhalte.` : `${d.name} ist nicht erreichbar. Bitte Strom und WLAN prüfen.`), storage?.warn ? storage.text : null].filter(Boolean);
  return h('div', {}, h('h1', {}, 'Startseite'), h('p', { class: 'lead' }, 'Hier siehst du, ob alle Bildschirme laufen und was gerade gezeigt wird.'),
    h('div', { class: 'grid', style: 'margin-bottom:16px' }, ...(can('media.write') ? quick.map(([i, t, d, href]) => h('button', { class: 'quick', onclick: () => { location.hash = href; } }, h('b', {}, `${i} ${t}`), h('span', { class: 'hint' }, d))) : []),
      can('devices.manage') ? h('button', { class: 'quick main', 'data-tour': 'pair', onclick: () => pairDialog(route) }, h('b', {}, '➕ Neuen Bildschirm verbinden'), h('span', {}, 'Zeigt einen Code für den neuen Bildschirm')) : null),
    pending.length ? h('div', { class: 'notice' }, h('b', {}, '⏳ Ein neuer Bildschirm wartet auf dich. '), pending.map((d) => `„${d.name}“ (${d.model ?? 'unbekanntes Gerät'})`).join(', '), ' – ', h('a', { href: '#/bildschirme' }, 'Jetzt bestätigen')) : null,
    ...issues.map((t) => h('div', { class: 'notice', role: 'status' }, '⚠ ', t)),
    h('h2', {}, 'Meine Bildschirme'),
    active.length ? h('div', { class: 'grid' }, active.map((d) => h('article', { class: 'card' }, h('h3', { style: 'margin:0 0 4px' }, d.name), statusEl(d.status), h('p', {}, d.summary), shot(d), h('p', { class: 'hint' }, d.lastSeen ? `Letzte Meldung: ${fmtDate(d.lastSeen)}` : 'Noch keine Meldung')))) : empty('Noch kein Bildschirm verbunden', 'Verbinde deinen ersten Bildschirm. Das dauert nur wenige Minuten.', can('devices.manage') ? h('button', { class: 'btn big', onclick: () => pairDialog(route) }, 'Neuen Bildschirm verbinden') : null),
    h('h2', {}, 'Was läuft heute?'), await today(devices, sched),
    storage ? h('p', { class: 'hint', style: 'margin-top:24px' }, `Speicher: ${storage.usedPercent} % belegt (${fmtBytes(storage.mediaBytes)} Medien)`) : null);
}
async function today(devices, sched) {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0'), day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ev = await get(`/calendar?from=${day}&to=${day}`); const names = Object.fromEntries(devices.map((x) => [x.id, x.name]));
  if (!ev.length) return h('p', {}, 'Heute sind keine besonderen Termine geplant. Es läuft die Standard-Abspielliste.');
  return h('ul', {}, ev.sort((a, b) => a.start - b.start).map((e) => h('li', {}, `${new Date(e.start).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr: ${names[e.targetId] ?? 'Gruppe'}`)));
}
