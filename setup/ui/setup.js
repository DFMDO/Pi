// Einrichtungsseite am Handy. Ein Schritt pro Ansicht, große Knöpfe, einfache Sprache.
// Alle Texte aus Fremdquellen (WLAN-Namen!) werden nur per textContent eingesetzt (kein XSS).
(() => {
  const app = document.getElementById('app'); let session = null, info = null; const d = { wifi: null, role: null, name: '', hubAddress: '', pairCode: '', fingerprint: '', admin: { name: '', password: '' }, site: 'Deutsches Fußballmuseum' };
  const h = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); } e.append(...kids.flat(Infinity).filter((x) => x != null && x !== false)); return e; };
  const api = async (path, body) => { const r = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Setup-Session': session ?? '' }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, ...j }; };
  const view = (step, title, ...kids) => { app.replaceChildren(...[step ? h('div', { class: 'steps', role: 'img', 'aria-label': `Schritt ${step} von 4` }, [1, 2, 3, 4].map((i) => h('i', { class: i <= step ? 'on' : '' }))) : null, step ? h('p', { class: 'hint' }, `Schritt ${step} von 4`) : null, h('h1', {}, title), ...kids].flat(Infinity).filter((x) => x != null && x !== false)); const f = app.querySelector('input,button'); f?.focus?.({ preventScroll: true }); };
  const field = (label, id, o = {}) => [h('label', { for: id }, label), o.hint ? h('p', { class: 'hint' }, o.hint) : null, h('input', { id, type: o.type ?? 'text', value: o.value ?? '', autocomplete: 'off', autocapitalize: o.caps ?? 'off', autocorrect: 'off', spellcheck: 'false', inputmode: o.mode, maxlength: o.max ?? 100, oninput: (e) => o.set?.(e.target.value) })];
  const btn = (text, fn, cls = '') => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, text);
  const err = (m) => h('p', { class: 'err', role: 'alert' }, m);

  // Startkarte aus dem Hub (QR → Link mit #c=…) füllt alles aus
  const card = (() => { try { const m = /#c=([A-Za-z0-9_-]+)$/.exec(location.hash); if (!m) return null; const j = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))); return j.v === 1 ? j : null; } catch { return null; } })();
  if (card) { if (card.s) d.wifi = { ssid: card.s, password: card.p ?? '' }; if (card.h) d.hubAddress = card.h; if (card.f) d.fingerprint = card.f; if (card.c) { d.pairCode = card.c; d.role = 'player'; } history.replaceState(null, '', location.pathname); }

  function pinView(msg) {
    let pin = ''; view(0, 'PIN eingeben', h('p', {}, 'Auf dem Bildschirm des Geräts siehst du eine 6-stellige Zahl. Gib sie hier ein.'),
      ...field('PIN', 'pin', { mode: 'numeric', max: 6, set: (v) => { pin = v; } }), msg ? err(msg) : null,
      btn('Weiter', async () => { const r = await api('/pin', { pin }); if (r.ok) { session = r.session; info = await api('/info'); wifiView(); } else pinView(r.error ?? 'Das hat nicht geklappt.'); }));
  }

  function wifiView(msg) {
    if (card && d.wifi && !msg) return testWifi();
    let showPw = false, hidden = false, ent = false, pwIn, ssidIn;
    const list = (info.networks ?? []).map((n) => h('button', { class: 'opt', type: 'button', 'aria-pressed': d.wifi?.ssid === n.ssid, onclick: () => { d.wifi = { ...(d.wifi ?? {}), ssid: n.ssid, enterprise: n.enterprise }; wifiView(); } },
      h('span', {}, n.ssid, n.secure ? ' 🔒' : ''), h('span', { 'aria-label': `Signal ${n.signal} Prozent` }, '▂▄▆█'.slice(0, Math.max(1, Math.ceil(n.signal / 25))), ` ${n.signal} %`)));
    view(1, 'WLAN wählen', h('p', {}, 'Mit diesem WLAN soll sich das Gerät verbinden.'), info.band24only ? h('p', { class: 'hint' }, 'Dieses Gerät kann nur 2,4-GHz-WLAN. 5-GHz-Netze funktionieren hier nicht.') : null,
      list.length ? list : h('p', { class: 'hint' }, 'Keine Netzwerke gefunden. Du kannst den Namen unten eintippen.'),
      ...field('Oder Netzwerkname eintippen (auch versteckte Netze)', 'ssid', { value: d.wifi?.ssid ?? '', max: 32, set: (v) => { d.wifi = { ...(d.wifi ?? {}), ssid: v }; } }),
      h('label', {}, h('input', { type: 'checkbox', style: 'width:auto;min-height:0;margin-right:8px', onchange: (e) => { hidden = e.target.checked; } }), 'Das Netzwerk ist versteckt'),
      h('label', {}, h('input', { type: 'checkbox', style: 'width:auto;min-height:0;margin-right:8px', onchange: (e) => { ent = e.target.checked; wifiView(); } }), 'Firmen-WLAN (Benutzername und Passwort)'),
      ent ? [...field('Benutzername', 'eu', { set: (v) => { d.eu = v; } }), h('label', { for: 'ep' }, 'Passwort'), h('input', { id: 'ep', type: 'password', autocomplete: 'off', oninput: (e) => { d.ep = e.target.value; } })]
        : [h('label', { for: 'pw' }, 'WLAN-Passwort'), h('div', { class: 'row' }, pwIn = h('input', { id: 'pw', type: 'password', autocomplete: 'off', value: d.wifi?.password ?? '', maxlength: 64, oninput: (e) => { d.wifi = { ...(d.wifi ?? {}), password: e.target.value }; } }),
          h('button', { class: 'eye', type: 'button', 'aria-label': 'Passwort anzeigen oder verbergen', onclick: () => { showPw = !showPw; pwIn.type = showPw ? 'text' : 'password'; } }, '👁'))],
      msg ? err(msg) : null,
      btn('WLAN prüfen und weiter', () => { d.wifi = { ...d.wifi, hidden, enterprise: ent ? { user: d.eu, password: d.ep } : undefined }; if (!d.wifi?.ssid) return wifiView('Bitte wähle ein WLAN aus.'); testWifi(); }));
  }

  async function testWifi() {
    view(1, 'WLAN wird geprüft …', h('div', { class: 'spin', role: 'status' }), h('p', {}, 'Das dauert etwa 30 Sekunden. Dein Handy verliert dabei kurz die Verbindung zum Einrichtungs-WLAN. Das ist normal – es verbindet sich gleich von selbst wieder. Bitte warte.'));
    const r = await api('/wifi', d.wifi); if (!r.ok) return wifiView(r.error ?? 'Das hat nicht geklappt.');
    let tries = 0;
    for (;;) { // Seite bleibt offen, solange das Handy neu verbindet
      await new Promise((res) => setTimeout(res, 2500)); let s; try { s = await api('/result'); } catch { continue; }
      if (s.status === 401) return pinView('Die Verbindung wurde neu gestartet. Bitte gib die PIN noch einmal ein.');
      if (s.state === 'wifi-ok') { info = await api('/info'); if (info.wifiOnly) return finishWifiOnly(); if (s.hub?.host && !d.hubAddress) { d.hubAddress = s.hub.host; if (!d.role) d.role = 'player'; } return roleView(); }
      if (s.state === 'wifi-failed') return wifiView(s.error);
      if (++tries > 60) return wifiView('Das Prüfen dauert zu lange. Bitte versuche es noch einmal.');
    }
  }

  async function finishWifiOnly() {
    view(4, 'WLAN wird geändert …', h('div', { class: 'spin', role: 'status' }), h('p', {}, 'Das Gerät verbindet sich jetzt mit dem neuen WLAN. Rolle und Einstellungen bleiben erhalten.'));
    await api('/finish', {}); await new Promise((r) => setTimeout(r, 12000));
    view(4, 'Fertig!', h('div', { class: 'card' }, h('p', { class: 'ok' }, '✔ Das WLAN wurde geändert.'), h('p', {}, 'Das Gerät startet neu und zeigt danach wieder seine Inhalte. Du kannst das Setup-WLAN jetzt verlassen.')));
  }

  function roleView() {
    const opt = (role, title, text) => h('button', { class: 'opt', type: 'button', 'aria-pressed': d.role === role, onclick: () => { d.role = role; roleView(); } }, h('span', {}, h('b', {}, title), h('br'), text));
    view(2, 'Was ist dieses Gerät?', info.hubFound ? h('div', { class: 'card' }, '✅ Im WLAN wurde schon ein Hub gefunden. Dieses Gerät ist wahrscheinlich ein Bildschirm.') : null,
      opt('hub', 'Hauptbildschirm-Rechner (Hub)', 'Speichert alle Bilder und Termine. Du bedienst ihn später im Browser. Es gibt nur einen pro Museum.'),
      opt('player', 'Bildschirm (Player)', 'Zeigt die Inhalte an, die im Hub geplant sind.'),
      d.role === 'hub' && info.hubWarning ? h('div', { class: 'card' }, '⚠️ ' + info.hubWarning) : null,
      btn('Weiter', async () => { if (!d.role) return; await api('/role', { role: d.role }); detailsView(); }), btn('Zurück', wifiView, 'sec'));
  }

  function detailsView(errs) {
    const e = errs?.length ? h('div', { role: 'alert' }, errs.map((x) => err(x))) : null;
    if (d.role === 'hub') view(3, 'Admin-Konto anlegen', h('p', {}, 'Mit diesem Konto meldest du dich am Hub an.'),
      ...field('Dein Name', 'an', { value: d.admin.name, set: (v) => { d.admin.name = v; } }), h('label', { for: 'ap' }, 'Passwort (mindestens 12 Zeichen)'), h('input', { id: 'ap', type: 'password', autocomplete: 'new-password', maxlength: 200, oninput: (x) => { d.admin.password = x.target.value; } }),
      ...field('Name des Museums oder Standorts', 'site', { value: d.site, set: (v) => { d.site = v; } }), e, btn('Weiter', finish), btn('Zurück', roleView, 'sec'));
    else view(3, 'Bildschirm einrichten', ...field('Name des Bildschirms, z. B. „Shop-Screen“', 'nm', { value: d.name || info.defaultName, set: (v) => { d.name = v; } }),
      ...field('Adresse des Hubs', 'ha', { value: d.hubAddress, hint: 'Steht im Hub unter „Neuen Bildschirm verbinden“. Meist: dfm-signage.local', set: (v) => { d.hubAddress = v; } }),
      ...field('Einrichtungscode vom Hub', 'pc', { value: d.pairCode, caps: 'characters', max: 9, hint: 'Besteht aus 8 Zeichen, z. B. K7M4-X9RD.', set: (v) => { d.pairCode = v; } }),
      d.fingerprint ? h('p', { class: 'ok' }, '✔ Fingerabdruck des Hubs wurde aus der Startkarte übernommen.') : null, e, btn('Weiter', finish), btn('Zurück', roleView, 'sec'));
    if (!d.name) d.name = info.defaultName;
  }

  async function finish() {
    const r = await api('/finish', { role: d.role, name: d.name, hubAddress: d.hubAddress, pairCode: d.pairCode, fingerprint: d.fingerprint, admin: d.admin, site: d.site });
    if (!r.ok) return detailsView(r.errors ?? [r.error ?? 'Das hat nicht geklappt.']);
    view(4, 'Fast fertig …', h('div', { class: 'spin', role: 'status' }), h('p', {}, 'Das Gerät verbindet sich jetzt dauerhaft mit dem WLAN.'));
    for (;;) { await new Promise((res) => setTimeout(res, 2500)); let s; try { s = await api('/result'); } catch { s = null; } // Hotspot geht aus – Fehler sind hier normal
      if (s?.state === 'failed') return detailsView([s.error]);
      if (s?.state === 'done') break; if (!s && (await Promise.race([new Promise((r) => setTimeout(() => r(true), 12000))]))) break; }
    done();
  }
  function done() {
    view(4, 'Fertig!', h('div', { class: 'card' }, h('p', { class: 'ok' }, '✔ Die Einrichtung ist abgeschlossen.'), h('p', {}, 'Der Bildschirm startet jetzt neu und verbindet sich mit dem WLAN. Du kannst das Setup-WLAN jetzt verlassen.')),
      d.role === 'hub' ? h('div', { class: 'card' }, h('p', {}, 'Später erreichst du den Hub im Browser unter ', h('b', {}, 'https://dfm-signage.local')), h('p', { class: 'hint' }, 'Dein Browser zeigt eine Warnung. Das ist normal – der Assistent erklärt dir, wie du sie sicher bestätigst. Den Fingerabdruck zum Vergleichen siehst du auf dem Bildschirm des Hubs.')) : h('p', {}, 'Bestätige den Bildschirm jetzt im Hub: „Ist das dein Bildschirm?“ → Ja.'));
  }
  pinView();
})();
