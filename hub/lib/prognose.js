// Gesundheits-Prognose: Aus dem Messwerte-Verlauf (metrics, höchstens 14 Tage) schätzt der Hub, wann der Speicherplatz voll wird, ob der freie
// Arbeitsspeicher stetig sinkt (Speicherleck) und ob ein Gerät immer heißer wird. Das sind SCHÄTZUNGEN aus einer geraden Linie durch die
// Stundenmittelwerte der letzten 7 Tage – sie ersetzen keine Warnung vor akuten Problemen (die kommen aus der Gesundheitsprüfung).
import { HUB } from './metrics.js';

const H = 3600000, MIN_HOURS = 24, WINDOW_DAYS = 7;
const r0 = (x) => Math.round(x);

/** Gerade durch (x, y) nach der Methode der kleinsten Quadrate → { slope (y je x), r2 (0–1, wie gut die Gerade passt) } */
export function linreg(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  if (!sxx) return null; const slope = sxy / sxx;
  return { slope, r2: syy < 1e-9 ? 1 : (sxy * sxy) / (sxx * syy) };
}
const span = (d) => (d < 14 ? `etwa ${Math.max(1, r0(d))} ${r0(d) === 1 ? 'Tag' : 'Tagen'}` : d < 60 ? `etwa ${r0(d / 7)} Wochen` : d < 365 ? `etwa ${r0(d / 30)} Monaten` : 'mehr als einem Jahr');
const hrs = (h) => (h < 36 ? `etwa ${Math.max(1, r0(h))} Stunden` : `etwa ${r0(h / 24)} Tagen`);

/**
 * Eine Quelle auswerten. rows: Stundenmittel [{ h (Stundenzähler), a (freier RAM MB), d (freier Platz MB), c (°C), n }], aufsteigend.
 * Gibt eine Liste von Befunden zurück: { id, kind, level: ok|warn|bad|info|wait, title, text, hint }.
 */
export function analyze(rows, { name, src = HUB, canDisk = true } = {}) {
  const out = [], have = rows.length, item = (kind, level, title, text, hint = null, est = null) => out.push({ id: `${kind}:${src}`, src, name, kind, level, title, text, hint, ...(est ? { estimate: est } : {}) });
  if (have < MIN_HOURS) {
    const t = `Es liegen erst ${have} von ${MIN_HOURS} Stunden Messwerte vor. Danach erscheint hier die Schätzung.`;
    item('speicher', 'wait', 'Speicherplatz', t); item('arbeitsspeicher', 'wait', 'Arbeitsspeicher', t); item('temperatur', 'wait', 'Temperatur', t); return out.filter((i) => canDisk || i.kind !== 'speicher');
  }
  // ---- Speicherplatz
  if (canDisk) {
    const pts = rows.filter((r) => r.d != null);
    if (pts.length < MIN_HOURS) item('speicher', 'wait', 'Speicherplatz', 'Für diesen Bildschirm liegen noch keine Werte zum freien Speicherplatz vor (sie kommen nach dem nächsten Update des Bildschirms).');
    else {
      const f = linreg(pts.map((r) => r.h), pts.map((r) => r.d)), now = pts.at(-1).d, perDay = f ? f.slope * 24 : 0;
      if (!f || perDay > -1) item('speicher', 'ok', 'Speicherplatz', `Der freie Platz bleibt stabil (${r0(now)} MB frei).`);
      else if (f.r2 < 0.3) item('speicher', 'info', 'Speicherplatz', `Der freie Platz schwankt unregelmäßig (${r0(now)} MB frei) – daraus lässt sich nichts vorhersagen.`);
      else {
        const left = now / -perDay, level = left < 14 ? 'bad' : left < 30 ? 'warn' : 'ok';
        item('speicher', level, 'Speicherplatz', `Der freie Platz sinkt um etwa ${r0(-perDay)} MB pro Tag (jetzt ${r0(now)} MB frei). Bei gleichem Tempo ist er in ${span(left)} voll.`,
          level === 'ok' ? null : 'Lösche Medien, die du nicht mehr brauchst (Bilder & Videos → „🧹 Aufräumen“), oder tausche die SD-Karte gegen eine größere. Das ist eine Schätzung aus den letzten Tagen.', { daysLeft: Math.round(left * 10) / 10, mbPerDay: Math.round(-perDay) });
      }
    }
  }
  // ---- Arbeitsspeicher: nur seit dem letzten Neustart betrachten (ein Sprung nach oben um mehr als 120 MB = Neustart)
  const mem = rows.filter((r) => r.a != null); let from = 0; for (let i = 1; i < mem.length; i++) if (mem[i].a - mem[i - 1].a > 120) from = i;
  const seg = mem.slice(from);
  if (seg.length < 6) item('arbeitsspeicher', 'wait', 'Arbeitsspeicher', 'Seit dem letzten Neustart liegen noch zu wenige Messwerte vor.');
  else {
    const f = linreg(seg.map((r) => r.h), seg.map((r) => r.a)), now = seg.at(-1).a;
    if (!f || f.slope > -2 || f.r2 < 0.5) item('arbeitsspeicher', 'ok', 'Arbeitsspeicher', `Der freie Arbeitsspeicher ist stabil (${r0(now)} MB frei).`);
    else {
      const left = Math.max(0, (now - 60) / -f.slope), level = left < 12 ? 'bad' : left < 48 ? 'warn' : 'info';
      item('arbeitsspeicher', level, 'Arbeitsspeicher', `Der freie Arbeitsspeicher sinkt seit dem letzten Neustart um etwa ${r0(-f.slope * 24)} MB pro Tag (jetzt ${r0(now)} MB frei). Bei gleichem Tempo wird er in ${hrs(left)} knapp.`,
        level === 'info' ? null : 'Das spricht für ein Speicherleck. Ein Neustart (Betrieb → Wartung) hilft vorübergehend. Bitte melde es mit der Kurve aus Betrieb → Verlauf.', { hoursLeft: Math.round(left) });
    }
  }
  // ---- Temperatur
  const tp = rows.filter((r) => r.c != null);
  if (tp.length < MIN_HOURS) item('temperatur', 'wait', 'Temperatur', 'Es liegen noch keine Temperaturwerte vor.');
  else {
    const last = tp.slice(-24), over = (lim) => last.filter((r) => r.c >= lim).length, hot = over(70), warm = over(60), mean = (xs) => xs.reduce((a, b) => a + b.c, 0) / xs.length;
    const earlier = tp.slice(0, -24), warming = earlier.length >= 48 ? mean(last) - mean(earlier) : 0, nowT = mean(last);
    if (hot / last.length >= 0.1) item('temperatur', 'bad', 'Temperatur', `In den letzten 24 Stunden war das Gerät in ${hot} von ${last.length} Stunden über 70 °C heiß (Mittelwert ${r0(nowT)} °C).`, 'Prüfe Kühlkörper, Gehäuse und Lüftung und stelle das Gerät nicht in die Sonne. Bei zu großer Hitze drosselt der Pi und Videos können ruckeln.', { hotHours: hot });
    else if (warm / last.length >= 0.3 || (warming >= 6 && nowT >= 55)) item('temperatur', 'warn', 'Temperatur', warming >= 6 && warm / last.length < 0.3
      ? `Das Gerät wird wärmer: gestern und heute im Mittel ${r0(nowT)} °C, in den Tagen davor ${r0(nowT - warming)} °C.` : `In den letzten 24 Stunden war das Gerät in ${warm} von ${last.length} Stunden über 60 °C warm (Mittelwert ${r0(nowT)} °C).`,
      'Ab etwa 60 °C drosselt ein Raspberry Pi 3 B+ seine Leistung. Prüfe Kühlkörper, Gehäuse und Lüftung.', { warmHours: warm });
    else item('temperatur', 'ok', 'Temperatur', `Die Temperatur ist unauffällig (Mittelwert der letzten 24 Stunden ${r0(nowT)} °C).`);
  }
  return out;
}

