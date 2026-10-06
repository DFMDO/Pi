// Vorlagen (Z.5), Lesbarkeitsprüfung, QR-Code-Element (Z.12): reine Funktionen, alles lokal.
import QRCode from 'qrcode';
import sharp from 'sharp';
import jsQR from 'jsqr';

const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const dateDE = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d}. ${MON[m - 1]} ${y}`; };
const berlinToday = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** Textfarben der Stile (müssen zu app.css/player.css passen) für die Kontrastprüfung */
export const STYLES = { standard: { fg: '#ffffff', bg: '#1a1a1a' }, hinweis: { fg: '#1a1a1a', bg: '#f2a900' }, highlight: { fg: '#ffffff', bg: '#c8102e' } };
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Mitgelieferte DFM-Vorlagen. dyn = wird täglich neu berechnet (Countdown, Datum). */
export const BUILTIN = [
  { id: 'tagesprogramm', name: 'Tagesprogramm', style: 'standard', fields: [{ key: 'titel', label: 'Überschrift', def: 'Heute im Museum', max: 60 }, { key: 'zeilen', label: 'Programm (eine Zeile pro Punkt, z. B. „10:00 Führung“)', type: 'lines', def: '10:00 Führung\n12:00 Kinderprogramm\n15:00 Rundgang', max: 400 }],
    render: (f) => ({ title: f.titel, body: f.zeilen }) },
  { id: 'oeffnungszeiten', name: 'Öffnungszeiten', style: 'standard', fields: [{ key: 'titel', label: 'Überschrift', def: 'Öffnungszeiten', max: 60 }, { key: 'zeilen', label: 'Zeiten (eine Zeile pro Tag)', type: 'lines', def: 'Dienstag – Sonntag: 10:00 – 18:00 Uhr\nMontag: geschlossen', max: 400 }],
    render: (f) => ({ title: f.titel, body: f.zeilen }) },
  { id: 'fuehrungen', name: 'Führungen und Termine', style: 'standard', fields: [{ key: 'titel', label: 'Überschrift', def: 'Führungen', max: 60 }, { key: 'zeilen', label: 'Termine (eine Zeile pro Termin)', type: 'lines', def: '11:00 Öffentliche Führung\n14:00 Familienführung', max: 400 }],
    render: (f) => ({ title: f.titel, body: f.zeilen }) },
  { id: 'willkommen', name: 'Willkommen für Gruppen', style: 'highlight', fields: [{ key: 'gruppe', label: 'Gruppenname', def: 'Klasse 7b', max: 60 }],
    render: (f) => ({ title: 'Herzlich willkommen', body: f.gruppe }) },
  { id: 'hinweis', name: 'Hinweis / Sperrung', style: 'hinweis', fields: [{ key: 'titel', label: 'Überschrift', def: 'Hinweis', max: 60 }, { key: 'text', label: 'Text', type: 'lines', def: 'Dieser Bereich ist vorübergehend gesperrt.', max: 300 }],
    render: (f) => ({ title: f.titel, body: f.text }) },
  { id: 'danke', name: 'Danke / Abschied', style: 'standard', fields: [{ key: 'text', label: 'Text', def: 'Danke für Ihren Besuch!', max: 100 }],
    render: (f) => ({ title: f.text, body: 'Wir freuen uns auf ein Wiedersehen.' }) },
  { id: 'countdown', name: 'Countdown', style: 'highlight', dyn: true, fields: [{ key: 'ereignis', label: 'Ereignis', def: 'Sonderausstellung', max: 60 }, { key: 'datum', label: 'Datum', type: 'date', def: '', max: 10 }],
    render: (f, now) => { const n = daysBetween(berlinToday(now), f.datum || berlinToday(now)); return { title: n > 0 ? `Noch ${n} ${n === 1 ? 'Tag' : 'Tage'}` : n === 0 ? 'Heute!' : 'Vorbei', body: `bis: ${f.ereignis} (${dateDE(f.datum || berlinToday(now))})` }; } },
  { id: 'datum', name: 'Uhr / Datum', style: 'standard', dyn: true, fields: [{ key: 'titel', label: 'Überschrift', def: 'Heute ist', max: 60 }],
    render: (f, now) => ({ title: f.titel, body: dateDE(berlinToday(now)) }) },
];

/** Felder prüfen und Vorlage zu {title, body, template} auflösen. Fehler = verständlicher Text. */
export function renderTemplate(tpl, fields, now = Date.now()) {
  const f = {};
  for (const d of tpl.fields) {
    const v = String(fields?.[d.key] ?? d.def ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (!v && d.type !== 'date' && !d.optional) throw new Error(`Bitte fülle das Feld „${d.label.split(' (')[0]}“ aus.`);
    if (v.length > (d.max ?? 200)) throw new Error(`Das Feld „${d.label.split(' (')[0]}“ ist zu lang (höchstens ${d.max ?? 200} Zeichen).`);
    if (d.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Das Datum im Feld „${d.label}“ ist ungültig.`);
    f[d.key] = v;
  }
  const r = tpl.render ? tpl.render(f, now) : { title: (tpl.titleTpl ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => f[k] ?? ''), body: (tpl.bodyTpl ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => f[k] ?? '') };
  return { title: r.title.slice(0, 120), body: (r.body ?? '').slice(0, 1000), template: tpl.style ?? 'standard' };
}

