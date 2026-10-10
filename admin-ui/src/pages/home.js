import { h, statusEl, empty, fmtDate, fmtBytes } from '../ui.js';
import { get, post, state, can } from '../api.js';
import { pairDialog } from './devices.js';
import { quickActions } from './quick.js';
import { photoDialog } from './alltag.js';
import { importDlg } from './tools.js';
import { usbUpdateBox } from './usbupdate.js';

/** Vorschaubild (Screenshot) eines Bildschirms; wenn keins da ist, ein ruhiger Platzhalter */
export const shot = (d) => { const box = h('div', { class: 'shot' }, 'Noch keine Vorschau'); if (d.status.level === 'ok') { const i = h('img', { alt: `Vorschau von ${d.name}`, src: `/api/v1/devices/${d.id}/screenshot?t=${Date.now() >> 14}` }); i.onload = () => box.replaceChildren(i); } return box; };

/** Kachel auf der Startseite: Symbol in einer Plakette, Titel und Erklärung */
const tile = (icon, title, desc, onclick, cls = 'quick', extra = {}) => h('button', { class: cls, onclick, ...extra }, h('span', { class: 'qi', 'aria-hidden': 'true' }, icon), h('span', { class: 'qt' }, h('b', {}, title), h('span', { class: 'hint' }, desc)));

/** Hinweise: bis zu vier sofort, bei mehr die übrigen hinter einem Knopf (die Startseite bleibt übersichtlich) */
function notices(list) {
  const mk = (t) => h('div', { class: 'notice', role: 'status' }, '⚠ ', t); if (list.length <= 4) return list.map(mk);
  const rest = h('div', { hidden: '' }, list.slice(3).map(mk)), label = (open) => (open ? 'Weniger anzeigen' : `Weitere ${list.length - 3} Hinweise anzeigen`);
  const btn = h('button', { class: 'btn sec', type: 'button', 'aria-expanded': false, onclick: () => { rest.hidden = !rest.hidden; btn.setAttribute('aria-expanded', String(!rest.hidden)); btn.textContent = label(!rest.hidden); } }, label(false));
  return [...list.slice(0, 3).map(mk), rest, btn];
}

