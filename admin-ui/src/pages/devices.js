import { h, dialog, confirmDlg, toast, field, statusEl, empty, fmtDate, help } from '../ui.js';
import { get, post, put, patch, del, api, state, can } from '../api.js';
import { shot } from './home.js';
import { commissioning } from './betrieb.js';

/** „Neuen Bildschirm verbinden“: Einmalcode + Fingerabdruck + Startkarte */
export async function pairDialog(after) {
  const ssid = h('input', { placeholder: 'WLAN-Name (optional für die Startkarte)' }), pw = h('input', { type: 'password', placeholder: 'WLAN-Passwort (optional)' });
  const body = h('div', {}, h('p', {}, 'Schalte den neuen Bildschirm ein und folge dort den Anweisungen. Gib dann diesen Code ein – oder scanne die Startkarte.'), h('div', { id: 'pairbox' }, h('p', {}, 'Wird erstellt …')),
    h('details', { style: 'margin-top:12px' }, h('summary', {}, 'Startkarte mit WLAN-Zugangsdaten (spart das Abtippen)'), h('p', { class: 'hint' }, 'Der QR-Code enthält das WLAN-Passwort. Bewahre die gedruckte Karte sicher auf und vernichte sie nach der Einrichtung.'), field('WLAN-Name', ssid), field('WLAN-Passwort', pw),
      h('button', { class: 'btn sec', type: 'button', onclick: () => make() }, 'Startkarte erstellen')));
  const d = dialog('Neuen Bildschirm verbinden', body, [{ text: 'Startkarte drucken', cls: 'sec', fn: () => { window.print(); return false; } }, { text: 'Fertig', fn: () => after?.() }]);
  async function make() {
    try {
      const r = await post('/pairing', ssid.value ? { wifi: { ssid: ssid.value, password: pw.value } } : {});
      const svg = await api('POST', '/qr', { text: r.card }, { raw: true }).then((x) => x.text());
      const qr = h('div', { style: 'width:220px;background:#fff;padding:8px;border-radius:8px' }); qr.innerHTML = svg; // SVG vom eigenen Hub (qrcode), kein Nutzertext
      document.getElementById('pairbox').replaceChildren(h('p', {}, 'Einrichtungscode:'), h('p', { class: 'fp', style: 'font-size:2rem;font-weight:800' }, r.code), h('p', { class: 'hint' }, 'Gültig für 10 Minuten. Er kann nur einmal benutzt werden.'),
        h('p', {}, 'Fingerabdruck dieses Hubs (Vergleiche ihn mit der Anzeige am Bildschirm):'), h('p', { class: 'fp' }, r.fingerprint), h('p', { class: 'hint' }, 'Hub-Adresse: ', r.hub.host), qr,
        h('p', { class: 'hint' }, 'Startkarte: erst das Handy mit dem Setup-WLAN des neuen Bildschirms verbinden, dann diesen Code scannen. Alles wird automatisch ausgefüllt.'));
    } catch (e) { toast(e.message, 'err'); }
  }
  make(); return d;
}

