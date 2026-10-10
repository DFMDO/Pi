// Medien-Sync: im Hintergrund, fortsetzbar (HTTP Range), SHA-256 je Datei,
// Delta (nur Neues/Geändertes), höchstens 2 parallele Downloads, Zufallsverzögerung,
// optionales Zeitfenster und Bandbreitenlimit.
// Stabilität: hängende Downloads werden abgebrochen (kein „für immer läuft der Abgleich“), eine volle Karte wird vorher erkannt
// (statt eine halbe Datei zu schreiben), Schreibfehler beenden nur das eine Medium, und bereits geprüfte Dateien werden nicht bei jedem Abgleich neu gelesen.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, statSync, statfsSync, renameSync, unlinkSync, readdirSync, mkdirSync, createReadStream, rmSync } from 'node:fs';
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

/** Freier Platz in Byte; wenn er sich nicht ermitteln lässt, wird nicht blockiert */
export const freeBytesOf = (dir) => { try { const s = statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } };

/** Warten, aber höchstens ms – danach Fehler (der Aufrufer bricht die Verbindung ab). Der Zeitgeber wird immer wieder abgeräumt. */
function within(promise, ms, message) {
  let t; const limit = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(t));
}

// Prüfsummen schon geprüfter Dateien (Größe + Änderungszeit müssen gleich sein): Der Abgleich liest sonst bei jedem Lauf ALLE Medien neu von der SD-Karte.
const hashCache = new Map();
async function verifiedHash(f, size) {
  const key = `${f}|${size}`, st = statSync(f), stamp = st.mtimeMs, hit = hashCache.get(key);
  if (hit && hit.stamp === stamp) return hit.sha;
  const sha = await sha256File(f); hashCache.set(key, { stamp, sha }); if (hashCache.size > 5000) hashCache.delete(hashCache.keys().next().value); return sha;
}

/**
 * @param fetchRange async (url, start) => { status, stream(AsyncIterable<Buffer>), } – vom Agent über gepinntes TLS bereitgestellt
 * @param freeBytes  () => freier Platz in Byte (für Tests austauschbar)
 * @param minFreeBytes  So viel bleibt immer frei (Protokolle, Plan, Arbeitsdateien)
 * @param stallMs  Kommt so lange kein Datenblock, wird der Download abgebrochen
 */
