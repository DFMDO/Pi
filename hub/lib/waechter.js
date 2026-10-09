// Bild-Wächter: Ein Bildschirm kann „online“ sein und trotzdem schwarz oder eingefroren. Der Hub fragt deshalb etwa alle 10 Minuten ein Bild ab
// (dasselbe Verfahren wie die Live-Ansicht) und prüft nur zwei Dinge: Ist es schwarz, obwohl es Inhalt geben müsste? Ist es auffällig lange unverändert,
// obwohl die Liste wechseln müsste? Zusätzlich gilt: Meldet der Player seit langem keinen Elementwechsel mehr, steht die Wiedergabe.
// Es werden KEINE Bilder gespeichert – nur eine Prüfsumme und die Helligkeit des verkleinerten Bildes. Standardmäßig an, Admins können es ausschalten.
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { resolvePlaylist, playableItems } from '../../shared/sequencer.js';
import { schedulePayload, manifestPayload } from './plan.js';
import { deviceStatus } from './devices.js';

export const GAP_MIN_MS = 8 * 60000, GAP_MAX_MS = 12 * 60000, MIN_SPACING_MS = 6 * 60000;   // Abstand der Proben (zufällig, damit er nie im Takt der Liste liegt)
export const BLACK_MEAN = 6, BLACK_DARK_SHARE = 0.98, BLACK_NEED = 2;                         // „schwarz“: mittlere Helligkeit < 6 von 255, fast alle Punkte dunkel, zweimal hintereinander
export const STALL_MIN_MS = 15 * 60000, MAX_SAMPLES = 24, FALSE_ALARM = 1e-6;

