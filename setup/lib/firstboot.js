// Erster Start (vollautomatisch): Geräte-ID, Hostname, Hardware, Konfigurationsdatei.
// Geheimnisse entstehen hier pro Gerät zufällig – nichts davon steckt im Image.
import { randomUUID, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../../player/agent/lib/store.js';
import { detectHardware } from '../../player/agent/lib/sysinfo.js';
import { parseSetupFile } from './parse.js';
import { validateDraft } from './validate.js';

const SUFFIX_CHARS = 'abcdefghjkmnpqrstvwxyz23456789';
export const genSuffix = (rnd = randomInt) => Array.from({ length: 4 }, () => SUFFIX_CHARS[rnd(SUFFIX_CHARS.length)]).join('');

/** Datei überschreiben, dann löschen. Hinweis: Auf SD-Karten ist echtes „sicheres Löschen“ nicht garantierbar (Wear-Leveling). */
export function shred(file) {
  try { const n = statSync(file).size; const fd = openSync(file, 'r+'); writeSync(fd, Buffer.alloc(n)); fsyncSync(fd); closeSync(fd); } catch {}
  try { unlinkSync(file); } catch {}
}

export const serialOf = (cpuinfo) => (/^Serial\s*:\s*([0-9a-f]+)/mi.exec(cpuinfo ?? '') ?? [])[1] ?? '';
export function displayConnected(drmDir = '/sys/class/drm') {
  try { return readdirSync(drmDir).some((d) => /HDMI|DSI|DP/.test(d) && readFileSync(join(drmDir, d, 'status'), 'utf8').trim() === 'connected'); } catch { return false; }
}

/** Einrichtungsvorlage für die Boot-Partition (am PC les- und bearbeitbar). */
export const SETUP_TEMPLATE = `# DFM Signage – Einrichtung per Datei (dfm-setup.txt)
# Diese Datei wird beim ersten Start eingelesen und danach GELÖSCHT (sie enthält Passwörter).
# Zeilen mit # werden ignoriert. Format:  eintrag = wert
# Benenne die Datei von "dfm-setup.vorlage.txt" in "dfm-setup.txt" um, wenn du sie nutzen willst.

# --- WLAN (Pflicht für WLAN-Betrieb; bei Netzwerkkabel nicht nötig) ---
wlan_name = Museum-Signage
wlan_passwort = HIER-DAS-WLAN-PASSWORT
# wlan_versteckt = true

# --- Rolle: hub (Hauptrechner, nur einer pro Museum) oder player (Bildschirm) ---
rolle = player

# --- Für einen Bildschirm (player) ---
geraetename = Shop-Screen
hub_adresse = dfm-signage.local
# Einmalcode aus dem Hub: "Neuen Bildschirm verbinden"
einrichtungscode = XXXX-XXXX
# Optional, aber empfohlen: Fingerabdruck des Hubs (steht auf der Startkarte)
# hub_fingerabdruck = A3F2 91C0 7B44 D8E1 5C6A 0F73 B2E9 1D88 4A21 CC09 E7F5 3B60 92D1 08AE 6C47 F13B

# --- Für den Hub (rolle = hub) ---
# admin_name = Chefin
# admin_passwort = mindestens-12-Zeichen-lang
# standort = Deutsches Fußballmuseum
`;

/**
 * @returns { mode: 'configured'|'setup'|'lan', device, errors?: string[] }
 */
export async function runFirstboot({ dataDir, bootDir, exec = async () => {}, rnd = randomInt, cpuinfo = '', drmDir, hash, applyConfig }) {
  const devFile = join(dataDir, 'device.json'); let dev;
  if (existsSync(devFile)) dev = JSON.parse(readFileSync(devFile, 'utf8'));
  else {
    const hw = detectHardware(); const serial = serialOf(cpuinfo), suffix = genSuffix(rnd);
    dev = { deviceId: randomUUID(), suffix, hostname: `dfm-${suffix}`, serial, hw, headless: !displayConnected(drmDir), createdAt: new Date().toISOString() };
    writeAtomic(devFile, JSON.stringify(dev), 0o644);
    await exec('hostnamectl', ['set-hostname', dev.hostname]);
  }
  // Geräteinfo für den PC (Label drucken): Seriennummer + (bei Headless) Einrichtungs-PIN
  const info = [`Gerät: ${dev.hostname}`, `Seriennummer: ${dev.serial}`, `Modell: ${dev.hw.model}`, dev.headless ? `Einrichtungs-PIN (Headless): ${dev.serial.slice(-6).toUpperCase()}` : '', ''].filter((x, i, a) => x !== '' || i === a.length - 1).join('\n');
  try { writeFileSync(join(bootDir, 'geraeteinfo.txt'), info); } catch {}

  if (existsSync(join(dataDir, 'config.json'))) return { mode: 'configured', device: dev };

  // Konfigurationsdatei auf der Boot-Partition
  for (const [name, json] of [['dfm-setup.json', true], ['dfm-setup.txt', false]]) {
    const f = join(bootDir, name); if (!existsSync(f)) continue;
    const { config, errors } = parseSetupFile(readFileSync(f, 'utf8'), json);
    const draft = config && { ...config, wifi: config.wifi, admin: config.admin, site: config.site ?? 'Deutsches Fußballmuseum', name: config.name ?? dev.hostname };
    const verr = draft ? validateDraft(draft, { adminPolicy: () => null }).filter((e) => !(config.wifi === null && /WLAN/.test(e))) : [];
    const all = [...errors, ...verr];
    if (all.length) { writeFileSync(join(bootDir, 'dfm-setup-FEHLER.txt'), `Die Einrichtungsdatei konnte nicht verwendet werden:\n- ${all.join('\n- ')}\n`); shred(f); return { mode: 'setup', device: dev, errors: all }; }
    await applyConfig(draft, dev); shred(f); // enthält Passwörter → nach dem Einlesen sicher löschen
    return { mode: 'configured', device: dev };
  }
  return { mode: 'setup', device: dev };
}

/** Taste/Datei/Stromweg-Reset (ohne Tastatur): 1) Datei dfm-reset-wifi auf der Boot-Partition, 2) 5× Strom aus/ein. */
export function resetRequested({ bootDir, counterFile, now = Date.now() }) {
  const marker = join(bootDir, 'dfm-reset-wifi');
  if (existsSync(marker)) { try { unlinkSync(marker); } catch {} return 'datei'; }
  let n = 0; try { n = Number(readFileSync(counterFile, 'utf8')) || 0; } catch {}
  n++; try { writeFileSync(counterFile, String(n)); } catch {}
  return n >= 5 ? 'strom' : null;
}
export const clearPowerCounter = (counterFile) => { try { writeFileSync(counterFile, '0'); } catch {} };
