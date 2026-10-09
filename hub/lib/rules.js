// Wenn-Dann-Regeln: „Wenn es regnet, zeige die Regenprogramm-Liste“, „Wenn das Spiel läuft, zeige die Live-Folie“, „Samstags 10–12 Uhr …“.
// Eine Regel hat bis zu vier Bedingungen (alle müssen zutreffen), einen Inhalt (Abspielliste oder Folie) und einen Bereich (alle / Gruppe / Bildschirm).
// Der Hub wertet jede Minute aus. Trifft eine Regel zu, legt er eine Übersteuerung der Art „regel“ an (niedrigster Rang: Notfall, Tor-Jubel und
// Hand-Aktionen gehen vor). Die Übersteuerung läuft nur ~15 Minuten und wird laufend verlängert – fällt der Hub aus, endet die Regel von selbst.
import { randomUUID } from 'node:crypto';
import { epochToLocal } from '../../shared/time.js';
import { MATCH_MAX_MS } from './apps/builders.js';

export const ROLL_MS = 15 * 60000, RENEW_LEFT_MS = 8 * 60000, OFF_DELAY_MS = 120000;
export const WEATHER_MAX_AGE_MS = 2 * 3600e3, MATCH_MAX_AGE_MS = 3 * 3600e3;
export const RULE_PREFIX = 'REGEL: ';
const DAYS = ['so', 'mo', 'di', 'mi', 'do', 'fr', 'sa'], DAY_NAMES = { mo: 'Montag', di: 'Dienstag', mi: 'Mittwoch', do: 'Donnerstag', fr: 'Freitag', sa: 'Samstag', so: 'Sonntag' };
const WEATHER_IS = ['regen', 'regen_bald', 'trocken', 'ueber', 'unter'], MATCH_IS = ['laeuft', 'heute', 'bald', 'nicht'], HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Eingabe prüfen und bereinigen; wirft einen verständlichen Fehler */
export function normalizeConditions(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Bitte gib mindestens eine Bedingung an.');
  if (list.length > 4) throw new Error('Eine Regel kann höchstens vier Bedingungen haben.');
  return list.map((c) => {
    if (c?.type === 'wetter') {
      if (!WEATHER_IS.includes(c.is)) throw new Error('Diese Wetter-Bedingung gibt es nicht.');
      if (c.is === 'ueber' || c.is === 'unter') { const v = Number(c.value); if (!Number.isFinite(v) || v < -30 || v > 50) throw new Error('Bitte gib eine Temperatur zwischen -30 und 50 °C an.'); return { type: 'wetter', is: c.is, value: Math.round(v) }; }
      return { type: 'wetter', is: c.is };
    }
    if (c?.type === 'spiel') {
      if (!MATCH_IS.includes(c.is)) throw new Error('Diese Spiel-Bedingung gibt es nicht.');
      if (c.is === 'bald') { const m = Math.round(Number(c.minutes ?? 60)); if (!Number.isFinite(m) || m < 5 || m > 360) throw new Error('Bitte gib bei „Das Spiel beginnt bald“ zwischen 5 und 360 Minuten an.'); return { type: 'spiel', is: 'bald', minutes: m }; }
      return { type: 'spiel', is: c.is };
    }
    if (c?.type === 'zeit') {
      const from = String(c.from ?? ''), to = String(c.to ?? ''), days = [...new Set((Array.isArray(c.days) ? c.days : []).map(String))];
      if ((from && !HHMM.test(from)) || (to && !HHMM.test(to))) throw new Error('Bitte gib die Uhrzeit so an: 08:30.');
      if (!!from !== !!to) throw new Error('Bitte gib „von“ und „bis“ an – oder lass beides leer.');
      if (from && from === to) throw new Error('„von“ und „bis“ dürfen nicht gleich sein.');
      if (days.some((d) => !DAYS.includes(d))) throw new Error('Diesen Wochentag gibt es nicht.');
      if (!from && !days.length) throw new Error('Bei der Zeit-Bedingung fehlt ein Wochentag oder eine Uhrzeit.');
      return { type: 'zeit', from, to, days: days.length === 7 ? [] : days };
    }
    throw new Error('Diese Bedingung gibt es nicht.');
  });
}

