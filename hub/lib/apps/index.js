// Apps-Rahmen: pflegt je App eine Textfolie („App: Wetter“ …) und aktualisiert sie regelmäßig. Nur der Hub ruft Daten ab; die Bildschirme zeigen die fertige Folie
// (laufen also auch ohne Internet weiter). Jede App ist standardmäßig AUS und wird von einem Admin eingeschaltet. Geändert wird nur, wenn sich der Inhalt ändert.
import { createHash, randomUUID } from 'node:crypto';
import { epochToLocal } from '../../../shared/time.js';
import { fetchText as realFetch } from './net.js';
import { buildWeather, buildMatchday, buildNews, buildToday, buildProgram, buildOnThisDay, parseOnThisDay, buildLive, liveIntervalMin, buildNext, parseRooms, LEAGUES, DAYS, HOURS_RE, MATCH_MAX_MS } from './builders.js';
import { parseJson } from '../../../shared/guard.js';

const MIN = 60000;
const str = (v, d, max) => { const s = String(v ?? d ?? '').trim(); if (s.length > max) throw new Error(`Der Text ist zu lang (höchstens ${max} Zeichen).`); return s; };
const url = (v) => { const s = str(v, '', 500); if (!/^https?:\/\//i.test(s)) throw new Error('Bitte gib eine vollständige Adresse an, die mit http:// oder https:// beginnt.'); return s; };
const int = (v, d, lo, hi) => { const n = v == null || v === '' ? d : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`Bitte gib eine ganze Zahl von ${lo} bis ${hi} an.`); return n; };
const coord = (v, d, lo, hi) => { const n = v == null || v === '' ? d : Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('Die Koordinate ist ungültig.'); return Math.round(n * 10000) / 10000; };
const host = (u) => { try { return new URL(u).host.replace(/^[^@]*@/, ''); } catch { return '?'; } };

export const APPS = {
  wetter: {
    title: 'Wetter', icon: '⛅', intervalMin: 30, desc: 'Aktuelle Temperatur und Vorhersage für heute und morgen (Daten des Deutschen Wetterdienstes).',
    defaults: { place: 'Dortmund', lat: 51.5256, lon: 7.4592 },
    validate: (c) => ({ place: str(c.place, 'Dortmund', 60) || 'Dortmund', lat: coord(c.lat, 51.5256, -90, 90), lon: coord(c.lon, 7.4592, -180, 180) }),
    hosts: () => ['api.brightsky.dev'],
    async build(cfg, { fetchText, now }) {
      const d = epochToLocal(now()), t = epochToLocal(now() + 86400000).date, q = `lat=${cfg.lat}&lon=${cfg.lon}&tz=Europe/Berlin`;
      const [w, c] = await Promise.all([fetchText(`https://api.brightsky.dev/weather?${q}&date=${d.date}&last_date=${t}`, { accept: 'application/json' }), fetchText(`https://api.brightsky.dev/current_weather?${q}`, { accept: 'application/json' }).catch(() => null)]);
      return buildWeather({ hourly: JSON.parse(w).weather ?? [], current: c ? JSON.parse(c).weather : null, nowMs: now(), place: cfg.place });
    },
  },
  datum: {
    title: 'Datum & Öffnungszeiten', icon: '🕘', intervalMin: 10, dayChange: true, desc: 'Zeigt das heutige Datum und die Öffnungszeiten („Heute geöffnet von 10 bis 18 Uhr“). Braucht kein Internet.',
    defaults: { hours: { mo: '', di: '10:00-18:00', mi: '10:00-18:00', do: '10:00-18:00', fr: '10:00-18:00', sa: '10:00-18:00', so: '10:00-18:00' }, closedDates: [], lastEntryMin: 60 },
    validate: (c) => {
      const hours = {}; for (const d of DAYS) { const v = String(c.hours?.[d] ?? '').trim(); if (!HOURS_RE.test(v)) throw new Error('Öffnungszeiten bitte so eingeben: 10:00-18:00 (oder leer = geschlossen).'); hours[d] = v; }
      const closedDates = [...new Set((Array.isArray(c.closedDates) ? c.closedDates : []).map((x) => String(x).trim()).filter(Boolean))]; if (closedDates.length > 100 || closedDates.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x))) throw new Error('Geschlossene Tage bitte als JJJJ-MM-TT eingeben (höchstens 100).');
      return { hours, closedDates, lastEntryMin: int(c.lastEntryMin, 60, 0, 180) };
    },
    hosts: () => [], async build(cfg, { now }) { return buildToday(now(), cfg); },
  },
  tagesprogramm: {
    title: 'Tagesprogramm (Event-Kalender)', icon: '📅', intervalMin: 15, dayChange: true, desc: 'Liest euren Event-Kalender (iCal-Adresse) und zeigt die heutigen Veranstaltungen mit Uhrzeit und Ort.',
    defaults: { url: '', title: 'Heute im Museum', locationFilter: '', maxEvents: 7 }, secret: ['url'],
    validate: (c) => ({ url: url(c.url), title: str(c.title, 'Heute im Museum', 40) || 'Heute im Museum', locationFilter: str(c.locationFilter, '', 60), maxEvents: int(c.maxEvents, 7, 1, 9) }),
    hosts: (cfg) => (cfg.url ? [host(cfg.url)] : []),
    async build(cfg, { fetchText, now }) { return buildProgram(await fetchText(cfg.url, { accept: 'text/calendar, */*', maxBytes: 5_000_000 }), now(), cfg); },
  },
  rss: {
    title: 'Nachrichten (RSS)', icon: '📰', intervalMin: 15, desc: 'Zeigt die neuesten Schlagzeilen eines RSS- oder Atom-Feeds, zum Beispiel von der eigenen Webseite.',
    defaults: { url: '', title: 'Neuigkeiten', maxItems: 5 }, secret: ['url'],
    validate: (c) => ({ url: url(c.url), title: str(c.title, 'Neuigkeiten', 40) || 'Neuigkeiten', maxItems: int(c.maxItems, 5, 1, 8) }),
    hosts: (cfg) => (cfg.url ? [host(cfg.url)] : []),
    async build(cfg, { fetchText }) { return buildNews(await fetchText(cfg.url, { accept: 'application/rss+xml, application/atom+xml, text/xml, */*' }), cfg); },
  },
  tagdaten: {
    title: 'An diesem Tag', icon: '📜', intervalMin: 30, dayChange: true, desc: 'Zeigt täglich einen Eintrag aus eurer eigenen Liste (zum Beispiel „An diesem Tag in der Fußballgeschichte“). Gibt es für heute keinen, erscheint der nächste. Braucht kein Internet.',
    defaults: { entries: "# Beispiele zum Prüfen und Ergänzen. Format: TT.MM.JJJJ Text  (das Jahr ist optional, Zeilen mit # werden ignoriert)\n04.07.1954 Wunder von Bern: Deutschland schlägt Ungarn 3:2 und wird zum ersten Mal Weltmeister.\n24.08.1963 Start der ersten Bundesliga-Saison.\n30.07.1966 WM-Finale in Wembley: England schlägt Deutschland 4:2 nach Verlängerung.\n07.07.1974 Deutschland wird im Münchner Olympiastadion Weltmeister (2:1 gegen die Niederlande).\n08.07.1990 Deutschland wird in Rom Weltmeister (1:0 gegen Argentinien).\n28.05.1997 Borussia Dortmund gewinnt in München die Champions League (3:1 gegen Juventus).\n13.07.2014 Deutschland wird in Rio de Janeiro Weltmeister (1:0 n. V. gegen Argentinien)." },
    validate: (c) => { const entries = String(c.entries ?? ''); if (entries.length > 6000) throw new Error('Die Liste ist zu lang (höchstens 6000 Zeichen).'); if (entries.trim() && !parseOnThisDay(entries).length) throw new Error('Keine gültige Zeile gefunden. Bitte so schreiben: 04.07.1954 Text'); return { entries }; },
    hosts: () => [], async build(cfg, { now }) { return buildOnThisDay(now(), cfg); },
  },
  fussball: {
    title: 'Fußball-Spieltag', icon: '⚽', intervalMin: 10, desc: 'Ergebnisse und Anstoßzeiten des aktuellen Spieltags (Daten von OpenLigaDB), dein Verein ist mit ★ markiert.',
    defaults: { league: 'bl1', favorite: 'Dortmund' },
    validate: (c) => { const league = String(c.league ?? 'bl1'); if (!LEAGUES.includes(league)) throw new Error('Diese Liga gibt es nicht in der Auswahl.'); return { league, favorite: str(c.favorite, 'Dortmund', 30) }; },
    hosts: () => ['api.openligadb.de'],
    async build(cfg, { fetchText }) { return buildMatchday(JSON.parse(await fetchText(`https://api.openligadb.de/getmatchdata/${cfg.league}`, { accept: 'application/json' })), cfg); },
  },
  livespiel: {
    title: 'Live-Spiel & Tor-Jubel', icon: '🏟️', intervalMin: 15, dynamicInterval: (_cfg, state, t) => liveIntervalMin(state, t),
    desc: 'Zeigt Anstoß-Countdown, laufenden Spielstand mit Toren und den Endstand deines Vereins (Daten von OpenLigaDB). Auf Wunsch blitzt bei einem Tor deines Vereins kurz „TOR!“ auf allen Bildschirmen auf.',
    defaults: { league: 'bl1', favorite: 'Dortmund', jubel: true, jubelSeconds: 20, jubelGroupId: '' },
    validate: (c) => { const league = String(c.league ?? 'bl1'); if (!LEAGUES.includes(league)) throw new Error('Diese Liga gibt es nicht in der Auswahl.'); const favorite = str(c.favorite, 'Dortmund', 30); if (!favorite) throw new Error('Bitte gib den Namen deines Vereins ein (ein Teil genügt, zum Beispiel „Dortmund“).');
      return { league, favorite, jubel: !(c.jubel === false || c.jubel === 'false' || c.jubel === 0), jubelSeconds: int(c.jubelSeconds, 20, 5, 60), jubelGroupId: str(c.jubelGroupId, '', 40) }; },
    hosts: () => ['api.openligadb.de'],
    async build(cfg, { fetchText, now }) { return buildLive(JSON.parse(await fetchText(`https://api.openligadb.de/getmatchdata/${cfg.league}`, { accept: 'application/json' })), cfg, now()); },
    info(state, t) { const m = state?.match; if (!m) return state ? 'Kein Spiel deines Vereins an diesem Spieltag.' : null; const [a, b] = m.score ?? [0, 0], live = !m.finished && t >= m.kickoff && t <= m.kickoff + MATCH_MAX_MS; return `${m.team1} ${a}:${b} ${m.team2} – ${m.finished ? 'beendet' : live ? 'läuft gerade' : 'noch nicht angepfiffen'}`; },
  },
  naechster: {
    title: 'Nächster Programmpunkt', icon: '⏱️', intervalMin: 1, dayChange: true, multi: true, desc: 'Zeigt, was als Nächstes im Event-Kalender ansteht, mit Countdown („in 25 Min.“). Je Raum eine eigene Folie, damit jeder Bildschirm sein Programm zeigt. Nutzt dieselbe Kalender-Adresse wie das Tagesprogramm.',
    defaults: { url: '', title: 'Als Nächstes', rooms: '', maxItems: 3 }, secret: ['url'],
    validate: (c) => ({ url: str(c.url, '', 500) ? url(c.url) : '', title: str(c.title, 'Als Nächstes', 40) || 'Als Nächstes', rooms: parseRooms(c.rooms).join(', '), maxItems: int(c.maxItems, 3, 1, 5) }),
    hosts: (cfg, of) => { const u = cfg.url || of?.('tagesprogramm')?.url; return u ? [host(u)] : []; },
    async build(cfg, { fetchCached, now, cfgOf }) { const u = cfg.url || cfgOf('tagesprogramm').url; if (!u) throw new Error('Bitte trage die Kalender-Adresse ein oder richte zuerst das Tagesprogramm ein.'); return buildNext(await fetchCached(u, { accept: 'text/calendar, */*', maxBytes: 5_000_000 }), now(), cfg); },
  },
};
export const APP_TYPES = Object.keys(APPS);

