// Live-Ansicht (Z.1): Alle Bildschirme auf einen Blick – was läuft JETZT (Ist), was ist geplant (Soll). Stufe 1 = Status, Stufe 2 = Screenshots (nur solange jemand zuschaut).
import { h, dialog, statusEl, empty, fmtDate, toast, confirmDlg } from '../ui.js';
import { get, post, del, can, state } from '../api.js';

const pref = (k, d) => { try { return localStorage.getItem('dfm-live-' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('dfm-live-' + k, v); } catch {} };
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? `vor ${s} Sekunden` : `vor ${Math.round(s / 60)} Minuten`; };
const stop = (e) => e.stopPropagation();

/** Vorschaubild: echtes Bild (Stufe 2) wenn vorhanden; sonst Platzhalter mit Inhaltsname (Stufe 1). Offline/veraltet = grau mit Symbol und Text. */
function preview(r, big = false) {
  const box = h('div', { class: 'shot liveshot' + (big ? ' big' : '') + (!r.status.level.startsWith('ok') || r.stale ? ' gray' : '') }, h('span', { class: 'hint' }, r.ist?.current?.name ? `${r.ist.current.name}` : 'Noch keine Vorschau'));
  if (r.shotAt) { const i = h('img', { alt: `Vorschau von ${r.name}`, src: `/api/v1/devices/${r.id}/screenshot?t=${r.shotAt}` }); i.onload = () => box.replaceChildren(i, h('span', { class: 'stamp' }, (r.status.level !== 'ok' ? `⏸ zuletzt gesehen ${ago(r.shotAt)}` : r.stale ? `⚠ Bild veraltet (${ago(r.shotAt)})` : ago(r.shotAt)))); }
  return box;
}
const progress = (r) => (r.ist?.current?.duration && r.endsInS != null ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': Math.round((1 - r.endsInS / r.ist.current.duration) * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${Math.max(0, Math.min(100, (1 - r.endsInS / r.ist.current.duration) * 100))}%` })) : null);

function tile(r, open) {
  const cur = r.ist?.current;
  return h('button', { class: 'card livetile' + (r.mismatch ? ' mismatch' : '') + (r.maintenance ? ' maint' : ''), onclick: () => open(r), 'aria-label': `${r.name}: ${r.status.label}` },
    h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'sp' }), statusEl(r.status)), r.location ? h('div', { class: 'hint' }, r.location) : null, preview(r), progress(r),
    h('p', { class: 'now' }, r.maintenance ? '🔧 Wartungsmodus' : r.status.level === 'ok' ? (cur ? `Jetzt: ${cur.name || 'Inhalt'}${r.endsInS != null ? ` · läuft noch ${mmss(r.endsInS)} Min` : ''}` : r.soll.playlist ? `Geplant: ${r.soll.playlist}` : 'Nichts geplant') : 'Zeigt den zwischengespeicherten Inhalt'),
    r.next ? h('p', { class: 'hint' }, `Als Nächstes: ${r.next.name} um ${r.next.atText} Uhr`) : null,
    r.soll.override ? h('p', { class: 'badge' }, '⚡ Übersteuert') : null, r.simplified ? h('p', { class: 'hint' }, 'ℹ Vorschau vereinfacht, damit der Bildschirm flüssig bleibt.') : null,
    r.mismatch ? h('p', { class: 'notice' }, '⚠ ', r.mismatchText) : null, ...r.warnings.slice(0, 2).map((w) => h('p', { class: 'hint warnline' }, '▲ ', w.text)));
}