/** Die Bedingung in Klartext („Es regnet“) */
export function describeCondition(c) {
  if (c.type === 'wetter') return { regen: 'Es regnet', regen_bald: 'Es regnet oder wird in den nächsten 3 Stunden regnen', trocken: 'Es bleibt trocken (kein Regen in den nächsten 3 Stunden)', ueber: `Es sind mehr als ${c.value} °C`, unter: `Es sind weniger als ${c.value} °C` }[c.is];
  if (c.type === 'spiel') return { laeuft: 'Das Spiel läuft gerade', heute: 'Heute ist Spieltag', bald: `Das Spiel beginnt in höchstens ${c.minutes} Minuten`, nicht: 'Gerade läuft kein Spiel' }[c.is];
  const days = c.days?.length ? (c.days.length === 5 && ['mo', 'di', 'mi', 'do', 'fr'].every((d) => c.days.includes(d)) ? 'Montag bis Freitag' : c.days.map((d) => DAY_NAMES[d]).join(', ')) : 'Jeden Tag';
  return c.from ? `${days} von ${c.from} bis ${c.to} Uhr` : days;
}

const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 2 ? 'gerade eben' : m < 120 ? `vor ${m} Min.` : `vor ${Math.round(m / 60)} Std.`; };
/** Eine Bedingung auswerten → { ok: true | false | null (unbekannt), text: Klartext zum aktuellen Wert } */
export function evalCondition(c, ctx) {
  const { t, weather, match } = ctx;
  if (c.type === 'zeit') {
    const l = epochToLocal(t), day = DAYS[new Date(`${l.date}T12:00:00Z`).getUTCDay()], dayOk = !c.days?.length || c.days.includes(day);
    let timeOk = true; if (c.from) { const now = toMin(l.time), a = toMin(c.from), b = toMin(c.to); timeOk = a < b ? now >= a && now < b : now >= a || now < b; }
    return { ok: dayOk && timeOk, text: `${DAY_NAMES[day]}, ${l.time} Uhr` };
  }
  if (c.type === 'wetter') {
    if (!weather.enabled) return { ok: null, text: 'Die Wetter-App ist ausgeschaltet.' };
    if (!weather.state || weather.ts == null) return { ok: null, text: 'Es liegen noch keine Wetterdaten vor.' };
    if (t - weather.ts > WEATHER_MAX_AGE_MS) return { ok: null, text: `Die Wetterdaten sind veraltet (${ago(t - weather.ts)}).` };
    const w = weather.state, now = `${w.tempC != null ? Math.round(w.tempC) + ' °C, ' : ''}${w.rain ? 'Regen' : w.rainSoon ? 'Regen bald' : 'trocken'} (${ago(t - weather.ts)})`;
    if ((c.is === 'ueber' || c.is === 'unter') && w.tempC == null) return { ok: null, text: 'Es liegt keine Temperatur vor.' };
    return { ok: { regen: w.rain, regen_bald: w.rainSoon, trocken: !w.rainSoon, ueber: w.tempC > c.value, unter: w.tempC < c.value }[c.is], text: now };
  }
  // Spiel (aus der App „Live-Spiel“): immer aus Anstoßzeit und „beendet“ neu gerechnet, damit es auch zwischen zwei Abrufen stimmt
  if (!match.enabled) return { ok: null, text: 'Die App „Live-Spiel“ ist ausgeschaltet.' };
  if (!match.state || match.ts == null) return { ok: null, text: 'Es liegen noch keine Spieldaten vor.' };
  if (t - match.ts > MATCH_MAX_AGE_MS) return { ok: null, text: `Die Spieldaten sind veraltet (${ago(t - match.ts)}).` };
  const m = match.state.match;
  if (!m) return { ok: c.is === 'nicht', text: 'Heute kein Spiel des Vereins' };
  const live = !m.finished && t >= m.kickoff && t <= m.kickoff + MATCH_MAX_MS, today = epochToLocal(t).date === epochToLocal(m.kickoff).date, until = m.kickoff - t;
  const text = `${m.team1} – ${m.team2}: ${live ? 'läuft' : m.finished || t > m.kickoff ? 'beendet' : until <= 3600e3 ? `Anstoß in ${Math.max(1, Math.round(until / 60000))} Min.` : 'noch nicht angepfiffen'}`;
  return { ok: { laeuft: live, heute: today, bald: !m.finished && until > 0 && until <= (c.minutes ?? 60) * 60000, nicht: !live }[c.is], text };
}
export function evalRule(conditions, ctx) {
  const items = conditions.map((c) => ({ ...evalCondition(c, ctx), what: describeCondition(c) }));
  return { ok: items.some((i) => i.ok === false) ? false : items.some((i) => i.ok === null) ? null : true, items };
}

