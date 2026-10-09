// Grundriss je Etage: Wo hängt welcher Bildschirm – und läuft er? Platzieren per Antippen (kein Ziehen nötig, geht auch am Handy).
import { h, dialog, confirmDlg, toast, field, statusEl, empty } from '../ui.js';
import { api, get, post, put, patch, del, can } from '../api.js';

export async function grundrissPage({ route }) {
  const data = await get('/floors'); const edit = can('devices.manage');
  let cur = sessionStorageGet('dfm-floor') ?? data.floors[0]?.id; if (!data.floors.some((f) => f.id === cur)) cur = data.floors[0]?.id;
  const root = h('div', {}, h('h1', {}, 'Grundriss'), h('p', { class: 'lead' }, 'Hier siehst du, wo welcher Bildschirm hängt und ob er läuft.'));
  if (!data.floors.length) return root.append(empty('Noch keine Etage angelegt', edit ? 'Lege eine Etage an und lade ein Bild des Grundrisses hoch (Foto, Scan oder Export als JPG/PNG).' : 'Ein Admin muss zuerst eine Etage anlegen.', edit ? h('button', { class: 'btn big', onclick: () => addFloor(route) }, 'Etage anlegen') : null)), root;
  const floor = data.floors.find((f) => f.id === cur);
  let picked = null; // Bildschirm, der gerade platziert wird
  const bar = h('div', { class: 'row', role: 'tablist', style: 'margin:8px 0' }, data.floors.map((f) => h('button', { class: 'chip', role: 'tab', 'aria-pressed': f.id === cur, onclick: () => { sessionStorageSet('dfm-floor', f.id); route(); } }, f.name)),
    edit ? h('button', { class: 'chip', onclick: () => addFloor(route) }, '＋ Etage') : null);
  const plan = h('div', { class: 'plan' + (floor.hasImage ? '' : ' empty'), 'aria-label': `Grundriss ${floor.name}` });
  if (floor.hasImage) plan.append(h('img', { src: `/api/v1/floors/${floor.id}/image?t=${Date.now() >> 12}`, alt: `Grundriss ${floor.name}`, draggable: 'false' })); else plan.append(h('p', {}, edit ? 'Noch kein Grundriss hochgeladen. Wähle unten „Grundriss hochladen“.' : 'Für diese Etage gibt es noch keinen Grundriss.'));
  const pins = () => { for (const p of plan.querySelectorAll('.pin')) p.remove();
    for (const d of floor.devices) plan.append(h('button', { class: 'pin ' + d.status.level, style: `left:${d.x}%;top:${d.y}%`, 'aria-label': `${d.name}: ${d.status.label}`, onclick: (e) => { e.stopPropagation(); if (edit && picked == null) openPin(d); else if (!edit) location.hash = `#/live/${d.id}`; } }, h('span', { 'aria-hidden': 'true' }, d.status.icon), ' ', d.name)); };
  pins();
  const hint = h('p', { class: 'notice', role: 'status', hidden: '' }, '');
  plan.addEventListener('click', async (e) => {
    if (!edit || !picked || !floor.hasImage) return; const r = plan.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), y = Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100));
    try { await put(`/devices/${picked.id}/plan`, { floorId: floor.id, x, y }); toast(`„${picked.name}“ ist jetzt auf dem Grundriss.`); route(); } catch (err) { toast(err.message, 'err'); }
  });
  function openPin(d) {
    dialog(d.name, h('div', {}, h('p', {}, statusEl(d.status)), d.location ? h('p', { class: 'hint' }, d.location) : null, h('p', {}, h('a', { class: 'btn sec', href: `#/live/${d.id}` }, 'Live ansehen'))), [
      { text: 'Position ändern', cls: 'sec', fn: () => { picked = d; hint.hidden = false; hint.textContent = `Tippe jetzt auf die neue Stelle im Grundriss für „${d.name}“.`; pins(); } },
      { text: 'Vom Grundriss entfernen', cls: 'sec', fn: async () => { await put(`/devices/${d.id}/plan`, { floorId: null }); toast('Entfernt.'); route(); } }, { text: 'Schließen' }]);
  }
  const list = h('div', { class: 'row', style: 'margin:8px 0' });
  if (edit && floor.hasImage) list.append(h('b', {}, 'Bildschirm platzieren: '), ...(data.unplaced.length ? data.unplaced.map((d) => h('button', { class: 'chip', 'aria-pressed': picked?.id === d.id, onclick: () => { picked = picked?.id === d.id ? null : d; hint.hidden = !picked; hint.textContent = picked ? `Tippe jetzt auf die Stelle im Grundriss, an der „${d.name}“ hängt.` : ''; list.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(picked && c.textContent === picked.name))); } }, d.name)) : [h('span', { class: 'hint' }, 'Alle Bildschirme sind platziert.')]));
  const manage = edit ? h('div', { class: 'row', style: 'margin-top:12px' },
    h('label', { class: 'btn sec', style: 'cursor:pointer' }, '🖼️ Grundriss hochladen', h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr', onchange: async (e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); try { await api('PUT', `/floors/${floor.id}/image`, fd); toast('Grundriss gespeichert.'); route(); } catch (err) { toast(err.message, 'err'); } } })),
    h('button', { class: 'btn sec', onclick: () => renameFloor(floor, route) }, 'Umbenennen'),
    h('button', { class: 'btn sec', onclick: async () => { if (await confirmDlg('Etage löschen?', `„${floor.name}“ und die Positionen der Bildschirme auf diesem Grundriss werden entfernt. Die Bildschirme selbst bleiben.`, 'Löschen')) { await del(`/floors/${floor.id}`); toast('Etage gelöscht.'); route(); } } }, 'Etage löschen')) : null;
  root.append(bar, hint, list, plan, manage, h('p', { class: 'hint' }, 'Grün = läuft, gelb = keine Verbindung, rot = nicht erreichbar.'));
  return root;
}
function addFloor(route) { const n = h('input', { maxlength: 60, placeholder: 'z. B. Erdgeschoss' }); dialog('Etage anlegen', field('Name der Etage', n), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Anlegen', fn: async () => { if (!n.value.trim()) { toast('Bitte gib einen Namen ein.', 'err'); return false; } try { const r = await post('/floors', { name: n.value.trim() }); sessionStorageSet('dfm-floor', r.id); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]); }
function renameFloor(f, route) { const n = h('input', { maxlength: 60, value: f.name }); dialog('Etage umbenennen', field('Name', n), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await patch(`/floors/${f.id}`, { name: n.value.trim() }); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]); }
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
