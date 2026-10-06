// dfm-agent: schlanker Player-Dienst. Pairing, WebSocket (WSS, gepinnt), Heartbeat,
// Sync, lokaler Zeitplan, Fernbefehle. Alles Wichtige liegt lokal im Cache –
// fällt WLAN oder Hub aus, läuft der Player unbegrenzt weiter.
import WebSocket from 'ws';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { pinnedAgent, request, PinError } from './lib/pinned.js';
import { writeJson, readJson } from './lib/store.js';
import { syncMedia } from './lib/sync.js';
import { hubCandidates } from './lib/discovery.js';
import { collect, timeSynced } from './lib/sysinfo.js';
import { createLocalServer } from './lib/localserver.js';
import { request as privRequest } from './lib/privd.js';
import { resolvePlaylist } from '../../shared/sequencer.js';
import { validateMessage, msg } from '../../shared/protocol.js';
import { stage, activate } from '../../hub/lib/update.js';

export const backoff = (n, rnd = Math.random) => Math.min(60000, 1000 * 2 ** Math.min(n, 6)) * (0.75 + rnd() * 0.5); // 1 s … 60 s mit Jitter

export class Agent {
  constructor({ dataDir, version = '0.1.0', renderer = null, privdDir = '/run/dfm/privd', port = 8080, updateKey = '/etc/dfm/update-key.pub', log = () => {}, heartbeatMs = 30000, pollMs = 60000, exit = (c) => process.exit(c) }) {
    Object.assign(this, { dataDir, version, renderer, privdDir, port, updateKey, log, heartbeatMs, pollMs, exit });
    this.cfgFile = join(dataDir, 'agent.json'); this.mediaDir = join(dataDir, 'cache', 'media');
    mkdirSync(this.mediaDir, { recursive: true });
    this.cfg = readJson(this.cfgFile); this.plan = readJson(join(dataDir, 'cache', 'plan.json')); this.manifest = readJson(join(dataDir, 'cache', 'manifest.json'));
    this.syncState = { total: 0, done: 0 }; this.connected = false; this.ws = null; this.stopped = false; this.attempt = 0; this.syncing = false;
    this.nowPlaying = null;
    this.server = createLocalServer({ getPlan: () => this.plan, getManifest: () => this.manifest, mediaDir: this.mediaDir, port, getHealth: () => this.health() });
  }
  health() { return { timeSynced: this.timeOk ?? true, connected: this.connected, hasPlan: !!this.plan, syncState: this.syncState, orientation: this.cfg?.orientation ?? 0, profile: this.cfg?.profile,
    cacheEmpty: !(this.manifest?.items?.length), offlineSince: this.offlineSince ?? null }; }

