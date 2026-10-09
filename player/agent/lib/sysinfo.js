// Geräte-Zustand für den Heartbeat (Temperatur, RAM, WLAN-Signal, Zeitsync …).
import { readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { uptime, loadavg } from 'node:os';

export const MIN_EPOCH = Date.UTC(2026, 0, 1);
const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const run = (c, a) => new Promise((res) => execFile(c, a, { timeout: 4000 }, (e, so) => res(e ? '' : so)));

export function parseMeminfo(t) {
  const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t ?? '') ?? [])[1] ?? 0);
  const total = g('MemTotal'), avail = g('MemAvailable');
  return { ramTotalMB: Math.round(total / 1024), ramUsedMB: Math.round((total - avail) / 1024) };
}
export function parseLink(t) { // „iw dev wlan0 link“: Zugangspunkt, Kanal, Band
  const bssid = (/Connected to ([0-9a-f:]{17})/i.exec(t ?? '') ?? [])[1] ?? null, ssid = (/SSID: (.*)/.exec(t ?? '') ?? [])[1] ?? null, freq = Number((/freq: (\d+)/.exec(t ?? '') ?? [])[1]) || null;
  const channel = freq ? (freq >= 5955 ? Math.round((freq - 5950) / 5) : freq >= 5000 ? Math.round((freq - 5000) / 5) : freq === 2484 ? 14 : Math.round((freq - 2407) / 5)) : null;
  return { bssid, ssid, freq, channel, band: freq ? (freq >= 5955 ? '6 GHz' : freq >= 4900 ? '5 GHz' : '2,4 GHz') : null };
}
/** Raspberry-Pi-Throttling-Bits: 0x1 Unterspannung, 0x4 gedrosselt, 0x10000/0x40000 früher aufgetreten */
export const parseThrottled = (t) => { const m = /throttled=0x([0-9a-f]+)/i.exec(t ?? ''); return m ? parseInt(m[1], 16) : null; };
export const parseSignal = (t) => { const m = /signal:\s*(-?\d+) dBm/.exec(t ?? ''); return m ? Number(m[1]) : null; };

/** authority: Das Gerät IST die Zeitquelle (Hub + Bildschirm in einem): Es gibt keinen anderen Zeitgeber, die Uhr stellt der Admin in der Verwaltung. Dann zählt nur, dass sie nicht vor dem Bau des Images steht. */
export async function timeSynced({ authority = false } = {}) {
  if (process.env.DFM_FAKE_TIMESYNC) return process.env.DFM_FAKE_TIMESYNC === '1';
  if (Date.now() < MIN_EPOCH) return false; // Datum vor dem Bau des Images = Uhr nicht gestellt
  if (authority) return true;
  const t = (await run('chronyc', ['-c', 'tracking'])).trim().split(',');  // refid,name,stratum,…,leapstatus
  if (t.length > 13) return Number(t[2]) < 16 && t[13] === 'Normal';
  return (await run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'])).trim() === 'yes';
}
let sdCache = { at: 0, n: 0 };
/** SD-Karten-Fehler im Kernel-Protokoll seit dem Start (alle 10 Minuten neu gezählt) */
async function sdErrors() {
  if (Date.now() - sdCache.at < 600000) return sdCache.n;
  const out = await run('journalctl', ['-k', '-b', '-q', '--no-pager', '-g', 'mmcblk0.*(I/O error|timeout|CRC)']); sdCache = { at: Date.now(), n: out.split('\n').filter(Boolean).length }; return sdCache.n;
}
export async function collect({ version, extra = {}, authority = false }) {
  const t = read('/sys/class/thermal/thermal_zone0/temp'); const link = await run('iw', ['dev', 'wlan0', 'link']);
  let diskFreeMB = null; try { const s = statfsSync(process.env.DFM_DATA ?? '/data'); diskFreeMB = Math.round((s.bavail * s.bsize) / 1048576); } catch {}
  return { version, epoch: Date.now(), uptimeS: Math.round(uptime()), cpuTemp: t ? Math.round(parseInt(t, 10) / 100) / 10 : null, load1: Math.round(loadavg()[0] * 100) / 100, ...parseMeminfo(read('/proc/meminfo')),
    signalDbm: parseSignal(link), wifi: parseLink(link), throttled: parseThrottled(await run('vcgencmd', ['get_throttled'])), diskFreeMB, sdErrors: await sdErrors(), timeSynced: await timeSynced({ authority }), ...extra };
}

/** Hardware erkennen → Modell, RAM, Architektur, Profilvorschlag */
export function detectHardware(model = (read('/proc/device-tree/model') ?? '').replace(/\0/g, ''), memMB = parseMeminfo(read('/proc/meminfo')).ramTotalMB, arch = process.arch) {
  let profile = 'standard';
  if (/Zero|Pi 1|Pi 2|Model [AB]( Plus)? Rev|Pi Model/.test(model) && !/Pi 3|Pi 4|Pi 5/.test(model) || memMB < 700) profile = 'lite';
  else if (/Pi (4|5|400|500)|Compute Module [45]/.test(model)) profile = 'pro';
  else if (/Pi 3|Compute Module 3/.test(model)) profile = 'standard';
  return { model, ramMB: memMB, arch, profile };
}

/** mpv-Statuszeile „D:<verworfen>/<Decoder verworfen> F:<Bilder>“ auswerten → Prozent ausgelassener Bilder */
export function parseDrops(out) {
  const m = [...String(out).matchAll(/D:(\d+)\/(\d+) F:(\d+)/g)].pop(); if (!m) return null;
  const frames = Number(m[3]) || 0; return { dropped: Number(m[1]) + Number(m[2]), frames, percent: frames ? Math.round(((Number(m[1]) + Number(m[2])) / frames) * 1000) / 10 : null };
}
export const powerSave = async () => (/Power save: (\w+)/.exec(await run('iw', ['dev', 'wlan0', 'get', 'power_save'])) ?? [])[1] ?? null;