const ROLES = { lite: 'Lite (einfach)', standard: 'Standard', pro: 'Pro (leistungsstark)' };
export async function devicesPage({ route }) {
  const [devices, groups] = await Promise.all([get('/devices'), get('/groups')]);
  const rows = devices.map((d) => h('article', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, d.name), h('span', { class: 'sp' }), statusEl(d.status)), h('p', {}, d.summary),
    d.status.level === 'pending' ? h('div', { class: 'notice' }, h('b', {}, 'Ist das dein Bildschirm? '), `Modell: ${d.model ?? 'unbekannt'}, Name: ${d.name}`, h('div', { class: 'row', style: 'margin-top:8px' },
      h('select', { class: 'inline', id: 'rep-' + d.id, 'aria-label': 'Ersetzt welchen Bildschirm?' }, h('option', { value: '' }, 'Neuer Bildschirm'), devices.filter((x) => x.status.level !== 'pending' && x.status.label !== 'Gesperrt').map((x) => h('option', { value: x.id }, `Ersetzt: ${x.name}`))),
      h('button', { class: 'btn', onclick: async () => { try { const rep = document.getElementById('rep-' + d.id).value; await post(`/devices/${d.id}/approve`, rep ? { replaces: rep } : {}); toast(rep ? 'Der neue Bildschirm hat alles vom alten übernommen.' : 'Der Bildschirm ist jetzt verbunden. Als Nächstes folgt die Prüfung.'); if (rep) route(); else commissioning(d.id, d.name, route); } catch (e) { toast(e.message, 'err'); } } }, 'Ja, das ist mein Bildschirm'),
      h('button', { class: 'btn sec', onclick: async () => { if (await confirmDlg('Bildschirm ablehnen?', 'Der Bildschirm wird entfernt. Er kann sich mit einem neuen Code erneut verbinden.', 'Ablehnen')) { await del(`/devices/${d.id}`); route(); } } }, 'Nein, ablehnen'))) : [
      h('div', { class: 'grid' }, shot(d), h('div', {}, h('p', {}, h('b', {}, 'Gruppe: '), d.groupName ?? 'keine'), h('p', {}, h('b', {}, 'Gerät: '), d.model ?? 'unbekannt'),
        d.state ? h('p', { class: 'hint' }, `Temperatur ${d.state.cpuTemp ?? '–'} °C · Speicher ${d.state.ramUsedMB ?? '–'}/${d.state.ramTotalMB ?? '–'} MB · WLAN-Signal ${d.state.signalDbm ?? '–'} dBm · Medien ${d.state.syncState?.done ?? 0}/${d.state.syncState?.total ?? 0}`) : null)),
      can('devices.manage') ? h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sec', onclick: () => editDlg(d, groups, route) }, 'Bearbeiten'), cmdMenu(d, route)) : null]));
  return h('div', {}, h('h1', {}, 'Bildschirme'), h('p', { class: 'lead' }, 'Hier verwaltest du alle Bildschirme im Museum.'),
    can('devices.manage') ? h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn big', onclick: () => pairDialog(route) }, '➕ Neuen Bildschirm verbinden'), h('button', { class: 'btn sec', onclick: () => groupDlg(route) }, 'Gruppe anlegen'), h('button', { class: 'btn sec', onclick: () => replaceInfo(route) }, 'Bildschirm ersetzen'), h('a', { class: 'btn sec', href: '/api/v1/devices.csv' }, 'Liste als Excel/CSV'), h('button', { class: 'btn sec', onclick: () => hubInfo() }, 'Hub-Adresse & Fingerabdruck')) : null,
    rows.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(340px,1fr))' }, rows) : empty('Noch kein Bildschirm verbunden', 'Klicke oben auf „Neuen Bildschirm verbinden“.'));
}
function cmdMenu(d, route) {
  const run = async (command, args, text) => { try { await post(`/devices/${d.id}/commands`, { command, args }); toast(text); } catch (e) { toast(e.message, 'err'); } };
  const sel = h('select', { class: 'inline', 'aria-label': 'Befehle', onchange: async (e) => {
    const v = e.target.value; e.target.value = '';
    if (v === 'reload') run('reload', {}, 'Der Bildschirm lädt neu.');
    if (v === 'screenshot') { run('screenshot', {}, 'Vorschau wird aktualisiert.'); setTimeout(route, 2500); }
    if (v === 'reconnect') run('reconnect', {}, 'Der Bildschirm verbindet sich neu.');
    if (v === 'reboot' && await confirmDlg('Bildschirm neu starten?', 'Der Bildschirm ist für etwa eine Minute schwarz.', 'Neu starten')) run('reboot', {}, 'Der Bildschirm startet neu.');
    if (v.startsWith('rot')) rotateConfirm(d, Number(v.slice(3)), run);
    if (v === 'identify') run('identify', { location: d.location ?? '', number: d.id.slice(0, 4).toUpperCase() }, 'Der Bildschirm zeigt 10 Sekunden lang seinen Namen.');
    if (v === 'test') run('testpattern', { on: true }, 'Das Testbild läuft 2 Minuten.');
    if (v === 'copy') copyDlg(d, route);
    if (v === 'wifi') wifiDlg(d, run);
    if (v === 'diag') diagDlg(d);
    if (v === 'update' && await confirmDlg('Update einspielen?', 'Der Bildschirm lädt das Update vom Hub und startet neu.', 'Update einspielen', false)) run('update', {}, 'Das Update wird eingespielt.');
    if (v === 'block' && await confirmDlg('Bildschirm sperren?', 'Der Bildschirm verliert sofort die Verbindung zum Hub und zeigt nur noch gespeicherte Inhalte. Du kannst ihn später neu verbinden.', 'Sperren')) { await post(`/devices/${d.id}/block`); route(); }
    if (v === 'remove' && await confirmDlg('Bildschirm entfernen?', `„${d.name}“ wird aus dem Hub entfernt. Seine Termine bleiben nicht erhalten.`, 'Entfernen')) { await del(`/devices/${d.id}`); route(); }
    if (v === 'reset' && await confirmDlg('Auf Werkseinstellungen zurücksetzen?', 'Alle Daten und die WLAN-Verbindung dieses Bildschirms werden gelöscht. Danach muss er neu eingerichtet werden.', 'Zurücksetzen')) run('factory_reset', {}, 'Der Bildschirm wird zurückgesetzt.');
  } }, h('option', { value: '' }, 'Weitere Aktionen …'), h('option', { value: 'reload' }, 'Neu laden'), h('option', { value: 'screenshot' }, 'Vorschau aktualisieren'), h('option', { value: 'identify' }, 'Diesen Bildschirm erkennen'), h('option', { value: 'test' }, 'Testbild anzeigen'), h('option', { value: 'copy' }, 'Einstellungen auf andere kopieren …'), h('option', { value: 'reconnect' }, 'Mit dem Hub neu verbinden'),
    h('option', { value: 'rot0' }, 'Ausrichtung: normal'), h('option', { value: 'rot90' }, 'Ausrichtung: 90° gedreht'), h('option', { value: 'rot180' }, 'Ausrichtung: 180°'), h('option', { value: 'rot270' }, 'Ausrichtung: 270°'),
    h('option', { value: 'wifi' }, 'WLAN ändern …'), h('option', { value: 'diag' }, 'Diagnose …'), h('option', { value: 'update' }, 'Update einspielen'), h('option', { value: 'reboot' }, 'Neu starten'), h('option', { value: 'block' }, 'Sperren'), h('option', { value: 'remove' }, 'Entfernen'), h('option', { value: 'reset' }, 'Auf Werkseinstellungen zurücksetzen'));
  return sel;
}
function wifiDlg(d, run) {
  const s = h('input', { maxlength: 32 }), p = h('input', { type: 'password', maxlength: 64 });
  dialog(`WLAN von „${d.name}“ ändern`, h('div', {}, h('p', {}, 'Der Bildschirm verbindet sich mit dem neuen WLAN. Klappt das nicht, startet nach 10 Minuten der Einrichtungsmodus.'), field('Neuer WLAN-Name', s), field('Passwort', p)),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'WLAN ändern', fn: () => { if (!s.value || p.value.length < 8) { toast('Bitte gib Name und ein Passwort mit mindestens 8 Zeichen ein.', 'err'); return false; } run('wifi_change', { ssid: s.value, password: p.value }, 'Der Bildschirm wechselt das WLAN.'); } }]);
}
function editDlg(d, groups, route) {
  const name = h('input', { value: d.name, maxlength: 60 }), grp = h('select', {}, h('option', { value: '' }, 'keine Gruppe'), groups.map((g) => h('option', { value: g.id, selected: g.id === d.groupId }, g.name)));
  const prof = h('select', {}, Object.entries(ROLES).map(([k, v]) => h('option', { value: k, selected: k === d.profile }, v)));
  const off = h('input', { type: 'checkbox', checked: !!d.display?.off }), from = h('input', { type: 'time', class: 'inline', value: d.display?.off?.from ?? '22:00', 'aria-label': 'Aus ab' }), to = h('input', { type: 'time', class: 'inline', value: d.display?.off?.to ?? '07:00', 'aria-label': 'An ab' });
  const dlg0 = dialog('Bildschirm bearbeiten', h('div', {}, field('Name', name), field('Gruppe', grp, 'Bildschirme in einer Gruppe können gemeinsam geplant werden.'),
    h('div', { class: 'card' }, h('label', {}, off, ' Bildschirm automatisch ausschalten'), h('p', {}, 'von ', from, ' bis ', to, ' Uhr'), h('p', { class: 'hint' }, 'Wenn sich der Bildschirm nicht abschalten lässt (kein HDMI-CEC), zeigt er in dieser Zeit stattdessen ein schwarzes Bild.'), d.state?.displayPower === 'nicht möglich' ? h('p', { class: 'bad' }, '⚠ Dieser Bildschirm lässt sich nicht abschalten – er zeigt ein schwarzes Bild.') : null),
    h('details', {}, h('summary', {}, 'Wiedergabe (für Video-Bildschirme)'), playbackBox(d)),
    h('details', {}, h('summary', {}, 'Hochkant und Seitenverhältnis'), h('div', { id: 'fitbox' }, h('p', { class: 'hint' }, 'Wird geladen …'))),
    h('details', {}, h('summary', {}, 'Erweitert'), field('Leistungsprofil', prof, 'Wird automatisch passend zum Gerät gewählt. Ändere es nur, wenn du genau weißt, warum.'), h('p', { class: 'hint' }, `Fingerabdruck des Hubs, den dieser Bildschirm kennt: ${d.spki ?? '–'}`))),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { await patch(`/devices/${d.id}`, { name: name.value, groupId: grp.value || null, profile: prof.value, display: off.checked ? { off: { from: from.value, to: to.value } } : null }); toast('Gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
  fitSection(d, dlg0.querySelector('#fitbox')).catch(() => {});
}
async function fitSection(d, root) {
  const c = await get(`/devices/${d.id}/fit-check`), fit = h('select', { 'aria-label': 'Darstellung' }, h('option', { value: 'contain', selected: c.fit === 'contain' }, 'Einpassen (ganzes Bild, evtl. schwarze Ränder)'), h('option', { value: 'cover', selected: c.fit === 'cover' }, 'Füllen (Bild füllt alles, Rand wird abgeschnitten)')), safe = h('input', { type: 'number', min: 0, max: 10, value: c.safe, 'aria-label': 'Sicherheitsrand in Prozent' });
  const warn = h('div', {}), prev = h('div', {}); const media = await get('/media'); const imgs = media.filter((m) => m.kind === 'image').slice(0, 6);
  const draw = () => { warn.replaceChildren(c.text ? h('p', { class: 'notice' }, c.text) : null, ...c.warnings.slice(0, 5).map((w) => h('p', { class: 'hint warnline' }, `▲ „${w.name}“: ${w.text}`)));
    prev.replaceChildren(h('p', { class: 'hint' }, c.portrait ? 'So sieht es auf Hochkant aus:' : 'Vorschau:'), h('div', { class: 'row' }, imgs.map((m) => h('img', { alt: `Vorschau ${m.name}`, style: 'height:140px;border:1px solid #888', src: `/api/v1/media/${m.id}/preview?deviceId=${d.id}&fit=${fit.value}&safe=${safe.value || 0}` })))); };
  fit.onchange = safe.onchange = draw; draw();
  root.replaceChildren(h('p', {}, h('b', {}, c.portrait ? 'Dieser Bildschirm steht hochkant.' : 'Dieser Bildschirm steht quer.')), field('Darstellung', fit), field('Sicherheitsrand gegen abgeschnittene Ränder (Overscan), Prozent', safe, 'Hält Inhalte vom Rand fern, wenn der Fernseher den Rand beschneidet.'), warn, prev,
    h('button', { class: 'btn', type: 'button', onclick: async () => { try { await put(`/devices/${d.id}/fit`, { fit: fit.value, safe: Number(safe.value) || 0 }); toast('Darstellung gespeichert.'); const n = await get(`/devices/${d.id}/fit-check`); c.warnings = n.warnings; c.text = n.text; draw(); } catch (e) { toast(e.message, 'err'); } } }, 'Darstellung speichern'));
}
function groupDlg(route) {
  const n = h('input', { maxlength: 60 }), l = h('input', { maxlength: 100 }), c = h('input', { type: 'color', value: '#c8102e' });
  dialog('Gruppe anlegen', h('div', {}, field('Name der Gruppe, z. B. „Foyer“', n), field('Ort (optional)', l), field('Farbe im Kalender', c)), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Anlegen', fn: async () => { try { await post('/groups', { name: n.value, location: l.value, color: c.value }); toast('Gruppe angelegt.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
async function hubInfo() {
  const i = await get('/system/hub');
  dialog('Hub-Adresse und Fingerabdruck', h('div', {}, h('p', {}, 'Adresse im Browser: ', h('b', {}, `https://${i.host}`)), h('p', {}, 'Fingerabdruck:'), h('p', { class: 'fp' }, i.fingerprint),
    h('h3', {}, 'Für die IT'), h('p', { class: 'hint' }, i.tip), h('ul', {}, i.addresses.map((a) => h('li', {}, `${a.ip} · MAC-Adresse ${a.mac}`))),
    h('a', { class: 'btn sec', href: '/api/v1/system/certificate' }, 'Zertifikat für die IT herunterladen')), [{ text: 'Schließen' }]);
}

/** Diagnose eines Bildschirms: Zustand, WLAN-Qualität, Durchsatz, Testvideo im eigenen Profil */
function diagDlg(d) {
  const out = h('div', {}, h('p', {}, 'Der Bildschirm misst jetzt Speicher, Temperatur, WLAN und Geschwindigkeit. Das dauert etwa eine halbe Minute.'));
  const tv = h('input', { type: 'checkbox' }); const start = h('button', { class: 'btn', type: 'button', onclick: async () => {
    start.disabled = true; out.replaceChildren(h('p', {}, '⏳ Wird gemessen …'));
    try { const { id } = await post(`/devices/${d.id}/commands`, { command: 'diagnose', args: { testvideo: tv.checked } });
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); const c = (await get(`/devices/${d.id}/commands`)).find((x) => x.id === id); if (c && c.status !== 'queued' && c.status !== 'sent') {
        if (c.status === 'failed') throw new Error('Die Messung ist fehlgeschlagen.'); const r = JSON.parse(c.result_json); const rows = [['Prozessor-Temperatur', r.cpuTemp != null ? `${r.cpuTemp} °C` : '–'], ['Arbeitsspeicher', `${r.ramUsedMB ?? '–'} von ${r.ramTotalMB ?? '–'} MB`], ['WLAN-Signal', r.signalDbm != null ? `${r.signalDbm} dBm (${r.signalDbm > -60 ? 'sehr gut' : r.signalDbm > -70 ? 'gut' : 'schwach'})` : '–'], ['WLAN-Energiesparen', r.powerSave === 'off' ? '✔ aus (richtig)' : `⚠ ${r.powerSave ?? 'unbekannt'}`], ['Geschwindigkeit vom Hub', r.throughputMBs != null ? `${r.throughputMBs} MB/s` : '–'], ['Zeit synchron', r.timeSynced ? '✔ ja' : '⚠ nein'], ...(r.testvideo ? [['Testvideo', r.testvideo.error ?? `${r.testvideo.percent ?? '–'} % Bilder ausgelassen (${r.testvideo.dropped}/${r.testvideo.frames})`]] : [])];
        return out.replaceChildren(h('table', {}, h('tbody', {}, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))))); } }
      throw new Error('Der Bildschirm hat nicht geantwortet.'); } catch (e) { out.replaceChildren(h('p', { class: 'bad' }, e.message)); start.disabled = false; } } }, 'Messung starten');
  dialog(`Diagnose: ${d.name}`, h('div', {}, out, h('label', {}, tv, ' Testvideo für dieses Gerät abspielen (zeigt, ob Videos flüssig laufen)')), [{ text: 'Schließen', cls: 'sec' }, { text: 'Messung starten', fn: () => { start.click(); return false; } }]);
}

/** Fern-Einstellung mit Rückfall (A5/Z.8): ohne Bestätigung binnen 60 s stellt der Bildschirm die alte Einstellung wieder her */
async function rotateConfirm(d, degrees, run) {
  try { await post(`/devices/${d.id}/commands`, { command: 'rotate', args: { degrees, rollback: true, seconds: 60 } }); } catch (e) { return toast(e.message, 'err'); }
  let left = 60; const t = h('b', {}, '60'); const iv = setInterval(() => { left--; t.textContent = String(left); if (left <= 0) { clearInterval(iv); dlg.close(); toast('Keine Bestätigung – der Bildschirm hat die alte Ausrichtung wiederhergestellt.', 'err'); } }, 1000);
  const dlg = dialog('Passt die Ausrichtung?', h('p', {}, 'Schau auf den Bildschirm. Wenn alles richtig aussieht, bestätige. Sonst wird die alte Ausrichtung in ', t, ' Sekunden automatisch wiederhergestellt.'),
    [{ text: 'Nein, zurücksetzen', cls: 'sec', fn: () => { clearInterval(iv); toast('Wird zurückgesetzt …'); } }, { text: 'Ja, passt', fn: async () => { clearInterval(iv); await post(`/devices/${d.id}/commands`, { command: 'confirm_display', args: { degrees } }); toast('Gespeichert.'); } }]);
}
function copyDlg(d, route) {
  get('/devices').then((all) => { const sel = all.filter((x) => x.id !== d.id && x.status.level !== 'pending').map((x) => ({ x, c: h('input', { type: 'checkbox' }) }));
    dialog(`Einstellungen von „${d.name}“ kopieren`, h('div', {}, h('p', {}, 'Kopiert Ausrichtung, automatisches Ausschalten und Layout auf diese Bildschirme:'), sel.map(({ x, c }) => h('label', { style: 'display:flex;gap:8px;min-height:44px;align-items:center' }, c, x.name))),
      [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Kopieren', fn: async () => { const to = sel.filter((s) => s.c.checked).map((s) => s.x.id); if (!to.length) { toast('Bitte wähle mindestens einen Bildschirm.', 'err'); return false; } const r = await post(`/devices/${d.id}/copy-settings`, { to }); toast(`${r.copied} Bildschirm(e) aktualisiert.`); route(); } }]); });
}
function replaceInfo(route) {
  dialog('Bildschirm ersetzen', h('div', {}, h('ol', {}, h('li', {}, 'Baue den neuen Raspberry Pi auf und schalte ihn ein.'), h('li', {}, 'Klicke hier auf „Weiter“ und verbinde ihn wie gewohnt mit dem Code oder der Startkarte.'), h('li', {}, 'Bestätige den neuen Bildschirm in der Liste und wähle dabei, welchen alten Bildschirm er ersetzt. Name, Gruppe, Termine und Einstellungen wandern automatisch zum neuen Gerät. Der alte wird gesperrt.'))),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Weiter', fn: () => { pairDialog(route); } }]);
}

/** Wiedergabe-Art: Browser (Texte, Laufband, Zonen) oder Video-optimiert (mpv: Videos direkt über den Hardware-Decoder, am flüssigsten) */
function playbackBox(d) {
  const sel = h('select', { 'aria-label': 'Wiedergabe-Art', disabled: d.profile === 'lite' }, [['auto', 'Automatisch (empfohlen)'], ['mpv', 'Video-optimiert – am flüssigsten, ohne Laufband/Zonen'], ['browser', 'Browser – mit Laufband, Uhr und Zonen']].map(([k, t]) => h('option', { value: k, selected: k === (d.renderer ?? 'auto') }, t)));
  return h('div', {}, h('p', { class: 'hint' }, d.profile === 'lite' ? 'Dieses Gerät nutzt immer die Video-optimierte Wiedergabe.' : 'Für einen Bildschirm, der hauptsächlich Videos zeigt, ist „Video-optimiert“ am flüssigsten: Videos laufen direkt über den Video-Chip des Raspberry Pi. Texte werden dort als Bild gezeigt; Laufband und Zonen gibt es dann nicht.'),
    field('Wiedergabe', sel), d.profile === 'lite' ? null : h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await put(`/devices/${d.id}/playback`, { renderer: sel.value }); toast(r.text); } catch (e) { toast(e.message, 'err'); } } }, 'Wiedergabe speichern'));
}
