// Bildschirm teilen – läuft im Hintergrund-Thread (Worker) der Verwaltungsseite.
// Warum ein Worker: Wenn ein Präsentationsfenster die Verwaltungsseite verdeckt, drosselt der Browser deren Zeitgeber stark (zuletzt auf eine Ausführung pro Minute).
// Ein Worker wird dabei nicht gedrosselt. Er liest die Bilder der Bildschirmaufnahme, macht JPEGs und schickt sie an den Hub.
// Nachrichten an die Seite: { type: 'sent' } nach jedem gesendeten Bild, { type: 'ended', reason } wenn Schluss ist.
self.onmessage = async (e) => {
  const { readable, csrf, id, maxWidth = 1920, fps = 5, quality = 0.8 } = e.data;
  const reader = readable.getReader(), minGap = 1000 / fps;
  let stopped = false, busy = false, last = -1e9, lastBlob = null, lastSent = 0, errors = 0;
  const fail = (reason) => { stopped = true; self.postMessage({ type: 'ended', reason }); };
  async function post(blob) {
    busy = true;
    try {
      const r = await fetch(`/api/v1/share/${id}/frame`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-csrf-token': csrf }, body: blob });
      if (r.status === 410 || r.status === 404) return fail('Die Übertragung wurde beendet.');
      if (r.status === 401 || r.status === 403) return fail('Du wurdest abgemeldet.');
      if (!r.ok) { if (++errors > 5) fail('Der Hub antwortet nicht richtig.'); return; }
      errors = 0; lastSent = Date.now(); self.postMessage({ type: 'sent' });
    } catch { if (++errors > 5) fail('Die Verbindung zum Hub ist weg.'); } finally { busy = false; }
  }
  // Steht das Bild still (z. B. eine Folie), kommen keine neuen Bilder: Das letzte wird alle 5 Sekunden erneut gesendet, damit die Übertragung „lebt“.
  const keep = setInterval(() => { if (!stopped && !busy && lastBlob && Date.now() - lastSent > 5000) post(lastBlob); }, 1000);
  try {
    for (;;) {
      const { value: frame, done } = await reader.read(); if (done || stopped) break;
      const t = performance.now(); if (busy || t - last < minGap) { frame.close(); continue; } last = t; // zu früh oder noch beim Senden: Bild überspringen
      const w = frame.displayWidth, hgt = frame.displayHeight, s = Math.min(1, maxWidth / w), cw = Math.max(2, Math.round(w * s)), ch = Math.max(2, Math.round(hgt * s));
      const canvas = new OffscreenCanvas(cw, ch); canvas.getContext('2d').drawImage(frame, 0, 0, cw, ch); frame.close();
      lastBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality }); await post(lastBlob);
    }
  } catch (err) { if (!stopped) fail('Die Aufnahme ist unterbrochen.'); }
  finally { clearInterval(keep); try { reader.cancel(); } catch {} if (!stopped) self.postMessage({ type: 'ended', reason: 'Die Bildschirm-Freigabe wurde beendet.' }); }
};
