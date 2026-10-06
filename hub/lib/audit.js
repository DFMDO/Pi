// Audit-Log: wer, was, wann, von wo. Hash-verkettet (Manipulation erkennbar),
// per Datenbank-Trigger nicht änderbar/löschbar. Geheimnisse werden maskiert.
import { createHash } from 'node:crypto';

const SECRET_KEY = /pass|token|secret|code|hmac|pin|key/i;
export function mask(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(mask);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, SECRET_KEY.test(k) ? '***' : mask(v)]));
}

export function createAudit(db) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const anchor = db.prepare("SELECT value FROM settings WHERE key='audit.anchor'");
  const ins = db.prepare(`INSERT INTO audit_log(ts,user_id,user_name,action,target,ip,security,detail_json,prev_hash,hash)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const calc = (prev, f) => createHash('sha256').update(prev + JSON.stringify(f)).digest('hex');
  return {
    log({ user = null, action, target = null, ip = null, security = false, detail = null }) {
      const ts = Date.now(), prev = last.get()?.hash ?? anchor.get()?.value ?? '0'.repeat(64);
      const dj = detail ? JSON.stringify(mask(detail)) : null;
      const f = [ts, user?.id ?? null, user?.name ?? null, action, target, ip, security ? 1 : 0, dj];
      ins.run(...f, prev, calc(prev, f));
    },
    verify() {
      let prev = db.prepare("SELECT value FROM settings WHERE key='audit.anchor'").get()?.value ?? '0'.repeat(64); // nach automatischer Löschung alter Einträge: Hash des letzten gelöschten Eintrags
      for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').all()) {
        const f = [r.ts, r.user_id, r.user_name, r.action, r.target, r.ip, r.security, r.detail_json];
        if (r.prev_hash !== prev || r.hash !== calc(prev, f)) return { ok: false, brokenAt: r.id };
        prev = r.hash;
      }
      return { ok: true };
    },
  };
}
