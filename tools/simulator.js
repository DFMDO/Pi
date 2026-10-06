// Simulator-Player (Teil E): virtuelle Pi-Player, die sich wie echte beim Hub anmelden – Pairing mit Pinning, WSS, Heartbeat, Plan-Auswertung,
// „status“-Meldungen für die Live-Ansicht. Mehrere gleichzeitig, Profil Lite/Standard/Pro wählbar. Für automatische Tests von Pairing, Zeitplan, Live und Konflikten.
// Start: node tools/simulator.js --hub https://dfm-signage.local --code ABCD-1234 --count 5 --profile standard   (jede Instanz muss im Hub bestätigt werden)
// Hinweis: bewusst NICHT im Browser – ein Browser-WebSocket kann keinen Authorization-Header senden; ein Zusatz-Anmeldeweg würde die Sicherheit des Hubs schwächen.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { pairWithHub } from '../player/agent/lib/pair.js';
import { pinnedAgent } from '../player/agent/lib/pinned.js';
import { validateMessage, msg } from '../shared/protocol.js';
import { resolvePlaylist, playableItems } from '../shared/sequencer.js';

export class SimPlayer {
  constructor({ hubUrl, name = 'Simulator', profile = 'standard', model, heartbeatMs = 5000, tick = 1000, state = {} }) {
    Object.assign(this, { hubUrl, name, profile, heartbeatMs, tickMs: tick, deviceId: randomUUID(), plan: null, manifest: null, connected: false, sent: [], received: [], cmds: [], idx: 0, cur: null, extra: state });
    this.model = model ?? { lite: 'Raspberry Pi Zero 2 W (Simulator)', standard: 'Raspberry Pi 3 Model B+ (Simulator)', pro: 'Raspberry Pi 4 Model B (Simulator)' }[profile];
  }
  /** Pairing wie ein echter Pi (Code + HMAC + Fingerabdruck). approve() bestätigt im Hub (Admin-Aufruf). */
  async pair(code, { approve, expectedFp } = {}) {
    const p = pairWithHub({ hubUrl: this.hubUrl, code, expectedFp, deviceId: this.deviceId, name: this.name, model: this.model, profile: this.profile, hw: { simulator: true, arch: 'x64' }, pollMs: 100 });
    if (approve) setTimeout(() => approve(this.deviceId), 300);
    const r = await p; this.token = r.token; this.spki = r.spki; return r;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.hubUrl.replace('https', 'wss') + '/api/v1/ws', { agent: pinnedAgent(this.spki), headers: { Authorization: `Bearer ${this.token}` }, handshakeTimeout: 10000 });
      this.ws = ws; ws.on('error', reject);
      ws.on('open', () => { this.connected = true; this.send('hello', { version: '0.2.0-sim', profile: this.profile, model: this.model, hw: { simulator: true } }); this.heartbeat(); this.hb = setInterval(() => this.heartbeat(), this.heartbeatMs); this.tk = setInterval(() => this.step(), this.tickMs); resolve(this); });
      ws.on('message', (raw) => this.onMessage(raw.toString()));
      ws.on('close', (code) => { this.connected = false; this.closeCode = code; clearInterval(this.hb); clearInterval(this.tk); });
    });
  }
  send(type, body) { if (this.ws?.readyState === 1) { const m = msg(type, body); this.sent.push(JSON.parse(m)); this.ws.send(m); } }
  heartbeat() { this.send('heartbeat', { state: { version: '0.2.0-sim', uptimeS: Math.round(process.uptime()), cpuTemp: 45, ramTotalMB: 1024, ramUsedMB: 300, signalDbm: -55, timeSynced: true, epoch: Date.now(), diskFreeMB: 4000, throttled: 0, syncState: { total: 0, done: 0 }, nowPlaying: this.cur && { name: this.cur.name }, ...this.extra } }); }
  async onMessage(raw) {
    const m = JSON.parse(raw); if (validateMessage(m)) return; this.received.push(m.type);
    if (m.type === 'schedule_update') { const { v, type, ...p } = m; this.plan = p; this.cur = null; }
    else if (m.type === 'media_manifest') { const { v, type, ...p } = m; this.manifest = p; }
    else if (m.type === 'command') { this.cmds.push(m); this.send('command_result', { id: m.id, ok: true, result: m.command === 'update' ? { version: '0.3.0-sim' } : {} }); if (m.command === 'screenshot') this.send('screenshot', { png: PNG }); }
  }
  /** Spielt den Plan wie die Playerseite: gleiche Auflösung, meldet Wechsel per „status“ (Live-Ansicht Stufe 1) */
  step(now = Date.now()) {
    if (!this.plan) return; const r = resolvePlaylist(this.plan, now);
    const have = (mm) => true, { items } = playableItems(this.plan, r.playlistId, { items: (this.manifest?.items ?? []).map((i) => ({ ...i, pending: false })) }, { profile: this.profile, now, have });
    if (!items.length) { if (this.cur) { this.cur = null; } return; }
    if (!this.cur || this.cur.until <= now || this.cur.playlistId !== r.playlistId) {
      const it = items[this.idx++ % items.length], nx = items[this.idx % items.length]; this.cur = { mediaId: it.mediaId, name: it.name ?? '', playlistId: r.playlistId, until: now + (it.duration ?? 10) * 1000 };
      this.send('status', { current: { mediaId: it.mediaId, name: it.name ?? '', kind: it.kind ?? 'image', since: now, duration: it.duration ?? 10 }, next: items.length > 1 ? { mediaId: nx.mediaId, name: nx.name ?? '' } : null, source: r.source, scheduleId: r.scheduleId ?? null });
    }
  }
  close() { clearInterval(this.hb); clearInterval(this.tk); this.ws?.close(); }
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64');

/** Mehrere Simulatoren gleichzeitig starten (Pairing + Bestätigung) */
export async function startSimulators({ hubUrl, count = 3, profiles = ['lite', 'standard', 'pro'], code, approve, namePrefix = 'Sim', ...opts }) {
  const sims = []; for (let i = 0; i < count; i++) { const s = new SimPlayer({ hubUrl, name: `${namePrefix} ${i + 1}`, profile: profiles[i % profiles.length], ...opts }); await s.pair(typeof code === 'function' ? await code() : code, { approve }); await s.connect(); sims.push(s); }
  return sims;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
  if (!a.hub || !a.code) { console.error('Aufruf: node tools/simulator.js --hub https://… --code ABCD-1234 [--count 3] [--profile lite|standard|pro]'); process.exit(2); }
  const sims = await startSimulators({ hubUrl: a.hub, count: Number(a.count ?? 1), profiles: a.profile ? [a.profile] : undefined, code: a.code }); console.log(`${sims.length} Simulator(en) laufen. Strg+C beendet.`);
}
