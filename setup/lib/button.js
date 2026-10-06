// Taster am GPIO (Standard: GPIO 3): 3 Sekunden gedrückt halten → Einrichtungsmodus (WLAN neu eintragen). Löscht keine Inhalte.
/** @param {{read:()=>boolean|Promise<boolean>, now?:()=>number, holdMs?:number, onHold:()=>void}} o  read() = true, wenn gedrückt */
export function createButtonWatcher({ read, now = () => Date.now(), holdMs = 3000, onHold }) {
  let since = null, fired = false;
  return async function poll() {
    const pressed = await read();
    if (!pressed) { since = null; fired = false; return false; }
    since ??= now();
    if (!fired && now() - since >= holdMs) { fired = true; onHold(); return true; } // nur einmal je Druck
    return false;
  };
}
/** „pinctrl get 3“ → gedrückt, wenn der Pin nach Masse gezogen ist („lo“) */
export const parsePinctrl = (out) => /\|\s*lo\b/.test(String(out)) || /\blo\b/.test(String(out).split('//')[0]);
