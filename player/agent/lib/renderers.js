// Renderer: Chromium-Kiosk (Standard/Pro) oder mpv (Lite). Beide laufen als Kindprozess
// des Agents, werden bei Absturz mit Wartezeit neu gestartet.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { dirname } from 'node:path';
import { totalmem } from 'node:os';
import { resolvePlaylist, playableItems } from '../../../shared/sequencer.js';

function supervise(start, log) {
  let child = null, stopped = false, delay = 1000;
  const run = () => {
    if (stopped) return; const t0 = Date.now(); child = start();
    let ended = false;
    const again = (c) => { if (ended) return; ended = true; log('Renderer beendet', c); delay = Date.now() - t0 > 30000 ? 1000 : Math.min(delay * 2, 30000); if (!stopped) setTimeout(run, delay); };
    child.on('exit', again); child.on('error', again); // z. B. Programm fehlt → später erneut versuchen, nie abstürzen
  };
  run();
  return { stop: () => { stopped = true; child?.kill('SIGTERM'); }, restart: () => child?.kill('SIGTERM'), pid: () => child?.pid };
}

export function chromiumRenderer({ url, profileDir, log = () => {} }) {
  // cage = minimaler Wayland-Kiosk-Compositor. Der Host-Resolver erlaubt NUR localhost:
  // der Browser KANN keine externen Server erreichen (Prinzip „lokal“).
  const args = ['-s', '--', 'chromium', '--kiosk', `--app=${url}`, `--user-data-dir=${profileDir}`, '--noerrdialogs', '--disable-infobars', '--no-first-run',
    '--disable-crash-reporter', '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-sync', '--no-default-browser-check', '--disable-component-update',
    '--autoplay-policy=no-user-gesture-required', '--overscroll-history-navigation=0', '--disable-pinch', '--ozone-platform=wayland', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy', '--enable-accelerated-video-decode', // GPU und Video-Hardware des Pi nutzen (V4L2)
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--proxy-server=direct://', '--disk-cache-size=1', '--password-store=basic'];
  // Fehlermeldungen von cage/Chromium sollen im Protokoll (journal) des Agents landen – sonst bleibt ein grauer Bildschirm unerklärlich.
  const sup = supervise(() => spawn('cage', args, { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WLR_LIBINPUT_NO_DEVICES: '1' } }), log);
  return { ...sup, screenshot: () => new Promise((res, rej) => execFile('grim', ['-s', '0.25', '-t', 'png', '-'], { encoding: 'buffer', timeout: 8000, maxBuffer: 8 << 20 }, (e, so) => (e ? rej(e) : res(so)))),
    notify: () => {} /* Seite lädt sich selbst über /events neu */ };
}

