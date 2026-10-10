// Medienvarianten je Leistungsprofil. Läuft als Hintergrundjob mit niedriger
// Priorität (nice 19, ionice idle), seriell, nur für Profile gepaarter Geräte.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import sharp from 'sharp';
import { PROFILES } from './plan.js';

export const PROFILE_SPEC = {
  lite:     { maxImg: 1280, h: 720,  fpsMax: 30, vb: '1500k', maxrate: '2M',  buf: '4M',  x264: ['-profile:v', 'baseline', '-level', '3.1'] },
  standard: { maxImg: 1920, h: 1080, fpsMax: 30, vb: '4500k', maxrate: '6M',  buf: '12M', x264: ['-profile:v', 'high', '-level', '4.1'] },
  pro:      { maxImg: 3840, h: 1080, fpsMax: 60, vb: '10M',   maxrate: '15M', buf: '30M', x264: ['-profile:v', 'high', '-level', '4.2'] },
};

/** Schutz vor „Bild-Bomben“ (riesige Bilder) und zu hohem Speicherverbrauch auf dem Pi */
// Alle Prozessorkerne nutzen – außer auf Geräten mit wenig Arbeitsspeicher (Pi 3 mit 1 GB, Hub + Anzeige in einem): dort 2 Threads, sonst geht der Speicher aus.
const SMALL_RAM = totalmem() < 1.5 * 1024 ** 3;
sharp.cache(false); sharp.concurrency(SMALL_RAM ? 2 : 0);
const FF_THREADS = SMALL_RAM ? '2' : '0'; // ffmpeg: 0 = automatisch
export const SHARP_OPTS = { failOn: 'error', limitInputPixels: 80_000_000 };

/** Container anhand der ersten Bytes → ffmpeg bekommt den Demuxer fest vorgegeben (kein „Raten“ durch Inhalt der Datei) */
export function demuxerFor(file) {
  const h = readFileSync(file).subarray(0, 12);
  return h.subarray(4, 8).toString() === 'ftyp' ? 'mov,mp4,m4a,3gp,3g2,mj2' : h.subarray(0, 4).toString('hex') === '1a45dfa3' ? 'matroska,webm' : null;
}
const sha256File = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
/** Externes Programm mit Zeitlimit: Ein hängendes ffmpeg/ffprobe würde sonst die ganze Verarbeitungsschlange für immer blockieren (und Speicher belegen) */
export const run = (cmd, args, { timeoutMs = 30 * 60000 } = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24, timeout: timeoutMs, killSignal: 'SIGKILL' }, (e, so, se) => (e ? rej(new Error(e.killed ? `Zeitüberschreitung: ${cmd} hat nach ${Math.max(1, Math.round(timeoutMs / 60000))} Minuten nicht geantwortet und wurde beendet.` : String(se ?? '').slice(-300) || e.message)) : res(so))));

let prefix = null;
function lowPriority() { // nice + ionice, falls im System verfügbar
  if (prefix) return prefix;
  prefix = [];
  try { execFileSync('nice', ['-n', '19', 'true']); prefix = ['nice', '-n', '19']; } catch {}
  try { execFileSync('ionice', ['-c3', 'true']); prefix = [...prefix, 'ionice', '-c3']; } catch {}
  return prefix;
}
const runLow = (cmd, args, opts) => { const p = lowPriority(); return p.length ? run(p[0], [...p.slice(1), cmd, ...args], opts) : run(cmd, args, opts); };