export function createApps({ db, variants = null, pushAll = () => {}, fetchText = realFetch, now = () => Date.now(), onRun = null }) {
  const row = (type) => db.prepare('SELECT * FROM apps WHERE type=?').get(type);
  const cfgOf = (type, r = row(type)) => ({ ...APPS[type].defaults, ...(r ? parseJson(r.config_json, {}) : {}) });
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  /** Letzte strukturierte Ergebnisse einer App (zum Beispiel Wetterwerte) und wann sie zuletzt erfolgreich geholt wurden */
  const stateOf = (type) => { const r = row(type); return { state: parse(r?.state_json), ts: r?.last_ok ?? null, enabled: !!r?.enabled }; };
  // Dieselbe Kalender-Adresse brauchen mehrere Apps, und der Countdown rechnet jede Minute: Der Server wird aber nur alle 5 Minuten gefragt.
  const cache = new Map();
  const fetchCached = async (u, opts, ttlMs = 5 * MIN) => { const c = cache.get(u); if (c && now() - c.t < ttlMs) return c.v; const v = await fetchText(u, opts); if (String(v).length < 3_000_000) { cache.set(u, { t: now(), v }); if (cache.size > 12) cache.delete(cache.keys().next().value); } return v; };
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  function ensureMedia(type) {
    const r = row(type); if (r?.media_id && db.prepare('SELECT 1 FROM media WHERE id=?').get(r.media_id)) return r.media_id;
    const id = randomUUID(); db.prepare("INSERT INTO media(id,name,kind,text_json,folder,created_at) VALUES(?,?,'text',?,'Apps',?)").run(id, `App: ${APPS[type].title}`, JSON.stringify({ title: APPS[type].title, body: 'Wird beim ersten Abruf gefüllt …', template: 'standard' }), now());
    db.prepare('UPDATE apps SET media_id=? WHERE type=?').run(id, type); return id;
  }
  /** Folie mit Schlüssel (zum Beispiel ein Raum): eigene Textfolie „App: Nächster Programmpunkt – Foyer“ */
  function ensureSlide(type, key) {
    const r = db.prepare('SELECT * FROM app_slides WHERE type=? AND key=?').get(type, key); if (r && db.prepare('SELECT 1 FROM media WHERE id=?').get(r.media_id)) return r;
    const id = randomUUID(); db.prepare("INSERT INTO media(id,name,kind,text_json,folder,created_at) VALUES(?,?,'text',?,'Apps',?)").run(id, `App: ${APPS[type].title} – ${key}`.slice(0, 100), JSON.stringify({ title: key, body: 'Wird beim ersten Abruf gefüllt …', template: 'standard' }), now());
    db.prepare('INSERT OR REPLACE INTO app_slides(type,key,media_id,last_hash) VALUES(?,?,?,NULL)').run(type, key, id); return { type, key, media_id: id, last_hash: null };
  }
  function save(type, { enabled, config }) {
    const def = APPS[type]; if (!def) throw Object.assign(new Error('Diese App gibt es nicht.'), { status: 404 });
    const cfg = def.validate({ ...cfgOf(type), ...(config ?? {}) });
    db.prepare('INSERT INTO apps(type,enabled,config_json,created_at) VALUES(?,?,?,?) ON CONFLICT(type) DO UPDATE SET enabled=excluded.enabled, config_json=excluded.config_json, last_hash=NULL').run(type, enabled ? 1 : 0, JSON.stringify(cfg), now());
    db.prepare('UPDATE app_slides SET last_hash=NULL WHERE type=?').run(type);
    if (enabled && !APPS[type].multi) ensureMedia(type); return cfg; // Apps mit mehreren Folien legen ihre Folien erst beim Abruf an
  }
  async function run(type) {
    const def = APPS[type], r = row(type); if (!r) throw new Error('Diese App ist noch nicht eingerichtet.');
    const t = now(); db.prepare('UPDATE apps SET last_run=? WHERE type=?').run(t, type);
    try {
      const cfg = cfgOf(type, r), out = await def.build(cfg, { fetchText, fetchCached, now, cfgOf: (ty) => cfgOf(ty) });
      const slides = out.slides ?? [{ key: '', title: out.title, body: out.body, compact: out.compact }]; let changed = false, first = null;
      for (const s of slides) {
        const key = s.key ?? '', text = { title: String(s.title).slice(0, 120), body: String(s.body).slice(0, 900), template: 'standard', ...(s.compact ? { compact: true } : {}) }, hash = sha(JSON.stringify(text));
        const slide = key === '' ? { media_id: ensureMedia(type), last_hash: row(type).last_hash } : ensureSlide(type, key); first ??= text;
        if (hash !== slide.last_hash) {
          db.transaction(() => { db.prepare('UPDATE media SET text_json=? WHERE id=?').run(JSON.stringify(text), slide.media_id); db.prepare("UPDATE media_variants SET status='pending', error=NULL WHERE media_id=?").run(slide.media_id);
            if (key === '') db.prepare('UPDATE apps SET last_hash=? WHERE type=?').run(hash, type); else db.prepare('UPDATE app_slides SET last_hash=? WHERE type=? AND key=?').run(hash, type, key); })(); changed = true;
        }
      }
      // Einträge, die nicht mehr eingerichtet sind (zum Beispiel ein entfernter Raum): Die Folie sagt es ehrlich, statt veraltete Zeiten zu zeigen
      if (out.slides) {
        const olds = db.prepare('SELECT * FROM app_slides WHERE type=?').all(type), main = row(type); if (main.media_id && !slides.some((s) => !s.key)) olds.push({ key: '', media_id: main.media_id, last_hash: main.last_hash });
        for (const old of olds) if (!slides.some((s) => (s.key ?? '') === old.key)) {
          const text = { title: old.key || APPS[type].title, body: 'Dieser Eintrag ist nicht mehr eingerichtet.', template: 'standard' }, hash = sha(JSON.stringify(text));
          if (hash !== old.last_hash) {
            db.prepare('UPDATE media SET text_json=? WHERE id=?').run(JSON.stringify(text), old.media_id); db.prepare("UPDATE media_variants SET status='pending', error=NULL WHERE media_id=?").run(old.media_id);
            if (old.key === '') db.prepare('UPDATE apps SET last_hash=? WHERE type=?').run(hash, type); else db.prepare('UPDATE app_slides SET last_hash=? WHERE type=? AND key=?').run(hash, type, old.key); changed = true;
          }
        }
      }
      if (out.state !== undefined) db.prepare('UPDATE apps SET state_json=? WHERE type=?').run(out.state == null ? null : JSON.stringify(out.state), type);
      db.prepare('UPDATE apps SET last_ok=?, last_error=NULL WHERE type=?').run(now(), type);
      if (changed) { variants?.ensureAll(); pushAll(); }
      // Ein Fehler in der Folgeaktion (Tor-Jubel, Regeln) lässt den Abruf nicht scheitern, wird aber sichtbar gemeldet
      try { await onRun?.(type, { cfg, state: out.state ?? null, now: now() }); } catch (e) { db.prepare('UPDATE apps SET last_error=? WHERE type=?').run(`Die Daten wurden geholt, aber die Folgeaktion (Tor-Jubel oder Regeln) ist fehlgeschlagen: ${String(e.message).slice(0, 200)}`, type); }
      return { ok: true, changed, text: first };
    } catch (e) { db.prepare('UPDATE apps SET last_error=? WHERE type=?').run(String(e.message).slice(0, 300), type); return { ok: false, error: e.message }; }
  }
  /** Alle fälligen Apps nacheinander aktualisieren (Aufruf jede Minute) */
  async function runDue() {
    const out = [];
    for (const r of db.prepare('SELECT * FROM apps WHERE enabled=1').all()) {
      const def = APPS[r.type]; if (!def) continue; const t = now();
      const dayChanged = def.dayChange && r.last_run && epochToLocal(r.last_run).date !== epochToLocal(t).date, iv = def.dynamicInterval ? def.dynamicInterval(cfgOf(r.type, r), parse(r.state_json), t) : def.intervalMin;
      const retryMs = r.last_error ? Math.min(iv, 5) * MIN : iv * MIN; // nach einem Fehler schneller erneut versuchen
      if (!r.last_run || dayChanged || t - r.last_run >= retryMs) out.push([r.type, await run(r.type)]);
    }
    return out;
  }
  const list = ({ revealSecrets = false } = {}) => APP_TYPES.map((type) => {
    const def = APPS[type], r = row(type), cfg = cfgOf(type, r), slides = db.prepare('SELECT key,media_id FROM app_slides WHERE type=? ORDER BY key').all(type), mid = r?.media_id ?? slides[0]?.media_id ?? null, m = mid ? db.prepare('SELECT text_json FROM media WHERE id=?').get(mid) : null;
    const shown = { ...cfg }; for (const k of def.secret ?? []) if (shown[k]) shown[k] = revealSecrets ? shown[k] : '(gesetzt)';
    let info = null; try { info = def.info && r?.enabled ? def.info(parse(r.state_json), now()) : null; } catch { info = null; }
    return { type, title: def.title, icon: def.icon, desc: def.desc, intervalMin: def.intervalMin, enabled: !!r?.enabled, config: shown, defaults: def.defaults, hosts: r ? def.hosts(cfg, cfgOf) : def.hosts(def.defaults, cfgOf), mediaId: r?.media_id ?? null, slides: slides.map((s) => ({ key: s.key, mediaId: s.media_id, name: db.prepare('SELECT name FROM media WHERE id=?').get(s.media_id)?.name ?? null })), info, lastRun: r?.last_run ?? null, lastOk: r?.last_ok ?? null, lastError: r?.last_error ?? null, preview: m ? JSON.parse(m.text_json) : null };
  });
  return { save, run, runDue, list, ensureMedia, stateOf, fetchCached, cfgOf: (type) => cfgOf(type) };
}
