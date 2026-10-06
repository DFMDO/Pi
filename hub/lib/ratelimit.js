// Einfacher Zähler mit steigender Sperre (im Speicher, pro Schlüssel).
export function createLimiter({ max = 5, baseMs = 30000, capMs = 15 * 60000, now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    /** Sekunden bis erlaubt (0 = erlaubt) */
    wait(key) { const e = m.get(key); return e && e.until > now() ? Math.ceil((e.until - now()) / 1000) : 0; },
    fail(key) {
      const e = m.get(key) ?? { n: 0, until: 0 }; e.n++;
      if (e.n >= max) e.until = now() + Math.min(capMs, baseMs * 2 ** (e.n - max));
      m.set(key, e); if (m.size > 5000) m.delete(m.keys().next().value);
    },
    ok(key) { m.delete(key); },
  };
}
