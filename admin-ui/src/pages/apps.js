// Apps: Wetter, Datum & Öffnungszeiten, Tagesprogramm (Event-Kalender), Nachrichten, Fußball-Spieltag.
// Der Hub holt die Daten und pflegt je App eine Textfolie; die Bildschirme zeigen nur die fertige Folie (auch ohne Internet).
import { h, toast, field, fmtDate } from '../ui.js';
import { get, put, post, can } from '../api.js';

const DAYS = [['mo', 'Montag'], ['di', 'Dienstag'], ['mi', 'Mittwoch'], ['do', 'Donnerstag'], ['fr', 'Freitag'], ['sa', 'Samstag'], ['so', 'Sonntag']];
const LEAGUES = [['bl1', 'Bundesliga'], ['bl2', '2. Bundesliga'], ['bl3', '3. Liga'], ['dfb', 'DFB-Pokal']];
const input = (v, attrs = {}) => h('input', { value: v ?? '', ...attrs });
const WHAT = {
  wetter: 'Es werden nur die Koordinaten des Ortes an den Deutschen Wetterdienst (über api.brightsky.dev) gesendet. Keine persönlichen Daten.',
  fussball: 'Es werden nur der Name der Liga und der aktuelle Spieltag abgefragt (api.openligadb.de). Keine persönlichen Daten.',
  tagesprogramm: 'Der Hub lädt die Kalender-Datei von der Adresse unten. Sie wird nur gelesen. Die Adresse bleibt geheim und wird anderen Benutzern nicht angezeigt.',
  rss: 'Der Hub lädt den Feed von der Adresse unten und zeigt nur die Überschriften.',
  datum: 'Diese App braucht kein Internet.',
  tagdaten: 'Diese App braucht kein Internet. Die Beispiele unten sind nur Vorschläge: Bitte prüfen, ändern und ergänzen.',
};

/** Pro App: Eingabefelder und eine Funktion, die die Eingaben als config liest */
function form(type, c) {
  switch (type) {
    case 'wetter': { const p = input(c.place, { maxlength: 60 }), la = input(c.lat, { inputmode: 'decimal' }), lo = input(c.lon, { inputmode: 'decimal' });
      return { nodes: [field('Ort (Anzeigename)', p), h('div', { class: 'row' }, field('Breitengrad', la, 'Dortmund: 51,5256'), field('Längengrad', lo, 'Dortmund: 7,4592'))], read: () => ({ place: p.value, lat: Number(String(la.value).replace(',', '.')), lon: Number(String(lo.value).replace(',', '.')) }) }; }
    case 'datum': { const ins = Object.fromEntries(DAYS.map(([k]) => [k, input(c.hours?.[k] ?? '', { placeholder: '10:00-18:00 oder leer = geschlossen', maxlength: 11 })])), closed = h('textarea', { rows: 3, placeholder: '2026-12-24\n2026-12-25' }, (c.closedDates ?? []).join('\n')), last = input(c.lastEntryMin ?? 60, { type: 'number', min: 0, max: 180 });
      return { nodes: [h('p', { class: 'hint' }, 'Öffnungszeiten je Wochentag („10:00-18:00“). Leer lassen heißt: an diesem Tag geschlossen.'), ...DAYS.map(([k, n]) => field(n, ins[k])), field('Geschlossene Tage (Datum JJJJ-MM-TT, ein Tag pro Zeile)', closed), field('Letzter Einlass: Minuten vor Schließung (0 = nicht anzeigen)', last)],
        read: () => ({ hours: Object.fromEntries(DAYS.map(([k]) => [k, ins[k].value.trim()])), closedDates: closed.value.split(/\s+/).filter(Boolean), lastEntryMin: Number(last.value) }) }; }
    case 'tagesprogramm': { const u = input(c.url, { placeholder: 'https://…/kalender.ics', autocomplete: 'off' }), t = input(c.title, { maxlength: 40 }), l = input(c.locationFilter, { maxlength: 60 }), m = input(c.maxEvents ?? 7, { type: 'number', min: 1, max: 9 });
      return { nodes: [field('Adresse des Kalenders (iCal / .ics)', u, 'Im Kalendersystem unter „Teilen“, „Abonnieren“ oder „iCal“ zu finden. Die Adresse endet oft auf .ics.'), field('Überschrift der Folie', t), field('Nur Veranstaltungen mit diesem Ort (leer = alle)', l, 'Zum Beispiel „Foyer“: Dann erscheint nur, was im Feld „Ort“ des Termins „Foyer“ enthält.'), field('Höchstens so viele Veranstaltungen', m)], read: () => ({ url: u.value.trim(), title: t.value, locationFilter: l.value, maxEvents: Number(m.value) }) }; }
    case 'tagdaten': { const t = h('textarea', { rows: 12, spellcheck: 'false' }, c.entries ?? '');
      return { nodes: [field('Eure Liste (ein Eintrag pro Zeile: 04.07.1954 Text)', t, 'Das Jahr ist optional (24.12. Text). Zeilen mit # am Anfang werden ignoriert.')], read: () => ({ entries: t.value }) }; }
    case 'rss': { const u = input(c.url, { placeholder: 'https://…/feed', autocomplete: 'off' }), t = input(c.title, { maxlength: 40 }), m = input(c.maxItems ?? 5, { type: 'number', min: 1, max: 8 });
      return { nodes: [field('Adresse des Feeds (RSS/Atom)', u), field('Überschrift der Folie', t), field('Höchstens so viele Meldungen', m)], read: () => ({ url: u.value.trim(), title: t.value, maxItems: Number(m.value) }) }; }
    case 'fussball': { const l = h('select', {}, LEAGUES.map(([k, n]) => h('option', { value: k, selected: k === c.league ? '' : null }, n))), f = input(c.favorite, { maxlength: 30 });
      return { nodes: [field('Liga', l), field('Dein Verein (wird mit ★ markiert)', f, 'Ein Teil des Namens genügt, zum Beispiel „Dortmund“.')], read: () => ({ league: l.value, favorite: f.value }) }; }
    default: return { nodes: [], read: () => ({}) };
  }
}

