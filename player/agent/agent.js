// dfm-agent: schlanker Player-Dienst. Pairing, WebSocket (WSS, gepinnt), Heartbeat,
// Sync, lokaler Zeitplan, Fernbefehle. Alles Wichtige liegt lokal im Cache –
// fällt WLAN oder Hub aus, läuft der Player unbegrenzt weiter.
import WebSocket from 'ws';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { readFileSync, existsSync, mkdirSync, createWriteStream, writeFileSync, readdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { pinnedAgent, request, PinError } from './lib/pinned.js';
import { writeJson, readJson } from './lib/store.js';
import { syncMedia, inSyncWindow } from './lib/sync.js';
import { hubCandidates } from './lib/discovery.js';
import { collect, timeSynced, parseDrops, powerSave } from './lib/sysinfo.js';
import { execFile } from 'node:child_process';
import { createLocalServer } from './lib/localserver.js';
import { request as privRequest } from './lib/privd.js';
import { resolvePlaylist } from '../../shared/sequencer.js';
import { validateMessage, msg } from '../../shared/protocol.js';
import { stage, activate } from '../../hub/lib/update.js';
import { pairWithHub, PairError } from './lib/pair.js';
import { shred } from '../../setup/lib/firstboot.js';
import { createPlayCounter } from './lib/plays.js';

const readText = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };
export const backoff = (n, rnd = Math.random) => Math.min(60000, 1000 * 2 ** Math.min(n, 6)) * (0.75 + rnd() * 0.5); // 1 s … 60 s mit Jitter

/** Eigene IPv4-Adressen (ohne Loopback). Darf nie fehlschlagen: bei Fehler einfach keine Adressen. */
export function ownAddresses() {
  try { return Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === 'IPv4').map((i) => i.address); } catch { return []; }
}

export class Agent {
  constructor({ dataDir, version = '0.2.24', renderer = null, privdDir = '/run/dfm/privd', port = 8080, updateKey = '/etc/dfm/update-key.pub', log = () => {}, heartbeatMs = 30000, pollMs = 60000, exit = (c) => process.exit(c) }) {
    Object.assign(this, { dataDir, version, renderer, privdDir, port, updateKey, log, heartbeatMs, pollMs, exit });
    this.cfgFile = join(dataDir, 'agent.json'); this.mediaDir = join(dataDir, 'cache', 'media');
    mkdirSync(this.mediaDir, { recursive: true });
    this.cfg = readJson(this.cfgFile); this.plan = readJson(join(dataDir, 'cache', 'plan.json')); this.manifest = readJson(join(dataDir, 'cache', 'manifest.json'));
    this.syncState = { total: 0, done: 0 }; this.connected = false; this.ws = null; this.stopped = false; this.attempt = 0; this.syncing = false;
    this.nowPlaying = null; this.displayOff = false; this.displayRule = null;
    this.hubPlays = false; // erst true, wenn der Hub „plays“ versteht (siehe plays_ack)
    this.share = null; this.shareDir = process.env.DFM_SHARE_DIR ?? '/run/dfm-agent'; this.shareIdleMs = 30000; this.shareCheckMs = 5000; // Bildschirm teilen (nur im Arbeitsspeicher; endet, wenn 30 s lang kein Bild mehr kommt)
    this.plays = createPlayCounter({ file: join(dataDir, 'state', 'plays.json') }); this.playsMs = 300000; // Wiedergabe-Nachweis: lokal zählen, alle 5 Minuten gesammelt melden
    this.server = createLocalServer({ getPlan: () => this.plan, getManifest: () => this.manifest, mediaDir: this.mediaDir, port, getHealth: () => this.health(), onStatus: (s) => this.onPlayerStatus(s) });
  }
  health() { let cached = []; try { cached = readdirSync(this.mediaDir).filter((f) => !f.endsWith('.part')); } catch {}
    return { cached, displayOff: !!this.displayOff, pairing: this.pairing ?? null, deviceName: this.cfg?.name, timeSynced: this.timeOk ?? true, connected: this.connected, hasPlan: !!this.plan, syncState: this.syncState, orientation: this.cfg?.orientation ?? 0, profile: this.cfg?.profile,
    cacheEmpty: !(this.manifest?.items?.length), offlineSince: this.offlineSince ?? null,
    isHub: !!this.cfg?.local, addresses: ownAddresses(), share: this.share ? { active: true, n: this.share.n } : null }; } // Adressen: der Standby-Bildschirm zeigt dem Einrichter, wo die Verwaltung erreichbar ist

