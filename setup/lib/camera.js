// Optional: USB-/CSI-Kamera scannt einen WLAN-QR vom Handy (Standardformat WIFI:T:WPA;S:…;P:…;;).
// Nur Zusatz – die Einrichtung geht immer auch ohne Kamera.
import { parseWifiQr } from './parse.js';

/** Ein Bild aufnehmen und QR-Codes lesen. `run(cmd,args)` → Promise<{code,stdout}>. */
export async function scanOnce({ run, device = '/dev/video0', frame = '/run/dfm/cam.jpg' }) {
  const g = await run('ffmpeg', ['-y', '-v', 'quiet', '-f', 'v4l2', '-i', device, '-frames:v', '1', frame]);
  if (g.code !== 0) return null;
  const z = await run('zbarimg', ['--raw', '-q', frame]);
  for (const line of z.stdout.split('\n')) { const w = parseWifiQr(line.trim()); if (w) return w; }
  return null;
}
export function startCameraLoop({ run, exists, onWifi, intervalMs = 3000, log = () => {} }) {
  if (!exists('/dev/video0')) return { stop() {} };
  let stopped = false, t = null;
  const tick = async () => { if (stopped) return; try { const w = await scanOnce({ run }); if (w) { onWifi(w); log('WLAN-QR per Kamera erkannt'); } } catch {} t = setTimeout(tick, intervalMs); };
  t = setTimeout(tick, intervalMs);
  return { stop() { stopped = true; clearTimeout(t); } };
}
