// Tor-Jubel: Schießt der Lieblingsverein ein Tor, zeigen die Bildschirme kurz eine fertige „TOR!“-Folie und kehren dann von selbst zum
// normalen Plan zurück. Technisch eine KURZE Übersteuerung der Art „tor“ (siehe shared/sequencer.js: Notfall > Tor > Hand > Regel).
// Die Folie ist immer dieselbe und wird vorab auf die Bildschirme geladen – beim Tor muss also nichts mehr übertragen werden.
// Datenquelle ist OpenLigaDB (von Fans gepflegt): Das Tor erscheint dort oft erst nach ein bis zwei Minuten. Das ist keine Live-Torlinientechnik.
import { randomUUID } from 'node:crypto';

export const TOR_LABEL = 'TOR';
export const TOR_COOLDOWN_MS = 30000;
const TOR_MEDIA_KEY = 'live.torMediaId';
export const TOR_TEXT = { title: 'TOR!', body: '', template: 'tor' };

export function createJubel({ db, audit = null, variants = null, pushAll = () => {}, shareActive = () => false, now = () => Date.now() }) {
  /** Die eine Jubel-Folie (Ordner „Apps“); wird bei Bedarf angelegt */
  function torMedia() {
    const have = db.prepare('SELECT value FROM settings WHERE key=?').get(TOR_MEDIA_KEY)?.value;
    if (have && db.prepare('SELECT 1 FROM media WHERE id=?').get(have)) return have;
    const id = randomUUID();
    db.transaction(() => {
      db.prepare("INSERT INTO media(id,name,kind,text_json,folder,created_at) VALUES(?,?,'text',?,'Apps',?)").run(id, 'App: Tor-Jubel', JSON.stringify(TOR_TEXT), now());
      db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(TOR_MEDIA_KEY, id);
    })();
    variants?.ensureAll(); pushAll(); return id;
  }
  /** Warum jetzt NICHT gejubelt wird (oder null) */
  function busy(t) {
    if (db.prepare("SELECT 1 FROM overrides o JOIN override_kind k ON k.id=o.id WHERE k.kind='notfall' AND o.ended_at IS NULL AND o.until>?").get(t)) return 'Eine Notfall-Meldung läuft.';
    if (shareActive()) return 'Gerade wird ein Bildschirm geteilt.';
    return null;
  }
  function fire(cfg, t, why) {
    const media = torMedia(), group = cfg.jubelGroupId && db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(cfg.jubelGroupId) ? cfg.jubelGroupId : null;
    const id = randomUUID(), until = t + Math.max(5, Math.min(60, Number(cfg.jubelSeconds) || 20)) * 1000;
    db.transaction(() => {
      db.prepare('INSERT INTO overrides VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(id, group ? 'group' : 'all', group, 'media', media, null, TOR_LABEL, null, 'Tor-Jubel', t, until);
      db.prepare("INSERT INTO override_kind(id,kind) VALUES(?, 'tor')").run(id);
    })();
    pushAll(); audit?.log({ action: 'tor_jubel.gezeigt', target: id, detail: { grund: why, bis: new Date(until).toISOString() } });
    return { id, until, scope: group ? 'group' : 'all' };
  }
  /**
   * Nach jedem Abruf der Live-App: Gibt es ein NEUES Tor des Lieblingsvereins? Beim ersten Mal, dass ein Spiel gesehen wird, gilt der aktuelle
   * Stand als bekannt (kein Jubel für alte Tore, auch nicht nach einem Neustart des Hubs mitten im Spiel).
   */
  function process(cfg, state, t = now()) {
    if (cfg.jubel) torMedia(); // Folie liegt vorab bereit (und wird mit dem Plan auf die Bildschirme geladen)
    const m = state?.match; if (!m) return { fired: false, reason: 'kein Spiel' };
    db.prepare('DELETE FROM live_state WHERE updated_at < ?').run(t - 14 * 86400000);
    const maxId = m.goals.reduce((mx, g) => Math.max(mx, g.id), 0), seen = db.prepare('SELECT * FROM live_state WHERE match_id=?').get(m.id);
    if (!seen) { db.prepare('INSERT INTO live_state(match_id,last_goal_id,updated_at) VALUES(?,?,?)').run(m.id, maxId, t); return { fired: false, reason: 'erster Stand' }; }
    const fresh = m.goals.filter((g) => g.id > seen.last_goal_id && g.team === m.side);
    db.prepare('UPDATE live_state SET last_goal_id=MAX(last_goal_id,?), updated_at=? WHERE match_id=?').run(maxId, t, m.id);
    if (!fresh.length) return { fired: false, reason: 'kein neues Tor' };
    if (!cfg.jubel) return { fired: false, reason: 'Jubel ist aus' };
    if (m.finished || t < m.kickoff) return { fired: false, reason: 'Spiel läuft nicht' };
    if (seen.last_jubel_at && t - seen.last_jubel_at < TOR_COOLDOWN_MS) return { fired: false, reason: 'zu kurz nach dem letzten Jubel' };
    const why = busy(t); if (why) return { fired: false, reason: why };
    db.prepare('UPDATE live_state SET last_jubel_at=? WHERE match_id=?').run(t, m.id);
    return { fired: true, ...fire(cfg, t, `Tor für ${m.side === 1 ? m.team1 : m.team2}`) };
  }
  /** „Tor-Jubel testen“ in der Oberfläche: zeigt die Folie sofort (ohne Spiel), sofern nichts Wichtigeres läuft */
  function test(cfg, t = now()) {
    const why = busy(t); if (why) return { ok: false, error: `${why} Der Test wurde nicht gestartet.` };
    const r = fire(cfg, t, 'Test'); return { ok: true, ...r, text: `Die Jubel-Folie läuft jetzt ${Math.round((r.until - t) / 1000)} Sekunden auf ${r.scope === 'group' ? 'der gewählten Gruppe' : 'allen Bildschirmen'}.` };
  }
  return { process, test, torMedia };
}
