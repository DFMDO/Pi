// Präsentation (z. B. PowerPoint) im Notfall zeigen: PDF oder Video hochladen → Liste anlegen → auf allen/einem Bildschirm zeigen.
// PowerPoint selbst kann der Hub nicht öffnen: Die Datei wird vorher in PowerPoint als PDF (oder MP4-Video) gespeichert.
import { h, dialog, field, toast } from '../ui.js';
import { api, get, post, put } from '../api.js';

const DURS = [['30', '30 Minuten'], ['60', '1 Stunde'], ['120', '2 Stunden'], ['eod', 'bis Tagesende']];
const SECS = [['5', '5 Sekunden'], ['10', '10 Sekunden'], ['15', '15 Sekunden'], ['30', '30 Sekunden'], ['60', '1 Minute']];
const durBody = (v) => (v === 'eod' ? { endOfDay: true } : { minutes: Number(v) });
const PPT = /\.(pptx?|ppsx?|potx?|odp|key)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wartet, bis die Medien für alle Bildschirme vorbereitet sind (PDF-Seiten werden je Profil in Bilder umgerechnet). Gibt nach spätestens 10 Minuten auf. */
export async function waitUntilReady(ids, setStatus, { everyMs = 2000, maxMs = 600000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const all = await get('/media'); const mine = all.filter((m) => ids.includes(m.id));
    const ready = mine.filter((m) => m.variants.length > 0 && m.variants.every((v) => v.status === 'ready' || v.status === 'failed') && m.variants.some((v) => v.status === 'ready'));
    setStatus(`Folien werden vorbereitet: ${ready.length} von ${ids.length} …`);
    if (ready.length === ids.length) return true;
    if (Date.now() - t0 > maxMs) return false;
    await sleep(everyMs);
  }
}

export async function presentationDialog(route) {
  const devices = (await get('/devices')).filter((d) => d.status.level !== 'pending');
  if (!devices.length) { toast('Es ist noch kein Bildschirm verbunden.', 'err'); return; }
  const file = h('input', { type: 'file', accept: '.pdf,application/pdf,.mp4,.mov,.mkv,video/*', 'aria-label': 'PDF oder Video auswählen' });
  const secs = h('select', { 'aria-label': 'Dauer pro Folie' }, SECS.map(([k, t]) => h('option', { value: k, selected: k === '15' ? '' : null }, t)));
  const dur = h('select', { 'aria-label': 'Wie lange zeigen' }, DURS.map(([k, t]) => h('option', { value: k }, t)));
  const target = h('select', { 'aria-label': 'Auf welchen Bildschirmen' }, h('option', { value: 'all' }, 'Auf ALLEN Bildschirmen'), devices.map((d) => h('option', { value: d.id }, d.name)));
  const status = h('p', { role: 'status', 'aria-live': 'polite', class: 'hint' }, '');
  const body = h('div', {},
    h('p', { class: 'notice' }, 'PowerPoint kann der Hub nicht direkt öffnen. In PowerPoint: ', h('b', {}, 'Datei → Exportieren → „PDF/XPS-Dokument erstellen“'), ' (jede Folie wird ein Bild, höchstens 60). Mit Animationen oder Ton: ', h('b', {}, 'Exportieren → „Video erstellen“ → Full HD'), ' und als MP4 speichern.'),
    field('PDF oder Video auswählen', file), field('Dauer pro Folie (bei PDF)', secs), field('Wie lange zeigen?', dur), field('Wo zeigen?', target),
    h('p', { class: 'hint' }, 'Das übersteuert alle Termine auf den gewählten Bildschirmen. Danach springen sie automatisch zum normalen Plan zurück, oder du beendest es vorher auf der Startseite.'), status);
  dialog('📑 Präsentation zeigen (z. B. PowerPoint)', body, [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Hochladen und zeigen', cls: 'danger', fn: async (d) => {
    const f = file.files?.[0];
    try {
      if (!f) throw new Error('Bitte wähle zuerst eine Datei aus.');
      if (PPT.test(f.name)) throw new Error('Das ist eine PowerPoint-Datei. Bitte zuerst in PowerPoint als PDF (Datei → Exportieren → PDF) oder als Video (MP4) speichern und diese Datei auswählen.');
      for (const b of d.querySelectorAll('button')) b.disabled = true;
      status.textContent = 'Datei wird hochgeladen …';
      const fd = new FormData(); fd.append('folder', 'Präsentation'); fd.append('file', f);
      const up = await api('POST', '/media', fd);
      const ids = up.ids;
      status.textContent = 'Liste wird angelegt …';
      const pl = await post('/playlists', { name: `Präsentation: ${f.name}`.slice(0, 80), publish: true });
      await put(`/playlists/${pl.id}`, { items: up.items.map((m) => ({ mediaId: m.id, ...(m.kind === 'video' ? {} : { duration: Number(secs.value) }) })), publish: true });
      const ok = await waitUntilReady(ids, (t) => { status.textContent = t; });
      if (!ok) toast('Nicht alle Folien sind fertig vorbereitet. Sie erscheinen nach und nach.', 'err');
      status.textContent = 'Wird angezeigt …';
      const r = await post('/overrides', { scope: target.value === 'all' ? 'all' : 'device', ...(target.value === 'all' ? {} : { targetId: target.value }), content: { type: 'playlist', id: pl.id }, confirm: true, ...durBody(dur.value) });
      toast(r.text); route();
    } catch (e) { toast(e.message, 'err'); for (const b of d.querySelectorAll('button')) b.disabled = false; status.textContent = ''; return false; }
  } }]);
}