  async start() {
    this.boundPort = await this.server.listen();            // 1) sofort anzeigen, was im Cache liegt (kein Hub nötig)
    this.timeOk = await timeSynced(); this.timeTimer = setInterval(async () => { this.timeOk = await timeSynced(); }, 30000).unref();
    this.renderer?.start?.();
    if (!this.cfg?.token) throw new Error('Dieses Gerät ist noch nicht mit einem Hub verbunden.');
    this.loop(); return this;
  }
  async stop() { this.stopped = true; clearInterval(this.timeTimer); clearInterval(this.hb); this.ws?.terminate(); this.renderer?.stop?.(); await this.server.close(); }

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
        opened = true; this.ws = ws; this.connected = true; this.offlineSince = null; this.attempt = 0; this.cfg.lastIp = new URL(base).hostname; writeJson(this.cfgFile, this.cfg);
        this.send('hello', { version: this.version, profile: this.cfg.profile, model: this.cfg.model, hw: this.cfg.hw });
        this.sendHeartbeat(); this.hb = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
      });
      ws.on('message', (raw) => this.onMessage(raw.toString()));
      ws.on('close', (code) => { clearInterval(this.hb); this.ws = null; if (code === 4001) this.revoked = true; opened ? resolve() : reject(new Error('geschlossen')); });
    });
  }
  send(type, body) { if (this.ws?.readyState === 1) this.ws.send(msg(type, body)); }
  async sendHeartbeat() {
    const np = this.nowPlayingInfo();
    this.send('heartbeat', { state: await collect({ version: this.version, extra: { syncState: this.syncState, nowPlaying: np, profile: this.cfg.profile, orientation: this.cfg.orientation ?? 0 } }) });
  }
  nowPlayingInfo() { // reine Anzeige für „zeigt gerade …“
    const r = resolvePlaylist(this.plan, Date.now()); if (!r.playlistId) return null;
    const m = this.manifest?.items?.find((i) => i.id === this.plan?.playlists?.[r.playlistId]?.items?.[0]?.mediaId);
    return { name: this.plan?.playlists?.[r.playlistId]?.name ?? m?.name ?? '', scheduleId: r.scheduleId };
  }

  async onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (validateMessage(m)) return;
    if (m.type === 'schedule_update') { const { v, type, ...plan } = m; this.plan = plan; writeJson(join(this.dataDir, 'cache', 'plan.json'), plan, 0o644); this.server.emit('plan'); this.renderer?.notify?.(); }
    else if (m.type === 'media_manifest') { const { v, type, ...mf } = m; this.manifest = mf; writeJson(join(this.dataDir, 'cache', 'manifest.json'), mf, 0o644); this.runSync(); }
    else if (m.type === 'command') this.runCommand(m);
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

  async runSync() {
    if (this.syncing) { this.resync = true; return; } this.syncing = true;
    try {
      const st = await syncMedia({ manifest: this.manifest, dir: this.mediaDir, fetchRange: this.fetchRange, jitterMs: this.cfg.syncJitterMs ?? 3000, window: this.cfg.syncWindow ?? '', bandwidthKbps: this.cfg.bandwidthKbps ?? 0,
        onProgress: (s) => { this.syncState = { done: s.done, total: s.total }; } });
      this.syncState = { done: st.done, total: st.total, failed: st.failed.length }; this.server.emit('manifest'); this.sendHeartbeat();
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
      if (command === 'reload') { this.server.emit('reload'); this.renderer?.notify?.(); return done(true); }
      if (command === 'reconnect') { done(true); this.ws?.close(); return; }
      if (command === 'reboot') { done(true); privRequest(this.privdDir, 'reboot'); return; }
      if (command === 'screenshot') { const png = await this.renderer?.screenshot?.(); if (!png) return done(false, null, 'Der Bildschirm kann keinen Screenshot erstellen.'); this.send('screenshot', { png: png.toString('base64') }); return done(true); }
      if (command === 'rotate') { this.cfg.orientation = args.degrees; writeJson(this.cfgFile, this.cfg); privRequest(this.privdDir, 'display-rotate', { degrees: args.degrees }); this.server.emit('reload'); this.renderer?.restart?.(); return done(true); }
      if (command === 'wifi_change') { done(true); privRequest(this.privdDir, 'wifi-connect', { ssid: args.ssid, password: args.password }); return; }
      if (command === 'factory_reset') { done(true); privRequest(this.privdDir, 'factory-reset'); return; }
      if (command === 'update') return done(...(await this.runUpdate()));
      done(false, null, 'Unbekannter Befehl');
    } catch (e) { done(false, null, e.message); }
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
  const a = new Agent({ dataDir, log: (...x) => console.error(...x), port: 8080 });
  a.renderer = cfg?.profile === 'lite' ? liteRenderer({ getPlan: () => a.plan, getManifest: () => a.manifest, getRotation: () => a.cfg?.orientation ?? 0, haveFile: (m) => existsSync(join(a.mediaDir, m.id)), fileOf: (i) => join(a.mediaDir, i.mediaId), profile: 'lite' })
    : chromiumRenderer({ url: 'http://127.0.0.1:8080/player/', profileDir: join(dataDir, 'chromium-profile') });
  await a.start();
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => a.stop().then(() => process.exit(0)));
}
