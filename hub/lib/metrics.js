// Messwerte-Verlauf: Der Hub speichert etwa einmal pro Minute freien Speicher, Last und Temperatur – von sich selbst und von jedem Bildschirm
// (aus dessen Heartbeat). So sieht man Lecks und Hitze als Kurve, ohne die SD-Karte zu ziehen. Aufbewahrung 14 Tage.
import { readFileSync, statfsSync } from 'node:fs';
import { totalmem, freemem, loadavg } from 'node:os';

/** Arbeitsspeicher des Hubs in MB (aus /proc/meminfo; MemAvailable ist der Wert, der wirklich zählt) */
export function memInfo() {
  try {
    const t = readFileSync('/proc/meminfo', 'utf8'), g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t) ?? [])[1] ?? NaN) / 1024;
    const avail = g('MemAvailable');
    if (Number.isFinite(avail)) return { totalMB: g('MemTotal'), availMB: avail, swapTotalMB: g('SwapTotal') || 0, swapUsedMB: (g('SwapTotal') || 0) - (g('SwapFree') || 0) };
  } catch {}
  return { totalMB: totalmem() / 1048576, availMB: freemem() / 1048576, swapTotalMB: 0, swapUsedMB: 0 };
}
const cpuTemp = () => { try { return parseInt(readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8'), 10) / 1000; } catch { return null; } };
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

export const HUB = 'hub';
export const RETENTION_DAYS = 14;

export function createMetrics({ db, now = () => Date.now(), dataDir = null }) {
  const ins = db.prepare('INSERT INTO metrics(ts,src,mem_avail,mem_total,swap_used,load1,temp,disk_free) VALUES(?,?,?,?,?,?,?,?)');
  const diskFree = () => { try { if (!dataDir) return null; const s = statfsSync(dataDir); return Math.round((s.bavail * s.bsize) / 1048576); } catch { return null; } };
  const last = new Map();
  /** Eine Messung speichern, höchstens alle minGapMs je Quelle */
  function record(src, s, minGapMs = 55000) {
    const t = now(); if (t - (last.get(src) ?? 0) < minGapMs) return false; last.set(src, t);
    ins.run(t, src, num(s.memAvailMB), num(s.memTotalMB), num(s.swapUsedMB), num(s.load1), num(s.tempC), num(s.diskFreeMB)); return true;
  }
  const recordHub = () => { const m = memInfo(); return record(HUB, { memAvailMB: m.availMB, memTotalMB: m.totalMB, swapUsedMB: m.swapUsedMB, load1: loadavg()[0], tempC: cpuTemp(), diskFreeMB: diskFree() }); };
  /** aus dem Heartbeat eines Bildschirms (state: ramTotalMB, ramUsedMB, cpuTemp, load1) */
  const recordDevice = (id, st = {}) => record(id, { memAvailMB: num(st.ramTotalMB) != null && num(st.ramUsedMB) != null ? st.ramTotalMB - st.ramUsedMB : null, memTotalMB: st.ramTotalMB, load1: st.load1, tempC: st.cpuTemp, diskFreeMB: st.diskFreeMB });
  /** Verlauf der letzten `hours` Stunden, auf höchstens maxPoints Punkte gemittelt */
  function query(src, hours, maxPoints = 240) {
    const to = now(), from = to - hours * 3600000, step = Math.max(60000, Math.ceil((to - from) / maxPoints));
    const rows = db.prepare('SELECT ts, mem_avail a, mem_total t, swap_used s, load1 l, temp c, disk_free f FROM metrics WHERE src=? AND ts>=? ORDER BY ts').all(src, from);
    const buckets = new Map();
    for (const r of rows) { const k = Math.floor((r.ts - from) / step); const b = buckets.get(k) ?? { ts: 0, n: 0, a: [], t: [], s: [], l: [], c: [], f: [] }; b.ts += r.ts; b.n++; for (const f of ['a', 't', 's', 'l', 'c', 'f']) if (r[f] != null) b[f].push(r[f]); buckets.set(k, b); }
    const avg = (xs) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null);
    const points = [...buckets.entries()].sort((x, y) => x[0] - y[0]).map(([, b]) => ({ ts: Math.round(b.ts / b.n), memAvailMB: r1(avg(b.a)), memTotalMB: r1(avg(b.t)), swapUsedMB: r1(avg(b.s)), load1: r1(avg(b.l)), tempC: r1(avg(b.c)), diskFreeMB: r1(avg(b.f)) }));
    return { from, to, points };
  }
  const prune = () => db.prepare('DELETE FROM metrics WHERE ts < ?').run(now() - RETENTION_DAYS * 86400000).changes;
  return { record, recordHub, recordDevice, query, prune };
}
