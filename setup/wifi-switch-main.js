// Wird vom Root-Dienst (privd) gestartet: wifi-switch-main.js <ssid> <passwort>. Schreibt das Ergebnis nach /data/state/wifi-switch-result.json.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { switchWifi } from './lib/wifi-switch.js';

const [ssid, password] = process.argv.slice(2), dataDir = process.env.DFM_DATA ?? '/data';
const run = (cmd, args, { timeout = 30000 } = {}) => new Promise((res) => execFile(cmd, args, { timeout }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const hub = (() => { try { return new URL(JSON.parse(readFileSync(`${dataDir}/agent/agent.json`, 'utf8')).hubUrl); } catch { return null; } })();
const reachable = () => new Promise((res) => { if (!hub) return res(true); const s = net.connect({ host: hub.hostname, port: Number(hub.port || 443), timeout: 4000 }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); }); });
const r = await switchWifi({ run, ssid, password, reachable, log: console.error });
mkdirSync(`${dataDir}/state`, { recursive: true }); writeFileSync(`${dataDir}/state/wifi-switch-result.json`, JSON.stringify({ ...r, ssid, ts: Date.now() }));
process.exit(r.ok ? 0 : 1);