/** Verkleinertes Graustufenbild → Prüfsumme und Helligkeit (das Bild selbst wird nicht aufgehoben) */
export async function analyzeImage(buf) {
  const raw = await sharp(buf).resize(64, 36, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer(); let sum = 0, dark = 0;
  for (const v of raw) { sum += v; if (v < 24) dark++; }
  const mean = sum / raw.length;
  return { h: createHash('sha1').update(raw).digest('hex').slice(0, 16), mean, black: mean < BLACK_MEAN && dark / raw.length >= BLACK_DARK_SHARE };
}

const durOf = (i) => (i.kind === 'video' ? (i.durationS ?? 30) : i.duration ?? 10);
/**
 * Wie viele Proben müssen identisch sein, bevor „Bild steht“ gemeldet wird? Zwei zufällige Proben zeigen auch bei einer gesunden Liste manchmal dasselbe Element.
 * Aus den Zeitanteilen der Elemente rechnet der Wächter aus, wie viele gleiche Proben in Folge praktisch nur bei einem eingefrorenen Bild vorkommen
 * (Zufallswahrscheinlichkeit unter einem Millionstel). Bei Listen, die dafür zu lange auf einem Element stehen oder nur ein Bild haben, wird nichts gemeldet (null).
 */
export function freezeWindow(items) {
  const total = items.reduce((s, i) => s + durOf(i), 0); if (!total) return null;
  const share = new Map(); for (const i of items) if (i.kind !== 'video') share.set(i.mediaId, (share.get(i.mediaId) ?? 0) + durOf(i)); // Video: jede Probe sieht ein anderes Bild
  const pSame = [...share.values()].reduce((s, x) => s + (x / total) ** 2, 0); if (pSame >= 0.999) return null;
  const n = Math.max(4, Math.ceil(Math.log(FALSE_ALARM) / Math.log(pSame)) + 1); return n <= MAX_SAMPLES ? n : null;
}

/** Aus den letzten Proben das Ergebnis ableiten. samples: [{ t, h, b (schwarz), x (Fenster, in dem Stillstand sicher erkennbar wäre) }] */
export function judge(samples) {
  const last = samples.at(-1); if (!last) return { status: 'unbekannt' };
  let k = samples.length; while (k > 0 && samples[k - 1].b) k--;
  const blackRun = samples.slice(k); if (blackRun.length >= BLACK_NEED && blackRun.at(-1).t - blackRun[0].t >= 7 * 60000) return { status: 'schwarz', since: blackRun[0].t };
  if (last.x) {
    let j = samples.length; while (j > 0 && samples[j - 1].x && samples[j - 1].h === last.h) j--;
    const run = samples.slice(j); if (run.length >= last.x) return { status: 'steht', since: run[0].t };
  }
  return { status: 'ok' };
}

/** Meldet der Player keine Elementwechsel mehr? (ohne Bild) */
export function stalled(st, items, t) {
  const ps = st?.playerStatus, at = ps?.current?.since ?? ps?.ts; if (!at || !items.length) return null;
  if (st.syncState && st.syncState.done < st.syncState.total) return null;      // lädt noch Medien: Wartebild ist normal
  if ((st.uptimeS ?? Infinity) < 20 * 60) return null;                           // gerade erst gestartet
  const limit = Math.max(STALL_MIN_MS, (Math.max(...items.map(durOf)) * 2 + 300) * 1000);
  return t - at > limit ? { since: at } : null;
}

async function waechterPlugin(app, { db, audit, now = () => Date.now() }) {
  const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  const enabled = () => (db.prepare("SELECT value FROM settings WHERE key='watch.enabled'").get()?.value ?? 'true') !== 'false';
  const row = (id) => db.prepare('SELECT * FROM watch_state WHERE device_id=?').get(id);
  const save = (id, patch) => {
    const w = { device_id: id, next_due: null, samples_json: '[]', status: 'unbekannt', note: null, since: null, checked_at: null, ...(row(id) ?? {}), ...patch };
    db.prepare('INSERT OR REPLACE INTO watch_state(device_id,next_due,samples_json,status,note,since,checked_at) VALUES(?,?,?,?,?,?,?)').run(w.device_id, w.next_due, w.samples_json, w.status, w.note, w.since, w.checked_at);
  };
  const jitter = () => GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
  const pending = new Map(); // Bildschirm → Zeitpunkt der Anfrage

  /** Was müsste der Bildschirm gerade zeigen? */
  function expectation(d, t) {
    const plan = schedulePayload(db, d, t, 1), r = resolvePlaylist(plan, t);
    if (plan.hold || r.off) return { skip: true };
    const { items } = playableItems(plan, r.playlistId, manifestPayload(db, d, t), { profile: d.profile ?? 'standard', now: t });
    return { items, clock: /clock/.test(plan.layout?.preset ?? '') }; // eine Uhr im Bild ändert es ohnehin jede Minute: Stillstand ist dann nicht erkennbar
  }
  /** Gründe, den Bildschirm gerade nicht per Bild zu prüfen (Wiedergabe wird trotzdem beobachtet) */
  function noShot(d, st) {
    if (d.profile === 'lite') return 'Lite-Bildschirme liefern keine Bildproben.';
    if (app.devices.reduced(d, st)) return 'Der Bildschirm ist gerade ausgelastet.';
    return null;
  }
  function finalize(d, t, sample) {
    const st = parse(d.state_json, null), w = row(d.id); let samples = parse(w?.samples_json, []);
    if (d.maintenance_since || d.ready === 0 || st?.displayOff) { save(d.id, { samples_json: '[]', status: 'ausgesetzt', note: d.maintenance_since ? 'Wartungsmodus.' : 'Bildschirm ist aus oder noch nicht bereit.', since: null, checked_at: t, next_due: t + jitter() }); return; }
    const exp = expectation(d, t);
    if (exp.skip) { save(d.id, { samples_json: '[]', status: 'aus', note: 'Planmäßig aus (Schließtag, Wartung oder Anzeige aus).', since: null, checked_at: t, next_due: t + jitter() }); return; }
    if (sample && (!samples.length || sample.t - samples.at(-1).t >= MIN_SPACING_MS)) samples = [...samples, { t: sample.t, h: sample.h, b: sample.black ? 1 : 0, x: exp.clock ? 0 : freezeWindow(exp.items) ?? 0 }].slice(-MAX_SAMPLES);
    const j = judge(samples), sk = stalled(st, exp.items, t);
    let status = 'ok', since = null, note = sample ? 'Bild in Ordnung.' : noShot(d, st) ?? 'Bild konnte nicht abgefragt werden.';
    if (j.status === 'schwarz') { status = 'schwarz'; since = j.since; note = 'Das Bild ist schwarz.'; }
    else if (j.status === 'steht') { status = 'steht'; since = j.since; note = 'Das Bild verändert sich nicht, obwohl die Liste wechseln müsste.'; }
    else if (sk) { status = 'wiedergabe_steht'; since = sk.since; note = 'Der Player meldet keinen Elementwechsel mehr.'; }
    const prev = w?.status; save(d.id, { samples_json: JSON.stringify(samples), status, note, since, checked_at: t, next_due: t + jitter() });
    if (status !== 'ok' && status !== prev) audit?.log({ action: 'bildwaechter.' + status, target: d.id, detail: { name: d.name } });
  }

  /** Ein Bild ist angekommen (auf Anfrage des Wächters oder für die Live-Ansicht) */
  async function ingest(id, buf, t = now()) {
    if (!enabled()) return; const d = app.devices.getDevice(id); if (!d || d.status !== 'active') return;
    const asked = pending.delete(id), w = row(id); if (!asked && w?.next_due && w.next_due > t + 2 * 60000) return; // Live-Bilder zählen nur, wenn die nächste Probe ohnehin bald fällig wäre
    let a; try { a = await analyzeImage(buf); } catch { return; }
    finalize(d, t, { t, ...a });
  }
  /** Alle 20 Sekunden: höchstens zwei Bildschirme zur Probe auffordern; ausbleibende Antworten und Bildschirme ohne Bildprobe abschließen */
  function tick(t = now()) {
    if (!enabled()) return 0; let n = 0;
    for (const [id, at] of [...pending]) if (t - at > 90000) { pending.delete(id); const d = app.devices.getDevice(id); if (d?.status === 'active') finalize(d, t, null); }
    for (const id of app.devices.sockets.keys()) {
      if (n >= 2) break; const d = app.devices.getDevice(id); if (!d || d.status !== 'active' || pending.has(id)) continue;
      const w = row(id); if (w?.next_due && w.next_due > t) continue; if (deviceStatus(d, t).level !== 'ok') continue;
      const st = parse(d.state_json, null);
      if (d.maintenance_since || d.ready === 0 || st?.displayOff || noShot(d, st)) { finalize(d, t, null); continue; }
      pending.set(id, t); if (app.devices.sendTo(id, 'command', { id: 'auto-' + randomUUID(), command: 'screenshot' })) n++; else pending.delete(id);
      save(id, { next_due: t + 120000 }); // nicht nachfragen, bevor die Antwort da ist (finalize setzt den nächsten Termin)
    }
    return n;
  }
  app.decorate('waechter', { tick, ingest, finalize, row, enabled });
  const timer = setInterval(() => { try { tick(); } catch {} }, 20000); timer.unref(); app.addHook('onClose', async () => clearInterval(timer));

  app.get('/api/v1/watch', { config: { perm: 'devices.read' } }, async () => ({ enabled: enabled(),
    devices: db.prepare("SELECT d.id,d.name,w.status,w.note,w.since,w.checked_at FROM devices d LEFT JOIN watch_state w ON w.device_id=d.id WHERE d.status='active' ORDER BY d.name").all().map((x) => ({ id: x.id, name: x.name, status: x.status ?? 'unbekannt', note: x.note, since: x.since, checkedAt: x.checked_at })),
    hint: 'Etwa alle 10 Minuten wird ein Bild abgefragt und geprüft, ob es schwarz oder auffällig lange unverändert ist. Es werden keine Bilder gespeichert. Lite-Bildschirme liefern keine Bildproben (dort wird nur die Wiedergabe beobachtet). „Bild steht“ meldet der Wächter vorsichtig und je nach Liste erst nach einigen Stunden, damit es keinen Fehlalarm gibt.' }));
  app.put('/api/v1/watch', { config: { perm: 'settings.manage' }, schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } } }, async (req) => {
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('watch.enabled', req.body.enabled ? 'true' : 'false');
    if (!req.body.enabled) db.prepare("UPDATE watch_state SET status='unbekannt', note='Bild-Wächter ist ausgeschaltet.', since=NULL, samples_json='[]'").run();
    audit.log({ user: req.user, action: 'bildwaechter.' + (req.body.enabled ? 'an' : 'aus'), ip: req.ip }); return { ok: true, enabled: req.body.enabled };
  });
}
waechterPlugin[Symbol.for('skip-override')] = true;
export default waechterPlugin;
