// Regeln: „Wenn … dann zeige …“ – nach Wetter, Fußballspiel und Uhrzeit wechselt der Inhalt von selbst.
// Der Hub prüft jede Minute. Regeln haben den niedrigsten Rang: Notfall-Meldung, Tor-Jubel und Hand-Aktionen gehen vor.
import { h, dialog, confirmDlg, toast, field, empty } from '../ui.js';
import { get, post, put, del, can } from '../api.js';

const STATUS = { zeigt: ['ok', '✔', 'zeigt gerade'], wartet: ['pending', '⏳', 'startet gleich'], pausiert: ['warn', '⏸', 'pausiert'], verdraengt: ['warn', '↓', 'verdrängt'], inaktiv: ['', '–', 'Bedingung gilt gerade nicht'], unbekannt: ['warn', '▲', 'Daten fehlen'], fehler: ['bad', '✖', 'Fehler'], aus: ['', '⏸', 'ausgeschaltet'] };
const WEATHER = [['regen', 'Es regnet gerade'], ['regen_bald', 'Es regnet oder wird in den nächsten 3 Stunden regnen'], ['trocken', 'Es bleibt trocken (kein Regen in den nächsten 3 Stunden)'], ['ueber', 'Es sind mehr als … °C'], ['unter', 'Es sind weniger als … °C']];
const MATCH = [['laeuft', 'Das Spiel läuft gerade'], ['heute', 'Heute ist Spieltag'], ['bald', 'Das Spiel beginnt in höchstens … Minuten'], ['nicht', 'Gerade läuft kein Spiel']];
const DAYS = [['mo', 'Mo'], ['di', 'Di'], ['mi', 'Mi'], ['do', 'Do'], ['fr', 'Fr'], ['sa', 'Sa'], ['so', 'So']];
const WAIT = [[0, 'sofort'], [60, 'nach 1 Minute'], [300, 'nach 5 Minuten'], [600, 'nach 10 Minuten'], [1800, 'nach 30 Minuten']];
const mark = (ok) => (ok === true ? '✔' : ok === false ? '✖' : '?');

