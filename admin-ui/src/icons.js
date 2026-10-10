// Einheitliche Symbole (Linien-Stil, 24 × 24, Farbe = Schriftfarbe). Alles Konstanten – nichts davon kommt aus Eingaben, darum kein Risiko.
// h() in ui.js ersetzt ein Emoji am Anfang eines Textes automatisch durch das passende Symbol, damit die ganze Oberfläche gleich aussieht.
// Form je Eintrag: 'p:<Pfad>', 'c:<cx>,<cy>,<r>', 'r:<x>,<y>,<Breite>,<Höhe>,<Rundung>', 'l:<x1>,<y1>,<x2>,<y2>'.
const D = {
  home: ['p:M3 11.5 12 4l9 7.5', 'p:M5 10v10h14V10', 'p:M10 20v-6h4v6'],
  eye: ['p:M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'c:12,12,3'],
  monitor: ['r:2,4,20,13,2', 'p:M8 21h8M12 17v4'],
  image: ['r:3,3,18,18,2', 'c:9,9,2', 'p:m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21'],
  list: ['p:M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  play: ['p:M7 4.5v15l12-7.5z'],
  pause: ['p:M8 5v14M16 5v14'],
  stop: ['r:6,6,12,12,2'],
  grid: ['r:3,3,7,7,1.5', 'r:14,3,7,7,1.5', 'r:3,14,7,7,1.5', 'r:14,14,7,7,1.5'],
  calendar: ['r:3,4,18,18,2', 'p:M16 2v4M8 2v4M3 10h18'],
  layers: ['p:M12 3 2 8l10 5 10-5z', 'p:M2 12.5l10 5 10-5', 'p:M2 17l10 5 10-5'],
  zap: ['p:M13 2 3 14h9l-1 8 10-12h-9z'],
  pin: ['p:M12 17v5', 'p:M9 3h6l-1 7 4 4H6l4-4z'],
  map: ['p:M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z', 'p:M9 3v15M15 6v15'],
  activity: ['p:M22 12h-4l-3 9L9 3l-3 9H2'],
  help: ['c:12,12,10', 'p:M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01'],
  info: ['c:12,12,10', 'p:M12 16v-5M12 8h.01'],
  users: ['c:9,7,4', 'p:M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9'],
  file: ['p:M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'p:M14 2v6h6M8 13h8M8 17h8'],
  buoy: ['c:12,12,10', 'c:12,12,4', 'p:M4.9 4.9l4.3 4.3M14.8 14.8l4.3 4.3M14.8 9.2l4.3-4.3M4.9 19.1l4.3-4.3'],
  sliders: ['p:M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'],
  sun: ['c:12,12,4', 'p:M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
  plus: ['p:M12 5v14M5 12h14'],
  upload: ['p:M12 16V4M7 9l5-5 5 5M4 20h16'],
  download: ['p:M12 4v12M7 11l5 5 5-5M4 20h16'],
  tag: ['p:M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'c:7.5,7.5,1'],
  qr: ['r:3,3,7,7,1', 'r:14,3,7,7,1', 'r:3,14,7,7,1', 'p:M14 14h3v3M21 14v.01M14 21h3M21 17v4'],
  video: ['r:2,6,14,12,2', 'p:m22 8-6 4 6 4z'],
  camera: ['p:M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z', 'c:12,13,4'],
  folder: ['p:M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  edit: ['p:M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  trash: ['p:M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6'],
  siren: ['p:M7 18v-6a5 5 0 0 1 10 0v6M5 18h14v3H5zM12 2v2M4.2 5.2l1.4 1.4M19.8 5.2l-1.4 1.4'],
  megaphone: ['p:M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1z', 'p:M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13'],
  present: ['r:3,3,18,12,1.5', 'p:M12 15v5M8 21h8'],
  cast: ['p:M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6', 'p:M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01'],
  link: ['p:M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'p:M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'],
  search: ['c:11,11,7', 'p:m21 21-4.3-4.3'],
  sparkles: ['p:M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'p:M19 17v4M17 19h4'],
  alert: ['p:M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'p:M12 9v4M12 17h.01'],
  check: ['p:M20 6 9 17l-5-5'],
  x: ['p:M18 6 6 18M6 6l12 12'],
  clock: ['c:12,12,10', 'p:M12 6v6l4 2'],
  hourglass: ['p:M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4'],
  plug: ['p:M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z'],
  shield: ['p:M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  lock: ['r:4,11,16,10,2', 'p:M8 11V7a4 4 0 0 1 8 0v4'],
  wifi: ['p:M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0'],
  trend: ['p:M22 7 13.5 15.5l-5-5L2 17', 'p:M16 7h6v6'],
  film: ['r:3,3,18,18,2', 'p:M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4'],
  mail: ['r:3,5,18,14,2', 'p:m3 7 9 6 9-6'],
  book: ['p:M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z', 'p:M4 4.5V22'],
  undo: ['p:M9 14 4 9l5-5', 'p:M4 9h10a6 6 0 0 1 0 12h-3'],
  refresh: ['p:M21 12a9 9 0 0 1-15.5 6.2L3 16', 'p:M3 21v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5'],
  compass: ['c:12,12,10', 'p:M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z'],
  flag: ['p:M4 22V4M4 4h13l-2 4 2 4H4'],
  door: ['p:M14 3H5a1 1 0 0 0-1 1v17h10', 'p:M10 12h.01M14 21h6M17 8l4 4-4 4M21 12h-9'],
  news: ['p:M4 4h13a1 1 0 0 1 1 1v15a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z', 'p:M18 9h3v11a2 2 0 0 1-2 2M8 8h6M8 12h6M8 16h6'],
  ball: ['c:12,12,10', 'p:M12 7.5l4 3-1.5 4.5h-5L8 10.5z', 'p:M12 2v5.5M20.5 8.5 16 10.5M17.5 19 14.5 15M6.5 19 9.5 15M3.5 8.5 8 10.5'],
  box: ['p:M21 8 12 3 3 8v8l9 5 9-5z', 'p:M3 8l9 5 9-5M12 13v9'],
  inbox: ['p:M22 12h-6l-2 3h-4l-2-3H2', 'p:M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z'],
  dot: ['c:12,12,5'],
  thermo: ['p:M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z'],
  arrow: ['p:M5 12h14M13 6l6 6-6 6'],
  left: ['p:M15 6l-6 6 6 6'],
  right: ['p:M9 6l6 6-6 6'],
  gauge: ['p:M12 14l4-4', 'p:M3.3 19a10 10 0 1 1 17.4 0'],
  printer: ['p:M6 9V2h12v7', 'p:M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'r:6,14,12,8,1'],
  wrench: ['p:M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2.3-.7-.7-2.3z'],
  ban: ['c:12,12,10', 'p:m4.9 4.9 14.2 14.2'],
  bulb: ['p:M9 18h6M10 22h4', 'p:M12 2a7 7 0 0 0-4 12.7c.7.6 1 1.4 1 2.3h6c0-.9.3-1.7 1-2.3A7 7 0 0 0 12 2z'],
  party: ['p:M5.8 20.2 4 22l1.8-6 6.3 4.2', 'p:M7 15l-3 6 6-3zM14 4l.5 2M20 9l-2 .5M17 2l-1 3M22 15l-3-1'],
  calendarday: ['r:3,4,18,18,2', 'p:M16 2v4M8 2v4M3 10h18', 'c:12,16,1.5'],
  repeat: ['p:M17 2l4 4-4 4', 'p:M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3'],
};
const SVGNS = 'http://www.w3.org/2000/svg';
const build = (spec) => {
  const [k, rest] = [spec[0], spec.slice(2)], v = rest.split(',');
  if (k === 'p') { const e = document.createElementNS(SVGNS, 'path'); e.setAttribute('d', rest); return e; }
  if (k === 'c') { const e = document.createElementNS(SVGNS, 'circle'); e.setAttribute('cx', v[0]); e.setAttribute('cy', v[1]); e.setAttribute('r', v[2]); return e; }
  if (k === 'r') { const e = document.createElementNS(SVGNS, 'rect'); e.setAttribute('x', v[0]); e.setAttribute('y', v[1]); e.setAttribute('width', v[2]); e.setAttribute('height', v[3]); e.setAttribute('rx', v[4] ?? 0); return e; }
  const e = document.createElementNS(SVGNS, 'line'); e.setAttribute('x1', v[0]); e.setAttribute('y1', v[1]); e.setAttribute('x2', v[2]); e.setAttribute('y2', v[3]); return e;
};
/** Symbol als Element (für Screenreader versteckt – der Text daneben sagt, was gemeint ist) */
export function icon(name, cls = '') {
  const wrap = document.createElement('span'); wrap.className = 'ico i-' + (name in D ? name : 'dot') + (cls ? ' ' + cls : ''); wrap.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('focusable', 'false');
  for (const s of D[name] ?? D.dot) svg.append(build(s));
  wrap.append(svg); return wrap;
}
export const hasIcon = (name) => name in D;

// Emoji / Zeichen → Symbolname. Nicht aufgeführte Emoji bleiben unverändert stehen.
const MAP = {
  '🏠': 'home', '📺': 'eye', '🖥': 'monitor', '🖼': 'image', '▶': 'play', '🧩': 'grid', '📅': 'calendar', '🗓': 'calendar', '🎬': 'layers', '🤖': 'zap', '⚡': 'zap', '📌': 'pin', '🗺': 'map', '🩺': 'activity',
  '❓': 'help', '❔': 'help', '👥': 'users', '📜': 'file', '🛟': 'buoy', '⚙': 'sliders', '🌓': 'sun', '➕': 'plus', '⬆': 'upload', '⬇': 'download', '🏷': 'tag', '🔳': 'qr', '📹': 'video', '📷': 'camera',
  '📁': 'folder', '📂': 'folder', '📝': 'edit', '✏': 'edit', '✎': 'edit', '🧹': 'sparkles', '🗑': 'trash', '✨': 'sparkles', '🚨': 'siren', '📢': 'megaphone', '📑': 'present', '📄': 'file', '🔗': 'link', '🔍': 'search',
  '⚠': 'alert', '🔌': 'plug', '🕒': 'clock', '🕘': 'clock', '⏰': 'clock', '⏳': 'hourglass', '✔': 'check', '✓': 'check', '✖': 'x', '✕': 'x', 'ℹ': 'info', '⏸': 'pause', '⏹': 'stop', '↩': 'undo',
  '🛡': 'shield', '🔒': 'lock', '🔐': 'lock', '📶': 'wifi', '📈': 'trend', '🎞': 'film', '✉': 'mail', '📖': 'book', '🧭': 'compass', '🎌': 'flag', '🚪': 'door', '📰': 'news', '🔄': 'refresh', '⚽': 'ball',
  '🏟': 'ball', '🧱': 'grid', '📦': 'box', '📭': 'inbox', '🔮': 'gauge', '🧰': 'wrench', '🔧': 'wrench', '🖨': 'printer', '⛔': 'ban', '⬛': 'monitor', '💡': 'bulb', '🎉': 'party', '🎄': 'party', '🌦': 'sun', '📡': 'wifi',
  '🆘': 'buoy', '📚': 'book', '●': 'dot', '▲': 'alert', '◀': 'arrow', '↔': 'repeat', '🔁': 'repeat',
};
const LEAD = /^\s*(\p{Extended_Pictographic}️?|[✔✓✕✖●▲ℹ⏸▶⏹↩◀↔✎✏⚠⚙⬆⬇✉])\s*/u;
/** Beginnt der Text mit einem bekannten Emoji? → { name, rest } (rest = der Text danach), sonst null. Ein einzelnes ◀ oder ▶ (ohne Emoji-Variante) ist ein Pfeil (Kalender „zurück/weiter“). */
export function lead(s) {
  const m = LEAD.exec(s); if (!m) return null;
  const emoji = m[1].includes('️'), ch = m[1].replace(/️/g, ''); let name = MAP[ch]; if (!name) return null;
  const rest = s.slice(m[0].length);
  if (!rest && !emoji && ch === '▶') name = 'right'; if (!rest && !emoji && ch === '◀') name = 'left'; // nur das einfache Zeichen ist ein Pfeil (Kalender), das Emoji ▶️ ist „Abspielen“
  return { name, rest };
}