export async function homePage({ route }) {
  const [devices, warnings, storage, sched, playlists, drafts, memory, prog] = await Promise.all([get('/devices'), get('/warnings'), get('/system/storage').catch(() => null), get('/schedules'), get('/playlists'), get('/drafts'), get('/system/memory').catch(() => null), get('/prognose?nurProbleme=1').catch(() => null)]);
  if (location.hash.startsWith('#/foto')) { history.replaceState(null, '', '#/'); if (can('media.write') && can('overrides.write')) setTimeout(() => photoDialog(route), 50); } // Lesezeichen auf dem Handy: „#/foto“ öffnet gleich das Foto-Fenster
  const active = devices.filter((d) => d.status.level !== 'pending'), pending =devices.filter((d) => d.status.level === 'pending');
  const quick = [['🖼️', 'Bild oder Video anzeigen', 'Datei hochladen und auf einem Bildschirm zeigen', '#/medien'], ['📝', 'Text-Ankündigung anzeigen', 'Aus einer DFM-Vorlage erstellen', '#/medien?text=1'], ['📅', 'Für einen bestimmten Tag planen', 'Zeitraum und Bildschirm wählen', '#/kalender']];
  const issues = [...warnings.map((w) => w.text), ...active.filter((d) => d.status.level === 'warn' || d.status.level === 'bad').map((d) => d.status.level === 'warn' ? `${d.name} hat gerade keine Verbindung. Der Bildschirm zeigt weiter die zuletzt geladenen Inhalte.` : `${d.name} ist nicht erreichbar. Bitte Strom und WLAN prüfen.`), storage?.warn ? storage.text : null, memory?.warn ? memory.text : null, ...(prog?.items ?? []).map((i) => `Vorhersage für „${i.name}“ (${i.title}): ${i.text} – Mehr unter Betrieb → Prognose.`)].filter(Boolean);
  return h('div', {}, h('h1', {}, 'Startseite'), h('p', { class: 'lead' }, 'Hier siehst du, ob alle Bildschirme laufen und was gerade gezeigt wird.'),
    can('overrides.write') ? await quickActions(route) : null,
    h('div', { class: 'grid', style: 'margin-bottom:16px' }, ...(can('media.write') ? quick.map(([i, t, d, href]) => tile(i, t, d, () => { location.hash = href; })) : []),
      can('media.write') && can('overrides.write') ? tile('📷', 'Foto vom Handy zeigen', 'Foto aufnehmen oder wählen und sofort zeigen', () => photoDialog(route)) : null,
      can('devices.manage') ? tile('➕', 'Neuen Bildschirm verbinden', 'Zeigt einen Code für den neuen Bildschirm', () => pairDialog(route), 'quick main', { 'data-tour': 'pair' }) : null),
    pending.length ? h('div', { class: 'notice' }, h('b', {}, '⏳ Ein neuer Bildschirm wartet auf dich. '), pending.map((d) => `„${d.name}“ (${d.model ?? 'unbekanntes Gerät'})`).join(', '), ' – ', h('a', { href: '#/bildschirme' }, 'Jetzt bestätigen')) : null,
    drafts.schedules + drafts.playlists ? h('div', { class: 'notice' }, `✎ ${drafts.schedules + drafts.playlists} Entwürfe warten auf Veröffentlichung. `, h('a', { href: '#/kalender' }, 'Zum Kalender'), ' · ', h('a', { href: '#/listen' }, 'Zu den Abspiellisten')) : null,
    await clockNotice(), await usbNotice(route), await usbUpdateBox({ onlyNewer: true }),
    ...notices(issues),
    h('h2', {}, 'Meine Bildschirme'),
    active.length ? h('div', { class: 'grid' }, active.map((d) => h('article', { class: 'card devcard' }, shot(d), h('div', { class: 'devbody' }, h('div', { class: 'row' }, h('h3', {}, d.name), h('span', { class: 'sp' }), statusEl(d.status)), h('p', {}, d.summary), h('p', { class: 'hint', style: 'margin:0' }, d.lastSeen ? `Letzte Meldung: ${fmtDate(d.lastSeen)}` : 'Noch keine Meldung'))))) : empty('Noch kein Bildschirm verbunden', 'Verbinde deinen ersten Bildschirm. Das dauert nur wenige Minuten.', can('devices.manage') ? h('button', { class: 'btn big', onclick: () => pairDialog(route) }, 'Neuen Bildschirm verbinden') : null),
    h('h2', {}, 'Was läuft heute?'), await today(devices, sched),
    storage ? h('p', { class: 'hint', style: 'margin-top:24px' }, `Speicher: ${storage.usedPercent} % belegt (${fmtBytes(storage.mediaBytes)} Medien)`) : null);
}
async function today(devices, sched) {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0'), day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ev = await get(`/calendar?from=${day}&to=${day}`); const names = Object.fromEntries(devices.map((x) => [x.id, x.name]));
  if (!ev.length) return h('p', {}, 'Heute sind keine besonderen Termine geplant. Es läuft die Standard-Abspielliste.');
  return h('ul', {}, ev.sort((a, b) => a.start - b.start).map((e) => h('li', {}, `${new Date(e.start).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr: ${names[e.targetId] ?? 'Gruppe'}`)));
}

/** Steckt ein USB-Stick am Hub? Dann bietet die Startseite an, die Inhalte anzusehen und zu übernehmen (nichts passiert ohne Bestätigung). */
async function usbNotice(route) {
  if (!can('import.run')) return null;
  try {
    const u = await get('/import/usb'); if (!u.present) return null;
    return h('div', { class: 'notice ok', role: 'status' }, h('b', {}, '🔌 USB-Stick erkannt. '), `${u.entries === 1 ? 'Darauf liegt 1 Eintrag (eine Datei oder ein Ordner).' : `Darauf liegen ${u.entries} Einträge (Dateien oder Ordner).`} Der Stick wird nur gelesen. `, h('button', { class: 'btn', onclick: () => importDlg(route, { path: u.path }) }, 'Inhalte ansehen und übernehmen'));
  } catch { return null; }
}

/** Der Hub hat keine Batterieuhr: Weicht seine Uhr von diesem Computer ab, bietet die Seite den Abgleich an. */
async function clockNotice() {
  try {
    const { now } = await get('/system/time'); const diff = Math.abs(now - Date.now());
    if (diff < 120000) return null;
    return h('div', { class: 'notice bad', role: 'alert' }, h('b', {}, '🕒 Die Uhr des Hubs geht falsch. '), 'Termine starten dadurch zur falschen Zeit. ',
      can('settings.manage') ? h('button', { class: 'btn', onclick: async (e) => { e.target.disabled = true; await post('/system/time', { epoch: Date.now() }); location.reload(); } }, 'Uhr mit diesem Computer abgleichen') : 'Bitte einen Admin informieren.');
  } catch { return null; }
}