export async function livePage({ route }, opts = {}) {
  let rows = await get('/live'), cols = Number(pref('cols', '3')), group = pref('group', ''), place = pref('place', ''), wall = !!opts.wall, timer = null;
  const root = h('div', { class: wall ? 'wall' : '' }), grid = h('div', {}), bar = h('div', { class: 'row', style: 'margin:10px 0' });
  const groups = () => [...new Map(rows.filter((r) => r.groupId).map((r) => [r.groupId, r.groupName])).entries()];
  const places = () => [...new Set(rows.map((r) => r.location).filter(Boolean))].sort();
  const detailDlg = (r) => detail(r, route);
  function draw() {
    const shown = rows.filter((r) => (!group || r.groupId === group) && (!place || r.location === place)), n = wall ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(shown.length)))) : cols;
    grid.style.cssText = `display:grid;gap:14px;grid-template-columns:repeat(${n},minmax(0,1fr))`; grid.className = 'livegrid';
    grid.replaceChildren(...(shown.length ? shown.map((r) => tile(r, wall ? () => {} : detailDlg)) : [empty('Keine Bildschirme', 'Hier erscheinen verbundene Bildschirme.')]));
    bar.replaceChildren(h('span', { class: 'hint' }, 'Spalten: '), ...[1, 2, 3, 4].map((x) => h('button', { class: 'chip', 'aria-pressed': cols === x, onclick: () => { cols = x; setPref('cols', x); draw(); } }, String(x))),
      groups().length ? h('select', { class: 'inline', 'aria-label': 'Gruppe wählen', onchange: (e) => { group = e.target.value; setPref('group', group); draw(); } }, h('option', { value: '' }, 'Alle Gruppen'), groups().map(([id, nm]) => h('option', { value: id, selected: id === group }, nm))) : null,
      places().length ? h('select', { class: 'inline', 'aria-label': 'Etage oder Standort wählen', onchange: (e) => { place = e.target.value; setPref('place', place); draw(); } }, h('option', { value: '' }, 'Alle Etagen/Orte'), places().map((x) => h('option', { value: x, selected: x === place }, x))) : null,
      h('span', { class: 'sp' }), h('span', { class: 'hint' }, 'Aktualisiert sich selbst'), can('overrides.write') ? h('button', { class: 'btn sec', onclick: async () => { try { await post('/overrides/end-all'); toast('Alles läuft wieder nach Plan.'); rows = await get('/live'); draw(); } catch (e) { toast(e.message, 'err'); } } }, 'Zurück zum normalen Plan') : null,
      h('button', { class: 'btn sec', onclick: () => { wall = !wall; root.classList.toggle('wall', wall); if (wall) root.requestFullscreen?.().catch(() => {}); else document.exitFullscreen?.().catch(() => {}); draw(); } }, wall ? 'Wandmodus beenden' : 'Wandmodus'));
  }
  draw();
  timer = setInterval(async () => { if (!document.body.contains(root)) return clearInterval(timer); try { rows = await get('/live'); draw(); } catch {} }, 10000); // Rückfall: Abfrage alle 10 s
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && wall && !opts.wall) { wall = false; root.classList.remove('wall'); if (document.body.contains(root)) draw(); } });
  if (opts.openId) { const r0 = rows.find((x) => x.id === opts.openId); if (r0) setTimeout(() => detailDlg(r0), 0); }
  root.append(...(wall && opts.wall ? [] : [h('h1', {}, 'Live'), h('p', { class: 'lead' }, 'Was zeigen die Bildschirme gerade? Ein Klick auf eine Kachel zeigt Einzelheiten.')]), bar, grid);
  return root;
}

