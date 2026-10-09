// Playerseite (Chromium). Wertet den lokal gespeicherten Plan selbst aus – funktioniert
// auch bei Hub- und WLAN-Ausfall. Dieselbe Logik wie die Tests (shared/sequencer.js).
import { resolvePlaylist, playableItems } from '/shared/sequencer.js';

const stage = document.getElementById('stage'), overlay = document.getElementById('overlay');
let plan = null, manifest = null, health = {}, gen = 0, front = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (u) => fetch(u, { cache: 'no-store' }).then((r) => r.json());

async function refresh() {
  [plan, manifest, health] = await Promise.all([j('/plan.json'), j('/manifest.json'), j('/health')]);
  document.body.classList.toggle('black', !!health.displayOff || (resolvePlaylist(plan, Date.now()).off === true));
  if (typeof applyLayout === 'function') applyLayout();
  const fit = plan?.fit ?? { fit: 'contain', safe: 0 }; stage.style.setProperty('--fit', fit.fit === 'cover' ? 'cover' : 'contain'); stage.style.setProperty('--safe', (fit.safe ?? 0) + '%'); // Hochkant/Seitenverhältnis, Sicherheitsrand gegen Overscan
  const deg = health.orientation ?? 0; stage.className = deg ? 'r' + deg : ''; stage.style.setProperty('--rot', deg + 'deg');
}
function el(tag, cls, ...kids) { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; }

// Besucher sehen nie Technikmeldungen über Inhalten. Hinweise erscheinen nur, wenn es gar nichts zu zeigen gibt.
function standby() {
  const logo = el('img'); logo.src = '/assets/dfm-logo.svg'; logo.alt = 'Deutsches Fußballmuseum';
  if (health.pairing) return el('div', 'notice', logo, el('p', '', `Bitte bestätige diesen Bildschirm im Hub: „${health.deviceName ?? ''}“ – Ist das dein Bildschirm? → Ja.`));
  if (health.timeSynced === false) return el('div', 'notice', logo, el('p', '', 'Einen Moment bitte – der Bildschirm startet gleich.'));
  const longOffline = health.offlineSince && Date.now() - health.offlineSince > 24 * 3600e3 && health.cacheEmpty;
  if (longOffline) return el('div', 'notice', logo, el('p', '', 'Dieser Bildschirm wartet auf Verbindung. Bitte die Museums-IT informieren.'));
  // Hub und Bildschirm in einem Gerät, noch ohne Inhalte: Adresse der Verwaltung anzeigen (der Einrichter muss sie nirgends suchen)
  if (health.isHub && health.addresses?.length) return el('div', 'standby', logo, el('p', 'addr', 'Verwaltung im Browser öffnen:'), ...health.addresses.map((a) => el('p', 'addr big', 'https://' + a)), el('p', 'addr', 'oder https://dfm-signage.local'));
  return el('div', 'standby', logo);
}
function build(item) {
  if (item.kind === 'text') { const t = item.text ?? {}; return el('div', 'text ' + (t.template ?? 'standard') + (t.compact ? ' compact' : ''), el('h1', '', t.title ?? ''), el('p', '', t.body ?? '')); }
  const src = '/media/' + item.mediaId;
  if (item.kind === 'video') { const v = el('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.disableRemotePlayback = true; v.src = src; return v; }
  const i = el('img'); i.src = src; i.alt = item.name ?? ''; return i;
}
/** Video-Decoder sofort freigeben: Der Pi hat nur wenige Hardware-Decoder – ein „vergessenes“ Video würde den nächsten ausbremsen */
function release(layer) { for (const v of layer.querySelectorAll('video')) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} } }
async function show(node, transition) {
  const layer = el('div', 'layer' + (transition === 'cut' ? ' cut' : ''), node); stage.append(layer);
  const media = node.tagName === 'VIDEO' || node.tagName === 'IMG' ? node : null;
  if (media) await new Promise((res) => { media.onloadeddata = media.onload = res; media.onerror = res; setTimeout(res, 8000); });
  requestAnimationFrame(() => layer.classList.add('on'));
  const old = front; front = layer;
  if (old) setTimeout(() => { release(old); old.remove(); }, transition === 'cut' ? 50 : 700);
  return node;
}

