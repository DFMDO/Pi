// Schutz vor Absturz-Schleifen. Ein Fehler in einer Hintergrundaufgabe (Zeitgeber, nicht abgefangene Zusage) darf nicht den ganzen Dienst beenden:
// Beim Hub würde sonst jede Störung (z. B. eine gesperrte Datenbank für einen Moment) alle Bildschirme kurz verwaisen lassen, beim Agenten würde der
// Bildschirm schwarz. Wir protokollieren den Fehler und machen weiter. Nur wenn es in kurzer Zeit sehr viele Fehler gibt – oder ein Fehler im
// Hauptablauf auftritt, nach dem der Zustand unklar ist –, startet der Dienst sauber neu (Exit-Code 75, systemd: Restart=on-failure).

/** JSON aus einer Datenbank- oder Datei-Spalte lesen, ohne bei kaputten Daten eine ganze Seite zu verlieren */
export function parseJson(s, fallback = null) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Funktion so umhüllen, dass weder ein Fehler noch eine abgelehnte Zusage den Prozess gefährdet */
export function guarded(fn, onError = () => {}) {
  return (...args) => {
    try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(onError); return r; } catch (e) { onError(e); return undefined; }
  };
}

/** setInterval, das nie wegen eines Fehlers im Takt abstürzt (und den Prozess nicht am Beenden hindert) */
export function safeInterval(fn, ms, log = console.error, label = 'Zeitgeber') {
  const t = setInterval(guarded(fn, (e) => log(`${label}:`, e?.message ?? e)), ms); t.unref?.(); return t;
}
export function safeTimeout(fn, ms, log = console.error, label = 'Zeitgeber') {
  const t = setTimeout(guarded(fn, (e) => log(`${label}:`, e?.message ?? e)), ms); t.unref?.(); return t;
}

/**
 * Prozessweite Schutzschalter. Nicht abgefangene Zusagen werden protokolliert (und gezählt: ab maxRejections in windowMs Neustart);
 * ein nicht abgefangener Fehler im Hauptablauf führt nach dem Protokollieren zu einem sauberen Neustart.
 * @returns Funktion, die die Schutzschalter wieder entfernt (für Tests)
 */
export function installProcessGuards({ name = 'Dienst', log = console.error, exit = (c) => process.exit(c), proc = process, windowMs = 60000, maxRejections = 30, exitCode = 75, delayMs = 100 } = {}) {
  const stamps = [];
  const onRejection = (reason) => {
    const t = Date.now(); stamps.push(t); while (stamps.length && t - stamps[0] > windowMs) stamps.shift();
    log(`[${name}] Fehler in einer Hintergrundaufgabe (wird übergangen):`, reason?.stack ?? reason);
    if (stamps.length >= maxRejections) { log(`[${name}] Zu viele Fehler in kurzer Zeit – sauberer Neustart.`); exit(exitCode); }
  };
  const onException = (e) => { log(`[${name}] Schwerer Fehler – sauberer Neustart:`, e?.stack ?? e); setTimeout(() => exit(exitCode), delayMs); /* nicht unref: sonst würde der Prozess mit Code 0 enden und systemd ihn nicht neu starten */ };
  proc.on('unhandledRejection', onRejection); proc.on('uncaughtException', onException);
  return () => { proc.off('unhandledRejection', onRejection); proc.off('uncaughtException', onException); };
}
