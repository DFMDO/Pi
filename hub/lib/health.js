// Gesundheit der Bildschirme (Z.3) und WLAN-Stufen (Z.15): reine Funktionen, Klartext statt Fachbegriffen.
export const signalQuality = (dbm) => (dbm == null ? { level: 'unbekannt', label: 'Unbekannt', bars: 0 } : dbm >= -55 ? { level: 'sehr_gut', label: 'Sehr gut', bars: 4 } : dbm >= -67 ? { level: 'gut', label: 'Gut', bars: 3 } : dbm >= -75 ? { level: 'schwach', label: 'Schwach', bars: 2 } : { level: 'zu_schwach', label: 'Zu schwach', bars: 1 });

const mins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 90 ? `${m} Minuten` : m < 48 * 60 ? `${Math.round(m / 60)} Stunden` : `${Math.round(m / 1440)} Tagen`; };
/** Ergebnis des Bild-Wächters (Tabelle watch_state) als Warnung; Ergebnisse, die älter als eine Stunde sind, gelten nicht mehr */
function watchWarning(d, w, now) {
  if (!w || !w.checked_at || now - w.checked_at > 3600000) return null;
  if (w.status === 'schwarz') return { kind: 'bild_schwarz', level: 'bad', text: `„${d.name}“ zeigt seit etwa ${mins(now - (w.since ?? now))} nur Schwarz. Bitte Bildschirm, HDMI-Kabel und Strom prüfen; oft hilft „Neu laden“.` };
  if (w.status === 'steht') return { kind: 'bild_steht', level: 'warn', text: `Das Bild von „${d.name}“ hat sich seit etwa ${mins(now - (w.since ?? now))} nicht verändert, obwohl die Liste wechseln müsste. Bitte „Neu laden“ ausprobieren.` };
  if (w.status === 'wiedergabe_steht') return { kind: 'wiedergabe_steht', level: 'warn', text: `Die Wiedergabe von „${d.name}“ meldet seit etwa ${mins(now - (w.since ?? now))} keinen Wechsel mehr. Bitte „Neu laden“ ausprobieren.` };
  return null;
}

/** Warnungen in Klartext für einen aktiven Bildschirm. st = Heartbeat-Zustand, cfg = Schwellenwerte */
export function deviceWarnings(d, st, now, cfg = {}) {
  const w = [], name = d.name;
  if (d.maintenance_since) { if (now - d.maintenance_since > 24 * 3600000) w.push({ kind: 'wartung_vergessen', level: 'warn', text: `„${name}“ ist seit über 24 Stunden im Wartungsmodus. Bitte prüfen, ob er noch gebraucht wird.` }); return w; } // Wartung: sonst alles stumm
  if (!st) return w;
  const bw = watchWarning(d, cfg.watch, now); if (bw) w.push(bw);
  const t = st.throttled;
  if (t != null && (t & 0x1)) w.push({ kind: 'netzteil', level: 'bad', text: `Netzteil zu schwach bei „${name}“. Bitte das Original-Netzteil verwenden oder austauschen.` });
  else if (t != null && (t & 0x10000)) w.push({ kind: 'netzteil', level: 'warn', text: `„${name}“ hatte Unterspannung. Bitte das Netzteil und das Kabel prüfen.` });
  if (t != null && (t & 0x4)) w.push({ kind: 'drosselung', level: 'warn', text: `„${name}“ wird gedrosselt (zu heiß oder zu wenig Strom).` });
  if ((st.cpuTemp ?? 0) >= 80) w.push({ kind: 'temperatur', level: 'bad', text: `„${name}“ ist zu heiß (${Math.round(st.cpuTemp)} °C). Bitte für Luft sorgen oder kühlen.` });
  else if ((st.cpuTemp ?? 0) >= 72) w.push({ kind: 'temperatur', level: 'warn', text: `„${name}“ wird sehr warm (${Math.round(st.cpuTemp)} °C).` });
  if ((st.sdErrors ?? 0) > 0) w.push({ kind: 'sd', level: 'bad', text: `Die SD-Karte von „${name}“ meldet Fehler. Bitte bald austauschen.` });
  if (st.diskFreeMB != null && st.diskFreeMB < 200) w.push({ kind: 'speicher', level: 'warn', text: `„${name}“ hat nur noch ${st.diskFreeMB} MB freien Speicher. Bitte nicht benötigte Medien entfernen.` });
  if (st.syncState?.noSpace) w.push({ kind: 'speicher_voll', level: 'bad', text: `Auf „${name}“ ist die Speicherkarte voll – neue Medien konnten nicht geladen werden. Bitte nicht benötigte Medien entfernen oder eine größere SD-Karte einsetzen.` });
  if (st.speicherFehler) w.push({ kind: 'schreibfehler', level: 'bad', text: `„${name}“ kann nichts mehr auf seine Speicherkarte schreiben (voll oder defekt). Die Anzeige läuft weiter, Änderungen gehen aber beim nächsten Neustart verloren. Bitte die SD-Karte prüfen.` });
  if (st.selfHeal?.last && now - st.selfHeal.last < 24 * 3600000) { const min = Math.max(1, Math.round((now - st.selfHeal.last) / 60000)); w.push({ kind: 'selbstheilung', level: 'warn', text: `Die Anzeige von „${name}“ hatte gehangen und wurde vor ${min < 90 ? `${min} Minuten` : `${Math.round(min / 60)} Stunden`} automatisch neu gestartet. Wenn das öfter vorkommt, bitte die IT informieren.` }); }
  const weak = cfg.warnDbm ?? -72;
  if (st.signalDbm != null && st.signalDbm < weak) w.push({ kind: 'wlan', level: 'warn', text: `WLAN bei „${name}“ ist ${signalQuality(st.signalDbm).label.toLowerCase()}. Bitte den Bildschirm näher an den Access Point stellen.` });
  if (st.wifiSwitch && st.wifiSwitch.ok === false && now - st.wifiSwitch.ts < 7 * 86400000) w.push({ kind: 'wlan_wechsel', level: 'warn', text: `Der Wechsel von „${name}“ auf das WLAN „${st.wifiSwitch.ssid}“ hat nicht geklappt (${{ auth: 'Passwort falsch', verbindung: 'keine Verbindung', hub_nicht_erreichbar: 'Hub darüber nicht erreichbar', config: 'ungültige Angaben' }[st.wifiSwitch.reason] ?? 'unbekannt'}). Der Bildschirm ist im alten WLAN geblieben.` });
  if (st.timeSynced === false) w.push({ kind: 'uhrzeit', level: 'warn', text: `Die Uhr von „${name}“ ist nicht abgeglichen.` });
  return w;
}
