// Update vom USB-Stick: Pakete auf dem Stick werden vorab geprüft angezeigt; installiert wird erst nach Rückfrage.
import { h, confirmDlg, toast } from '../ui.js';
import { get, post, can } from '../api.js';

const REL = { 1: 'neuer als die installierte Version', 0: 'gleiche Version wie installiert', [-1]: 'ÄLTER als die installierte Version' };
/** @param onlyNewer Startseite: nur anbieten, was wirklich neuer ist. Einstellungen: alles zeigen, auch ungültige Pakete mit Grund. */
export async function usbUpdateBox({ onlyNewer = false } = {}) {
  if (!can('update.manage')) return null;
  let r; try { r = await get('/update/usb'); } catch { return null; }
  const list = onlyNewer ? r.packages.filter((p) => p.valid && p.newer === 1) : r.packages; if (!list.length) return null;
  const install = async (p, btn) => {
    const older = p.newer === -1;
    if (!(await confirmDlg(`Update auf Version ${p.version} installieren?`, `${older ? 'ACHTUNG: Das ist eine ÄLTERE Version als die installierte. ' : ''}Der Hub startet danach kurz neu (etwa eine Minute). Die Bildschirme laden das Update danach auf Wunsch (Erweitert → Update). Das Update ändert das Programm, nicht das Betriebssystem.`, 'Jetzt installieren', older))) return;
    btn.disabled = true; try { const x = await post('/update/usb/install', { name: p.name, confirmed: true }); toast(x.text); setTimeout(() => location.reload(), 9000); } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  };
  return h('div', { class: 'notice ok', role: 'status' }, h('b', {}, '📦 Update auf dem USB-Stick'), r.current ? h('span', { class: 'hint' }, ` (installiert: Version ${r.current})`) : null,
    h('ul', { class: 'cleanlist' }, list.map((p) => h('li', {}, p.valid
      ? [h('b', {}, `Version ${p.version}`), ` – ${REL[p.newer] ?? ''} · Signatur ✔ · `, h('span', { class: 'hint' }, p.name), p.notes ? h('div', { class: 'hint' }, p.notes) : null, h('div', {}, h('button', { class: 'btn', onclick: (e) => install(p, e.currentTarget) }, 'Installieren'))]
      : [h('span', { class: 'status bad' }, '✖ nicht verwendbar'), ' ', h('b', {}, p.name), h('div', { class: 'hint' }, p.error)]))));
}
