// Ablaufsteuerung des Einrichtungsmodus (AP-only). Reine Logik mit eingespeisten Abhängigkeiten,
// damit alles ohne Hardware testbar ist.
import { randomInt, randomBytes, randomUUID, createHash } from 'node:crypto';
import { pinOk, validateDraft, ssidOk, wpaOk, nameOk, normalizeHubAddress } from './validate.js';
import { friendlyWifiError } from './nm.js';
import { wifiQr } from './parse.js';

const PW_CHARS = 'abcdefghjkmnpqrstvwxyz23456789'; // ohne verwechselbare Zeichen
export const randPassword = (n = 12, rnd = randomInt) => Array.from({ length: n }, () => PW_CHARS[rnd(PW_CHARS.length)]).join('');
export const randPin = (rnd = randomInt) => String(rnd(1000000)).padStart(6, '0');

export const IDLE_MS = 15 * 60000, MAX_PIN_FAILS = 5;

export function createController({ nm, suffix, now = () => Date.now(), rnd = randomInt, writeConfig, hashPassword, policy, hw = {}, onDone = () => {}, discoverHub = async () => null, log = () => {}, serialPin = null, headless = false, wifiOnly = false, onWifiOnlyDone = async () => {}, prepareHub = async () => null, led = { set() {} } }) {
  const s = { phase: 'welcome', ssid: `DFM-Setup-${suffix}`, password: '', pin: '', fails: 0, sessions: new Set(), started: 0, last: 0, stations: 0, draft: {}, result: { state: 'idle' }, networks: [], hubFound: null, cameraWifi: null, lan: null };

  async function startMode() { // (Neu-)Start: neues Passwort + neue PIN, nur hier gültig
    s.password = randPassword(12, rnd); s.pin = serialPin ?? randPin(rnd); s.fails = 0; s.sessions.clear(); s.draft = {}; s.result = { state: 'idle' };
    s.started = s.last = now(); s.stations = 0;
    s.networks = await nm.scan().catch(() => []);              // Scan VOR dem Hotspot (AP-only: danach nicht mehr möglich)
    const ok = await nm.startHotspot({ ssid: s.ssid, password: s.password });
    s.phase = ok ? 'step1' : 'error'; led.set(ok ? 'waiting' : 'error'); return ok;
  }
  const touch = () => { s.last = now(); };
  const authed = (t) => typeof t === 'string' && s.sessions.has(t);

  async function tick() { // alle 2 s
    s.lan = await Promise.resolve(nm.hasLan?.() ?? false).then(async (ok) => (ok ? { ip: await Promise.resolve(nm.lanAddress?.() ?? null).catch(() => null) } : null)).catch(() => null);
    if (s.phase === 'step1' || s.phase === 'step2') {
      if (now() - s.last > IDLE_MS) { log('15 Minuten ohne Aktivität – Modus wird neu gestartet'); return startMode(); }
      s.stations = await nm.stations().catch(() => 0);
      s.phase = s.stations > 0 ? 'step2' : 'step1';
      if (s.stations > 0) touch();
    }
  }

  function enterPin(pin) {
    touch();
    if (s.fails >= MAX_PIN_FAILS) return { ok: false, locked: true, error: 'Zu viele falsche Eingaben. Auf dem Bildschirm erscheint gleich eine neue PIN.' };
    if (!pinOk(pin) || pin !== s.pin) {
      s.fails++;
      if (s.fails >= MAX_PIN_FAILS) { s.pin = serialPin ?? randPin(rnd); s.fails = MAX_PIN_FAILS; s.sessions.clear(); setTimeout(() => { s.fails = 0; }, 1000).unref?.(); return { ok: false, locked: true, error: 'Zu viele falsche Eingaben. Auf dem Bildschirm erscheint eine neue PIN.' }; }
      return { ok: false, error: `Die PIN stimmt nicht. Noch ${MAX_PIN_FAILS - s.fails} Versuche.` };
    }
    s.fails = 0; const t = randomBytes(24).toString('base64url'); s.sessions.add(t); return { ok: true, session: t };
  }

  const api = {
    state: s, startMode, tick, enterPin, authed,
    info(t) { if (!authed(t)) return null; touch(); return { wifiOnly, model: hw.model ?? '', profile: hw.profile ?? 'standard', band24only: !/Pi (4|5|400|500)/.test(hw.model ?? ''), hubWarning: hw.profile && hw.profile !== 'pro' ? 'Dieses Gerät ist eher schwach. Als Hub – und erst recht als Hub mit Bildschirm – empfehlen wir einen Raspberry Pi 4 (2 GB) oder Pi 5.' : null,
      hubFound: s.hubFound, lan: !!s.lan, cameraWifi: s.cameraWifi ? { ssid: s.cameraWifi.ssid } : null, networks: s.networks, suffix, defaultName: `Bildschirm ${suffix}` }; },

    /** Schritt 1: WLAN prüfen. Wegen AP-only wird der Hotspot kurz abgeschaltet (Zwei-Phasen-Test). */
    async testWifi(t, w) {
      if (!authed(t)) return { ok: false, status: 401 }; touch();
      if (w?.skip && s.lan) { s.draft.wifi = { skip: true }; s.result = { state: 'wifi-ok', hub: await discoverHub().catch(() => null) }; return { ok: true, skipped: true }; } // Kabel: kein WLAN-Test nötig
      if (w?.useCamera && s.cameraWifi) w = { ...s.cameraWifi }; // WLAN stammt aus dem Kamera-Scan (Passwort bleibt auf dem Gerät)
      const bad = !ssidOk(w?.ssid) ? 'Der WLAN-Name ist ungültig.' : w.enterprise ? null : (w.password && !wpaOk(w.password)) ? 'Das WLAN-Passwort muss 8 bis 63 Zeichen lang sein.' : null;
      if (bad) return { ok: false, error: bad };
      s.draft.wifi = { ssid: w.ssid, password: w.password ?? '', hidden: !!w.hidden, enterprise: w.enterprise };
      s.result = { state: 'wifi-testing' }; s.phase = 'testing';
      setTimeout(async () => {
        await nm.stopHotspot(); const r = await nm.connect(s.draft.wifi);
        if (r.ok) { s.hubFound = await discoverHub().catch(() => null); s.result = { state: 'wifi-ok', hub: s.hubFound }; }
        else s.result = { state: 'wifi-failed', error: friendlyWifiError(r.reason) };
        if (r.ok) await nm.disconnect(); // Test-Verbindung lösen, damit der Hotspot wieder starten kann
        await restartHotspot();
      }, 1200);
      return { ok: true, testing: true };
    },
    /** WLAN-QR per Kamera gelesen: wird dem Handy als Vorschlag angeboten */
    useCameraWifi(w) { s.cameraWifi = w; touch(); },
    result(t) { return authed(t) ? s.result : null; },
    setRole(t, role) { if (!authed(t) || !['hub', 'player', 'kombi'].includes(role)) return false; touch(); s.draft.role = role; return true; },

    /** Alles abschließen: validieren, WLAN dauerhaft verbinden, Konfiguration schreiben. */
    async finish(t, d) {
      if (!authed(t)) return { ok: false, status: 401 }; touch();
      if (wifiOnly) { // „Nur WLAN ändern“: Rolle und Zugangsdaten bleiben, es wird nur das neue WLAN verbunden
        if (!s.draft.wifi) return { ok: false, errors: ['Bitte wähle zuerst ein WLAN.'] };
        s.result = { state: 'finishing' }; s.phase = 'testing';
        setTimeout(async () => { await nm.stopHotspot(); const r = await nm.connect(s.draft.wifi); if (!r.ok) { s.result = { state: 'failed', error: friendlyWifiError(r.reason) }; return restartHotspot(); }
          await onWifiOnlyDone(); s.phase = 'done'; s.result = { state: 'done', role: 'wifi' }; onDone({ wifiOnly: true }); }, 1200);
        return { ok: true };
      }
      const draft = { ...s.draft, ...d, wifi: s.draft.wifi };
      const errors = validateDraft(draft, { adminPolicy: policy }); if (errors.length) return { ok: false, errors };
      s.draft = draft; s.result = { state: 'finishing' }; s.phase = 'testing';
      setTimeout(() => finalize(draft).catch((e) => { log('Abschluss fehlgeschlagen', e.message); s.result = { state: 'failed', error: 'Der Abschluss hat nicht geklappt. Bitte versuche es noch einmal.' }; restartHotspot(); }), 1200);
      return { ok: true };
    },
  };

  async function restartHotspot() { // gleiches Passwort/PIN, damit das Handy sich selbst wieder verbinden kann
    await nm.startHotspot({ ssid: s.ssid, password: s.password }); s.phase = 'step1'; touch();
  }
  async function finalize(draft) {
    if (draft.wifi?.skip) await nm.stopHotspot();
    else if (!(await nm.wifiConnected())) { await nm.stopHotspot(); const r = await nm.connect(draft.wifi); if (!r.ok) { s.result = { state: 'failed', error: friendlyWifiError(r.reason) }; return restartHotspot(); } }
    else await nm.stopHotspot();
    const isHub = draft.role === 'hub' || draft.role === 'kombi';
    const cfg = { v: 1, role: draft.role, name: draft.role === 'hub' ? 'Hub' : draft.name.trim(), createdAt: new Date(now()).toISOString() };
    const extra = {};
    let fingerprint = null, spki = null;
    if (isHub) { // Hub-Schlüssel schon jetzt erzeugen → Fingerabdruck kann sofort angezeigt werden
      extra.hubBootstrap = { admin: { name: draft.admin.name.trim(), pwHash: await hashPassword(draft.admin.password) }, site: draft.site };
      const ph = await prepareHub(); fingerprint = typeof ph === 'string' ? ph : ph?.fingerprint ?? null; spki = typeof ph === 'object' ? ph?.spki ?? null : null;
    }
    if (draft.role === 'kombi') { // Hub UND Bildschirm in einem Gerät: der Player ist ohne Code mit dem eigenen Hub verbunden (gepinnt auf dessen Schlüssel)
      const deviceId = randomUUID(), token = randomBytes(32).toString('base64url');
      extra.agent = { deviceId, hubUrl: 'https://127.0.0.1', hubSpki: spki, token, name: draft.name.trim(), profile: hw.profile ?? 'standard', model: hw.model ?? null, local: true };
      extra.localPlayer = { deviceId, tokenHash: createHash('sha256').update(token).digest('hex'), name: draft.name.trim(), profile: hw.profile ?? 'standard', model: hw.model ?? null };
    } else if (draft.role === 'player') extra.agent = { hubUrl: normalizeHubAddress(draft.hubAddress), hubSpki: draft.fingerprint ? draft.fingerprint.replace(/[\s:-]/g, '').toLowerCase() : null, pairing: { code: draft.pairCode.replace('-', '').toUpperCase() }, name: draft.name.trim(), profile: hw.profile ?? 'standard', model: hw.model, hw };
    await writeConfig(cfg, extra); // atomar, erst danach gilt die Einrichtung als fertig
    s.phase = 'done'; led.set('ready'); s.result = { state: 'done', role: draft.role, hub: isHub ? { url: 'https://dfm-signage.local', fingerprint } : null }; onDone(cfg);
  }

  /** Daten für den Bildschirm. NUR über den Loopback-Server abrufbar (enthält PIN und WLAN-Passwort). */
  api.display = async () => {
    const base = { phase: s.phase, ssid: s.ssid, minutesLeft: Math.max(0, Math.ceil((IDLE_MS - (now() - s.last)) / 60000)) };
    if (s.cameraWifi && (s.phase === 'step1' || s.phase === 'step2')) base.camera = `WLAN per Kamera erkannt: ${s.cameraWifi.ssid}`;
    if (s.lan && (s.phase === 'step1' || s.phase === 'step2')) { const url = `http://${s.lan.ip ?? 'dfm-' + suffix + '.local'}/`; return { ...base, phase: 'step2', pin: s.pin, qr: url, url, lan: true }; } // Netzwerkkabel: gleich zur Einrichtungsseite
    if (s.phase === 'step1') return { ...base, password: s.password, qr: wifiQr({ ssid: s.ssid, password: s.password }), steps: ['Kamera-App öffnen', 'Code scannen', '„Verbinden“ tippen'] };
    if (s.phase === 'step2') return { ...base, pin: s.pin, qr: 'http://10.42.0.1/', url: 'http://10.42.0.1/' };
    if (s.phase === 'testing') return { ...base, message: s.result.state === 'wifi-testing' ? 'Das WLAN wird geprüft …' : 'Einrichtung wird abgeschlossen …' };
    if (s.phase === 'done') return { ...base, message: s.result.role === 'hub' || s.result.role === 'kombi' ? 'Fertig! Der Hub startet jetzt neu.' : 'Fertig! Der Bildschirm startet jetzt neu.', fingerprint: s.result.hub?.fingerprint ?? null, url: s.result.hub?.url ?? null };
    return base;
  };
  return api;
}
