// Geräte-Zustand für den Heartbeat (Temperatur, RAM, WLAN-Signal, Zeitsync …).
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { uptime } from 'node:os';

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const run = (c, a) => new Promise((res) => execFile(c, a, { timeout: 4000 }, (e, so) => res(e ? '' : so)));

export function parseMeminfo(t) {
  const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t ?? '') ?? [])[1] ?? 0);
  const total = g('MemTotal'), avail = g('MemAvailable');
  return { ramTotalMB: Math.round(total / 1024), ramUsedMB: Math.round((total - avail) / 1024) };
}
export const parseSignal = (t) => { const m = /signal:\s*(-?\d+) dBm/.exec(t ?? ''); return m ? Number(m[1]) : null; };

export async function timeSynced() {
  if (process.env.DFM_FAKE_TIMESYNC) return process.env.DFM_FAKE_TIMESYNC === '1';
  const o = (await run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'])).trim();
  return o === 'yes';
}
export async function collect({ version, extra = {} }) {
  const t = read('/sys/class/thermal/thermal_zone0/temp');
  return { version, uptimeS: Math.round(uptime()), cpuTemp: t ? Math.round(parseInt(t, 10) / 100) / 10 : null, ...parseMeminfo(read('/proc/meminfo')),
    signalDbm: parseSignal(await run('iw', ['dev', 'wlan0', 'link'])), timeSynced: await timeSynced(), ...extra };
}

/** Hardware erkennen → Modell, RAM, Architektur, Profilvorschlag */
export function detectHardware(model = (read('/proc/device-tree/model') ?? '').replace(/\0/g, ''), memMB = parseMeminfo(read('/proc/meminfo')).ramTotalMB, arch = process.arch) {
  let profile = 'standard';
  if (/Zero|Pi 1|Pi 2|Model [AB]( Plus)? Rev|Pi Model/.test(model) && !/Pi 3|Pi 4|Pi 5/.test(model) || memMB < 700) profile = 'lite';
  else if (/Pi (4|5|400|500)|Compute Module [45]/.test(model)) profile = 'pro';
  else if (/Pi 3|Compute Module 3/.test(model)) profile = 'standard';
  return { model, ramMB: memMB, arch, profile };
}