/**
 * Lesbarkeit auf der Zielauflösung (Z.5): Textgröße für den Betrachtungsabstand, Platz, Kontrast. Maße entsprechen player.css (Titel 7 vw, Text 3,4 vw).
 * @returns {{level:'warn'|'error',kind:string,text:string}[]}
 */
export function readability({ title, body, template = 'standard' }, { width = 1920, height = 1080, distanceM = 3, diagonalInch = 43 } = {}) {
  const w = [], st = STYLES[template] ?? STYLES.standard, vw = Math.max(width, height) / 100; // Playerseite skaliert nach der Breite des (gedrehten) Bildes
  const W = width, titlePx = 7 * (W / 100), bodyPx = 3.4 * (W / 100); void vw;
  const mmPerPx = (diagonalInch * 25.4 * (Math.min(width, height) / Math.hypot(width, height))) / Math.min(width, height);
  const capMm = (px) => px * 0.72 * mmPerPx, need = distanceM * 3.3; // grobe Regel: 10 mm Versalhöhe je 3 m Abstand
  const usable = W * 0.88, charsTitle = usable / (titlePx * 0.55), charsBody = usable / (bodyPx * 0.52);
  const lines = (t, cpl) => String(t).split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / cpl)), 0);
  const tl = lines(title, charsTitle), bl = body ? lines(body, charsBody) : 0, need_h = tl * titlePx * 1.1 + (body ? bl * bodyPx * 1.4 + height * 0.03 : 0), avail = height * 0.88;
  if (body && capMm(bodyPx) < need) w.push({ level: 'warn', kind: 'klein', text: `Der Text ist für ${distanceM} m Abstand zu klein. Bitte kürzer schreiben oder weniger Zeilen verwenden.` });
  if (need_h > avail) w.push({ level: 'error', kind: 'platz', text: `Es ist zu viel Text: auf dem Bildschirm (${width}×${height}) würde er abgeschnitten. Bitte kürzen (etwa ${Math.max(1, Math.floor((avail - tl * titlePx * 1.1) / (bodyPx * 1.4)))} Zeilen möglich).` });
  const c = contrast(st.fg, st.bg); if (c < 4.5) w.push({ level: c < 3 ? 'error' : 'warn', kind: 'kontrast', text: `Der Kontrast ist zu schwach (${c.toFixed(1)}:1, empfohlen mindestens 4,5:1).` });
  if (/(.)\1{9,}/.test(title + body)) w.push({ level: 'warn', kind: 'wiederholung', text: 'Der Text enthält auffällige Wiederholungen. Bitte prüfen.' });
  return w;
}

// ======================= QR-Code (Z.12) =======================
const BAD_SCHEME = /^\s*(javascript|data|file|vbscript|blob|about|ftp|chrome|intent):/i;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wifiEsc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');