/** Eine Zeile im Bedingungs-Editor */
function condRow(c, remove) {
  const type = h('select', { 'aria-label': 'Art der Bedingung' }, [['wetter', '🌦️ Wetter'], ['spiel', '⚽ Fußballspiel'], ['zeit', '🕘 Uhrzeit / Wochentag']].map(([k, t]) => h('option', { value: k, selected: k === c.type ? '' : null }, t)));
  const body = h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' });
  let read = () => ({});
  const draw = () => {
    if (type.value === 'wetter') {
      const is = h('select', { 'aria-label': 'Wetter' }, WEATHER.map(([k, t]) => h('option', { value: k, selected: k === (c.type === 'wetter' ? c.is : 'regen_bald') ? '' : null }, t))), v = h('input', { type: 'number', min: -30, max: 50, value: c.value ?? 25, 'aria-label': 'Grad Celsius', style: 'width:5em' });
      const sync = () => { v.hidden = !['ueber', 'unter'].includes(is.value); }; is.addEventListener('change', sync); sync(); body.replaceChildren(is, v, h('span', { class: 'hint' }, 'Daten vom Deutschen Wetterdienst (App „Wetter“ muss an sein)'));
      read = () => ({ type: 'wetter', is: is.value, ...(['ueber', 'unter'].includes(is.value) ? { value: Number(v.value) } : {}) });
    } else if (type.value === 'spiel') {
      const is = h('select', { 'aria-label': 'Spiel' }, MATCH.map(([k, t]) => h('option', { value: k, selected: k === (c.type === 'spiel' ? c.is : 'laeuft') ? '' : null }, t))), m = h('input', { type: 'number', min: 5, max: 360, value: c.minutes ?? 60, 'aria-label': 'Minuten', style: 'width:5em' });
      const sync = () => { m.hidden = is.value !== 'bald'; }; is.addEventListener('change', sync); sync(); body.replaceChildren(is, m, h('span', { class: 'hint' }, 'Spiel deines Vereins (App „Live-Spiel“ muss an sein)'));
      read = () => ({ type: 'spiel', is: is.value, ...(is.value === 'bald' ? { minutes: Number(m.value) } : {}) });
    } else {
      const z = c.type === 'zeit' ? c : { from: '', to: '', days: [] }, from = h('input', { type: 'time', value: z.from, 'aria-label': 'von' }), to = h('input', { type: 'time', value: z.to, 'aria-label': 'bis' });
      const days = DAYS.map(([k, t]) => ({ k, box: h('input', { type: 'checkbox', checked: (z.days ?? []).includes(k), 'aria-label': t }), t }));
      body.replaceChildren(h('span', {}, 'von '), from, h('span', {}, ' bis '), to, h('span', { class: 'hint' }, '(leer = ganztägig)'), h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap;width:100%' }, days.map((d) => h('label', {}, d.box, ' ', d.t)), h('span', { class: 'hint' }, 'keine Auswahl = jeden Tag')));
      read = () => ({ type: 'zeit', from: from.value, to: to.value, days: days.filter((d) => d.box.checked).map((d) => d.k) });
    }
  };
  type.addEventListener('change', () => { c = { type: type.value }; draw(); }); draw();
  return { node: h('div', { class: 'card', style: 'margin-bottom:8px' }, h('div', { class: 'row' }, type, h('span', { class: 'sp' }), h('button', { class: 'btn link', type: 'button', onclick: remove }, 'Entfernen')), body), read: () => read() };
}

/** Dialog zum Anlegen und Ändern */
async function editor(info, rule, route, hintText = null) {
  const [pl, md, groups, devices] = await Promise.all([get('/playlists'), get('/media'), get('/groups'), get('/devices')]);
  const r = rule ?? { name: '', enabled: true, priority: 5, stableS: 0, scope: 'all', conditions: [{ type: 'wetter', is: 'regen_bald' }], content: { type: 'playlist', id: '' } };
  const name = h('input', { value: r.name, maxlength: 60, 'aria-label': 'Name der Regel', placeholder: 'zum Beispiel: Bei Regen' }), on = h('input', { type: 'checkbox', checked: r.enabled !== false, id: 'rule-on' });
  const rows = [], box = h('div', {}), addBtn = h('button', { class: 'btn sec', type: 'button' }, '＋ Weitere Bedingung');
  const addRow = (c) => { const row = condRow(c, () => { rows.splice(rows.indexOf(row), 1); row.node.remove(); addBtn.hidden = rows.length >= 4; }); rows.push(row); box.append(row.node); addBtn.hidden = rows.length >= 4; };
  r.conditions.forEach(addRow); addBtn.addEventListener('click', () => addRow({ type: 'zeit', days: [], from: '', to: '' }));
  const content = h('select', { 'aria-label': 'Inhalt' }, h('option', { value: '' }, '– bitte wählen –'), pl.filter((x) => x.state === 'published' && !x.draftOf).map((p) => h('option', { value: 'playlist:' + p.id, selected: r.content.type === 'playlist' && r.content.id === p.id ? '' : null }, 'Abspielliste: ' + p.name)),
    md.map((m) => h('option', { value: 'media:' + m.id, selected: r.content.type === 'media' && r.content.id === m.id ? '' : null }, `${m.kind === 'video' ? 'Video' : m.kind === 'text' ? 'Text' : 'Bild'}: ${m.name}`)));
  const scope = h('select', { 'aria-label': 'Wo' }, [['all', 'Alle Bildschirme'], ['group', 'Eine Gruppe'], ['device', 'Ein Bildschirm']].map(([k, t]) => h('option', { value: k, selected: k === r.scope ? '' : null }, t)));
  const target = h('select', { 'aria-label': 'Ziel' }), targetField = field('Welche(r)?', target), fill = () => { targetField.hidden = scope.value === 'all'; target.replaceChildren(...(scope.value === 'group' ? groups : devices.filter((d) => d.status.level !== 'pending')).map((x) => h('option', { value: x.id, selected: x.id === r.targetId ? '' : null }, x.name))); };
  scope.addEventListener('change', fill); fill();
  const prio = h('select', { 'aria-label': 'Wichtigkeit' }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h('option', { value: n, selected: n === r.priority ? '' : null }, n === 5 ? '5 (normal)' : String(n)))), wait = h('select', { 'aria-label': 'Wartezeit' }, WAIT.map(([s, t]) => h('option', { value: s, selected: s === r.stableS ? '' : null }, t)));
  const result = h('div', { 'aria-live': 'polite' });
  const readConds = () => rows.map((x) => x.read());
  const check = async (btn) => { btn.disabled = true; try { const p = await post('/rules/preview', { conditions: readConds() }); result.replaceChildren(h('p', {}, h('b', {}, p.ok === true ? '✔ Alles trifft gerade zu – die Regel würde jetzt zeigen.' : p.ok === false ? '✖ Gerade trifft nicht alles zu – die Regel würde jetzt nichts ändern.' : '? Eine Angabe fehlt oder ist veraltet – die Regel würde jetzt nichts ändern.')), h('ul', {}, p.items.map((i) => h('li', {}, `${mark(i.ok)} ${i.what}`, i.text ? h('span', { class: 'hint' }, ` – ${i.text}`) : null)))); } catch (e) { result.replaceChildren(h('div', { class: 'notice bad' }, e.message)); } btn.disabled = false; };
  const body = h('div', {}, hintText ? h('p', { class: 'notice' }, hintText) : null, field('Name der Regel', name), h('h3', {}, 'Wenn …'), box, addBtn, h('p', { class: 'hint' }, 'Alle Bedingungen müssen gleichzeitig zutreffen.'),
    h('div', {}, h('button', { class: 'btn sec', type: 'button', onclick: (e) => check(e.currentTarget) }, '🔍 Jetzt prüfen'), result),
    h('h3', {}, 'dann zeige …'), field('Inhalt', content), h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, field('Wo?', scope), targetField),
    h('details', {}, h('summary', {}, 'Weitere Einstellungen'), field('Wichtigkeit (1–9)', prio, 'Gelten zwei Regeln gleichzeitig für denselben Bildschirm, gewinnt die wichtigere.'), field('Die Bedingung muss durchgehend gelten', wait, 'Gegen kurze Schauer oder Datenschwankungen. Zum Beenden wartet jede Regel mit Wetter oder Spiel 2 Minuten.')),
    h('label', { class: 'row', for: 'rule-on' }, on, h('b', {}, ' Regel ist eingeschaltet')));
  const isEdit = !!rule?.id; // Vorlagen haben noch keine Nummer: sie legen eine neue Regel an
  dialog(isEdit ? 'Regel ändern' : 'Neue Regel', body, [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => {
    if (!content.value) { toast('Bitte wähle, was gezeigt werden soll.', 'err'); return false; }
    const [type, ...id] = content.value.split(':'), payload = { name: name.value, enabled: on.checked, priority: Number(prio.value), conditions: readConds(), content: { type, id: id.join(':') }, scope: scope.value, ...(scope.value === 'all' ? {} : { targetId: target.value }), stableS: Number(wait.value) };
    try { isEdit ? await put(`/rules/${rule.id}`, payload) : await post('/rules', payload); toast('Gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

function card(rule, route, edit) {
  const [cls, icon, label] = STATUS[rule.status] ?? ['', '', rule.status];
  return h('article', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, rule.name), h('span', { class: 'sp' }), h('span', { class: 'status ' + cls }, h('span', { 'aria-hidden': 'true' }, icon), label)),
    h('p', {}, h('b', {}, 'Wenn '), rule.checks.length ? '' : '…'), h('ul', { style: 'margin:0 0 8px 1.2em;padding:0' }, rule.checks.map((c) => h('li', {}, `${mark(c.ok)} ${c.what}`, c.text ? h('span', { class: 'hint' }, ` – ${c.text}`) : null))),
    h('p', {}, h('b', {}, 'dann zeige '), `„${rule.content.name ?? '(gelöscht)'}“ auf ${rule.targetName} `, h('span', { class: 'hint' }, `(Wichtigkeit ${rule.priority}${rule.stableS ? `, Wartezeit ${Math.round(rule.stableS / 60)} Min.` : ''})`)),
    h('p', { class: 'hint' }, rule.statusText),
    can('scenes.write') ? h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
      rule.status === 'pausiert' ? h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try { await post(`/rules/${rule.id}/resume`); toast('Die Regel läuft wieder.'); } catch (er) { toast(er.message, 'err'); } route(); } }, '▶ Jetzt wieder starten') : null,
      h('button', { class: 'btn sec', onclick: () => edit(rule) }, 'Ändern'),
      h('button', { class: 'btn sec', onclick: async (e) => { e.currentTarget.disabled = true; try { await put(`/rules/${rule.id}`, { name: rule.name, enabled: !rule.enabled, priority: rule.priority, conditions: rule.conditions, content: { type: rule.content.type, id: rule.content.id }, scope: rule.scope, ...(rule.scope === 'all' ? {} : { targetId: rule.targetId }), stableS: rule.stableS }); } catch (er) { toast(er.message, 'err'); } route(); } }, rule.enabled ? 'Ausschalten' : 'Einschalten'),
      h('button', { class: 'btn link', onclick: async () => { if (await confirmDlg('Regel löschen?', `„${rule.name}“ wird gelöscht. Läuft sie gerade, kehren die Bildschirme zum normalen Plan zurück.`, 'Ja, löschen')) { try { await del(`/rules/${rule.id}`); toast('Gelöscht.'); } catch (er) { toast(er.message, 'err'); } route(); } } }, 'Löschen')) : null);
}