/** Stundenmittel einer Quelle aus der Datenbank (letzte 7 Tage) */
export function hourlyRows(db, src, nowMs) {
  return db.prepare('SELECT (ts/3600000) h, AVG(mem_avail) a, AVG(disk_free) d, AVG(temp) c, COUNT(*) n FROM metrics WHERE src=? AND ts>=? AND ts<=? GROUP BY (ts/3600000) ORDER BY h')
    .all(src, nowMs - WINDOW_DAYS * 24 * H, nowMs);
}

export function prognoseReport(db, nowMs) {
  const items = analyze(hourlyRows(db, HUB, nowMs), { name: 'Hub', src: HUB });
  for (const d of db.prepare("SELECT id,name FROM devices WHERE status='active' ORDER BY name").all()) items.push(...analyze(hourlyRows(db, d.id, nowMs), { name: d.name, src: d.id }));
  const order = { bad: 0, warn: 1, info: 2, ok: 3, wait: 4 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { generatedAt: nowMs, items, bad: items.filter((i) => i.level === 'bad').length, warn: items.filter((i) => i.level === 'warn').length,
    hint: 'Das sind Schätzungen aus dem Verlauf der letzten Tage (eine gerade Linie durch die Stundenmittelwerte). Sie brauchen mindestens 24 Stunden Messwerte und werden mit jedem Tag genauer. Plötzliche Änderungen, etwa ein großes Video, sieht die Schätzung nicht voraus.' };
}

async function prognosePlugin(app, { db, now = () => Date.now() }) {
  app.get('/api/v1/prognose', { config: { perm: 'system.read' }, schema: { querystring: { type: 'object', properties: { nurProbleme: { enum: ['1'] } } } } }, async (req) => {
    const r = prognoseReport(db, now()); return req.query.nurProbleme ? { ...r, items: r.items.filter((i) => i.level === 'bad' || i.level === 'warn') } : r;
  });
}
prognosePlugin[Symbol.for('skip-override')] = true;
export default prognosePlugin;
