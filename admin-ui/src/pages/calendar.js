import { h, dialog, confirmDlg, toast, field, help, empty, fmtDate } from '../ui.js';
import { get, post, put, del, can } from '../api.js';
import { specialDaysDlg, weekDlg } from './tools.js';
import { epochToLocal, localToEpoch, addDays, dowOf } from '../../../shared/time.js';

const PALETTE = ['#c8102e', '#2a6f97', '#5a8f29', '#a23b9e', '#d97706', '#0f766e', '#6b4f3a', '#475569'];
const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], RR = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'], DN = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const H0 = 6, H1 = 22, PX = 48; const pad = (n) => String(n).padStart(2, '0');
const today = () => epochToLocal(Date.now()).date;
const monday = (d) => addDays(d, -((dowOf(d) + 6) % 7));
const nice = (d) => { const [y, m, dd] = d.split('-'); return `${DN[(dowOf(d) + 6) % 7]}, ${dd}.${m}.${y}`; };

export async function calendarPage({ route }) {
  const ovl = await get('/overrides').catch(() => []);
  const [devices, groups, lists, media, scheds, drafts] = await Promise.all([get('/devices'), get('/groups'), get('/playlists'), get('/media'), get('/schedules?drafts=1'), get('/drafts')]);
  const free = PALETTE.filter((c) => !groups.some((g) => g.color.toLowerCase() === c)); // Bildschirm-Farben: nie dieselbe wie eine Gruppe
  const targets = [...groups.map((g) => ({ key: 'group:' + g.id, name: 'Gruppe: ' + g.name, color: g.color })), ...devices.filter((d) => d.status.level !== 'pending').map((d, i) => ({ key: 'device:' + d.id, name: d.name, color: free[i % free.length] }))];
  const colorOf = (t, id) => targets.find((x) => x.key === `${t}:${id}`)?.color ?? '#666', nameOf = (t, id) => targets.find((x) => x.key === `${t}:${id}`)?.name ?? 'Bildschirm';
  let view = 'week', anchor = today();
  const root = h('div', {}, h('h1', {}, 'Kalender'), h('p', { class: 'lead' }, 'Klicke in den Kalender oder ziehe über einen Zeitraum, um etwas zu planen. Oder schreibe den Termin in einem Satz.'));
  const bar = h('div', { class: 'row', style: 'margin-bottom:10px' }), cal = h('div', {}), legend = h('div', { class: 'legend', style: 'margin:8px 0' }, targets.map((t) => h('span', {}, h('i', { style: `background:${t.color}` }), t.name)));
  const nav = (n) => { anchor = view === 'month' ? addDays(anchor, 31 * n) : addDays(anchor, (view === 'week' ? 7 : 1) * n); draw(); };
  const content = (c) => (c.type === 'playlist' ? lists.find((l) => l.id === c.id)?.name : media.find((m) => m.id === c.id)?.name) ?? '(gelöscht)';
  const open = (s, date, st, en) => editor({ s, date, st, en, targets, lists, media, scheds, devices, groups, route, canPublish: drafts.canPublish });
  async function draw() {
    const days = view === 'day' ? [anchor] : view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(monday(anchor), i)) : null;
    const from = days ? days[0] : addDays(anchor.slice(0, 8) + '01', -7), to = days ? days[days.length - 1] : addDays(anchor.slice(0, 8) + '01', 40);
    const ev = await get(`/calendar?from=${from}&to=${to}&drafts=1`);
    bar.replaceChildren(h('button', { class: 'btn sec', onclick: () => nav(-1), 'aria-label': 'Zurück' }, '◀'), h('button', { class: 'btn sec', onclick: () => { anchor = today(); draw(); } }, 'Heute'), h('button', { class: 'btn sec', onclick: () => nav(1), 'aria-label': 'Weiter' }, '▶'),
      h('b', {}, view === 'month' ? new Date(anchor + 'T12:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) : days.length === 1 ? nice(anchor) : `${days[0].split('-').reverse().slice(0, 2).join('.')}. – ${days[6].split('-').reverse().join('.')}`), h('span', { class: 'sp' }),
      ...['day', 'week', 'month'].map((v) => h('button', { class: 'chip', 'aria-pressed': view === v, onclick: () => { view = v; draw(); } }, { day: 'Tag', week: 'Woche', month: 'Monat' }[v])));
    if (!targets.length) return cal.replaceChildren(empty('Noch kein Bildschirm vorhanden', 'Verbinde zuerst einen Bildschirm, dann kannst du Termine planen.'));
    cal.replaceChildren(days ? grid(days, ev) : month(ev));
  }
  function grid(days, ev) {
    const g = h('div', { class: 'cal', style: `grid-template-columns:54px repeat(${days.length},1fr)` }, h('div', { class: 'h' }));
    days.forEach((d) => g.append(h('div', { class: 'h' + (d === today() ? ' today' : '') }, `${DAYS[dowOf(d)]} ${d.slice(8)}.${d.slice(5, 7)}.`)));
    const hours = h('div', {}); for (let x = H0; x < H1; x++) hours.append(h('div', { class: 'hour' }, `${x}:00`)); g.append(hours);
    days.forEach((d) => {
      const col = h('div', { class: 'col' + (d === today() ? ' today' : ''), 'data-date': d }); for (let x = H0; x < H1; x++) col.append(h('div', { class: 'slot' }));
      for (const e of ev.filter((e) => epochToLocal(e.start).date === d)) {
        const s = epochToLocal(e.start).time, en = epochToLocal(e.end).date === d ? epochToLocal(e.end).time : '22:00', top = (Number(s.slice(0, 2)) + Number(s.slice(3)) / 60 - H0) * PX, hgt = Math.max(24, (Number(en.slice(0, 2)) + Number(en.slice(3)) / 60 - Number(s.slice(0, 2)) - Number(s.slice(3)) / 60) * PX);
        col.append(h('button', { class: 'ev' + (e.state === 'draft' ? ' draft' : ''), style: `top:${top}px;height:${hgt}px;background:${colorOf(e.targetType, e.targetId)}`, 'aria-label': `${e.state === 'draft' ? 'Entwurf: ' : ''}${content(e.content)} auf ${nameOf(e.targetType, e.targetId)}, ${s} bis ${en}`, onclick: (x) => { x.stopPropagation(); open(scheds.find((z) => z.id === e.scheduleId), d); } }, `${e.state === 'draft' ? '✎ Entwurf · ' : ''}${s} ${content(e.content)}`, h('br'), nameOf(e.targetType, e.targetId)));
      }
      let sel = null, y0 = 0; const snap = (y) => Math.max(0, Math.min((H1 - H0) * PX, Math.round(y / (PX / 2)) * (PX / 2)));
      const time = (y) => { const mins = H0 * 60 + (y / PX) * 60; return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; };
      col.addEventListener('pointerdown', (e) => { if (!can('schedules.write') || e.target.closest('.ev')) return; y0 = snap(e.clientY - col.getBoundingClientRect().top); sel = h('div', { class: 'sel', style: `top:${y0}px;height:${PX / 2}px` }); col.append(sel); col.setPointerCapture(e.pointerId); });
      col.addEventListener('pointermove', (e) => { if (!sel) return; const y = snap(e.clientY - col.getBoundingClientRect().top); sel.style.top = Math.min(y, y0) + 'px'; sel.style.height = Math.max(PX / 2, Math.abs(y - y0)) + 'px'; });
      col.addEventListener('pointerup', (e) => { if (!sel) return; const y = snap(e.clientY - col.getBoundingClientRect().top); let a = Math.min(y, y0), b = Math.max(y, y0); if (b - a < PX / 2) b = a + PX; sel.remove(); sel = null; open(null, d, time(a), time(Math.min(b, (H1 - H0) * PX))); });
      g.append(col);
    });
    return g;
  }
  function month(ev) {
    const first = anchor.slice(0, 8) + '01', start = monday(first), m = h('div', { class: 'month' }, DN.map((x) => h('b', {}, x.slice(0, 2))));
    for (let i = 0; i < 42; i++) { const d = addDays(start, i), es = ev.filter((e) => epochToLocal(e.start).date === d);
      m.append(h('div', { class: 'd' + (d.slice(0, 7) === first.slice(0, 7) ? '' : ' out'), tabindex: 0, role: 'button', 'aria-label': `${nice(d)}, ${es.length} Termine`, onclick: () => open(null, d), onkeydown: (e) => { if (e.key === 'Enter') open(null, d); } }, d.slice(8), ...es.slice(0, 3).map((e) => h('small', { class: e.state === 'draft' ? 'draft' : '', style: `background:${colorOf(e.targetType, e.targetId)}`, onclick: (x) => { x.stopPropagation(); open(scheds.find((z) => z.id === e.scheduleId), d); } }, (e.state === 'draft' ? '✎ ' : '') + content(e.content))), es.length > 3 ? h('small', { style: 'color:inherit' }, `+${es.length - 3} weitere`) : null)); }
    return m;
  }
  root.append(...ovl.map((o) => h('div', { class: 'notice' }, '⚡ ', o.text, ' (übersteuert den Plan bis dahin)')));
  root.append(drafts.schedules + drafts.playlists ? h('div', { class: 'notice' }, `✎ ${drafts.schedules + drafts.playlists} Entwürfe warten auf Veröffentlichung. Sie sind gestrichelt dargestellt und laufen noch nicht auf den Bildschirmen.`, drafts.old ? ` ${drafts.old} davon sind älter als 30 Tage.` : '') : null, can('schedules.write') && targets.length ? h('p', { class: 'row' }, h('button', { class: 'btn big', 'data-tour': 'newsched', onclick: () => open(null, today()) }, '➕ Neuer Termin'), h('button', { class: 'btn sec', onclick: () => specialDaysDlg(route) }, '🎄 Feiertage & Sondertage'), h('button', { class: 'btn sec', onclick: () => weekDlg(route, monday(anchor)) }, '🗓 Woche kopieren / Vorlage')) : null, bar, legend, cal);
  await draw(); return root;
}

/** Termin anlegen/ändern: „Zeige [Inhalt] auf [Bildschirm] am [Datum] von [Zeit] bis [Zeit]“ */
function editor({ s, date, st, en, targets, lists, media, scheds, devices, groups, route, canPublish }) {
  const isNew = !s, startDate = s ? s.startLocal.slice(0, 10) : date;
  const rr = s?.rrule ? Object.fromEntries(s.rrule.split(';').map((x) => x.split('='))) : {};
  const v = { content: s ? `${s.content.type}:${s.content.id}` : `playlist:${lists[0]?.id}`, target: s ? `${s.targetType}:${s.targetId}` : targets[0]?.key, date: startDate, from: s ? s.startLocal.slice(11) : st ?? '10:00', to: s ? s.endLocal.slice(11) : en ?? '11:00',
    endDate: s ? s.endLocal.slice(0, 10) : date, repeat: rr.FREQ ? { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' }[rr.FREQ] : 'none', days: rr.BYDAY ? rr.BYDAY.split(',') : [RR[(dowOf(startDate) + 6) % 7]], until: rr.UNTIL ? `${rr.UNTIL.slice(0, 4)}-${rr.UNTIL.slice(4, 6)}-${rr.UNTIL.slice(6)}` : '', priority: s?.priority ?? 5, ex: [...(s?.exdates ?? [])] };
  const sel = (opts, val, on) => h('select', { class: 'inline', onchange: (e) => on(e.target.value) }, opts.map(([k, t]) => h('option', { value: k, selected: k === val }, t)));
  const days = h('div', { class: 'chips', role: 'group', 'aria-label': 'Wochentage' }); const drawDays = () => { days.replaceChildren(...RR.map((c, i) => h('button', { type: 'button', class: 'chip', 'aria-pressed': v.days.includes(c), onclick: () => { v.days = v.days.includes(c) ? v.days.filter((x) => x !== c) : [...v.days, c]; drawDays(); } }, DN[i].slice(0, 2)))); }; drawDays();
  const rep = h('div', {}), drawRep = () => { rep.replaceChildren(h('p', {}, h('b', {}, 'Wiederholung: '), sel([['none', 'Einmalig'], ['daily', 'Jeden Tag'], ['weekly', 'Jede Woche'], ['monthly', 'Jeden Monat']], v.repeat, (x) => { v.repeat = x; drawRep(); })), v.repeat === 'weekly' ? days : null, v.repeat !== 'none' ? h('p', {}, ' bis ', h('input', { class: 'inline', type: 'date', value: v.until, 'aria-label': 'Wiederholen bis', onchange: (e) => { v.until = e.target.value; } }), h('span', { class: 'hint' }, ' (leer = ohne Ende)')) : null); }; drawRep();
  const ctn = [['—', ''], ...lists.map((l) => ['playlist:' + l.id, 'Abspielliste: ' + l.name]), ...media.map((m) => ['media:' + m.id, `${m.kind === 'video' ? 'Video' : m.kind === 'text' ? 'Text' : 'Bild'}: ${m.name}`])].slice(1);
  const sentence = h('p', { style: 'line-height:3' }, h('b', {}, 'Zeige '), sel(ctn, v.content, (x) => { v.content = x; }), h('b', {}, ' auf '), sel(targets.map((t) => [t.key, t.name]), v.target, (x) => { v.target = x; }), h('b', {}, ' am '),
    h('input', { class: 'inline', type: 'date', value: v.date, 'aria-label': 'Datum', onchange: (e) => { v.date = e.target.value; if (v.endDate < v.date) v.endDate = v.date; } }), h('b', {}, ' von '), h('input', { class: 'inline', type: 'time', value: v.from, 'aria-label': 'Von', onchange: (e) => { v.from = e.target.value; } }), h('b', {}, ' bis '), h('input', { class: 'inline', type: 'time', value: v.to, 'aria-label': 'Bis', onchange: (e) => { v.to = e.target.value; } }), h('b', {}, ' Uhr.'));
  const adv = h('details', {}, h('summary', {}, 'Erweitert'), field('Wichtigkeit (1 = niedrig, 10 = hoch)', h('input', { type: 'number', min: 1, max: 10, value: v.priority, onchange: (e) => { v.priority = Number(e.target.value); } }), 'Überschneiden sich zwei Termine, gewinnt der wichtigere. Bei gleicher Wichtigkeit gewinnt der später gestartete. Ein Termin direkt für einen Bildschirm schlägt einen Gruppen-Termin.'));
  const prev = h('div', {});
  const build = () => { const [tt, ti] = v.target.split(':'), [ct, ...ci] = v.content.split(':'); const BY = { weekly: 'BYDAY=' + (v.days.length ? v.days.join(',') : RR[(dowOf(v.date) + 6) % 7]) };
    return { targetType: tt, targetId: ti, content: { type: ct, id: ci.join(':') }, startLocal: `${v.date}T${v.from}`, endLocal: `${v.endDate < v.date ? v.date : v.endDate}T${v.to}`, priority: v.priority, exdates: v.ex,
      rrule: v.repeat === 'none' ? null : [`FREQ=${v.repeat.toUpperCase()}`, BY[v.repeat], v.until ? 'UNTIL=' + v.until.replaceAll('-', '') : null].filter(Boolean).join(';') }; };
  async function preview() {
    try { const b = build(); const dev = b.targetType === 'device' ? b.targetId : devices.find((d) => d.groupId === b.targetId)?.id;
      if (!dev) return prev.replaceChildren(h('p', { class: 'hint' }, 'In dieser Gruppe ist noch kein Bildschirm.'));
      const r = await get(`/preview?deviceId=${dev}&date=${v.date}&time=${v.from}`); const m = media.find((x) => x.id === (r.mediaIds[0]));
      prev.replaceChildren(h('h3', {}, `So sieht der Bildschirm am ${nice(v.date).split(',')[0]} um ${v.from} Uhr heute aus:`), h('p', {}, r.text), m ? h('div', { class: 'shot' }, m.kind === 'text' ? h('b', {}, m.text.title) : h('img', { alt: m.name, src: `/api/v1/media/${m.id}/file` })) : null, h('p', { class: 'hint' }, 'Das ist die Anzeige vor dem Speichern – mit dem neuen Termin zeigt der Bildschirm dort den gewählten Inhalt.'));
    } catch (e) { toast(e.message, 'err'); }
  }
  const actions = [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Vorschau ansehen', cls: 'sec', fn: async () => { await preview(); return false; } }];
  if (!isNew && can('schedules.write')) {
    actions.unshift({ text: 'Löschen', cls: 'danger', fn: async () => { if (!(await confirmDlg('Termin löschen?', 'Du kannst ihn 30 Tage lang aus dem Papierkorb zurückholen.', 'Löschen'))) return false; await del(`/schedules/${s.id}`); toast('Termin gelöscht.', 'ok', async () => { const t = await get('/trash'); const x = t.find((q) => q.kind === 'schedule'); if (x) { await post(`/trash/${x.id}/restore`); route(); } }); route(); } });
    if (s.rrule) actions.unshift({ text: 'Nur diesen Tag ausfallen lassen', cls: 'sec', fn: async () => { await put(`/schedules/${s.id}`, { ...strip(s), exdates: [...(s.exdates ?? []), date] }); toast(`Am ${nice(date)} fällt der Termin aus.`); route(); } });
  }
  async function saveDraft() { const b = build(); const r = isNew ? await post('/schedules', b) : await put(`/schedules/${s.id}`, b); return r.draftId ?? r.id; }
  async function publishFlow(id) {
    const c = await get(`/schedules/${id}/publish-check`);
    const body = h('div', {}, h('p', {}, h('b', {}, c.summary)), ...c.problems.map((x) => h('p', { class: 'notice bad' }, '⛔ ', x)), ...c.conflicts.map((x) => h('p', { class: 'notice' }, '⚠ ', x)), c.notLoaded ? h('p', { class: 'notice' }, '⚠ ' + c.notLoaded) : null, ...(c.hints ?? []).map((x) => h('p', { class: 'notice' }, 'ℹ ', x)));
    if (c.problems.length) { dialog('Veröffentlichen nicht möglich', body, [{ text: 'Verstanden', cls: 'sec' }]); return false; }
    return new Promise((res) => dialog('Jetzt veröffentlichen?', body, [{ text: 'Noch nicht', cls: 'sec', fn: () => res(false) }, { text: 'Veröffentlichen', fn: async () => { try { await post(`/schedules/${id}/publish`); toast('Veröffentlicht. Die Bildschirme bekommen den Termin gleich.'); route(); res(true); } catch (e) { toast(e.message, 'err'); return false; } } }]));
  }
  if (can('schedules.write')) {
    actions.push({ text: 'Als Entwurf speichern', cls: canPublish ? 'sec' : '', fn: async () => { try { await saveDraft(); toast('Als Entwurf gespeichert. Er läuft erst nach dem Veröffentlichen.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } });
    if (canPublish) actions.push({ text: 'Speichern und veröffentlichen', fn: async () => { try { const id = await saveDraft(); await publishFlow(id); route(); } catch (e) { toast(e.message, 'err'); return false; } } });
    if (s?.state === 'draft') actions.unshift({ text: 'Entwurf verwerfen', cls: 'danger', fn: async () => { await post(`/schedules/${s.id}/discard`); toast('Entwurf verworfen.'); route(); } });
    if (!isNew) actions.unshift({ text: 'Frühere Stände', cls: 'sec', fn: async () => { await history(s, route); return false; } });
  }
  dialog(isNew ? 'Neuer Termin' : s.state === 'draft' ? 'Entwurf bearbeiten' : 'Termin ansehen oder ändern', h('div', {}, s?.state === 'draft' ? h('p', { class: 'notice' }, '✎ Das ist ein Entwurf. Er läuft erst, wenn du ihn veröffentlichst.') : null, sentence, rep, adv, prev), actions);
}
const strip = (s) => ({ targetType: s.targetType, targetId: s.targetId, content: s.content, startLocal: s.startLocal, endLocal: s.endLocal, rrule: s.rrule, exdates: s.exdates, priority: s.priority, validFrom: s.validFrom ?? null, validTo: s.validTo ?? null });

async function history(s, route) {
  const v = await get(`/versions?kind=schedule&refId=${s.draftOf ?? s.id}`);
  dialog('Frühere Stände', v.length ? h('ul', {}, v.map((x) => h('li', {}, `${fmtDate(x.ts)} – ${x.user}: ${x.label} `, h('button', { class: 'btn link', onclick: async () => { await post(`/versions/${x.id}/restore`); toast('Als Entwurf wiederhergestellt. Du kannst ihn prüfen und veröffentlichen.'); route(); } }, 'Als Entwurf wiederherstellen')))) : h('p', {}, 'Es gibt noch keine früheren Stände (sie werden 90 Tage aufbewahrt).'), [{ text: 'Schließen', cls: 'sec' }]);
}