export async function syncMedia({ manifest, dir, fetchRange, parallel = 2, bandwidthKbps = 0, jitterMs = 0, window = '', now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {},
  freeBytes = () => freeBytesOf(dir), minFreeBytes = 150 * 1048576, stallMs = 45000 }) {
  mkdirSync(dir, { recursive: true });
  const want = manifest.items.filter((i) => i.url && i.sha256 && !i.pending);
  const todo = [];
  for (const it of want) {
    const f = fileFor(dir, it);
    try { if (existsSync(f) && statSync(f).size === it.size && await verifiedHash(f, it.size) === it.sha256) continue; } catch { /* unlesbare Datei: neu laden */ } // Delta: schon da
    todo.push(it);
  }
  const state = { total: want.length, done: want.length - todo.length, bytes: 0, failed: [], skippedWindow: false, noSpace: false };
  onProgress({ ...state });
  if (todo.length && !inSyncWindow(window, now())) { state.skippedWindow = true; return state; }
  // Aufräumen: nur Dateien, die nicht mehr im Manifest stehen. Ein leeres Manifest (z. B. Hub-Fehler) löscht nie den ganzen Cache.
  const prune = () => {
    const keep = new Set(manifest.items.map((i) => i.id));
    if (manifest.items.length) for (const f of readdirSync(dir)) { const id = f.replace(/\.part$/, ''); if (!keep.has(id)) rmSync(join(dir, f), { force: true }); }
  };
  // Reicht der Platz nicht für das Neue, zuerst die nicht mehr benötigten Medien entfernen (sonst bliebe eine volle Karte für immer voll).
  const need = todo.reduce((s, it) => s + Math.max(0, it.size - (existsSync(fileFor(dir, it) + '.part') ? statSync(fileFor(dir, it) + '.part').size : 0)), 0);
  if (todo.length && need + minFreeBytes > freeBytes()) { try { prune(); } catch { /* nicht kritisch */ } }
  if (todo.length && jitterMs) await sleep(Math.floor(Math.random() * jitterMs)); // nicht alle Player gleichzeitig
  const queue = [...todo]; let inflight = 0; // inflight: Byte, die gerade geladen werden (zwei Downloads dürfen sich den Platz nicht doppelt versprechen)
  const worker = async () => {
    for (let it; (it = queue.shift());) {
      try { await download(it); state.done++; } catch (e) { if (e.noSpace) state.noSpace = true; state.failed.push({ id: it.id, error: e.message }); }
      onProgress({ ...state });
    }
  };
  async function download(it) {
    const part = fileFor(dir, it) + '.part'; let start = existsSync(part) ? statSync(part).size : 0;
    if (start > it.size) { unlinkSync(part); start = 0; }
    if (start < it.size) {
      const missing = it.size - start, free = freeBytes();
      if (missing + inflight + minFreeBytes > free) { const e = new Error(`Zu wenig Speicherplatz auf dem Bildschirm (frei ${Math.floor(free / 1048576)} MB, benötigt ${Math.ceil((missing + minFreeBytes) / 1048576)} MB)`); e.noSpace = true; throw e; }
      inflight += missing;
      let out, werr = null;
      try {
        const r = await within(fetchRange(it.url, start), stallMs, 'Der Hub antwortet nicht');
        if (r.status === 200 && start > 0) { unlinkSync(part); start = 0; } // Server ignoriert Range → von vorn
        else if (r.status !== 200 && r.status !== 206) { r.stream?.destroy?.(); throw new Error(`Hub antwortet mit Status ${r.status}`); }
        out = createWriteStream(part, { flags: start ? 'a' : 'w' });
        out.on('error', (e) => { werr = e; }); // ohne diesen Handler würde ein Schreibfehler (Karte voll/defekt) den ganzen Agenten beenden
        const chunks = r.stream[Symbol.asyncIterator]();
        try {
          for (;;) {
            const nx = await within(chunks.next(), stallMs, 'Der Hub sendet keine Daten mehr'); if (nx.done) break;
            if (werr) throw werr;
            if (!out.write(nx.value)) await new Promise((res) => { out.once('drain', res); out.once('error', res); });
            if (werr) throw werr;
            state.bytes += nx.value.length;
            if (bandwidthKbps) await sleep((nx.value.length * 8) / (bandwidthKbps * 1000) * 1000 / parallel); // grobe Drosselung je Worker
          }
        } catch (e) { try { r.stream.destroy?.(); } catch { /* schon beendet */ } throw e; }
        await new Promise((res, rej) => { if (werr) return rej(werr); out.once('error', rej); out.end(() => res()); });
        if (werr) throw werr;
      } catch (e) { try { out?.destroy(); } catch { /* schon beendet */ } if (werr?.code === 'ENOSPC' || e.code === 'ENOSPC') { e.noSpace = true; e.message = 'Die Speicherkarte des Bildschirms ist voll'; } throw e; }
      finally { inflight -= missing; }
    }
    if (statSync(part).size !== it.size || await sha256File(part) !== it.sha256) { unlinkSync(part); throw new Error('Prüfsumme stimmt nicht'); }
    renameSync(part, fileFor(dir, it));
    hashCache.set(`${fileFor(dir, it)}|${it.size}`, { stamp: statSync(fileFor(dir, it)).mtimeMs, sha: it.sha256 }); // gerade geprüft: beim nächsten Abgleich nicht noch einmal lesen
  }
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
  try { prune(); } catch { /* nicht kritisch */ } // Aufräumen nach dem Abgleich
  return state;
}