export async function appsPage({ route }) {
  const apps = await get('/apps'), admin = can('settings.manage');
  const root = h('div', {}, h('h1', {}, 'Apps'), h('p', { class: 'lead' }, 'Wetter, Öffnungszeiten, Veranstaltungen, Nachrichten und Fußball als fertige Folien. Der Hub holt die Daten; die Bildschirme zeigen nur die Folie und laufen auch ohne Internet weiter.'),
    admin ? null : h('div', { class: 'notice' }, 'Nur Admins können Apps einrichten. Du kannst hier ansehen, was läuft.'),
    h('p', { class: 'hint' }, 'So nutzt du eine App: Einschalten und speichern. Danach liegt die Folie „App: …“ unter „Bilder & Videos“ im Ordner „Apps“. Lege sie in eine Abspielliste. Sie aktualisiert sich selbst.'));
  root.append(h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' }, apps.map((a) => card(a, admin, route))));
  return root;
}

function card(a, admin, route) {
  const f = form(a.type, a.config), on = h('input', { type: 'checkbox', checked: a.enabled, disabled: admin ? null : '', id: `on-${a.type}` });
  const status = a.lastError ? h('span', { class: 'status warn' }, '▲ Fehler') : a.enabled ? h('span', { class: 'status ok' }, '✔ aktiv') : h('span', { class: 'status' }, '⏸ aus');
  const save = async (btn) => { btn.disabled = true; try { const r = await put(`/apps/${a.type}`, { enabled: on.checked, config: f.read() }); toast(r.ok === false ? `Gespeichert, aber der Abruf hat nicht geklappt: ${r.error}` : on.checked ? 'Gespeichert und aktualisiert.' : 'Gespeichert (aus).', r.ok === false ? 'err' : 'ok'); route(); } catch (e) { toast(e.message, 'err'); btn.disabled = false; } };
  const refresh = async (btn) => { btn.disabled = true; try { const r = await post(`/apps/${a.type}/run`); toast(r.ok ? (r.changed ? 'Aktualisiert.' : 'Aktuell, nichts geändert.') : `Der Abruf hat nicht geklappt: ${r.error}`, r.ok ? 'ok' : 'err'); route(); } catch (e) { toast(e.message, 'err'); btn.disabled = false; } };
  return h('article', { class: 'card appcard' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, `${a.icon} ${a.title}`), h('span', { class: 'sp' }), status),
    h('p', {}, a.desc), h('p', { class: 'hint' }, WHAT[a.type], a.hosts.length ? ` Verbindet sich mit: ${a.hosts.join(', ')}, etwa alle ${a.intervalMin} Minuten.` : ''),
    admin ? h('div', {}, h('label', { class: 'row', for: `on-${a.type}` }, on, h('b', {}, ' Diese App ist eingeschaltet')), ...f.nodes,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: (e) => save(e.currentTarget) }, 'Speichern'), a.enabled ? h('button', { class: 'btn sec', onclick: (e) => refresh(e.currentTarget) }, 'Jetzt aktualisieren') : null)) : null,
    a.lastError ? h('p', { class: 'notice bad', role: 'alert' }, '✖ ', a.lastError, ' Die zuletzt erzeugte Folie bleibt stehen.') : null,
    a.preview ? h('div', {}, h('p', { class: 'hint', style: 'margin:8px 0 4px' }, a.lastOk ? `Vorschau – zuletzt aktualisiert: ${fmtDate(a.lastOk)}` : 'Vorschau'), h('div', { class: 'apppreview' }, h('b', {}, a.preview.title), '\n', a.preview.body)) : null);
}
