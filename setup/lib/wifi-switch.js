// WLAN sicher wechseln (A1): Das neue WLAN wird erst übernommen, wenn die Verbindung getestet wurde – sonst Rückfall auf das alte WLAN.
/**
 * @param {{run:(cmd:string,args:string[],o?:object)=>Promise<{code:number,stdout:string,stderr:string}>, ssid:string, password:string, reachable:()=>Promise<boolean>, iface?:string, log?:Function}} o
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function switchWifi({ run, ssid, password, reachable, iface = 'wlan0', log = () => {} }) {
  const nm = (...a) => run('nmcli', a, { timeout: 60000 });
  const hadOld = (await nm('-t', '-f', 'NAME', 'connection', 'show')).stdout.split('\n').includes('dfm-wifi');
  if (hadOld) { await nm('connection', 'modify', 'dfm-wifi', 'connection.id', 'dfm-wifi-old', 'connection.autoconnect', 'no'); }
  const restore = async (reason) => { // zurück zum alten WLAN
    await nm('connection', 'down', 'dfm-wifi-new'); await nm('connection', 'delete', 'dfm-wifi-new');
    if (hadOld) { await nm('connection', 'modify', 'dfm-wifi-old', 'connection.id', 'dfm-wifi', 'connection.autoconnect', 'yes'); await nm('--wait', '40', 'connection', 'up', 'dfm-wifi'); }
    log('WLAN-Wechsel fehlgeschlagen, altes WLAN aktiv', reason); return { ok: false, reason };
  };
  const add = await nm('connection', 'add', 'type', 'wifi', 'ifname', iface, 'con-name', 'dfm-wifi-new', 'ssid', ssid, 'connection.autoconnect', 'yes', 'connection.autoconnect-retries', '0',
    ...(password ? ['wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password] : []));
  if (add.code) return restore('config');
  const up = await nm('--wait', '40', 'connection', 'up', 'dfm-wifi-new');
  if (up.code) return restore(/secrets|password|auth/i.test(up.stderr + up.stdout) ? 'auth' : 'verbindung');
  let ok = false; for (let i = 0; i < 6 && !ok; i++) { ok = await reachable(); if (!ok) await new Promise((r) => setTimeout(r, 5000)); }
  if (!ok) return restore('hub_nicht_erreichbar'); // verbunden, aber der Hub ist darüber nicht erreichbar
  if (hadOld) await nm('connection', 'delete', 'dfm-wifi-old');
  await nm('connection', 'modify', 'dfm-wifi-new', 'connection.id', 'dfm-wifi');
  return { ok: true };
}
