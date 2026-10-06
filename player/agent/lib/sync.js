// Medien-Sync: im Hintergrund, fortsetzbar (HTTP Range), SHA-256 je Datei,
// Delta (nur Neues/Geändertes), höchstens 2 parallele Downloads, Zufallsverzögerung,
// optionales Zeitfenster und Bandbreitenlimit.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, statSync, renameSync, unlinkSync, readdirSync, mkdirSync, createReadStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { epochToLocal } from '../../../shared/time.js';

export const sha256File = (f) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

/** "22:00-06:00" → ist now (epoch) im Fenster? Leer = immer. */
export function inSyncWindow(win, now = Date.now()) {
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(win ?? ''); if (!m) return true;
  const t = epochToLocal(now).time, [a, b] = [m[1], m[2]];
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

/** Datei zum Medium (Endung aus dem Namen des Hub-Pfads unbekannt → nach Typ). */
export const fileFor = (dir, item) => join(dir, item.id);

/**
 * @param fetchRange async (url, start) => { status, stream(AsyncIterable<Buffer>), } – vom Agent über gepinntes TLS bereitgestellt
 */
export async function syncMedia({ manifest, dir, fetchRange, parallel = 2, bandwidthKbps = 0, jitterMs = 0, window = '', now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const want = manifest.items.filter((i) => i.url && i.sha256 && !i.pending);
  const todo = [];
  for (const it of want) {
    const f = fileFor(dir, it);
    if (existsSync(f) && statSync(f).size === it.size && await sha256File(f) === it.sha256) continue; // Delta: schon da
    todo.push(it);
  }
  const state = { total: want.length, done: want.length - todo.length, bytes: 0, failed: [], skippedWindow: false };
  onProgress({ ...state });
  if (todo.length && !inSyncWindow(window, now())) { state.skippedWindow = true; return state; }
  if (todo.length && jitterMs) await sleep(Math.floor(Math.random() * jitterMs)); // nicht alle Player gleichzeitig
  const queue = [...todo];
  const worker = async () => {
    for (let it; (it = queue.shift());) {
      try { await download(it); state.done++; } catch (e) { state.failed.push({ id: it.id, error: e.message }); }
      onProgress({ ...state });
    }
  };
  async function download(it) {
    const part = fileFor(dir, it) + '.part'; let start = existsSync(part) ? statSync(part).size : 0;
    if (start > it.size) { unlinkSync(part); start = 0; }
    if (start < it.size) {
      const r = await fetchRange(it.url, start);
      if (r.status === 200 && start > 0) { unlinkSync(part); start = 0; } // Server ignoriert Range → von vorn
      else if (r.status !== 200 && r.status !== 206) throw new Error(`Hub antwortet mit Status ${r.status}`);
      const out = createWriteStream(part, { flags: start ? 'a' : 'w' });
      for await (const chunk of r.stream) {
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
        state.bytes += chunk.length;
        if (bandwidthKbps) await sleep((chunk.length * 8) / (bandwidthKbps * 1000) * 1000 / parallel); // grobe Drosselung je Worker
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
    }
    if (statSync(part).size !== it.size || await sha256File(part) !== it.sha256) { unlinkSync(part); throw new Error('Prüfsumme stimmt nicht'); }
    renameSync(part, fileFor(dir, it));
  }
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
  // Aufräumen: nur nach erfolgreichem Abgleich, nur Dateien die nicht mehr im Manifest stehen
  const keep = new Set(manifest.items.map((i) => i.id));
  // Ein leeres Manifest (z. B. Hub-Fehler) löscht nie den ganzen Cache
  if (manifest.items.length) for (const f of readdirSync(dir)) { const id = f.replace(/\.part$/, ''); if (!keep.has(id)) rmSync(join(dir, f), { force: true }); }
  return state;
}