async function main() {
  await refresh().catch(() => {});
  let idx = 0, lastPl = null;
  for (;;) {
    const now = Date.now(), r = resolvePlaylist(plan, now); document.body.classList.toggle('black', !!health.displayOff || r.off === true);
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
// ---- Zonen (Z.7): Laufband und Uhr/Datum; Lite hat keine Zonen (der Hub liefert dort kein Layout) ----
const bar = el('div', 'bar'); bar.hidden = true; const tick = el('div', 'ticker'), clock = el('div', 'clock'), info = el('div', 'infozone'); bar.append(tick, clock); stage.append(bar, info);
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
function applyLayout() {
  const L = plan?.layout?.preset ?? null; const on = !!L && !health.displayOff;
  bar.hidden = !on; info.hidden = !(L === 'ticker-clock-info' && plan.layout.info); stage.classList.toggle('zones', on); stage.classList.toggle('side', !info.hidden);
  if (!on) return;
  clock.hidden = L === 'ticker'; const d = today();
  const msgs = (plan.tickers ?? []).filter((t) => (!t.validFrom || d >= t.validFrom) && (!t.validTo || d <= t.validTo)).map((t) => t.text);
  const text = msgs.length ? msgs.join('     •     ') : '';
  if (tick.dataset.t !== text) { tick.dataset.t = text; tick.replaceChildren(); if (text) { const sp = el('span', '', text + '     •     '); tick.append(sp); sp.style.setProperty('animation-duration', Math.max(12, text.length * 0.22) + 's'); } }
  info.replaceChildren(el('div', '', plan.layout.info ?? ''));
}
function tickClock() { const n = new Date(); clock.replaceChildren(el('b', '', n.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })), el('small', '', n.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long' }))); }
setInterval(tickClock, 10000); tickClock();

// ---- Erkennen und Testbild (Z.8): nur vorübergehend, nie für Besucher gedacht ----
let ovTimer = null;
function overlayShow(node, ms) { overlay.replaceChildren(node); overlay.hidden = false; clearTimeout(ovTimer); if (ms) ovTimer = setTimeout(() => { overlay.hidden = true; overlay.replaceChildren(); }, ms); }
function identify(d) { overlayShow(el('div', 'ident', el('h1', '', d.name ?? ''), el('p', '', d.location ?? ''), el('div', 'num', d.number ?? '')), (d.seconds ?? 10) * 1000); }
function testPattern(d) {
  if (!d.on) { overlay.hidden = true; overlay.replaceChildren(); return; }
  const bars = el('div', 'bars'); for (const c of ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000']) { const b = el('i'); b.style.setProperty('background', c); bars.append(b); }
  overlayShow(el('div', 'pattern', bars, el('div', 'grid'), el('div', 'arrow', '▲ OBEN'), el('div', 'res', `${innerWidth} × ${innerHeight} px · ${(innerWidth / innerHeight).toFixed(2)}:1 · Ränder und Ausrichtung prüfen`)), (d.seconds ?? 120) * 1000);
}
const ev = new EventSource('/events');
ev.addEventListener('identify', (e) => identify(JSON.parse(e.data))); ev.addEventListener('testpattern', (e) => testPattern(JSON.parse(e.data)));
ev.addEventListener('black', () => document.body.classList.add('black')); ev.addEventListener('unblack', () => document.body.classList.remove('black'));
ev.addEventListener('plan', refresh); ev.addEventListener('manifest', refresh); ev.addEventListener('reload', () => location.reload());
setInterval(() => refresh().catch(() => {}), 30000);
main();
