// Medienvarianten je Leistungsprofil. Läuft als Hintergrundjob mit niedriger
// Priorität (nice 19, ionice idle), seriell, nur für Profile gepaarter Geräte.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { PROFILES } from './plan.js';

export const PROFILE_SPEC = {
  lite:     { maxImg: 1280, h: 720,  fpsMax: 30, vb: '1500k', maxrate: '2M',  buf: '4M',  x264: ['-profile:v', 'baseline', '-level', '3.1'] },
  standard: { maxImg: 1920, h: 1080, fpsMax: 30, vb: '4500k', maxrate: '6M',  buf: '12M', x264: ['-profile:v', 'high', '-level', '4.1'] },
  pro:      { maxImg: 3840, h: 1080, fpsMax: 60, vb: '10M',   maxrate: '15M', buf: '30M', x264: ['-profile:v', 'high', '-level', '4.2'] },
};

const sha256File = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, so, se) => (e ? rej(new Error(se.slice(-300) || e.message)) : res(so))));

let prefix = null;
function lowPriority() { // nice + ionice, falls im System verfügbar
  if (prefix) return prefix;
  prefix = [];
  try { execFileSync('nice', ['-n', '19', 'true']); prefix = ['nice', '-n', '19']; } catch {}
  try { execFileSync('ionice', ['-c3', 'true']); prefix = [...prefix, 'ionice', '-c3']; } catch {}
  return prefix;
}
const runLow = (cmd, args) => { const p = lowPriority(); return p.length ? run(p[0], [...p.slice(1), cmd, ...args]) : run(cmd, args); };

export async function probeVideo(file) {
  const out = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,codec_name:format=duration', '-of', 'json', file]));
  const s = out.streams?.[0]; if (!s) throw new Error('Keine Videospur gefunden.');
  const [a, b] = (s.avg_frame_rate || '0/1').split('/').map(Number);
  return { width: s.width, height: s.height, fps: b ? a / b : 0, duration: parseFloat(out.format?.duration ?? '0'), codec: s.codec_name };
}

async function imageVariant(src, dst, spec) {
  const img = sharp(src, { failOn: 'error' }).rotate();
  const meta = await sharp(src).metadata();
  const base = img.resize({ width: spec.maxImg, height: spec.maxImg, fit: 'inside', withoutEnlargement: true });
  // Neu kodiert, Metadaten (EXIF/GPS) entfernt
  if (meta.hasAlpha) await base.png({ compressionLevel: 9 }).toFile(dst + '.png'), dst += '.png';
  else await base.jpeg({ quality: 85, mozjpeg: true }).toFile(dst + '.jpg'), dst += '.jpg';
  return dst;
}

async function videoVariant(src, dst, spec, probe) {
  const vf = [`scale=-2:'min(${spec.h},ih)'`]; if (probe.fps > spec.fpsMax + 0.5) vf.push(`fps=${spec.fpsMax}`);
  const out = dst + '.mp4';
  await runLow('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-an', '-sn', '-vf', vf.join(','),
    '-c:v', 'libx264', ...spec.x264, '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-b:v', spec.vb, '-maxrate', spec.maxrate, '-bufsize', spec.buf,
    '-movflags', '+faststart', out]);
  return out;
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function wrap(text, max) { const out = []; for (const para of text.split('\n')) { let line = ''; for (const w of para.split(/\s+/)) { if ((line + ' ' + w).trim().length > max) { out.push(line); line = w; } else line = (line + ' ' + w).trim(); } out.push(line); } return out; }

/** Text-Ankündigung als Bild (für Lite-Player ohne Browser). */
export async function renderTextImage(t, spec, dst) {
  const W = spec.maxImg, H = Math.round(W * 9 / 16), pad = Math.round(W * 0.06);
  const colors = { standard: ['#1a1a1a', '#ffffff', '#c8102e'], hinweis: ['#f2a900', '#1a1a1a', '#1a1a1a'], highlight: ['#c8102e', '#ffffff', '#ffffff'] }[t.template] ?? ['#1a1a1a', '#ffffff', '#c8102e'];
  const tf = Math.round(W * 0.06), bf = Math.round(W * 0.032);
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
        if (m.kind === 'text' && p !== 'lite') continue; // nur Lite braucht Bild-Variante von Text
        ins.run(`${m.id}:${p}`, m.id, p);
      }
    }
    kick();
  }
  function kick() { if (!closed && !running && !waiting) { waiting = true; setImmediate(() => { waiting = false; running = loop().finally(() => { running = null; }); }); } }
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
        if (m.kind === 'video') out = await videoVariant(join(mediaDir, 'original', m.original_path), dst, spec, await probeVideo(join(mediaDir, 'original', m.original_path)));
        else if (m.kind === 'text') out = await renderTextImage(JSON.parse(m.text_json), spec, dst);
        else out = await imageVariant(join(mediaDir, 'original', m.original_path), dst, spec);
        db.prepare("UPDATE media_variants SET status='ready', path=?, sha256=?, size=?, error=NULL WHERE id=?").run(out.split('/').pop(), await sha256File(out), statSync(out).size, v.id);
      } catch (e) {
        log('variant failed', v.id, e.message);
        db.prepare("UPDATE media_variants SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 300), v.id);
      }
      onChange();
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

export function mediaHints(kind, w, h) {
  const hints = [];
  if (!w || !h) return hints;
  if (kind === 'image' && Math.max(w, h) < 1000) hints.push('Das Bild ist ziemlich klein und könnte auf großen Bildschirmen unscharf wirken.');
  if (kind === 'video' && h > 1080) hints.push('Dieses Video ist größer als Full-HD. Für schwächere Bildschirme wird es automatisch verkleinert.');
  if (h > w) hints.push('Das ist ein Hochformat-Medium. Es passt am besten zu Bildschirmen, die gedreht aufgehängt sind.');
  return hints;
}
