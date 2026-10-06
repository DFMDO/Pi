// Playerseite (Chromium). Wertet den lokal gespeicherten Plan selbst aus – funktioniert
// auch bei Hub- und WLAN-Ausfall. Dieselbe Logik wie die Tests (shared/sequencer.js).
import { resolvePlaylist, playableItems } from '/shared/sequencer.js';

const stage = document.getElementById('stage'), overlay = document.getElementById('overlay');
let plan = null, manifest = null, health = {}, gen = 0, front = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (u) => fetch(u, { cache: 'no-store' }).then((r) => r.json());

async function refresh() {
  [plan, manifest, health] = await Promise.all([j('/plan.json'), j('/manifest.json'), j('/health')]);
  document.body.classList.toggle('black', !!health.displayOff);
  const deg = health.orientation ?? 0; stage.className = deg ? 'r' + deg : ''; stage.style.setProperty('--rot', deg + 'deg');
}
function el(tag, cls, ...kids) { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; }

// Besucher sehen nie Technikmeldungen über Inhalten. Hinweise erscheinen nur, wenn es gar nichts zu zeigen gibt.
function standby() {
  const logo = el('img'); logo.src = '/assets/dfm-logo.svg'; logo.alt = 'Deutsches Fußballmuseum';
  if (health.pairing) return el('div', 'notice', logo, el('p', '', `Bitte bestätige diesen Bildschirm im Hub: „${health.deviceName ?? ''}“ – Ist das dein Bildschirm? → Ja.`));
  if (health.timeSynced === false) return el('div', 'notice', logo, el('p', '', 'Einen Moment bitte – der Bildschirm startet gleich.'));
  const longOffline = health.offlineSince && Date.now() - health.offlineSince > 24 * 3600e3 && health.cacheEmpty;
  return longOffline ? el('div', 'notice', logo, el('p', '', 'Dieser Bildschirm wartet auf Verbindung. Bitte die Museums-IT informieren.')) : el('div', 'standby', logo);
}
function build(item) {
  if (item.kind === 'text') { const t = item.text ?? {}; return el('div', 'text ' + (t.template ?? 'standard'), el('h1', '', t.title ?? ''), el('p', '', t.body ?? '')); }
  const src = '/media/' + item.mediaId;
  if (item.kind === 'video') { const v = el('video'); v.muted = true; v.playsInline = true; v.src = src; return v; }
  const i = el('img'); i.src = src; i.alt = item.name ?? ''; return i;
}
async function show(node, transition) {
  const layer = el('div', 'layer' + (transition === 'cut' ? ' cut' : ''), node); stage.append(layer);
  const media = node.tagName === 'VIDEO' || node.tagName === 'IMG' ? node : null;
  if (media) await new Promise((res) => { media.onloadeddata = media.onload = res; media.onerror = res; setTimeout(res, 8000); });
  requestAnimationFrame(() => layer.classList.add('on'));
  const old = front; front = layer;
  if (old) setTimeout(() => old.remove(), transition === 'cut' ? 50 : 700);
  return node;
}

async function main() {
  await refresh().catch(() => {});
  let idx = 0, lastPl = null;
  for (;;) {
    const now = Date.now(), r = resolvePlaylist(plan, now);
    const { items } = playableItems(plan, r.playlistId, manifest, { profile: health.profile ?? 'standard', now, have: (m) => (health.cached ?? []).includes(m.id) }); // noch nicht geladene Medien werden übersprungen
    if (r.playlistId !== lastPl) { idx = 0; lastPl = r.playlistId; }
    if (!items.length) { await show(standby(), 'fade'); await sleep(5000); continue; }
    const item = items[idx % items.length]; idx++;
    const node = build(item); await show(node, item.transition);
    const nx = items[idx % items.length]; fetch('/status', { method: 'POST', body: JSON.stringify({ current: { mediaId: item.mediaId, name: item.name, kind: item.kind, duration: item.duration }, next: items.length > 1 ? { mediaId: nx.mediaId, name: nx.name } : null }) }).catch(() => {});
    let ms = item.duration * 1000;
    if (node.tagName === 'VIDEO') { // Video wird immer zu Ende gespielt
      await node.play().catch(() => {}); ms = await new Promise((res) => { node.onended = () => res(0); node.onerror = () => res(0); setTimeout(() => res(0), ((item.durationS ?? 60) + 5) * 1000); });
    } else {
      if (r.until) ms = Math.min(ms, Math.max(0, r.until - Date.now())); // sekundengenau an der Terminkante wechseln
      await sleep(Math.max(ms, 300));
    }
  }
}
const ev = new EventSource('/events');
ev.addEventListener('black', () => document.body.classList.add('black')); ev.addEventListener('unblack', () => document.body.classList.remove('black'));
ev.addEventListener('plan', refresh); ev.addEventListener('manifest', refresh); ev.addEventListener('reload', () => location.reload());
setInterval(() => refresh().catch(() => {}), 30000);
main();
