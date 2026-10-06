// Grüne LED (Pi: ACT) als Statusanzeige für Geräte ohne Bildschirm:
// 3× kurz blinken, Pause = wartet auf Einrichtung · dauerhaft an = bereit · 1× lang pro Sekunde = Fehler.
export const PATTERNS = { waiting: [[150, 250], [150, 250], [150, 1700]], ready: 'on', error: [[800, 200]], off: 'off' };
export function createLed({ write, timers = { set: setTimeout, clear: clearTimeout } }) {
  let t = null, cur = null;
  const stop = () => { timers.clear(t); t = null; };
  const run = (steps, i = 0) => { const [on, off] = steps[i % steps.length]; write(1); t = timers.set(() => { write(0); t = timers.set(() => run(steps, i + 1), off); }, on); };
  return { set(name) { if (name === cur) return; cur = name; stop(); const p = PATTERNS[name]; if (p === 'on') write(1); else if (p === 'off' || !p) write(0); else run(p); }, stop };
}
export function sysfsWriter(fs, base = '/sys/class/leds') {
  const dir = ['ACT', 'led0'].map((n) => `${base}/${n}`).find((d) => fs.existsSync(d)); if (!dir) return () => {};
  try { fs.writeFileSync(`${dir}/trigger`, 'none'); } catch {}
  return (v) => { try { fs.writeFileSync(`${dir}/brightness`, v ? '1' : '0'); } catch {} };
}
