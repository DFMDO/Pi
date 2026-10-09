// Laufband, Uhr und Infozone für Bildschirme mit mpv („Video-optimiert“): mpv kann keine Webseite zeigen, deshalb zeichnet der Agent eine einfache
// Einblendung (ASS, mpv-Befehl osd-overlay) und macht das Video dafür etwas kleiner (video-margin-ratio-*), damit nichts verdeckt wird.
// Unterschied zum Browser: Das Laufband SCROLLT hier nicht, sondern zeigt die Meldungen seitenweise im Wechsel (spart Rechenleistung am Pi 3).
// Gezeichnet wird auf einer festen Fläche von 1920×1080; mpv skaliert sie auf den Bildschirm.
export const RES = { x: 1920, y: 1080 };
export const BAR_H = 80, INFO_W = 440, PAGE_MS = 6000;

/** Text für ASS unschädlich machen: { } \ würden als Formatbefehle gelesen, Steuerzeichen/Zeilenumbrüche entfallen */
export const esc = (s) => String(s ?? '').replace(/[{}\\]/g, (c) => ({ '{': '(', '}': ')', '\\': '/' })[c]).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const berlinDay = (now) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

/** Text in Zeilen von höchstens `max` Zeichen umbrechen (an Wortgrenzen; ein zu langes Wort wird gekürzt) */
export function wrapLines(text, max) {
  const lines = []; let cur = '';
  for (let w of esc(text).split(' ').filter(Boolean)) {
    if (w.length > max) w = w.slice(0, max - 1) + '…';
    if (!cur) cur = w; else if (cur.length + 1 + w.length <= max) cur += ' ' + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur); return lines;
}
/** Ein Laufband-Text wird in „Seiten“ geteilt, die in eine Zeile passen */
const pagesOf = (text, max) => wrapLines(text, max);

/**
 * @param layout { preset: 'ticker'|'ticker-clock'|'ticker-clock-info', info?: string }  (aus dem Plan)
 * @param tickers [{ text, validFrom?, validTo? }]
 * @returns null (nichts zeichnen) oder { events: string[] (ASS-Zeilen), marginBottom, marginRight, key }
 */
export function zonesFor({ layout, tickers = [], now = Date.now() }) {
  const preset = layout?.preset; if (!['ticker', 'ticker-clock', 'ticker-clock-info'].includes(preset)) return null;
  const clockOn = preset !== 'ticker', infoLines = preset === 'ticker-clock-info' && layout.info ? wrapLines(layout.info, 22).slice(0, 12) : [], infoOn = infoLines.length > 0;
  const d = berlinDay(now), msgs = tickers.filter((t) => t && t.text && (!t.validFrom || d >= t.validFrom) && (!t.validTo || d <= t.validTo)).map((t) => t.text);
  const pages = msgs.flatMap((m) => pagesOf(m, clockOn ? 62 : 84)), page = pages.length ? pages[Math.floor(now / PAGE_MS) % pages.length] : '';
  if (!page && !clockOn && !infoOn) return null;
  const y0 = RES.y - BAR_H, ev = [];
  const rect = (x, y, w, hgt, col) => `{\\an7\\pos(${x},${y})\\bord0\\shad0\\1c&H${col}&\\p1}m 0 0 l ${w} 0 ${w} ${hgt} 0 ${hgt}{\\p0}`;
  ev.push(rect(0, y0, RES.x, BAR_H, '1A1A1A'), rect(0, y0, RES.x, 4, '2E10C8')); // Leiste dunkel, oben roter Streifen (DFM-Rot c8102e als BGR)
  if (page) ev.push(`{\\an4\\pos(36,${y0 + 42})\\bord0\\shad0\\fnInter\\fs40\\1c&HFFFFFF&\\clip(0,${y0 + 4},${clockOn ? 1560 : RES.x},${RES.y})}${page}`);
  if (clockOn) {
    const t = new Date(now), hm = t.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }), date = t.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long' });
    ev.push(`{\\an6\\pos(${RES.x - 36},${y0 + 41})\\bord0\\shad0\\fnInter\\1c&HFFFFFF&}{\\fs46\\b1}${esc(hm)}{\\b0\\fs22}\\N${esc(date)}`);
  }
  if (infoOn) ev.push(rect(RES.x - INFO_W, 0, INFO_W, y0, '2D2D2D'), rect(RES.x - INFO_W, 0, 6, y0, '2E10C8'), `{\\an7\\pos(${RES.x - INFO_W + 34},40)\\bord0\\shad0\\fnInter\\fs34\\1c&HFFFFFF&}${infoLines.join('\\N')}`);
  const marginBottom = Math.round((BAR_H / RES.y) * 1000) / 1000, marginRight = infoOn ? Math.round((INFO_W / RES.x) * 1000) / 1000 : 0;
  return { events: ev, marginBottom, marginRight, key: `${marginBottom}|${marginRight}|${ev.join('\n')}` };
}