  async start() {
    this.boundPort = await this.server.listen();            // 1) sofort anzeigen, was im Cache liegt (kein Hub nötig)
    if (this.plan) this.applyHubSettings(this.plan);        // Bildschirm-Zeiten/Sync-Einstellungen gelten auch nach Neustart ohne Hub
    // Sicherheitsnetz gegen Speicherlecks: Wächst der Agent über 300 MB (normal sind 60–100 MB), startet er sich neu (Code 75 → systemd startet ihn wieder), statt dem ganzen Gerät den Speicher zu nehmen.
    this.rssTimer = setInterval(() => { const mb = process.memoryUsage().rss / 1048576; if (mb > (this.rssLimitMB ?? 300)) { this.log(`Speicherverbrauch zu hoch (${Math.round(mb)} MB) – Neustart`); this.exit(75); } }, 60000); this.rssTimer.unref();
    const authority = () => !!this.cfg?.local; // Hub + Bildschirm in einem: dieses Gerät ist selbst die Zeitquelle
    this.timeOk = await timeSynced({ authority: authority() }); this.timeTimer = setInterval(async () => { this.timeOk = await timeSynced({ authority: authority() }); this.checkDisplay(); }, 30000).unref();
    this.playsTimer = setInterval(() => this.sendPlays(), this.playsMs); this.playsTimer.unref();
    this.shareTimer = setInterval(() => { if (this.share && Date.now() - this.share.last > this.shareIdleMs) this.shareStop('keine Bilder mehr'); }, this.shareCheckMs); this.shareTimer.unref();
    this.renderer?.start?.();
    if (!this.cfg?.token && this.cfg?.pairing) await this.pairNow();   // Erstverbindung mit dem Hub (Einmalcode)
    if (!this.cfg?.token) throw new Error('Dieses Gerät ist noch nicht mit einem Hub verbunden.');
    this.loop(); return this;
  }
  /** Pairing nach der Einrichtung: Code und (optional) Fingerabdruck stammen aus der Einrichtung. Der Code wird danach gelöscht. */
  async pairNow() {
    const c = this.cfg; const devFile = process.env.DFM_DEVICE_FILE ?? join(this.dataDir, '..', 'device.json');
    const dev = readJson(devFile, {}); c.deviceId ??= dev.deviceId ?? (await import('node:crypto')).randomUUID();
    for (let n = 0; !this.stopped; n++) {
      try {
        this.pairing = 'waiting';
        const r = await pairWithHub({ hubUrl: c.hubUrl, code: c.pairing.code, expectedFp: c.hubSpki, deviceId: c.deviceId, name: c.name, model: c.model, profile: c.profile, hw: c.hw, pollMs: 2000, onStatus: () => {} });
        Object.assign(c, { token: r.token, hubSpki: r.spki }); delete c.pairing; this.pairing = null; writeJson(this.cfgFile, c); return;
      } catch (e) {
        if (e instanceof PairError && ['code', 'fingerprint', 'rejected'].includes(e.code)) { // endgültig: neu einrichten
          this.log('Pairing endgültig fehlgeschlagen:', e.message); writeFileSync(join(this.dataDir, 'unpaired'), e.message); this.pairing = null; this.exit(0); return;
        }
        this.log('Pairing: Hub nicht erreichbar, neuer Versuch', e.message); await new Promise((r) => setTimeout(r, backoff(n)));
      }
    }
  }
  async stop() { this.stopped = true; clearInterval(this.shareTimer); this.shareStop('Agent beendet'); clearInterval(this.playsTimer); clearTimeout(this.playsKick); this.plays.stop(); clearInterval(this.rssTimer); clearInterval(this.timeTimer); clearTimeout(this.retryT); clearInterval(this.hb); this.ws?.terminate(); this.renderer?.stop?.(); await this.server.close(); }

