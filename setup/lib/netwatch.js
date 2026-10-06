// Was passiert, wenn ein Player sein WLAN verliert? Reine Entscheidung (testbar).
//  • Der Player zeigt weiter seine gespeicherten Inhalte (kein Eingriff in die Anzeige).
//  • Nach 10 Minuten ohne WLAN startet der Einrichtungsmodus erneut (Hotspot), damit man das WLAN neu eintragen kann.
//  • Technikhinweise erscheinen am Bildschirm NIE über Inhalten: nur nach 24 h Ausfall UND ohne Cache,
//    oder wenn jemand die Hilfe per Taste anfordert. Im Admin-Panel steht der Ausfall sofort.
export const OFFLINE_SETUP_MS = 10 * 60000, HELP_AFTER_MS = 24 * 3600000;
export function decideNetAction({ offlineMs, hasCache, helpRequested = false, setupRunning = false }) {
  return {
    startSetup: !setupRunning && offlineMs >= OFFLINE_SETUP_MS,
    showHelpScreen: helpRequested || (offlineMs >= HELP_AFTER_MS && !hasCache),
    keepShowingContent: hasCache && !helpRequested,
  };
}