/** Eingabe → Text im QR-Code + Klartext darunter. Nur http/https, WLAN, Kontakt, einfacher Text. */
export function buildQrPayload(input) {
  const t = input?.kind ?? 'url';
  if (t === 'url') {
    const raw = String(input.url ?? '').trim(); if (BAD_SCHEME.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) throw new Error('Nur Adressen mit http:// oder https:// sind erlaubt.');
    let u; try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw new Error('Diese Adresse ist ungültig.'); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && !/^localhost$/i.test(u.hostname) && !/^\[/.test(u.hostname)) { if (!u.hostname) throw new Error('Diese Adresse ist ungültig.'); }
    return { payload: u.toString(), plain: u.toString(), host: u.hostname };
  }
  if (t === 'wifi') {
    const ssid = String(input.ssid ?? ''), pw = String(input.password ?? ''), sec = input.security === 'nopass' ? 'nopass' : 'WPA';
    if (!ssid || Buffer.byteLength(ssid) > 32) throw new Error('Der WLAN-Name fehlt oder ist zu lang.'); if (sec !== 'nopass' && pw.length < 8) throw new Error('Das WLAN-Passwort braucht mindestens 8 Zeichen.');
    return { payload: `WIFI:T:${sec};S:${wifiEsc(ssid)};${sec === 'nopass' ? '' : `P:${wifiEsc(pw)};`};`, plain: `WLAN „${ssid}“` };
  }
  if (t === 'contact') {
    const name = String(input.name ?? '').trim(); if (!name) throw new Error('Bitte gib einen Namen an.');
    const clean = (x) => String(x ?? '').replace(/[\r\n;]/g, ' ').trim();
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${clean(name)}`, input.phone ? `TEL:${clean(input.phone)}` : null, input.email ? `EMAIL:${clean(input.email)}` : null, input.org ? `ORG:${clean(input.org)}` : null, 'END:VCARD'].filter(Boolean);
    return { payload: lines.join('\n'), plain: clean(name) };
  }
  if (t === 'text') { const x = String(input.text ?? '').trim(); if (!x) throw new Error('Bitte gib einen Text ein.'); if (BAD_SCHEME.test(x)) throw new Error('Dieser Text sieht aus wie ein unerlaubter Link.'); return { payload: x, plain: x }; }
  throw new Error('Unbekannte Art von QR-Code.');
}
/** Adresse zeigt ins interne Netz? Besucher erreichen sie nicht. */
export const isInternalHost = (h) => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h) || /\.(local|lan|internal|intranet|home|corp|fritz\.box)$/i.test(h) || (!h.includes('.') && !h.startsWith('['));

/** QR-Bild im Seitenverhältnis des Ziels erzeugen (weiß/schwarz = maximaler Kontrast), danach selbst dekodieren (Gegenprobe). */
export async function renderQr({ payload, plain, heading = '', text = '' }, { width = 1920, height = 1080 } = {}) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' }), n = qr.modules.size, quiet = 4;
  const avail = Math.min(height * 0.62, width * 0.5), mod = Math.max(1, Math.floor(avail / (n + quiet * 2))), size = mod * (n + quiet * 2);
  const portrait = height > width, qx = portrait ? Math.round((width - size) / 2) : Math.round(width * 0.08), qy = portrait ? Math.round(height * 0.38) : Math.round((height - size) / 2);
  let cells = ''; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) cells += `<rect x="${qx + (x + quiet) * mod}" y="${qy + (y + quiet) * mod}" width="${mod}" height="${mod}"/>`;
  const tx = portrait ? width / 2 : qx + size + width * 0.05, anchor = portrait ? 'middle' : 'start', fs = Math.round(Math.min(width, height) * 0.075), bs = Math.round(fs * 0.5), tw = portrait ? width * 0.9 : width - tx - width * 0.05;
  const wrap = (s, px) => { const max = Math.max(8, Math.floor(tw / (px * 0.52))); const out = []; for (const para of String(s).split('\n')) { let line = ''; for (const w of para.split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim(); } out.push(line); } return out.slice(0, 5); };
  const ty = portrait ? Math.round(height * 0.12) : Math.round(height * 0.3);
  const hl = wrap(heading, fs), bl = wrap(text, bs), plainLines = wrap(plain && plain.length < 120 ? plain : '', Math.round(bs * 0.8));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/><rect x="0" y="0" width="${Math.round(width * 0.012)}" height="${height}" fill="#c8102e"/><g fill="#000">${cells}</g>`
    + hl.map((l, i) => `<text x="${tx}" y="${ty + i * fs * 1.15}" text-anchor="${anchor}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="${fs}" fill="#1a1a1a">${esc(l)}</text>`).join('')
    + bl.map((l, i) => `<text x="${tx}" y="${ty + hl.length * fs * 1.15 + bs * 0.4 + i * bs * 1.35}" text-anchor="${anchor}" font-family="Inter, DejaVu Sans, sans-serif" font-size="${bs}" fill="#333">${esc(l)}</text>`).join('')
    + plainLines.map((l, i) => `<text x="${portrait ? width / 2 : qx}" y="${qy + size + Math.round(bs * 1.3) + i * bs}" text-anchor="${portrait ? 'middle' : 'start'}" font-family="DejaVu Sans Mono, monospace" font-size="${Math.round(bs * 0.8)}" fill="#333">${esc(l)}</text>`).join('') + '</svg>';
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const dec = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return { png, width, height, modules: n, modulePx: mod, codePx: size, decoded: dec?.data ?? null, matches: dec?.data === payload };
}
/** Prüfungen in Klartext: Mindestgröße, Rand, Kontrast, Betrachtungsabstand */
export function qrChecks(r, { distanceM = 3, diagonalInch = 43, name = 'Bildschirm' } = {}) {
  const w = [], mmPerPx = (diagonalInch * 25.4 * (9 / Math.hypot(16, 9))) / 1080 * (1080 / r.height), codeM = (r.codePx * mmPerPx) / 1000;
  if (!r.matches) w.push({ level: 'error', kind: 'abweichung', text: 'Der erzeugte Code liest sich anders als eingegeben. Bitte kürzere Eingabe versuchen.' });
  if (r.modulePx < 4) w.push({ level: 'warn', kind: 'klein', text: 'Die einzelnen Punkte des Codes sind sehr klein. Bitte weniger Text im Code verwenden.' });
  if (distanceM > codeM * 10) w.push({ level: 'warn', kind: 'abstand', text: `Dieser Code ist auf „${name}“ aus ${distanceM} m Abstand schwer lesbar (Code ca. ${Math.round(codeM * 100)} cm breit). Besucher sollten näher herantreten, oder der Code muss kürzer sein.` });
  return w;
}
