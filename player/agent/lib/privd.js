// Privilegierte Aktionen laufen NICHT im Agent. Der Agent (unprivilegierter Benutzer)
// legt eine Anfragedatei in /run/dfm/privd ab; ein winziger Root-Dienst prüft sie gegen
// eine feste Liste erlaubter Aktionen und führt sie mit execFile (keine Shell) aus.
import { writeFileSync, readdirSync, readFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SSID = (s) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 32 && !/[\x00-\x1f\x7f]/.test(s);
const soft = (a) => Object.assign(a, { soft: true }); // Fehler dieses Befehls sind nicht schlimm
const WPA = (p) => typeof p === 'string' && ((p.length >= 8 && p.length <= 63 && /^[\x20-\x7e]+$/.test(p)) || /^[0-9a-fA-F]{64}$/.test(p));

/** Whitelist: Aktion → (Argumente prüfen) → Befehlsliste [[cmd,...args], ...] */
export const ACTIONS = {
  reboot: () => [['systemctl', 'reboot']],
  'wifi-connect': (a) => { if (!SSID(a.ssid) || !WPA(a.password)) throw new Error('ungültige WLAN-Daten'); return [soft(['nmcli', 'connection', 'delete', 'dfm-wifi']), ['nmcli', 'connection', 'add', 'type', 'wifi', 'ifname', 'wlan0', 'con-name', 'dfm-wifi', 'ssid', a.ssid, 'connection.autoconnect', 'yes', 'wifi.powersave', '2', 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', a.password], ['nmcli', '--wait', '40', 'connection', 'up', 'dfm-wifi']]; },
  'wifi-reset': () => [soft(['nmcli', 'connection', 'delete', 'dfm-wifi']), ['systemctl', 'start', 'dfm-setup.service']],
  'display-rotate': (a) => { if (![0, 90, 180, 270].includes(a.degrees)) throw new Error('ungültiger Winkel'); return [['/usr/lib/dfm/set-rotation', String(a.degrees)]]; },
  'display-power': (a) => { if (!['on', 'off'].includes(a.state)) throw new Error('ungültiger Zustand'); return [['/usr/lib/dfm/display-power', a.state]]; },
  'factory-reset': () => [['/usr/lib/dfm/factory-reset']],
  'set-time': (a) => { if (!Number.isInteger(a.epoch) || a.epoch < 1767225600 || a.epoch > 4102444800) throw new Error('ungültige Zeit'); return [['date', '-u', '-s', `@${a.epoch}`], ['fake-hwclock', 'save']]; },
  'restart-agent': () => [['systemctl', 'restart', 'dfm-agent.service']],
};

export function plan(req) {
  const f = ACTIONS[req?.action]; if (!f) throw new Error('Aktion nicht erlaubt');
  return f(req.args ?? {});
}

export function request(dir, action, args = {}) {
  mkdirSync(dir, { recursive: true });
  const id = randomUUID(), tmp = join(dir, id + '.tmp');
  writeFileSync(tmp, JSON.stringify({ action, args }), { mode: 0o600 }); renameSync(tmp, join(dir, id + '.req')); return id;
}

/** Root-Seite: alle Anfragen abarbeiten. exec ist injizierbar (Tests). */
export async function processDir(dir, exec, log = () => {}) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.req'))) {
    const p = join(dir, f);
    try { for (const c of plan(JSON.parse(readFileSync(p, 'utf8')))) { const [cmd, ...args] = c; try { await exec(cmd, args); } catch (e) { if (!c.soft) throw e; } } }
    catch (e) { log('privd abgelehnt:', f, e.message); }
    finally { try { unlinkSync(p); } catch {} }
  }
}