  async loop() {
    while (!this.stopped) {
      let ok = false;
      try { ok = await this.session(); } catch (e) { this.log('Sitzung beendet:', e.message); }
      this.connected = false; this.offlineSince ??= Date.now();
      if (this.stopped) return;
      if (this.revoked) return this.handleRevoked();
      this.attempt = ok ? 0 : this.attempt + 1;
      await this.pollFallback();                              // WSS nicht erreichbar → Polling (60 s)
      await new Promise((r) => { this.sleepT = setTimeout(r, Math.min(backoff(this.attempt), this.pollMs)); });
    }
  }

  /** Eine Verbindung: Kandidaten (gespeichert → IP → mDNS) durchprobieren. */
  async session() {
    const c = this.cfg;
    for (const url of await hubCandidates({ hubUrl: c.hubUrl, lastIp: c.lastIp })) {
      try { await this.connect(url); return true; }
      catch (e) {
        if (e instanceof PinError || e.code === 'PIN_MISMATCH') { this.log('Hub-Schlüssel stimmt nicht – Verbindung abgelehnt'); continue; } // keine Ausnahme
        if (e.revoked) { this.revoked = true; return false; }
      }
    }
    return false;
  }

  connect(base) {
    return new Promise((resolve, reject) => {
      const { token, hubSpki } = this.cfg; let opened = false;
      const ws = new WebSocket(base.replace('https', 'wss') + '/api/v1/ws', { agent: pinnedAgent(hubSpki), headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000, maxPayload: 8 << 20 });
      ws.on('unexpected-response', (_q, res) => { const e = new Error('HTTP ' + res.statusCode); if (res.statusCode === 401) e.revoked = true; reject(e); });
      ws.on('error', (e) => { if (!opened) reject(e); });
      ws.on('open', async () => {
        opened = true; this.ws = ws; this.reconnects = (this.reconnects ?? 0) + 1; this.connected = true; this.offlineSince = null; this.attempt = 0; this.cfg.lastIp = new URL(base).hostname; writeJson(this.cfgFile, this.cfg);
        this.send('hello', { version: this.version, profile: this.cfg.profile, model: this.cfg.model, hw: this.cfg.hw });
        this.sendHeartbeat(); this.hb = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
        this.hubPlays = false; clearTimeout(this.playsKick); this.playsKick = setTimeout(() => this.sendPlays(), 15000); this.playsKick.unref?.(); // nach (Wieder-)Verbindung gleich nachmelden
      });
      ws.on('message', (raw) => this.onMessage(raw.toString()));
      ws.on('close', (code) => { clearInterval(this.hb); this.ws = null; if (code === 4001) this.revoked = true; opened ? resolve() : reject(new Error('geschlossen')); });
    });
  }
  send(type, body) { if (this.ws?.readyState === 1) this.ws.send(msg(type, body)); }
  /** Geplanter nächtlicher Neustart (Wartungsfenster, Z.3): einmal pro Nacht, nur wenn der Player schon länger läuft */
  nightlyReboot() {
    const at = this.plan?.maintenance?.nightlyReboot; if (!at) return;
    const n = new Date(), hhmm = n.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }), day = n.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    const [h, m] = at.split(':').map(Number), [ch, cm] = hhmm.split(':').map(Number);
    if (ch * 60 + cm >= h * 60 + m && ch * 60 + cm < h * 60 + m + 10 && this.rebootDay !== day && process.uptime() > 6 * 3600) { this.rebootDay = day; this.log('Nächtlicher Neustart'); try { privRequest(this.privdDir, 'reboot'); } catch {} }
  }
  async sendHeartbeat() {
    this.nightlyReboot(); const np = this.nowPlayingInfo();
    this.send('heartbeat', { state: await collect({ version: this.version, authority: !!this.cfg?.local, extra: { syncState: this.syncState, nowPlaying: np, playerStatus: this.playerStatus ?? null, wifiSwitch: readJson(join(this.dataDir, 'state', 'wifi-switch-result.json')), reconnects: this.reconnects ?? 0, profile: this.cfg.profile, orientation: this.cfg.orientation ?? 0, displayPower: this.displayRule ? (readText(process.env.DFM_DISPLAY_STATUS ?? '/run/dfm/display-power.status') ?? 'unbekannt') : undefined } }) });
  }
  /** Aufstellmodus (Z.15): alle 2 s Signal melden, höchstens 15 Minuten */
  startSignalWatch(seconds) {
    clearInterval(this.sigTimer); const until = Date.now() + seconds * 1000;
    this.sigTimer = setInterval(async () => { if (Date.now() > until || !this.ws) return clearInterval(this.sigTimer); const c = await collect({ version: this.version }); this.send('signal', { dbm: c.signalDbm ?? null, wifi: c.wifi ?? null }); }, 2000);
    this.sigTimer.unref?.();
  }
  /** Was der Player gerade WIRKLICH zeigt (Ist) – gemeldet von Chromium-Seite oder Lite-Renderer, sofort an den Hub */
  onPlayerStatus(s) {
    if (!s || typeof s !== 'object' || typeof s.current !== 'object') return;
    const cur = s.current && { mediaId: String(s.current.mediaId ?? '').slice(0, 40), name: String(s.current.name ?? '').slice(0, 120), kind: String(s.current.kind ?? '').slice(0, 12), since: Date.now(), duration: Number(s.current.duration) || null };
    const nxt = s.next ? { mediaId: String(s.next.mediaId ?? '').slice(0, 40), name: String(s.next.name ?? '').slice(0, 120) } : null;
    const r = resolvePlaylist(this.plan, Date.now());
    this.playerStatus = { current: cur, next: nxt, source: r.source, scheduleId: r.scheduleId ?? null };
    this.send('status', this.playerStatus);
    this.plays.start(this.displayOff ? null : cur); // Wiedergabe-Nachweis (bei ausgeschaltetem Bildschirm wird nicht gezählt)
  }
  /** Gesammelte Wiedergabe-Zähler an den Hub melden; wird wiederholt, bis der Hub bestätigt */
  /** Bildschirm teilen (Hub → Player): geteilte Bilder zeigen, bis der Hub stoppt oder 30 s lang nichts mehr kommt */
  shareStart(id) { this.share = { id, last: Date.now(), n: 0 }; this.log('Bildschirm wird geteilt'); }
  shareFrame(m) {
    if (!this.share || this.share.id !== m.id) this.shareStart(m.id); // z. B. nach kurzem Verbindungsabbruch: das Bild ist dann der Start
    const buf = Buffer.from(m.jpg, 'base64'); if (buf.length < 100 || buf.length > 3 * 1048576 || buf[0] !== 0xff || buf[1] !== 0xd8) return; // nur echte JPEG-Bilder
    this.share.last = Date.now(); this.share.n++;
    if (this.renderer?.share) { // mpv: das Bild als Datei (im Arbeitsspeicher) laden, abwechselnd zwei Dateinamen
      try { mkdirSync(this.shareDir, { recursive: true }); const f = join(this.shareDir, `share-${this.share.n % 2}.jpg`); writeFileSync(f, buf); this.renderer.share(f); } catch (e) { this.log('Teilen: Bild nicht geschrieben', e.message); }
    } else this.server.setFrame(buf);
  }
  shareStop(why) { if (!this.share) return; this.share = null; this.log('Teilen beendet:', why); this.server.clearFrame(); this.renderer?.share?.(null); }
  sendPlays() { try { if (!this.hubPlays) { this.plays.save(); return; } /* alter Hub: nichts senden, sonst trennt er die Verbindung */ const p = this.plays.payload(); if (p && this.ws?.readyState === 1) this.send('plays', p); this.plays.save(); } catch (e) { this.log('Wiedergabe-Nachweis:', e.message); } }
  nowPlayingInfo() { // reine Anzeige für „zeigt gerade …“
    const r = resolvePlaylist(this.plan, Date.now()); if (!r.playlistId) return null;
    const m = this.manifest?.items?.find((i) => i.id === this.plan?.playlists?.[r.playlistId]?.items?.[0]?.mediaId);
    return { name: this.plan?.playlists?.[r.playlistId]?.name ?? m?.name ?? '', scheduleId: r.scheduleId };
  }

  async onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (validateMessage(m)) return;
    if (m.type === 'schedule_update') { const { v, type, ...plan } = m; this.plan = plan; this.applyHubSettings(plan); writeJson(join(this.dataDir, 'cache', 'plan.json'), plan, 0o644); this.server.emit('plan'); this.renderer?.notify?.(); }
    else if (m.type === 'media_manifest') { const { v, type, ...mf } = m; this.manifest = mf; writeJson(join(this.dataDir, 'cache', 'manifest.json'), mf, 0o644); this.runSync(); }
    else if (m.type === 'command') this.runCommand(m);
    else if (m.type === 'plays_ack') { this.hubPlays = true; this.plays.ack(m.id); }
    else if (m.type === 'share_start') this.shareStart(m.id);
    else if (m.type === 'share_frame') this.shareFrame(m);
    else if (m.type === 'share_stop') this.shareStop('vom Hub beendet');
  }

  fetchRange = async (url, start) => { // gepinnter Download mit Range-Fortsetzung
    const { PassThrough } = await import('node:stream'); const sink = new PassThrough();
    const headers = start ? { Range: `bytes=${start}-` } : {};
    const base = this.activeBase();
    return new Promise((resolve, reject) => {
      import('node:https').then(({ default: https }) => {
        const u = new URL(base + url);
        const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname, headers: { ...headers, Authorization: `Bearer ${this.cfg.token}` }, agent: pinnedAgent(this.cfg.hubSpki) }, (res) => { resolve({ status: res.statusCode, stream: res }); });
        req.on('error', reject); req.end();
      });
    });
  };
  activeBase() { return `https://${this.cfg.lastIp ?? new URL(this.cfg.hubUrl).hostname}${new URL(this.cfg.hubUrl).port ? ':' + new URL(this.cfg.hubUrl).port : ''}`; }

  /** Einstellungen aus dem Hub: Sync-Zeitfenster, Bandbreite, Bildschirm aus/an (lokal gespeichert, wirkt auch ohne Hub) */
  /** Wiedergabe-Art (Browser oder Video-optimiert mit mpv) kommt vom Hub. Ändert sie sich, startet der Agent neu und wählt den passenden Renderer. */
  rendererWanted() { return this.cfg?.profile === 'lite' || this.cfg?.renderer === 'mpv' ? 'mpv' : 'browser'; }
  applyHubSettings(plan) {
    if (plan.renderer && plan.renderer !== this.rendererWanted()) { this.cfg.renderer = plan.renderer; writeJson(this.cfgFile, this.cfg); this.log('Wiedergabe-Art geändert:', plan.renderer, '– Anzeige startet neu'); setTimeout(() => this.exit(75), 300); } // 75 (nicht 0): Der Dienst startet nur nach einem "Fehler" neu (Restart=on-failure) – mit 0 bliebe der Bildschirm bis zum nächsten Neustart des Geräts aus
    if (plan.sync) { this.cfg.syncWindow = plan.sync.window ?? ''; this.cfg.bandwidthKbps = plan.sync.bandwidthKbps ?? 0; }
    this.displayRule = plan.display?.off ?? null; this.checkDisplay();
  }
  /** „Bildschirm von 22:00 bis 07:00 aus“: zuerst HDMI-CEC/wlr-randr/vcgencmd (privd), sonst schwarzes Bild + klare Meldung im Hub */
  checkDisplay(now = Date.now()) {
    const off = !!this.displayRule && inSyncWindow(`${this.displayRule.from}-${this.displayRule.to}`, now);
    if (off === this.displayOff) return; this.displayOff = off; if (off) this.plays.start(null); // Nachweis: Anzeige aus = nichts mehr zählen
    try { privRequest(this.privdDir, 'display-power', { state: off ? 'off' : 'on' }); } catch {}
    this.server.emit(off ? 'black' : 'unblack'); // Fallback: schwarzes Bild, falls die Hardware nicht abschaltbar ist
  }

  async runSync() {
    if (this.syncing) { this.resync = true; return; } this.syncing = true;
    try {
      const st = await syncMedia({ manifest: this.manifest, dir: this.mediaDir, fetchRange: this.fetchRange, jitterMs: this.cfg.syncJitterMs ?? 3000, window: this.cfg.syncWindow ?? '', bandwidthKbps: this.cfg.bandwidthKbps ?? 0,
        onProgress: (s) => { this.syncState = { done: s.done, total: s.total }; } });
      this.syncState = { done: st.done, total: st.total, failed: st.failed.length }; this.server.emit('manifest'); this.sendHeartbeat();
      if (st.failed.length || st.skippedWindow) { clearTimeout(this.retryT); this.retryT = setTimeout(() => this.runSync(), st.skippedWindow ? 5 * 60000 : 20000 + Math.random() * 40000); this.retryT.unref?.(); } // Hub ausgelastet / Fenster geschlossen → später erneut
    } catch (e) { this.log('Sync-Fehler', e.message); }
    finally { this.syncing = false; if (this.resync) { this.resync = false; this.runSync(); } }
  }

  async pollFallback() {
    try {
      const get = (p) => request({ url: this.activeBase() + p, pin: this.cfg.hubSpki, token: this.cfg.token, timeout: 8000 });
      const s = await get('/api/v1/device/schedule');
      if (s.status === 401) { this.revoked = true; return; }
      if (s.status === 200) { await this.onMessage(JSON.stringify(s.json())); await this.onMessage(JSON.stringify((await get('/api/v1/device/manifest')).json())); }
    } catch {}
  }

  async runCommand({ id, command, args = {} }) {
    const done = (ok, result, error) => this.send('command_result', { id, ok, ...(result ? { result } : {}), ...(error ? { error: String(error).slice(0, 400) } : {}) });
    try {
      if (command === 'identify') { const d = { name: this.cfg?.name ?? '', location: args.location ?? '', number: args.number ?? '', seconds: Math.min(60, args.seconds ?? 10) }; this.server.emit('identify', d); this.renderer?.osd?.(`${d.name}\n${d.location}\n${d.number}`, d.seconds * 1000); return done(true); }
      if (command === 'testpattern') { this.server.emit('testpattern', { on: args.on !== false, seconds: Math.min(300, args.seconds ?? 120) }); this.renderer?.osd?.(args.on !== false ? 'Testbild: Farben, Ränder, Ausrichtung prüfen' : '', 15000); return done(true); }
      if (command === 'signal_watch') { this.startSignalWatch(Math.min(900, args.seconds ?? 900)); return done(true); }
      if (command === 'confirm_display') { if (this.displayRevert) { clearTimeout(this.displayRevert.timer); this.displayRevert = null; } return done(true); }
      if (command === 'reload') { this.server.emit('reload'); this.renderer?.notify?.(); return done(true); }
      if (command === 'reconnect') { done(true); this.ws?.close(); return; }
      if (command === 'reboot') { done(true); privRequest(this.privdDir, 'reboot'); return; }
      if (command === 'screenshot') { const png = await this.renderer?.screenshot?.(); if (!png) return done(false, null, 'Der Bildschirm kann keinen Screenshot erstellen.'); this.send('screenshot', { png: png.toString('base64') }); return done(true); }
      if (command === 'rotate' && args.rollback) { // Z.8/A5: ohne Bestätigung binnen 60 s zurück zur alten Ausrichtung
        if (this.displayRevert) { clearTimeout(this.displayRevert.timer); } const prev = this.displayRevert?.prev ?? this.cfg.orientation ?? 0;
        const apply = (deg) => { this.cfg.orientation = deg; writeJson(this.cfgFile, this.cfg); try { privRequest(this.privdDir, 'display-rotate', { degrees: deg }); } catch {} this.server.emit('reload'); this.renderer?.notify?.(); };
        apply(args.degrees); this.displayRevert = { prev, timer: setTimeout(() => { this.displayRevert = null; apply(prev); this.send('status', { current: { mediaId: '', name: 'Einstellung zurückgesetzt' }, source: 'rueckfall' }); }, (args.seconds ?? 60) * 1000) };
        return done(true, { revertInS: args.seconds ?? 60 });
      }
      if (command === 'rotate') { this.cfg.orientation = args.degrees; writeJson(this.cfgFile, this.cfg); privRequest(this.privdDir, 'display-rotate', { degrees: args.degrees }); this.server.emit('reload'); this.renderer?.restart?.(); return done(true); }
      if (command === 'wifi_change') { done(true); privRequest(this.privdDir, 'wifi-switch', { ssid: args.ssid, password: args.password }); return; }
      if (command === 'factory_reset') { done(true); privRequest(this.privdDir, 'factory-reset'); return; }
      if (command === 'rollback') { if (!rollback(join(this.dataDir, 'app'))) return done(false, null, 'Es gibt keine vorherige Version.'); done(true); privRequest(this.privdDir, 'restart-agent'); return; }
      if (command === 'update') return done(...(await this.runUpdate()));
      if (command === 'diagnose') return done(true, await this.runDiagnose(args));
      done(false, null, 'Unbekannter Befehl');
    } catch (e) { done(false, null, e.message); }
  }

  /** Diagnose: Zustand, WLAN, Durchsatz und (optional) Testvideo im eigenen Profil. */
  async runDiagnose(args = {}) {
    const get = (p, extra = {}) => request({ url: this.activeBase() + p, pin: this.cfg.hubSpki, token: this.cfg.token, timeout: 60000, ...extra });
    const res = { ...(await collect({ version: this.version, authority: !!this.cfg?.local })), powerSave: await powerSave(), profile: this.cfg.profile };
    const t0 = Date.now(); const sp = await get(args.quick ? '/api/v1/device/speedtest?kb=2048' : '/api/v1/device/speedtest'); res.throughputMBs = sp.status === 200 ? Math.round((sp.body.length / 1048576) / ((Date.now() - t0) / 1000) * 10) / 10 : null;
    if (args.testvideo) {
      const f = join(this.dataDir, 'testvideo.mp4'); const tv = await get('/api/v1/device/testvideo'); if (tv.status !== 200) { res.testvideo = { error: 'Testvideo nicht verfügbar' }; return res; }
      writeFileSync(f, tv.body);
      res.testvideo = await new Promise((r) => execFile('mpv', ['--vo=null', '--ao=null', '--no-audio', '--hwdec=auto-safe', '--length=15', '--msg-level=all=no', '--term-status-msg=D:${frame-drop-count}/${decoder-frame-drop-count} F:${estimated-frame-count}', f], { timeout: 40000 }, (e, so) => r(e && !so ? { error: 'mpv nicht verfügbar' } : parseDrops(so) ?? { error: 'keine Messwerte' })));
    }
    return res;
  }

  async runUpdate() {
    const r = await request({ url: this.activeBase() + '/api/v1/device/update/current', pin: this.cfg.hubSpki, token: this.cfg.token, timeout: 120000 });
    if (r.status !== 200) return [false, null, 'Auf dem Hub liegt kein Update.'];
    const f = join(this.dataDir, 'update.dfmpkg'); writeFileSync(f, r.body);
    const m = stage(f, join(this.dataDir, 'app'), readFileSync(this.updateKey, 'utf8'), process.env.DFM_BASE ?? '/opt/dfm'); // prüft die Signatur selbst
    activate(join(this.dataDir, 'app'), m.version); privRequest(this.privdDir, 'restart-agent'); return [true, { version: m.version }];
  }

  handleRevoked() { // Hub hat dieses Gerät gesperrt/entfernt → Verbindung löschen, neu einrichten
    this.log('Gerät wurde im Hub gesperrt oder entfernt'); writeFileSync(join(this.dataDir, 'unpaired'), String(Date.now())); this.cfg.token = null; writeJson(this.cfgFile, this.cfg); this.exit(0);
  }
}

// Start als Dienst
if (import.meta.url === `file://${process.argv[1]}`) {
  const dataDir = process.env.DFM_AGENT_DATA ?? '/data/agent';
  const cfg = readJson(join(dataDir, 'agent.json'));
  const { chromiumRenderer, liteRenderer } = await import('./lib/renderers.js');
  const a = new Agent({ dataDir, log: (...x) => console.error(...x), port: Number(process.env.DFM_PORT ?? 8080) });
  if (!process.env.DFM_NO_RENDERER) a.renderer = cfg?.profile === 'lite' || cfg?.renderer === 'mpv' ? liteRenderer({ getPlan: () => a.plan, getManifest: () => a.manifest, getHealth: () => a.health(), getRotation: () => a.cfg?.orientation ?? 0, onShow: (s) => a.onPlayerStatus(s), haveFile: (m) => existsSync(join(a.mediaDir, m.id)), fileOf: (i) => join(a.mediaDir, i.mediaId), profile: 'lite' })
    : chromiumRenderer({ url: 'http://127.0.0.1:8080/player/', profileDir: join(dataDir, 'chromium-profile'), log: (...x) => console.error(...x) });
  await a.start();
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => a.stop().then(() => process.exit(0)));
}
