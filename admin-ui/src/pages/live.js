// Live-Ansicht (Z.1): Alle Bildschirme auf einen Blick – was läuft JETZT (Ist), was ist geplant (Soll).
import { h, dialog, statusEl, empty, fmtDate, toast } from '../ui.js';
import { get, post, can } from '../api.js';

const SRC = { termin: 'Termin', standard: 'Standard-Abspielliste', szene: 'Schnellaktion', sondertag: 'Sondertag', none: 'nichts geplant' };
const pref = (k, d) => { try { return localStorage.getItem('dfm-live-' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('dfm-live-' + k, v); } catch {} };

export async function livePage({ route }) {
  let rows = await get('/live'), cols = Number(pref('cols', '3')), group = pref('group', ''), wall = false, timer = null;
  const root = h('div', {}), grid = h('div', { class: 'livegrid' }), bar = h('div', { class: 'row', style: 'margin:10px 0' });
  const groups = [...new Map(rows.filter((r) => r.groupId).map((r) => [r.groupId, r.groupName])).entries()];
  const ago = (ms) => (ms ? `vor ${Math.max(0, Math.round((Date.now() - ms) / 1000))} s` : 'noch nie');
  const tile = (r) => {
    const img = h('img', { alt: `Vorschau von ${r.name}`, src: `/api/v1/devices/${r.id}/screenshot?t=${r.shotAt ?? 0}` }); const box = h('div', { class: 'shot' }, 'Noch keine Vorschau'); img.onload = () => box.replaceChildren(img);
    const cur = r.ist?.current;
    return h('button', { class: 'card livetile' + (r.mismatch ? ' mismatch' : ''), onclick: () => detail(r), 'aria-label': `${r.name}: ${r.status.label}` },
      h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'sp' }), statusEl(r.status)), box,
      h('p', { class: 'now' }, r.status.level === 'ok' ? (cur ? `Jetzt: ${cur.name || 'Inhalt'}` : r.soll.playlist ? `Geplant: ${r.soll.playlist}` : 'Nichts geplant') : 'Keine Verbindung – zeigt gespeicherte Inhalte'),
      r.ist?.next ? h('p', { class: 'hint' }, `Danach: ${r.ist.next.name || 'Inhalt'}`) : null,
      r.mismatch ? h('p', { class: 'notice' }, '⚠ ', r.mismatchText) : null);
  };
  function detail(r) {
    const tbl = [['Status', r.status.label], ['Gruppe', r.groupName ?? '–'], ['Jetzt (Ist)', r.ist?.current?.name ?? '–'], ['Seit', r.ist?.current?.since ? fmtDate(r.ist.current.since) : '–'], ['Danach', r.ist?.next?.name ?? '–'],
      ['Geplant (Soll)', r.soll.playlist ? `${r.soll.playlist} (${SRC[r.soll.source] ?? r.soll.source})` : 'nichts'], ['Letzte Meldung', r.lastSeen ? fmtDate(r.lastSeen) : '–'], ['Bildschirm', r.displayOff ? 'aus (Ruhezeit)' : 'an']];
    const body = h('div', {}, h('img', { alt: `Vorschau von ${r.name}`, src: `/api/v1/devices/${r.id}/screenshot?t=${Date.now()}`, style: 'width:100%;border-radius:8px;background:#000' }), r.mismatch ? h('p', { class: 'notice' }, '⚠ ', r.mismatchText) : null,
      h('table', {}, h('tbody', {}, tbl.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))));
    const acts = [{ text: 'Schließen', cls: 'sec' }];
    if (can('devices.manage')) { acts.unshift({ text: 'Neu laden', cls: 'sec', fn: async () => { await post(`/devices/${r.id}/commands`, { command: 'reload' }); toast('Der Bildschirm lädt die Seite neu.'); } }); }
    if (can('devices.read')) acts.unshift({ text: 'Neues Vorschaubild', cls: 'sec', fn: async () => { await post(`/devices/${r.id}/commands`, { command: 'screenshot' }).catch((e) => toast(e.message, 'err')); toast('Neues Vorschaubild kommt in wenigen Sekunden.'); return false; } });
    dialog(r.name, body, acts);
  }
  function draw() {
    const shown = rows.filter((r) => !group || r.groupId === group);
    grid.style.cssText = `display:grid;gap:14px;grid-template-columns:repeat(${wall ? Math.min(4, Math.max(1, Math.ceil(Math.sqrt(shown.length)))) : cols},1fr)`;
    grid.replaceChildren(...(shown.length ? shown.map(tile) : [empty('Keine Bildschirme', 'Hier erscheinen verbundene Bildschirme.')]));
    bar.replaceChildren(h('span', { class: 'hint' }, 'Spalten: '), ...[1, 2, 3, 4].map((n) => h('button', { class: 'chip', 'aria-pressed': cols === n, onclick: () => { cols = n; setPref('cols', n); draw(); } }, String(n))),
      groups.length ? h('select', { class: 'inline', 'aria-label': 'Gruppe wählen', onchange: (e) => { group = e.target.value; setPref('group', group); draw(); } }, h('option', { value: '' }, 'Alle Gruppen'), groups.map(([id, n]) => h('option', { value: id, selected: id === group }, n))) : null,
      h('span', { class: 'sp' }), h('span', { class: 'hint' }, 'Aktualisiert sich selbst'), h('button', { class: 'btn sec', onclick: () => { wall = !wall; root.classList.toggle('wall', wall); if (wall) root.requestFullscreen?.().catch(() => {}); else document.exitFullscreen?.().catch(() => {}); draw(); } }, 'Wandmodus'));
  }
  draw();
  timer = setInterval(async () => { if (!document.body.contains(root)) return clearInterval(timer); try { rows = await get('/live'); draw(); } catch {} }, 10000);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && wall) { wall = false; root.classList.remove('wall'); if (document.body.contains(root)) draw(); } });
  root.append(h('h1', {}, 'Live'), h('p', { class: 'lead' }, 'Was zeigen die Bildschirme gerade? Ein Klick auf eine Kachel zeigt Einzelheiten.'), bar, grid);
  return root;
}
