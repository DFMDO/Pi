// NetworkManager über nmcli. Jede Eingabe wird als EIN Argument übergeben (execFile, keine Shell).
import { execFile } from 'node:child_process';

const defaultRun = (cmd, args, { timeout = 30000 } = {}) => new Promise((res) => execFile(cmd, args, { timeout }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));

/** `nmcli -t` trennt mit ':' und maskiert ':' als '\:' */
export const splitT = (line) => line.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':').replace(/\\\\/g, '\\'));

export function createNm({ run = defaultRun, iface = 'wlan0' } = {}) {
  return {
    async scan() {
      await run('nmcli', ['device', 'wifi', 'rescan', 'ifname', iface]);
      const r = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY,FREQ', 'device', 'wifi', 'list', 'ifname', iface]);
      const best = new Map();
      for (const l of r.stdout.split('\n').filter(Boolean)) {
        const [ssid, sig, sec, freq] = splitT(l); if (!ssid) continue;
        const n = { ssid, signal: Number(sig), secure: !!sec && sec !== '--', enterprise: /802\.1X/.test(sec), band5: Number.parseInt(freq, 10) >= 4900 };
        if (!best.has(ssid) || best.get(ssid).signal < n.signal) best.set(ssid, n);
      }
      return [...best.values()].sort((a, b) => b.signal - a.signal);
    },
    async startHotspot({ ssid, password }) {
      await run('nmcli', ['connection', 'delete', 'dfm-setup']);
      const r = await run('nmcli', ['device', 'wifi', 'hotspot', 'ifname', iface, 'con-name', 'dfm-setup', 'ssid', ssid, 'password', password, 'band', 'bg', 'channel', '6']);
      await run('nmcli', ['connection', 'modify', 'dfm-setup', 'ipv4.addresses', '10.42.0.1/24', 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.proto', 'rsn', 'wifi-sec.pairwise', 'ccmp', 'wifi-sec.group', 'ccmp', 'wifi-sec.pmf', '1']);
      return r.code === 0;
    },
    async stopHotspot() { await run('nmcli', ['connection', 'down', 'dfm-setup']); await run('nmcli', ['connection', 'delete', 'dfm-setup']); },
    /** Verbindung herstellen. Rückgabe { ok, reason } – reason hilft bei verständlichen Fehlermeldungen. */
    async connect({ ssid, password, hidden, enterprise }) {
      await run('nmcli', ['connection', 'delete', 'dfm-wifi']);
      const base = ['connection', 'add', 'type', 'wifi', 'ifname', iface, 'con-name', 'dfm-wifi', 'ssid', ssid, 'connection.autoconnect', 'yes', 'connection.autoconnect-retries', '0', 'wifi.hidden', hidden ? 'yes' : 'no', 'wifi.powersave', '2'];
      const sec = enterprise ? ['wifi-sec.key-mgmt', 'wpa-eap', '802-1x.eap', 'peap', '802-1x.phase2-auth', 'mschapv2', '802-1x.identity', enterprise.user, '802-1x.password', enterprise.password]
        : password ? ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password] : [];
      const add = await run('nmcli', [...base, ...sec]); if (add.code) return { ok: false, reason: 'config' };
      const up = await run('nmcli', ['--wait', '40', 'connection', 'up', 'dfm-wifi'], { timeout: 50000 });
      if (up.code === 0) return { ok: true };
      await run('nmcli', ['connection', 'delete', 'dfm-wifi']);
      const t = up.stderr + up.stdout;
      return { ok: false, reason: /secrets were required|password|802\.1X|auth/i.test(t) ? 'auth' : /not found|no network|ssid/i.test(t) ? 'notfound' : 'other' };
    },
    async disconnect() { await run('nmcli', ['connection', 'down', 'dfm-wifi']); await run('nmcli', ['connection', 'delete', 'dfm-wifi']); },
    async hasLan() { const r = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'device']); return r.stdout.split('\n').some((l) => { const [, t, s] = splitT(l); return t === 'ethernet' && s === 'connected'; }); },
    async wifiConnected() { const r = await run('nmcli', ['-t', '-f', 'NAME,STATE', 'connection', 'show', '--active']); return r.stdout.split('\n').some((l) => splitT(l)[0] === 'dfm-wifi'); },
    async stations() { const r = await run('iw', ['dev', iface, 'station', 'dump']); return (r.stdout.match(/^Station /gm) ?? []).length; },
  };
}
export const friendlyWifiError = (reason) => ({
  auth: 'Das Passwort scheint falsch zu sein. Bitte prüfe es und versuche es noch einmal.',
  notfound: 'Das WLAN wurde nicht gefunden. Ist der Bildschirm in Reichweite? Pi 3 und Zero 2 W können nur 2,4-GHz-WLAN.',
  config: 'Die WLAN-Angaben konnten nicht verwendet werden. Bitte prüfe Name und Passwort.',
}[reason] ?? 'Die Verbindung hat nicht geklappt. Bitte versuche es noch einmal.');