/** Einzelansicht: großes Bild, Herkunft, nächste 5 Elemente, Schnellaktionen für genau diesen Bildschirm */
async function detail(r0, route) {
  let r = await get(`/live/${r0.id}`).catch(() => r0); const body = h('div', {}), timer = { t: null };
  const act = async (command, args, text) => { try { await post(`/devices/${r.id}/commands`, { command, args }); toast(text); } catch (e) { toast(e.message, 'err'); } };
  function draw() {
    const rowsT = [['Status', r.status.label], ['Herkunft', r.soll.origin], ['Jetzt (Ist)', r.ist?.current?.name ?? '–'], ['Seit', r.ist?.current?.since ? fmtDate(r.ist.current.since) : '–'], ['Danach', r.ist?.next?.name ?? '–'],
      ['Geplant (Soll)', r.soll.playlist ?? 'nichts'], ['Letzte Meldung', r.lastSeen ? fmtDate(r.lastSeen) : '–'], ['WLAN', r.signal.label], ['Bildschirm', r.displayOff ? 'aus (Ruhezeit/Schließtag)' : r.maintenance ? 'Wartungsmodus' : 'an']];
    body.replaceChildren(preview(r, true), progress(r), r.mismatch ? h('p', { class: 'notice' }, '⚠ ', r.mismatchText) : null, ...r.warnings.map((w) => h('p', { class: 'notice' }, '▲ ', w.text)),
      ...(r.overrides ?? []).map((o) => h('div', { class: 'notice' }, '⚡ ', o.text, ' ', can('overrides.write') ? h('button', { class: 'btn link', onclick: async () => { await del(`/overrides/${o.id}`); toast('Zurück zum normalen Plan.'); r = await get(`/live/${r.id}`); draw(); } }, 'Zurück zum normalen Plan') : null)),
      h('table', {}, h('tbody', {}, rowsT.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))), r.upcoming?.length ? h('div', {}, h('h3', {}, 'Die nächsten Elemente'), h('ol', {}, r.upcoming.map((u) => h('li', {}, `${u.name} – ${u.duration} Sekunden`)))) : null,
      h('p', { class: 'hint' }, 'Lesezeichen für diesen Bildschirm: ', h('code', {}, `${location.origin}/#/live/${r.id}`)), r.simplified ? h('p', { class: 'hint' }, 'ℹ Vorschau vereinfacht, damit der Bildschirm flüssig bleibt.') : null,
      can('overrides.write') ? quick(r) : null);
  }
  function quick(dev) { // Schnellaktion nur für diesen Bildschirm
    const sel = h('select', { class: 'inline', 'aria-label': 'Inhalt' }, h('option', { value: '' }, 'Jetzt zeigen …')); const dur = h('select', { class: 'inline', 'aria-label': 'Dauer' }, [['30', '30 Minuten'], ['60', '1 Stunde'], ['120', '2 Stunden'], ['eod', 'bis Tagesende']].map(([k, t]) => h('option', { value: k }, t)));
    Promise.all([get('/playlists'), get('/media')]).then(([pl, md]) => { for (const p of pl.filter((x) => x.state === 'published')) sel.append(h('option', { value: 'playlist:' + p.id }, 'Abspielliste: ' + p.name)); for (const m of md) sel.append(h('option', { value: 'media:' + m.id }, m.name)); }).catch(() => {});
    return h('div', { class: 'row', style: 'margin-top:10px' }, h('b', {}, 'Schnellaktion:'), sel, h('span', {}, 'für'), dur, h('button', { class: 'btn', onclick: async () => { if (!sel.value) return toast('Bitte wähle einen Inhalt.', 'err'); const [type, id] = sel.value.split(':'); try { const x = await post('/overrides', { scope: 'device', targetId: dev.id, content: { type, id }, ...(dur.value === 'eod' ? { endOfDay: true } : { minutes: Number(dur.value) }) }); toast(x.text); r = await get(`/live/${dev.id}`); draw(); } catch (e) { toast(e.message, 'err'); } } }, 'Zeigen'));
  }
  const acts = [{ text: 'Schließen', cls: 'sec' }];
  acts.unshift({ text: 'Jetzt aktualisieren', cls: 'sec', fn: async () => { try { const x = await post(`/live/${r.id}/refresh`); toast(x.text); setTimeout(async () => { r = await get(`/live/${r.id}`).catch(() => r); draw(); }, 2500); } catch (e) { toast(e.message, 'err'); } return false; } });
  if (can('devices.manage')) acts.unshift({ text: 'Bild speichern', cls: 'sec', fn: async () => { try { await post(`/devices/${r.id}/screenshot/save`); toast('Das Bild wurde gespeichert (Admin-Aktion, wird protokolliert).'); } catch (e) { toast(e.message, 'err'); } return false; } });
  if (can('devices.manage')) acts.unshift({ text: r.maintenance ? 'Wartungsmodus beenden' : 'Wartungsmodus', cls: 'sec', fn: async () => { await post(`/devices/${r.id}/maintenance`, { on: !r.maintenance }); toast(r.maintenance ? 'Wartungsmodus aus.' : 'Wartungsmodus an.'); route?.(); }, },
    { text: 'Testbild', cls: 'sec', fn: async () => { await act('testpattern', { on: true }, 'Das Testbild läuft 2 Minuten.'); return false; } }, { text: 'Neu laden', cls: 'sec', fn: async () => { await act('reload', {}, 'Der Bildschirm lädt neu.'); return false; } },
    { text: 'Erkennen', cls: 'sec', fn: async () => { await act('identify', { location: r.location ?? '', number: r.id.slice(0, 4).toUpperCase() }, 'Der Bildschirm zeigt 10 Sekunden seinen Namen.'); return false; } });
  const d = dialog(r.name, body, acts); d.classList.add('wide'); draw();
  timer.t = setInterval(async () => { if (!document.body.contains(d)) return clearInterval(timer.t); try { r = await get(`/live/${r.id}`); draw(); } catch {} }, 5000); // Einzelansicht: alle 5 s
}

/** Wandmodus-Seite (#/wand): eigenes Lese-Token, keine Anmeldung, keine automatische Abmeldung */
export async function wallPage() {
  const wrap = h('div', { class: 'wallwrap' });
  const tryOpen = async () => { try { wrap.replaceChildren(await livePage({ route: () => {} }, { wall: true })); return true; } catch { return false; } };
  if (!(await tryOpen())) {
    const t = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Zugangs-Token' });
    wrap.replaceChildren(h('div', { class: 'card', style: 'max-width:520px;margin:10vh auto' }, h('h1', {}, 'Wandmodus'), h('p', {}, 'Gib das Zugangs-Token ein, das ein Admin unter „Benutzer → Wandmodus“ erzeugt hat. Das Token erlaubt nur die Live-Ansicht.'), t,
      h('button', { class: 'btn big', style: 'margin-top:10px', onclick: async () => { try { await post('/live/wall-login', { token: t.value }); location.reload(); } catch (e) { toast(e.message, 'err'); } } }, 'Öffnen')));
  }
  return wrap;
}
