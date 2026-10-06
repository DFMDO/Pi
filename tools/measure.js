// Messung auf dem Entwicklungsrechner: Speicher (RSS) und Startzeit von Hub und Player-Agent.
// Auf echter Hardware bitte tools/diagnose.sh nutzen (misst zusätzlich Temperatur, WLAN, Chromium/mpv).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../hub/lib/crypto.js';
import { ensureCertificate } from '../hub/lib/tls.js';
import { pairWithHub } from '../player/agent/lib/pair.js';
import { request } from '../player/agent/lib/pinned.js';

const rss = (pid) => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'measure-')), hubData = join(dir, 'hub'), agData = join(dir, 'agent');
import { mkdirSync } from 'node:fs'; mkdirSync(hubData, { recursive: true }); mkdirSync(agData, { recursive: true });
writeFileSync(join(hubData, 'hub-bootstrap.json'), JSON.stringify({ admin: { name: 'admin', pwHash: await hashPassword('Messung-Passwort-123') }, site: 'Messung' }));
const t0 = Date.now(); const hub = spawn(process.execPath, ['hub/server.js'], { env: { ...process.env, DFM_DATA: hubData, DFM_HTTPS_PORT: '18443', DFM_HTTP_PORT: '18080', DFM_UPDATE_KEY: '/nonexistent' }, stdio: 'ignore' });
let up = false; while (!up && Date.now() - t0 < 20000) { await wait(100); try { await request({ url: 'https://127.0.0.1:18443/api/v1/setup/state', pin: null, timeout: 500 }); up = true; } catch {} }
const hubStart = Date.now() - t0; await wait(1500);
const res = { hubStartMs: hubStart, hubIdleMB: Math.round(rss(hub.pid)) };
const login = await request({ url: 'https://127.0.0.1:18443/api/v1/auth/login', pin: null, method: 'POST', body: { name: 'admin', password: 'Messung-Passwort-123' } });
const cookie = login.headers['set-cookie'][0].split(';')[0], csrf = login.json().csrf; const H = { cookie, 'x-csrf-token': csrf };
const api = (m, u, b) => request({ url: 'https://127.0.0.1:18443/api/v1' + u, pin: null, method: m, body: b, headers: H });
const pairInfo = (await api('POST', '/pairing', {})).json(); const deviceId = randomUUID();
const p = pairWithHub({ hubUrl: 'https://127.0.0.1:18443', code: pairInfo.code, expectedFp: pairInfo.fingerprintRaw, deviceId, name: 'Messung', model: 'Messung', profile: 'standard', hw: {}, pollMs: 100 });
await wait(500); await api('POST', `/devices/${deviceId}/approve`, {}); const { token, spki } = await p;
writeFileSync(join(agData, 'agent.json'), JSON.stringify({ deviceId, hubUrl: 'https://127.0.0.1:18443', hubSpki: spki, token, profile: 'standard' }));
const t1 = Date.now(); const agent = spawn(process.execPath, ['player/agent/agent.js'], { env: { ...process.env, DFM_AGENT_DATA: agData, DFM_NO_RENDERER: '1', DFM_FAKE_TIMESYNC: '1', DFM_PORT: '18081' }, stdio: 'ignore' });
await wait(4000); res.agentIdleMB = Math.round(rss(agent.pid)); res.agentStartToConnectedMs = null;
for (let i = 0; i < 40; i++) { const d = (await api('GET', `/devices/${deviceId}`)).json(); if (d.online) { res.agentStartToConnectedMs = Date.now() - t1; break; } await wait(100); }
res.node = process.version; res.arch = process.arch; res.note = 'x86-Messung auf dem Entwicklungsrechner; arm64/Pi-Werte weichen ab (siehe docs/hardware-checkliste.md)';
console.log(JSON.stringify(res, null, 2)); hub.kill(); agent.kill(); process.exit(0);