export function createRules({ db, apps, audit = null, pushAll = () => {}, now = () => Date.now() }) {
  const parse = (r) => ({ ...r, enabled: !!r.enabled, conditions: JSON.parse(r.conditions_json) });
  const all = () => db.prepare('SELECT * FROM rules ORDER BY priority DESC, created_at, id').all().map(parse);
  const getState = (id) => db.prepare('SELECT * FROM rule_state WHERE rule_id=?').get(id) ?? { rule_id: id, override_id: null, blocked: 0, true_since: null, false_since: null, started_at: null };
  const putState = (s) => db.prepare('INSERT OR REPLACE INTO rule_state(rule_id,override_id,blocked,true_since,false_since,started_at) VALUES(?,?,?,?,?,?)').run(s.rule_id, s.override_id, s.blocked ? 1 : 0, s.true_since, s.false_since, s.started_at);
  const ctxAt = (t) => ({ t, weather: apps.stateOf('wetter'), match: apps.stateOf('livespiel') });
  const targetOk = (r) => r.scope === 'all' || !!db.prepare(r.scope === 'group' ? 'SELECT 1 FROM device_groups WHERE id=?' : "SELECT 1 FROM devices WHERE id=? AND status IN ('active','pending')").get(r.target_id);
  const contentName = (r) => db.prepare(r.content_type === 'playlist' ? 'SELECT name FROM playlists WHERE id=?' : 'SELECT name FROM media WHERE id=?').get(r.content_id)?.name ?? null;
  const targetName = (r) => r.scope === 'all' ? 'alle Bildschirme' : r.scope === 'group' ? `Gruppe „${db.prepare('SELECT name FROM device_groups WHERE id=?').get(r.target_id)?.name ?? '?'}“` : `„${db.prepare('SELECT name FROM devices WHERE id=?').get(r.target_id)?.name ?? '?'}“`;

  /** Überschneiden sich die Bereiche zweier Regeln (dann gewinnt die mit der höheren Wichtigkeit)? */
  function overlap(a, b) {
    if (a.scope === 'all' || b.scope === 'all') return true;
    if (a.scope === b.scope) return a.target_id === b.target_id;
    const [g, d] = a.scope === 'group' ? [a, b] : [b, a]; return db.prepare('SELECT 1 FROM devices WHERE id=? AND group_id=?').get(d.target_id, g.target_id) != null;
  }
  function endOverride(s, t) {
    if (s.override_id) db.prepare('UPDATE overrides SET ended_at=? WHERE id=? AND ended_at IS NULL').run(t, s.override_id);
    s.override_id = null; s.started_at = null;
  }
  function startOverride(r, s, t) {
    const id = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO overrides VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(id, r.scope, r.scope === 'all' ? null : r.target_id, r.content_type, r.content_id, null, (RULE_PREFIX + r.name).slice(0, 80), null, 'Regel', t, t + ROLL_MS);
      db.prepare("INSERT INTO override_kind(id,kind,prio) VALUES(?,'regel',?)").run(id, Math.max(0, Math.min(9, r.priority)));
    })();
    s.override_id = id; s.started_at = t;
  }

  /** Eine Auswertungsrunde (jede Minute und nach jedem App-Abruf). Gibt zurück, ob sich etwas für die Bildschirme geändert hat. */
  function tick(t = now()) {
    const ctx = ctxAt(t); let changed = false;
    for (const r of all()) {
      const s = getState(r.id), before = JSON.stringify(s);
      const ov = s.override_id ? db.prepare('SELECT ended_at, until FROM overrides WHERE id=?').get(s.override_id) : null;
      if (s.override_id && (!ov || ov.ended_at)) { // jemand hat die Anzeige von Hand beendet („Beenden“ in der Live-Ansicht) → Pause, bis die Bedingung einmal nicht mehr gilt
        if (ov?.ended_at) s.blocked = 1; s.override_id = null; s.started_at = null; changed = true;
      }
      if (s.override_id && ov && ov.until <= t) { s.override_id = null; s.started_at = null; s.true_since = null; s.false_since = null; changed = true; } // abgelaufen (Hub war lange weg): ohne Anzeige und mit neuer Wartezeit weiter
      const usable = r.enabled && contentName(r) != null && targetOk(r), res = usable ? evalRule(r.conditions, ctx) : { ok: false, items: [] };
      if (res.ok === true) { s.false_since = null; s.true_since ??= t; }
      else { s.true_since = null; s.false_since ??= t; if (s.blocked && (res.ok === false || !usable)) s.blocked = 0; }
      // Wetter und Spiel schwanken (kurzer Schauer, Datenpause): Sie müssen 2 Minuten lang nicht mehr zutreffen, bevor die Regel endet. Eine Uhrzeit endet auf die Minute genau.
      const flaky = res.items.some((i, k) => i.ok !== true && r.conditions[k].type !== 'zeit');
      const holds = res.ok === true && (t - s.true_since) >= r.stable_s * 1000, offDue = res.ok !== true && (!flaky || t - s.false_since >= OFF_DELAY_MS);
      if (!s.override_id && holds && usable && !s.blocked) { startOverride(r, s, t); changed = true; audit?.log({ action: 'regel.gestartet', target: r.id, detail: { name: r.name } }); }
      else if (s.override_id && (offDue || !usable)) { endOverride(s, t); changed = true; audit?.log({ action: 'regel.beendet', target: r.id, detail: { name: r.name } }); }
      else if (s.override_id && ov && ov.until - t < RENEW_LEFT_MS) { db.prepare('UPDATE overrides SET until=? WHERE id=?').run(t + ROLL_MS, s.override_id); changed = true; } // verlängern: so endet die Regel von selbst, wenn der Hub ausfällt
      if (JSON.stringify(s) !== before) putState(s);
    }
    // Zustände gelöschter Regeln aufräumen (die Übersteuerung dazu beenden)
    for (const s of db.prepare('SELECT * FROM rule_state WHERE rule_id NOT IN (SELECT id FROM rules)').all()) { if (s.override_id) { endOverride(s, t); changed = true; } db.prepare('DELETE FROM rule_state WHERE rule_id=?').run(s.rule_id); }
    if (changed) pushAll();
    return changed;
  }

  /** Alle Regeln mit Klartext für die Oberfläche: aktueller Zustand und warum */
  function view(t = now()) {
    const ctx = ctxAt(t), rules = all(), out = [];
    const items = rules.map((r) => {
      const s = getState(r.id), usable = r.enabled && contentName(r) != null && targetOk(r), res = usable ? evalRule(r.conditions, ctx) : { ok: false, items: r.conditions.map((c) => ({ ok: null, text: '', what: describeCondition(c) })) };
      return { r, s, usable, res, showing: !!s.override_id && !!db.prepare('SELECT 1 FROM overrides WHERE id=? AND ended_at IS NULL AND until>?').get(s.override_id, t) };
    });
    for (const x of items) {
      const { r, s, usable, res, showing } = x, beaten = items.find((o) => o.showing && o.r.id !== r.id && o.r.priority > r.priority && overlap(o.r, r));
      const status = !r.enabled ? 'aus' : !usable ? 'fehler' : s.blocked ? 'pausiert' : showing ? (beaten ? 'verdraengt' : 'zeigt') : res.ok === true ? 'wartet' : res.ok === null ? 'unbekannt' : 'inaktiv';
      const statusText = { aus: 'Ausgeschaltet.', fehler: contentName(r) == null ? 'Der Inhalt dieser Regel wurde gelöscht. Bitte wähle einen neuen.' : 'Der Bildschirm oder die Gruppe dieser Regel gibt es nicht mehr.', pausiert: 'Pausiert, weil die Anzeige von Hand beendet wurde. Sie startet wieder, sobald die Bedingung einmal nicht mehr gilt – oder mit „Jetzt wieder starten“.',
        verdraengt: `Die Bedingung gilt, aber eine wichtigere Regel („${beaten?.r.name}“) zeigt gerade ihren Inhalt.`, zeigt: `Zeigt gerade „${contentName(r)}“ auf ${targetName(r)}.`, wartet: r.stable_s ? `Die Bedingung gilt – die Regel startet nach ${r.stable_s} Sekunden Wartezeit.` : 'Die Bedingung gilt – die Regel startet gleich.',
        unbekannt: 'Mindestens eine Angabe fehlt oder ist veraltet. Die Regel wartet, bis wieder frische Daten da sind.', inaktiv: 'Die Bedingung gilt gerade nicht.' }[status];
      out.push({ id: r.id, name: r.name, enabled: r.enabled, priority: r.priority, conditions: r.conditions, content: { type: r.content_type, id: r.content_id, name: contentName(r) }, scope: r.scope, targetId: r.target_id, targetName: targetName(r), stableS: r.stable_s, createdAt: r.created_at,
        status, statusText, blocked: !!s.blocked, showingSince: showing ? s.started_at : null, checks: res.items.map((i) => ({ what: i.what, ok: i.ok, text: i.text })) });
    }
    return out;
  }
  function resume(id) { const s = getState(id); s.blocked = 0; putState(s); return tick(); }
  /** Beim Ändern/Löschen/Ausschalten einer Regel: ihre laufende Übersteuerung sofort beenden */
  function stop(id, t = now()) { const s = getState(id); if (s.override_id) { endOverride(s, t); pushAll(); } s.blocked = 0; s.true_since = null; s.false_since = null; putState(s); }
  return { tick, view, resume, stop, evalRule: (conds, t = now()) => evalRule(conds, ctxAt(t)) };
}
