// Gleichtakt und Videowand: Alle Bildschirme einer Gruppe berechnen aus derselben Uhrzeit, welches Element jetzt läuft und wie weit es ist.
// So brauchen sie keine Verbindung untereinander: Die Uhren der Bildschirme stimmen über den Hub (chrony) auf wenige Millisekunden überein.
// Videowand: Jeder Bildschirm zeigt nur „seine“ Kachel des Bildes (Ausschnitt im Raster Spalten × Zeilen).

/** Erst Bildschirme ab dieser Version verstehen das Planfeld „wall“ (das Protokoll lehnt unbekannte Felder ab) */
export const WALL_MIN_VERSION = '0.2.29';
export const MAX_WALL = 4; // höchstens 4 × 4 Bildschirme

/** Dauer eines Elements in Millisekunden (Bild: eingestellte Dauer, Video: Länge). Muss auf allen Bildschirmen gleich gerechnet werden. */
export const slotMs = (it) => Math.max(1000, Math.round((it.kind === 'video' ? (it.durationS ?? 30) : (it.duration ?? 10)) * 1000));

/**
 * Welches Element läuft jetzt, und wie weit ist es? items: abspielbare Elemente (auf allen Bildschirmen der Gruppe dieselbe Liste),
 * epoch: gemeinsamer Startpunkt (ms, steht im Plan), now: ms.
 * @returns {{ index, offsetMs, startMs, endMs, cycleMs } | null}
 */
export function wallPosition(items, epoch, now) {
  const d = items.map(slotMs), cycle = d.reduce((s, x) => s + x, 0);
  if (!cycle || !Number.isFinite(epoch) || !Number.isFinite(now)) return null;
  const pos = (((now - epoch) % cycle) + cycle) % cycle;
  let acc = 0;
  for (let i = 0; i < d.length; i++) {
    if (pos < acc + d[i]) { const off = pos - acc; return { index: i, offsetMs: off, startMs: now - off, endMs: now - off + d[i], cycleMs: cycle }; }
    acc += d[i];
  }
  return null;
}

/**
 * Ausschnitt (Kachel) für mpv „video-crop“, in ganzen Prozent des Quellbilds.
 * Der Inhalt wird auf die ganze Wand „gefüllt“ (die überstehenden Ränder fallen weg), jede Kachel hat danach das Seitenverhältnis ihres Bildschirms.
 * Wichtig: mpv rechnet die Verschiebung (+x/+y) in Prozent des FREIEN Platzes (Quellbild minus Ausschnitt), wie bei einer Fensterposition –
 * verifiziert mit mpv 0.37 (tools/wall-experiment3.py). Darum wird der Anfang durch (1 − Breite) geteilt.
 * @param {{cols:number, rows:number, col:number, row:number, aspect?:number, tileAspect?:number}} o
 *   aspect: Seitenverhältnis des Inhalts (Breite/Höhe), tileAspect: Seitenverhältnis eines Bildschirms (16:9)
 * @returns {string} z. B. „50%x100%+0%+0%“; leer, wenn kein Zuschnitt nötig ist (1 × 1)
 */
export function tileCrop({ cols, rows, col, row, aspect = 16 / 9, tileAspect = 16 / 9 }) {
  if (!(cols >= 1 && rows >= 1) || (cols === 1 && rows === 1)) return '';
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const wallAspect = (cols * tileAspect) / rows;
  let fw = 1, fh = 1; if (a > wallAspect) fw = wallAspect / a; else fh = a / wallAspect; // gefüllte Fläche im Quellbild (Bruchteile)
  const W = fw / cols, H = fh / rows, X = (1 - fw) / 2 + col * W, Y = (1 - fh) / 2 + row * H;
  const pct = (v) => Math.max(0, Math.min(100, Math.round(v * 100)));
  return `${pct(W)}%x${pct(H)}%+${W < 1 ? pct(X / (1 - W)) : 0}%+${H < 1 ? pct(Y / (1 - H)) : 0}%`;
}

/** Rechnet einen Zuschnitt wie mpv in Bruchteile des Quellbilds zurück (für Tests): { x, y, w, h } */
export function cropRect(crop) {
  const m = /^(\d+)%x(\d+)%\+(\d+)%\+(\d+)%$/.exec(crop); if (!m) return { x: 0, y: 0, w: 1, h: 1 };
  const [w, h, xp, yp] = m.slice(1).map((v) => Number(v) / 100); return { w, h, x: (1 - w) * xp, y: (1 - h) * yp };
}
