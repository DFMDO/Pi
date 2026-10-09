// Bildschirm teilen: den eigenen PC-Bildschirm auf Museumsbildschirme übertragen (z. B. für eine Präsentation). Nur Chrome/Edge am PC.
// Die Aufnahme läuft in einem Hintergrund-Thread (share-worker.js), damit sie auch weiterläuft, wenn ein Präsentationsfenster diese Seite verdeckt.
import { h, dialog, toast, field } from '../ui.js';
import { get, post, del, state } from '../api.js';

/* global __SHARE_WORKER__ */
const DURS = [['30', '30 Minuten'], ['60', '1 Stunde'], ['120', '2 Stunden'], ['240', '4 Stunden']];
const QUAL = { text: { label: 'Folien und Text (scharf, wenig Bewegung)', maxWidth: 1920, quality: 0.8 }, video: { label: 'Bewegtbild (flüssiger, etwas weicher)', maxWidth: 1280, quality: 0.62 } };
const supported = () => !!(navigator.mediaDevices?.getDisplayMedia && typeof MediaStreamTrackProcessor !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && window.isSecureContext);
let active = null; // { id, stop(), names }

/** Laufende Übertragung dieses Browsers: Balken am unteren Rand, bleibt auch beim Seitenwechsel */
function banner(names, until) {
  const bar = h('div', { class: 'sharebar', role: 'status', 'aria-live': 'polite' }, h('b', {}, '🖥️ Du teilst gerade deinen Bildschirm'), ` auf ${names.join(', ')}. `, h('span', { class: 'hint' }, `Ende spätestens ${new Date(until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr. `), h('button', { class: 'btn', onclick: () => active?.stop('beendet') }, '⏹ Beenden'));
  document.body.append(bar); return bar;
}

export async function shareDlg(route) {
  if (active) { toast('Du teilst schon einen Bildschirm. Beende zuerst die laufende Übertragung (Balken unten).', 'err'); return; }
  const devices = (await get('/devices')).filter((d) => d.status.level !== 'pending'); if (!devices.length) { toast('Es ist noch kein Bildschirm verbunden.', 'err'); return; }
  const checks = devices.map((d) => { const online = d.status.level === 'ok', mpv = d.renderer === 'mpv' || d.profile === 'lite'; const c = h('input', { type: 'checkbox', disabled: online ? null : '', id: 'sh-' + d.id, 'aria-label': d.name });
    return { d, c, row: h('li', {}, h('label', { for: 'sh-' + d.id }, c, ' ', h('b', {}, d.name)), h('span', { class: 'hint' }, online ? (mpv ? ' · Video-optimiert: einfache Darstellung, etwa 1 Bild pro Sekunde' : ' · Browser-Anzeige: flüssig, etwa 5 Bilder pro Sekunde') : ' · keine Verbindung, nicht auswählbar')) }; });
  const all = h('button', { type: 'button', class: 'btn link', onclick: () => checks.forEach(({ c }) => { if (!c.disabled) c.checked = true; }) }, 'Alle verbundenen auswählen');
  const dur = h('select', { 'aria-label': 'Wie lange höchstens' }, DURS.map(([k, t]) => h('option', { value: k, selected: k === '60' ? '' : null }, t))), qual = h('select', { 'aria-label': 'Qualität' }, Object.entries(QUAL).map(([k, q]) => h('option', { value: k }, q.label)));
  const body = h('div', {},
    supported() ? null : h('div', { class: 'notice bad', role: 'alert' }, 'Dieser Browser kann den Bildschirm nicht an den Hub übertragen. Bitte am PC Google Chrome oder Microsoft Edge benutzen und die Verwaltung über https öffnen.'),
    h('p', {}, 'Dein PC-Bildschirm (ganz, ein Fenster oder ein Browser-Tab, das wählst du gleich) erscheint live auf den ausgewählten Museumsbildschirmen. Der Plan pausiert dort. Alles bleibt im Haus.'),
    h('p', { class: 'hint' }, 'Diese Seite muss geöffnet bleiben, ein Tab im Hintergrund ist in Ordnung. Ton wird nicht übertragen. Es entsteht eine Verzögerung von etwa einer halben bis ganzen Sekunde.'),
    h('h3', {}, 'Auf welchen Bildschirmen?'), h('ul', { class: 'cleanlist' }, checks.map((x) => x.row)), h('p', {}, all), field('Wie lange höchstens?', dur), field('Qualität', qual));
  dialog('🖥️ Bildschirm teilen', body, [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Teilen starten', fn: async () => {
    const ids = checks.filter(({ c }) => c.checked).map(({ d: x }) => x.id); if (!ids.length) { toast('Bitte wähle mindestens einen Bildschirm aus.', 'err'); return false; }
    if (!supported()) { toast('Dieser Browser kann das nicht. Bitte Chrome oder Edge verwenden.', 'err'); return false; }
    let stream; try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false }); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Die Auswahl des Bildschirms wurde abgebrochen.' : `Die Aufnahme konnte nicht starten: ${e.message}`, 'err'); return false; }
    let s; try { s = await post('/share', { deviceIds: ids, minutes: Number(dur.value) }); } catch (e) { stream.getTracks().forEach((t) => t.stop()); toast(e.message, 'err'); return false; }
    const [track] = stream.getVideoTracks(), proc = new MediaStreamTrackProcessor({ track }), worker = new Worker(__SHARE_WORKER__), q = QUAL[qual.value], names = s.devices.map((x) => x.name);
    const fps = s.devices.some((x) => x.mode === 'browser') ? s.fps.browser : s.fps.mpv; let bar = null, done = false;
    const stop = async (why) => { if (done) return; done = true; active = null; stream.getTracks().forEach((t) => t.stop()); worker.terminate(); bar?.remove(); await del(`/share/${s.id}`).catch(() => {}); toast(why === 'beendet' ? 'Die Übertragung ist beendet. Die Bildschirme zeigen wieder den normalen Plan.' : why, why === 'beendet' ? 'ok' : 'err'); };
    active = { id: s.id, stop, names };
    worker.onmessage = (m) => { if (m.data.type === 'ended') stop(m.data.reason === 'Die Bildschirm-Freigabe wurde beendet.' ? 'beendet' : m.data.reason); }; track.onended = () => stop('beendet');
    worker.postMessage({ readable: proc.readable, csrf: state.csrf, id: s.id, maxWidth: q.maxWidth, fps, quality: q.quality }, [proc.readable]);
    bar = banner(names, s.until); toast(s.text); if (s.skipped?.length) toast(`Nicht dabei: ${s.skipped.map((x) => `${x.name} (${x.reason})`).join(' ')}`, 'err'); route?.();
  } }]);
}

/** Startseite: laufende Übertragungen anderer (oder eigene aus einem anderen Tab) mit Beenden-Knopf */
export function shareNotices(list, route) {
  return list.filter((s) => !(active && active.id === s.id)).map((s) => h('div', { class: 'notice bad', role: 'status' }, h('b', {}, `🖥️ ${s.by} teilt gerade einen Bildschirm `), `auf ${s.devices.join(', ')} (bis ${new Date(s.until).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr). `,
    h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try { await del(`/share/${s.id}`); toast('Die Übertragung ist beendet.'); route(); } catch (x) { toast(x.message, 'err'); e.currentTarget.disabled = false; } } }, 'Übertragung beenden')));
}