export async function regelnPage({ route }) {
  const info = await get('/rules'), edit = (rule) => editor(info, rule, route), root = h('div', {}, h('h1', {}, 'Regeln'),
    h('p', { class: 'lead' }, 'Der Hub prüft jede Minute, ob eine Regel zutrifft („Wenn es regnet …“, „Wenn das Spiel läuft …“, „Samstags von 10 bis 12 Uhr …“) und zeigt dann automatisch den gewählten Inhalt. Sobald die Bedingung nicht mehr gilt, geht es zurück zum normalen Plan.'),
    h('p', { class: 'hint' }, info.hint));
  if (can('scenes.write')) root.append(h('section', { class: 'card', style: 'margin-bottom:16px' }, h('h2', { style: 'margin-top:0' }, 'Neue Regel'), h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
    info.templates.map((t) => h('button', { class: 'btn sec', title: t.hint, onclick: () => { const need = t.needs && !info.apps[t.needs]; editor(info, { ...t.rule, enabled: true, scope: 'all', content: { type: 'playlist', id: '' } }, route, `${t.hint}${need ? ` Achtung: Dafür muss die App „${t.needs === 'wetter' ? 'Wetter' : 'Live-Spiel & Tor-Jubel'}“ eingeschaltet sein (Menü Apps).` : ''}`).catch((e) => toast(e.message, 'err')); } }, `${t.icon} ${t.name}`)),
    h('button', { class: 'btn', onclick: () => edit(null).catch((e) => toast(e.message, 'err')) }, '＋ Eigene Regel'))));
  root.append(info.rules.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(360px,1fr))' }, info.rules.map((r) => card(r, route, (x) => edit(x).catch((e) => toast(e.message, 'err')))))
    : empty('Noch keine Regel', 'Wähle oben eine Vorlage, zum Beispiel „Bei Regen“, und bestimme, was dann gezeigt werden soll.'));
  root.append(h('p', {}, h('button', { class: 'btn link', onclick: () => route() }, '↻ Status aktualisieren')));
  return root;
}