export async function probeVideo(file) {
  const fmt = demuxerFor(file); if (!fmt) throw new Error('Containerformat nicht erlaubt');
  const out = JSON.parse(await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', fmt, '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,codec_name,pix_fmt,profile,bit_rate:format=duration,bit_rate', '-of', 'json', file], { timeoutMs: 60000 }));
  const s = out.streams?.[0]; if (!s) throw new Error('Keine Videospur gefunden.');
  const [a, b] = (s.avg_frame_rate || '0/1').split('/').map(Number);
  return { width: s.width, height: s.height, fps: b ? a / b : 0, duration: parseFloat(out.format?.duration ?? '0'), codec: s.codec_name, pixFmt: s.pix_fmt ?? null, profile: s.profile ?? null,
    bitrate: Number(s.bit_rate) || Number(out.format?.bit_rate) || null };
}

async function imageVariant(src, dst, spec) {
  const img = sharp(src, SHARP_OPTS).rotate();
  const meta = await sharp(src, SHARP_OPTS).metadata();
  const base = img.resize({ width: spec.maxImg, height: spec.maxImg, fit: 'inside', withoutEnlargement: true });
  // Neu kodiert, Metadaten (EXIF/GPS) entfernt
  if (meta.hasAlpha) await base.png({ compressionLevel: 9 }).toFile(dst + '.png'), dst += '.png';
  else await base.jpeg({ quality: 85, mozjpeg: true }).toFile(dst + '.jpg'), dst += '.jpg';
  return dst;
}

/** Höchste Datenrate, die ein Bildschirm des Profils per Hardware sicher abspielt (Bit/s). Darüber wird neu berechnet. */
const PASS_MAX = { lite: 0, standard: 20e6, pro: 40e6 };
/**
 * Passt das Video schon (H.264, 8-Bit 4:2:0, höchstens Full HD und erlaubte Bildrate)? Dann wird es nur umverpackt (Sekunden statt Minuten –
 * wichtig für schwache Hubs wie den Pi 3 B+). Lite (Zero 2 W) bekommt immer eine eigene 720p-Fassung.
 */
export function canPassThrough(probe, profile) {
  const spec = PROFILE_SPEC[profile], max = PASS_MAX[profile] ?? 0;
  return !!spec && max > 0 && probe.codec === 'h264' && (probe.pixFmt === 'yuv420p' || probe.pixFmt === 'yuvj420p') && !/4:4:4|High 10|High 4:2:2/i.test(probe.profile ?? '')
    && probe.height <= spec.h && probe.width <= 1920 && probe.fps > 0 && probe.fps <= spec.fpsMax + 0.5 && (!probe.bitrate || probe.bitrate <= max);
}
async function videoVariant(src, dst, spec, probe, profile) {
  if (canPassThrough(probe, profile)) { // nur umverpacken: Bildspur kopieren, Ton/Untertitel weg, „faststart“ für fortsetzbares Laden
    const out = dst + '.mp4';
    await runLow('ffmpeg', ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-f', demuxerFor(src), '-i', src, '-map', '0:v:0', '-an', '-sn', '-c:v', 'copy', '-movflags', '+faststart', out], { timeoutMs: 20 * 60000 });
    return out;
  }
  const vf = [`scale=-2:'min(${spec.h},ih)'`]; if (probe.fps > spec.fpsMax + 0.5) vf.push(`fps=${spec.fpsMax}`);
  const out = dst + '.mp4';
  await runLow('ffmpeg', ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-f', demuxerFor(src), '-i', src, '-map', '0:v:0', '-an', '-sn', '-vf', vf.join(','),
    '-c:v', 'libx264', ...spec.x264, '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-threads', FF_THREADS, '-b:v', spec.vb, '-maxrate', spec.maxrate, '-bufsize', spec.buf,
    '-movflags', '+faststart', out], { timeoutMs: 3 * 3600000 }); // Neuberechnung auf einem Pi 3 dauert lange, aber nicht endlos
  return out;
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function wrap(text, max) { const out = []; for (const para of text.split('\n')) { let line = ''; for (const w of para.split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } out.push(line); } return out; }

/** Text-Ankündigung als Bild (für Lite-Player ohne Browser). */
export async function renderTextImage(t, spec, dst) {
  const W = spec.maxImg, H = Math.round(W * 9 / 16), pad = Math.round(W * 0.06);
  const colors = { standard: ['#1a1a1a', '#ffffff', '#c8102e'], hinweis: ['#f2a900', '#1a1a1a', '#1a1a1a'], highlight: ['#c8102e', '#ffffff', '#ffffff'], frage: ['#0b3d91', '#ffffff', '#f2a900'], antwort: ['#1b7f3b', '#ffffff', '#ffffff'], notfall: ['#b00020', '#ffffff', '#ffffff'] }[t.template] ?? ['#1a1a1a', '#ffffff', '#c8102e'];
  if (t.template === 'tor') { // Jubel: ein riesiges, mittiges Wort auf grünem Grund mit goldenen Balken
    const big = Math.round(W * 0.27), bar = Math.round(H * 0.06);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#0a7a2f"/><rect x="0" y="0" width="${W}" height="${bar}" fill="#f2a900"/><rect x="0" y="${H - bar}" width="${W}" height="${bar}" fill="#f2a900"/>
<text x="${W / 2}" y="${Math.round(H / 2 + big * 0.35)}" text-anchor="middle" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="${big}" fill="#ffffff">${esc(t.title ?? 'TOR!')}</text></svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(dst + '.jpg');
    return dst + '.jpg';
  }
  const tf = Math.round(W * (t.compact ? 0.05 : 0.06)), bf = Math.round(W * (t.compact ? 0.024 : 0.032)); // compact: längere Listen (Apps) passen aufs Bild
  const body = wrap(t.body ?? '', Math.floor((W - 2 * pad) / (bf * 0.55)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${colors[0]}"/><rect x="0" y="0" width="${Math.round(W * 0.02)}" height="${H}" fill="${colors[2]}"/>
<text x="${pad}" y="${pad + tf}" font-family="Inter, DejaVu Sans, sans-serif" font-weight="700" font-size="${tf}" fill="${colors[1]}">${esc(t.title ?? '')}</text>
${body.map((l, i) => `<text x="${pad}" y="${pad + tf * 2 + i * bf * 1.4}" font-family="Inter, DejaVu Sans, sans-serif" font-size="${bf}" fill="${colors[1]}">${esc(l)}</text>`).join('')}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(dst + '.jpg');
  return dst + '.jpg';
}

export function createVariantQueue({ db, mediaDir, onChange = () => {}, log = () => {} }) {
  const vdir = join(mediaDir, 'variants'); mkdirSync(vdir, { recursive: true });
  let running = null, waiting = false, closed = false;
  db.prepare("UPDATE media_variants SET status='pending' WHERE status='running'").run(); // nach Neustart fortsetzen

  const activeProfiles = () => {
    const p = new Set(db.prepare("SELECT DISTINCT profile FROM devices WHERE status IN ('active','pending')").all().map((r) => r.profile));
    return PROFILES.filter((x) => p.has(x));
  };
  /** Fehlende Varianten für alle Medien und alle genutzten Profile anlegen. */
  function ensureAll() {
    const ins = db.prepare("INSERT OR IGNORE INTO media_variants(id,media_id,profile,status) VALUES(?,?,?, 'pending')");
    for (const m of db.prepare("SELECT id,kind FROM media WHERE kind IN ('image','video','pdfpage','text')").all()) {
      for (const p of activeProfiles()) {
        // Text auch als Bild für jedes Profil: Bildschirme mit Video-optimierter Wiedergabe (mpv) zeigen Text als Bild
        ins.run(`${m.id}:${p}`, m.id, p);
      }
    }
    kick();
  }
  function kick() { if (!closed && !running && !waiting) { waiting = true; setImmediate(() => { waiting = false; running = loop().catch((e) => log('variant loop', e?.message ?? e)).finally(() => { running = null; }); }); } }
  async function loop() {
    for (;;) {
      if (closed) return;
      const v = db.prepare("SELECT * FROM media_variants WHERE status='pending' ORDER BY rowid LIMIT 1").get();
      if (!v) return;
      db.prepare("UPDATE media_variants SET status='running' WHERE id=?").run(v.id);
      try {
        const m = db.prepare('SELECT * FROM media WHERE id=?').get(v.media_id);
        const spec = PROFILE_SPEC[v.profile], dst = join(vdir, `${m.id}-${v.profile}`);
        let out;
        if (m.kind === 'video') out = await videoVariant(join(mediaDir, 'original', m.original_path), dst, spec, await probeVideo(join(mediaDir, 'original', m.original_path)), v.profile);
        else if (m.kind === 'text') out = await renderTextImage(JSON.parse(m.text_json), spec, dst);
        else out = await imageVariant(join(mediaDir, 'original', m.original_path), dst, spec);
        db.prepare("UPDATE media_variants SET status='ready', path=?, sha256=?, size=?, error=NULL WHERE id=?").run(out.split('/').pop(), await sha256File(out), statSync(out).size, v.id);
      } catch (e) {
        log('variant failed', v.id, e.message);
        try { db.prepare("UPDATE media_variants SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), v.id); } catch (e2) { log('variant status', e2.message); }
      }
      try { onChange(); } catch (e) { log('variant onChange', e.message); } // ein Fehler beim Benachrichtigen darf die Schlange nicht anhalten
    }
  }
  return { ensureAll, kick, close: async () => { closed = true; await running; }, idle: async () => { while (!closed && (running || waiting || db.prepare("SELECT 1 FROM media_variants WHERE status IN ('pending','running')").get())) { kick(); await (running ?? new Promise((r) => setTimeout(r, 20))); } } };
}

// ---- Upload-Prüfung ----
/** Erkennt den Typ an den ersten Bytes (nicht an Dateiname/Content-Type). */
export function detectKind(head) {
  const h = head.subarray(0, 16);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image';
  if (h.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image';
  if (h.subarray(0, 4).toString() === 'RIFF' && h.subarray(8, 12).toString() === 'WEBP') return 'image';
  if (h.subarray(4, 8).toString() === 'ftyp') return 'video'; // MP4/MOV
  if (h.subarray(0, 4).toString('hex') === '1a45dfa3') return 'video'; // MKV/WebM
  if (h.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  return null;
}
export const LIMITS = { image: 40 * 1024 * 1024, video: 2 * 1024 ** 3, pdf: 100 * 1024 * 1024 };

export function mediaHints(kind, w, h, extra = {}) {
  const hints = [];
  const { bytes = 0, codec = null, fps = null, durationS = null } = extra ?? {};
  if (kind === 'image' && (bytes > 15 * 1048576 || Math.max(w ?? 0, h ?? 0) > 5000)) hints.push('Dieses Foto ist sehr groß. Der Hub verkleinert es, braucht dafür aber viel Arbeitsspeicher und Zeit. Besser vorher auf höchstens 4000 Pixel Kantenlänge verkleinern.');
  if (kind === 'video') { // Ziel: Full-HD, H.264, höchstens 30 Bilder/s → wird in Sekunden übernommen statt in Minuten neu berechnet
    if (codec && codec !== 'h264') hints.push(`Dieses Video ist nicht im Format H.264 (hier: ${codec}). Der Hub muss es neu berechnen – auf einem Raspberry Pi 3 dauert das sehr lange. Besser als Full-HD-MP4 (H.264) speichern.`);
    if (fps && fps > 30.5) hints.push(`Dieses Video hat ${Math.round(fps)} Bilder pro Sekunde. Der Hub muss es neu berechnen. Besser mit 25 oder 30 Bildern pro Sekunde speichern.`);
    if (bytes > 1024 ** 3 || (durationS && durationS > 900)) hints.push('Dieses Video ist sehr groß oder lang. Das Laden auf die Bildschirme dauert entsprechend. Kürzere Videos (wenige Minuten) laufen am zuverlässigsten.');
  }
  if (!w || !h) return hints;
  if (kind === 'image' && Math.max(w, h) < 1000) hints.push('Das Bild ist ziemlich klein und könnte auf großen Bildschirmen unscharf wirken.');
  if (kind === 'video' && h > 1080) hints.push('Dieses Video ist größer als Full-HD. Es wird für die Bildschirme neu berechnet – das kann auf einem Raspberry Pi 3 sehr lange dauern. Besser als Full-HD-MP4 hochladen.');
  if (h > w) hints.push('Das ist ein Hochformat-Medium. Es passt am besten zu Bildschirmen, die gedreht aufgehängt sind.');
  return hints;
}

/** Testvideo für die Diagnose (je Profil, einmal erzeugt): zeigt, ob ein Bildschirm sein Profil flüssig abspielt. */
export async function ensureTestVideo(mediaDir, profile) {
  const spec = PROFILE_SPEC[profile]; if (!spec) throw new Error('Unbekanntes Profil');
  mkdirSync(mediaDir, { recursive: true }); const out = join(mediaDir, `testvideo-${profile}.mp4`);
  if (existsSync(out)) return out;
  const w = Math.round(spec.h * 16 / 9 / 2) * 2, fps = spec.fpsMax;
  // veryfast + wenige Threads: Mit dem Standard (medium) brauchte ffmpeg am Pi 3 (1 GB) ~285 MB und wurde vom Speicherwächter beendet (Pilot, 0.2.6).
  await runLow('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${spec.h}:rate=${fps}:duration=20`, '-c:v', 'libx264', '-preset', 'veryfast', '-threads', FF_THREADS, ...spec.x264, '-pix_fmt', 'yuv420p', '-b:v', spec.vb, '-maxrate', spec.maxrate, '-bufsize', spec.buf, '-movflags', '+faststart', out + '.tmp.mp4']);
  (await import('node:fs')).renameSync(out + '.tmp.mp4', out); return out;
}