/** Lite: mpv ohne Browser. Der Agent steuert mpv über den IPC-Socket und wertet den Plan selbst aus. */
export function liteRenderer({ getPlan, getManifest, haveFile, fileOf, getHealth = () => ({}), getRotation = () => 0, onShow = () => {}, profile = 'lite', socket = '/run/dfm-agent/mpv.sock', log = () => {}, now = () => Date.now(),
  net: netLib = net, spawnFn = spawn, reconnectMs = 1000 }) {
  const sup = supervise(() => spawnFn('mpv', ['--idle=yes', '--force-window=yes', '--vo=drm', '--hwdec=auto-safe', '--fs', '--no-osc', '--msg-level=all=warn', '--keep-open=no',
    '--image-display-duration=inf', '--loop-playlist=no', `--input-ipc-server=${socket}`, '--no-audio', '--cache=no', '--demuxer-max-bytes=8MiB', '--osd-font-size=42', `--video-rotate=${getRotation()}`], { stdio: ['ignore', 'ignore', 'inherit'] }), log); // Fehlermeldungen von mpv ins Journal des Agents
  let sock = null, idx = 0, timer = null, current = null, stopped = false, shown = null;
  const send = (cmd) => { try { sock?.write(JSON.stringify({ command: cmd }) + '\n'); } catch {} };
  // Eine Datei nur dann neu laden, wenn sie sich ändert: Das ständige Neuladen desselben Bilds (Standby alle 5 s) ließ mpv im Pilot auf 522 MB wachsen.
  const show = (file, force = false) => { if (!force && file === shown) return; shown = file; send(['loadfile', file, 'replace']); };
  // Verbindung zu mpv: IMMER nur ein Socket und nur EIN geplanter Wiederholversuch. (Früher planten „error“ UND „close“ je einen neuen Versuch: Bei fehlendem
  // mpv verdoppelten sich die Versuche jede Sekunde, jeder mpv-Neustart vervielfachte die offenen Verbindungen – nach Stunden war der Speicher voll, Pilot 0.2.16.)
  let reconnectT = null;
  const scheduleConnect = (ms = reconnectMs) => { if (stopped || reconnectT) return; reconnectT = setTimeout(() => { reconnectT = null; connect(); }, ms); };
  const connect = () => {
    if (stopped) return; try { sock?.destroy(); } catch {}
    const s = netLib.connect(socket); sock = s;
    s.on('error', () => {}); // danach kommt „close“ – dort wird neu verbunden
    s.on('connect', () => { if (sock === s) { shown = null; tick(); } });
    s.on('data', (d) => { const t = d.toString(); if (t.includes('"reason":"eof"') && t.includes('"end-file"') && current?.kind === 'video') next(); });
    s.on('close', () => { if (sock === s) scheduleConnect(); });
  };
  scheduleConnect(reconnectMs * 1.5);
  // Sicherheitsnetz: Belegt mpv zu viel Speicher (Leck), wird er neu gestartet – die Anzeige ist nach ~2 s wieder da.
  const RSS_LIMIT_KB = Math.min(400 * 1024, Math.floor(totalmem() / 1024 * 0.45));
  const watchdog = setInterval(() => { const pid = sup.pid(); if (!pid) return; try { const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]); if (kb > RSS_LIMIT_KB) { log('mpv belegt zu viel Speicher (MB):', Math.round(kb / 1024), '– wird neu gestartet'); sup.restart(); } } catch {} }, 60000); watchdog.unref();
  function pick() {
    const plan = getPlan(), t = now(), r = resolvePlaylist(plan, t);
    const { items } = playableItems(plan, r.playlistId, getManifest(), { profile, now: t, have: (m) => haveFile(m) });
    return { r, items };
  }
  function tick() { // aktuelles Element starten
    clearTimeout(timer); if (stopped) return;
    const { r, items } = pick(); const hs = getHealth();
    // Vorgerenderte Bilder statt Browser-Seiten (Lite hat keinen Browser): Uhrzeit, Warten auf Bestätigung, Hilfe, Standby
    const special = hs.pairing ? 'wartet' : hs.timeSynced === false ? 'uhrzeit' : (hs.offlineSince && Date.now() - hs.offlineSince > 24 * 3600e3 && hs.cacheEmpty) ? 'hilfe' : null;
    if (hs.displayOff) { show('/usr/share/dfm/schwarz.png'); timer = setTimeout(tick, 5000); return; }
    if (special || !items.length) {
      show(`/usr/share/dfm/${special ?? 'standby'}.png`);
      // Hub und Bildschirm in einem Gerät ohne Inhalte: Adresse der Verwaltung einblenden (der Einrichter muss sie nirgends suchen)
      if (!special && hs.isHub && hs.addresses?.length) send(['show-text', `Verwaltung im Browser öffnen:\n${hs.addresses.map((a) => 'https://' + a).join('\n')}`, 5500]);
      timer = setTimeout(tick, 5000); return;
    }
    idx %= items.length; current = items[idx];
    show(fileOf(current), current.kind === 'video'); const nx = items[(idx + 1) % items.length]; onShow({ current: { mediaId: current.mediaId, name: current.name, kind: current.kind, duration: current.duration }, next: items.length > 1 ? { mediaId: nx.mediaId, name: nx.name } : null });
    let wait = current.kind === 'video' ? (current.durationS ?? 30) * 1000 + 3000 : current.duration * 1000; // Video: end-file löst weiter, Timer nur als Sicherung
    if (r.until) wait = current.kind === 'video' ? wait : Math.min(wait, Math.max(0, r.until - now())); // Bild endet spätestens an der Terminkante; Video wird zu Ende gespielt
    timer = setTimeout(() => { next(); }, Math.max(500, wait));
  }
  function next() { idx++; tick(); }
  const osd = (text, ms) => send(['show-text', text, ms]);
  return { ...sup, osd, stop: () => { stopped = true; clearTimeout(timer); clearTimeout(reconnectT); clearInterval(watchdog); try { sock?.destroy(); } catch {} sup.stop(); }, notify: () => { idx = 0; tick(); },
    screenshot: () => new Promise((res, rej) => { // mpv schreibt das Bild in eine Datei
      const f = dirname(socket) + '/shot.png'; send(['screenshot-to-file', f, 'window']); setTimeout(() => { try { res(require_fs().readFileSync(f)); } catch (e) { rej(e); } }, 800); }) };
}
import { readFileSync } from 'node:fs';
const require_fs = () => ({ readFileSync });
