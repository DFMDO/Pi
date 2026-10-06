// Captive-Portal-Erkennung: iOS, Android, Windows und Firefox fragen feste Adressen ab.
// Antwort = Weiterleitung auf die Einrichtungsseite → das Handy öffnet sie von selbst.
export const PORTAL_URL = 'http://10.42.0.1/';
export const PROBES = new Set(['/generate_204', '/gen_204', '/hotspot-detect.html', '/library/test/success.html', '/success.txt', '/connecttest.txt', '/ncsi.txt', '/redirect', '/canonical.html', '/check_network_status.txt']);
export const isProbe = (path) => PROBES.has(path);
