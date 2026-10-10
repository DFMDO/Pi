// Renderer: Chromium-Kiosk (Standard/Pro) oder mpv (Lite). Beide laufen als Kindprozess
// des Agents, werden bei Absturz mit Wartezeit neu gestartet.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { dirname } from 'node:path';
import { totalmem } from 'node:os';
import { resolvePlaylist, playableItems, dueInsert, insertItem } from '../../../shared/sequencer.js';
import { zonesFor, RES } from './zones.js';
import { parseStreamUrl } from '../../../shared/stream.js';
import { wallPosition, tileCrop } from '../../../shared/wall.js';

function supervise(start, log) {
  let child = null, stopped = false, delay = 1000;
  const run = () => {
    if (stopped) return; const t0 = Date.now();
    try { child = start(); } catch (e) { log('Renderer konnte nicht gestartet werden', e?.message ?? e); delay = Math.min(delay * 2, 30000); setTimeout(run, delay); return; } // z. B. Programm nicht ausführbar: später erneut versuchen, nie abstürzen
    let ended = false;
    const again = (c) => { if (ended) return; ended = true; log('Renderer beendet', c); delay = Date.now() - t0 > 30000 ? 1000 : Math.min(delay * 2, 30000); if (!stopped) setTimeout(run, delay); };
    child.on('exit', again); child.on('error', again); // z. B. Programm fehlt → später erneut versuchen, nie abstürzen
  };
  run();
  // Reagiert ein eingefrorener Prozess nicht auf SIGTERM, wird er nach 5 Sekunden hart beendet (dann startet die Überwachung ihn neu)
  const end = () => { const c = child; if (!c) return; try { c.kill('SIGTERM'); } catch {} const k = setTimeout(() => { if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL'); } catch {} } }, 5000); k.unref?.(); };
  return { stop: () => { stopped = true; end(); }, restart: end, pid: () => child?.pid };
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
  net: netLib = net, spawnFn = spawn, reconnectMs = 1000, streamRetryMs = 10000, getWall = () => null }) {
  const sup = supervise(() => spawnFn('mpv', ['--idle=yes', '--force-window=yes', '--vo=drm', '--hwdec=auto-safe', '--fs', '--no-osc', '--msg-level=all=warn', '--keep-open=no',
    '--image-display-duration=inf', '--loop-playlist=no', `--input-ipc-server=${socket}`, '--no-audio', '--cache=no', '--demuxer-max-bytes=8MiB', '--osd-font-size=42', `--video-rotate=${getRotation()}`], { stdio: ['ignore', 'ignore', 'inherit'] }), log); // Fehlermeldungen von mpv ins Journal des Agents
  const lastIns = new Map(); let advance = true; // Einschübe: letzte Einblendung je Einschub; nach einem Einschub geht es mit dem unterbrochenen Element weiter (kein Vorrücken)
  let sock = null, idx = 0, timer = null, current = null, stopped = false, shown = null, zoneKey = null, zoneTimer = null, zoneOn = false, sharing = false, streaming = false, retryT = null;
  // Gleichtakt/Videowand: wallActive = mpv ist gerade dafür eingestellt (kein „end-file“-Vorrücken, letztes Bild bleibt stehen), wallKey = welches Element ab wann gezeigt wird
  let wallActive = false, wallKey = null, lastCrop = null, alignT = null, reqId = 0; const waiters = new Map();
  const wallOk = (w) => (w && Number.isFinite(w.epoch) && (w.mode === 'gleichtakt' || w.mode === 'videowand') ? w : null);
  const streamUrl = (it) => { const r = parseStreamUrl(it?.stream?.url); return r.ok ? r.url : null; }; // Live-Bild: Adresse noch einmal prüfen (nur Geräte im eigenen Netz)
  const send = (cmd) => { try { sock?.write(JSON.stringify({ command: cmd }) + '\n'); } catch {} };
  // Eine Datei nur dann neu laden, wenn sie sich ändert: Das ständige Neuladen desselben Bilds (Standby alle 5 s) ließ mpv im Pilot auf 522 MB wachsen.
  const show = (file, force = false) => { if (!force && file === shown) return; shown = file; const net = /^(rtsps?|https?|udp):\/\//.test(file); if (net !== streaming) { streaming = net; send(['set_property', 'cache', net ? 'yes' : 'no']); } send(['loadfile', file, 'replace']); }; // Netzwerk-Adressen (Live-Bild) brauchen einen kleinen Zwischenspeicher, Dateien nicht
  // Verbindung zu mpv: IMMER nur ein Socket und nur EIN geplanter Wiederholversuch. (Früher planten „error“ UND „close“ je einen neuen Versuch: Bei fehlendem
  // mpv verdoppelten sich die Versuche jede Sekunde, jeder mpv-Neustart vervielfachte die offenen Verbindungen – nach Stunden war der Speicher voll, Pilot 0.2.16.)
  let reconnectT = null;
  const scheduleConnect = (ms = reconnectMs) => { if (stopped || reconnectT) return; reconnectT = setTimeout(() => { reconnectT = null; connect(); }, ms); };
  const connect = () => {
    if (stopped) return; try { sock?.destroy(); } catch {}
    const s = netLib.connect(socket); sock = s;
    s.on('error', () => {}); // danach kommt „close“ – dort wird neu verbunden
    s.on('connect', () => { if (sock === s) { shown = null; zoneKey = null; zoneOn = false; wallActive = false; wallKey = null; lastCrop = null; tick(); applyZones(); } }); // neuer mpv: Einstellungen sind wieder Standard
    s.on('data', (d) => { const t = d.toString();
      if (t.includes('"request_id"')) for (const line of t.split('\n')) { if (!line.startsWith('{')) continue; let j; try { j = JSON.parse(line); } catch { continue; } const w = waiters.get(j.request_id); if (w) { waiters.delete(j.request_id); w(j.error === 'success' ? j.data : null); } } // Antwort auf eine Abfrage
      if (!t.includes('"end-file"')) return; if (t.includes('"reason":"eof"') && current?.kind === 'video') next(); else if (current?.kind === 'stream' && (t.includes('"reason":"error"') || t.includes('"reason":"eof"'))) streamLost(); });
    s.on('close', () => { if (sock === s) scheduleConnect(); });
  };
  scheduleConnect(reconnectMs * 1.5);
  // Sicherheitsnetz: Belegt mpv zu viel Speicher (Leck), wird er neu gestartet – die Anzeige ist nach ~2 s wieder da.
  const RSS_LIMIT_KB = Math.min(400 * 1024, Math.floor(totalmem() / 1024 * 0.45));
  const watchdog = setInterval(() => { const pid = sup.pid(); if (!pid) return; try { const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]); if (kb > RSS_LIMIT_KB) { log('mpv belegt zu viel Speicher (MB):', Math.round(kb / 1024), '– wird neu gestartet'); sup.restart(); } } catch {} }, 60000); watchdog.unref();
  function pick() {
    const plan = getPlan(), t = now(), r = resolvePlaylist(plan, t);
    const { items } = playableItems(plan, r.playlistId, getManifest(), { profile, now: t, have: (m) => haveFile(m) });
    return { r, items, plan, t };
  }
  function tick() { // aktuelles Element starten; ein Fehler darf den Takt nie anhalten (sonst bliebe das letzte Bild für immer stehen)
    try { tickOnce(); } catch (e) { log('Anzeige-Takt:', e?.message ?? e); clearTimeout(timer); if (!stopped) timer = setTimeout(tick, 5000); }
  }
  function tickOnce() {
    clearTimeout(timer); clearTimeout(retryT); if (stopped) return;
    if (sharing) { timer = setTimeout(tick, 2000); return; } // Bildschirm teilen: der Plan pausiert
    const { r, items: haveItems, plan, t } = pick(); const hs = getHealth();
    const w0 = wallOk(getWall()), wall = w0 && !(r.source === 'uebersteuerung' && r.override?.kind === 'notfall') ? w0 : null; // Notfall-Meldung: jeder Bildschirm zeigt sie ganz
    const items = wall ? playableItems(plan, r.playlistId, getManifest(), { profile, now: t, have: () => true }).items : haveItems; // im Gleichtakt auf allen Bildschirmen dieselbe Liste (auch wenn eine Datei hier noch fehlt)
    if (!wall && wallActive) leaveWall();
    // Vorgerenderte Bilder statt Browser-Seiten (Lite hat keinen Browser): Uhrzeit, Warten auf Bestätigung, Hilfe, Standby
    const special = hs.pairing ? 'wartet' : hs.timeSynced === false ? 'uhrzeit' : (hs.offlineSince && Date.now() - hs.offlineSince > 24 * 3600e3 && hs.cacheEmpty) ? 'hilfe' : null;
    if (hs.displayOff) { setCrop(''); show('/usr/share/dfm/schwarz.png'); timer = setTimeout(tick, 5000); return; }
    if (special || !items.length) {
      setCrop('');
      show(`/usr/share/dfm/${special ?? 'standby'}.png`);
      // Hub und Bildschirm in einem Gerät ohne Inhalte: Adresse der Verwaltung einblenden (der Einrichter muss sie nirgends suchen)
      if (!special && hs.isHub && hs.addresses?.length) send(['show-text', `Verwaltung im Browser öffnen:\n${hs.addresses.map((a) => 'https://' + a).join('\n')}`, 5500]);
      timer = setTimeout(tick, 5000); return;
    }
    if (wall) return wallTick(wall, items, t);
    const due = dueInsert(plan, r, t, lastIns); let ins = null; if (due) { lastIns.set(due.id, t); ins = insertItem(due, getManifest(), { profile, now: t, have: (m) => haveFile(m) }); }
    advance = !ins; if (ins) current = ins; else { idx %= items.length; current = items[idx]; }
    const target = (current.kind === 'stream' && streamUrl(current)) || fileOf(current); // Live-Bild: die Adresse; ist sie ungültig, die Ersatzfolie
    show(target, current.kind === 'video' || current.kind === 'stream'); const nx = items[(ins ? idx : idx + 1) % items.length]; onShow({ current: { mediaId: current.mediaId, name: current.name, kind: current.kind, duration: current.duration }, next: items.length > 1 ? { mediaId: nx.mediaId, name: nx.name } : null });
    let wait = current.kind === 'video' ? (current.durationS ?? 30) * 1000 + 3000 : (Number(current.duration) > 0 ? Number(current.duration) : 10) * 1000; // Video: end-file löst weiter, Timer nur als Sicherung; fehlt die Dauer, nicht in einer Endlosschleife neu laden
    if (r.until) wait = current.kind === 'video' ? wait : Math.min(wait, Math.max(0, r.until - now())); // Bild endet spätestens an der Terminkante; Video wird zu Ende gespielt
    timer = setTimeout(() => { next(); }, Math.max(500, wait));
  }
  // ---- Gleichtakt / Videowand ----
  const setCrop = (c) => { const want = c || ''; if ((lastCrop ?? '') === want) return; lastCrop = want; send(['set_property', 'video-crop', want]); };
  function leaveWall() { wallActive = false; wallKey = null; clearTimeout(alignT); setCrop(''); send(['set_property', 'keep-open', 'no']); }
  /** Eine Eigenschaft von mpv abfragen (null, wenn mpv nicht rechtzeitig antwortet) */
  const getProp = (name, ms = 800) => new Promise((res) => { const id = ++reqId, to = setTimeout(() => { waiters.delete(id); res(null); }, ms); waiters.set(id, (v) => { clearTimeout(to); res(v); }); try { sock?.write(JSON.stringify({ command: ['get_property', name], request_id: id }) + '\n'); } catch { clearTimeout(to); waiters.delete(id); res(null); } });
  /** Läuft das Video hier an der gemeinsamen Stelle? Sonst genau dorthin springen (später dazugekommen, ruckelnder Start, kleine Uhr-Abweichung) */
  async function align(startMs, key) {
    if (stopped || !wallActive || wallKey !== key || current?.kind !== 'video') return;
    const want = (now() - startMs) / 1000, at = await getProp('time-pos');
    if (typeof at === 'number' && Math.abs(at - want) > 0.35) send(['seek', want + 0.1, 'absolute+exact']);
  }
  function wallTick(wall, items, t) {
    if (!wallActive) { wallActive = true; send(['set_property', 'keep-open', 'yes']); } // am Ende bleibt das letzte Bild stehen, bis der nächste Zeitabschnitt beginnt
    const pos = wallPosition(items, wall.epoch, t);
    if (!pos) { setCrop(''); show('/usr/share/dfm/standby.png'); timer = setTimeout(tick, 5000); return; }
    advance = false; idx = pos.index; current = items[pos.index];
    const key = `${pos.index}:${current.mediaId}:${pos.startMs}`;
    if (key !== wallKey) {
      wallKey = key; clearTimeout(alignT);
      const url = current.kind === 'stream' ? streamUrl(current) : null;
      const target = url ?? (haveFile({ id: current.mediaId, kind: current.kind }) ? fileOf(current) : '/usr/share/dfm/standby.png'); // haveFile erwartet ein Verzeichnis-Element (id), kein Listen-Element (mediaId)
      setCrop(wall.mode === 'videowand' && wall.cols * wall.rows > 1 ? tileCrop({ cols: wall.cols, rows: wall.rows, col: wall.col, row: wall.row, aspect: current.aspect }) : '');
      show(target, current.kind === 'video' || current.kind === 'stream');
      const nx = items[(pos.index + 1) % items.length];
      onShow({ current: { mediaId: current.mediaId, name: current.name, kind: current.kind, duration: current.duration }, next: items.length > 1 ? { mediaId: nx.mediaId, name: nx.name } : null });
      if (current.kind === 'video') { // erst nach kurzer Zeit prüfen, dann alle 20 Sekunden
        const run = (first) => { alignT = setTimeout(async () => { await align(pos.startMs, key); if (!stopped && wallKey === key) run(false); }, first ? (pos.offsetMs > 1500 ? 1500 : 3000) : 20000); alignT.unref?.(); };
        run(true);
      }
    }
    timer = setTimeout(tick, Math.max(50, pos.endMs - now())); // genau zum gemeinsamen Zeitpunkt weiter
  }
  /** Live-Bild nicht erreichbar oder abgebrochen: Ersatzfolie zeigen und es nach einer Weile erneut versuchen (Kamera kommt zurück) */
  function streamLost() {
    const c = current; if (stopped || c?.kind !== 'stream') return;
    log('Live-Bild nicht erreichbar:', c.name ?? ''); show(fileOf(c), true);
    clearTimeout(retryT); retryT = setTimeout(() => { const u = streamUrl(c); if (!stopped && current === c && u) show(u, true); }, streamRetryMs);
    retryT.unref?.();
  }
  function next() { if (advance) idx++; tick(); }
  const osd = (text, ms) => send(['show-text', text, ms]);
  // Laufband, Uhr, Infozone (nur wenn der Hub für diesen Bildschirm ein Layout vorgibt): einfache Einblendung statt Webseite, siehe zones.js.
  // Nicht bei gedrehtem Bildschirm (die Einblendung würde nicht mitgedreht) und nicht auf den Hinweisbildern (Warten, Uhrzeit, Hilfe).
  function applyZones() { try { applyZonesOnce(); } catch (e) { log('Einblendung:', e?.message ?? e); } }
  function applyZonesOnce() {
    if (stopped) return; const hs = getHealth(), plan = getPlan();
    const hidden = sharing || !!wallOk(getWall()) || getRotation() !== 0 || hs.displayOff || hs.pairing || hs.timeSynced === false || (hs.offlineSince && now() - hs.offlineSince > 24 * 3600e3 && hs.cacheEmpty);
    const z = hidden ? null : zonesFor({ layout: plan?.layout, tickers: plan?.tickers ?? [], now: now() }), key = z?.key ?? '';
    if (key === zoneKey) return; zoneKey = key; // nur bei Änderung neu senden (Seitenwechsel des Laufbands, Minute der Uhr)
    if (!z) { if (zoneOn) { send(['osd-overlay', 1, 'none', '']); send(['set_property', 'video-margin-ratio-bottom', 0]); send(['set_property', 'video-margin-ratio-right', 0]); } zoneOn = false; return; } // nur aufräumen, was wir gezeichnet haben
    send(['set_property', 'video-margin-ratio-bottom', z.marginBottom]); send(['set_property', 'video-margin-ratio-right', z.marginRight]); send(['osd-overlay', 1, 'ass-events', z.events.join('\n'), RES.x, RES.y]); zoneOn = true;
  }
  zoneTimer = setInterval(applyZones, 2000); zoneTimer.unref?.();
  /** Bildschirm teilen: ein Bild (Datei) zeigen; null = Übertragung beendet, der Plan läuft weiter */
  function share(file) {
    if (stopped) return;
    if (file) { sharing = true; show(file, true); applyZones(); } else if (sharing) { sharing = false; shown = null; zoneKey = null; tick(); applyZones(); }
  }
  return { ...sup, osd, share, stop: () => { stopped = true; clearInterval(zoneTimer); clearTimeout(timer); clearTimeout(retryT); clearTimeout(alignT); clearTimeout(reconnectT); clearInterval(watchdog); try { sock?.destroy(); } catch {} sup.stop(); }, notify: () => { idx = 0; tick(); applyZones(); },
    screenshot: () => new Promise((res, rej) => { // mpv schreibt das Bild in eine Datei
      const f = dirname(socket) + '/shot.png'; send(['screenshot-to-file', f, 'window']); setTimeout(() => { try { res(require_fs().readFileSync(f)); } catch (e) { rej(e); } }, 800); }) };
}
import { readFileSync } from 'node:fs';
const require_fs = () => ({ readFileSync });
