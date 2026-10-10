import { h, dialog, confirmDlg, toast, field, fmtDate, fmtBytes, help } from '../ui.js';
import { get, post, put, del, patch, api, state } from '../api.js';
import { usbUpdateBox } from './usbupdate.js';
import { alertSection } from './meldung.js';

export async function usersPage({ route }) {
  const users = await get('/users'); const R = { admin: 'Admin (alles)', editor: 'Redakteur (Inhalte & Termine)', anzeige: 'Anzeige (nur Live-Ansicht)' };
  return h('div', {}, h('h1', {}, 'Benutzer'), h('p', { class: 'lead' }, 'Wer darf sich am Hub anmelden – und was darf die Person tun?'),
    h('p', {}, h('button', { class: 'btn big', onclick: () => addUser(route) }, '➕ Neue Person')), h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Rolle', 'Zusätzliche Sicherheit', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, users.map((u) => h('tr', {}, h('td', {}, h('span', { class: 'uname' }, h('span', { class: 'avatar sm', 'aria-hidden': 'true' }, (u.name.trim()[0] ?? '?').toUpperCase()), u.name)), h('td', {}, h('span', { class: 'metachip role-' + u.role }, R[u.role]), u.groups ? h('div', { class: 'hint' }, `nur ${u.groups.length} Gruppe(n)`) : null), h('td', {}, u.totp ? '✔ Code aus App aktiv' : '–'), h('td', {}, h('button', { class: 'btn link', onclick: () => roleDlg(u, R, route) }, 'Rolle ändern'), h('button', { class: 'btn link', onclick: () => resetDlg(u, route) }, 'Passwort zurücksetzen'), u.id === state.user.id ? h('span', { class: 'hint' }, ' (Das bist du)') : h('button', { class: 'btn link', style: 'color:var(--dfm-bad)', onclick: async () => { if (await confirmDlg('Person löschen?', `„${u.name}“ kann sich danach nicht mehr anmelden.`, 'Löschen')) { try { await del(`/users/${u.id}`); route(); } catch (e) { toast(e.message, 'err'); } } } }, 'Löschen')))))),
    h('h2', {}, 'Wandmodus (Monitor im Technikraum)'), await wallSection(route),
    h('h2', {}, 'Mein Konto'), h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: pwDlg }, 'Passwort ändern'), h('button', { class: 'btn sec', onclick: totpDlg }, 'Zusätzliche Sicherheit (Code aus App)')));
}
function addUser(route) {
  const n = h('input', { maxlength: 60 }), p = h('input', { type: 'password', autocomplete: 'new-password' }), r = h('select', {}, [['editor', 'Redakteur (Inhalte & Termine)'], ['anzeige', 'Anzeige (nur Live-Ansicht)'], ['admin', 'Admin (alles)']].map(([k, t]) => h('option', { value: k }, t)));
  dialog('Neue Person', h('div', {}, field('Name', n), field('Passwort (mindestens 12 Zeichen)', p, 'Die Person kann es später selbst ändern.'), field('Rolle', r, 'Redakteure dürfen Inhalte und Termine bearbeiten, aber keine Geräte verwalten oder Einstellungen ändern.')), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Anlegen', fn: async () => { try { await post('/users', { name: n.value, password: p.value, role: r.value }); toast('Die Person wurde angelegt.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
function pwDlg() {
  const o = h('input', { type: 'password' }), n = h('input', { type: 'password', autocomplete: 'new-password' });
  dialog('Passwort ändern', h('div', {}, field('Altes Passwort', o), field('Neues Passwort (mindestens 12 Zeichen)', n)), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Ändern', fn: async () => { try { await post('/auth/password', { old: o.value, new: n.value }); toast('Dein Passwort wurde geändert.'); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
async function totpDlg() {
  const r = await post('/auth/totp/start'); const c = h('input', { inputmode: 'numeric', maxlength: 6 });
  dialog('Zusätzliche Sicherheit einrichten', h('div', {}, h('p', {}, 'Öffne eine Authenticator-App (z. B. auf dem Handy) und füge ein neues Konto mit diesem Schlüssel hinzu:'), h('p', { class: 'fp' }, r.secret), field('Gib den 6-stelligen Code aus der App ein', c)),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Bestätigen', fn: async () => { try { const x = await post('/auth/totp/enable', { code: c.value }); dialog('Wiederherstellungscodes', h('div', {}, h('p', {}, 'Schreibe diese Codes auf und bewahre sie sicher auf. Jeder Code funktioniert einmal, falls du dein Handy verlierst.'), h('p', { class: 'fp' }, x.recoveryCodes.join('  '))), [{ text: 'Ich habe sie gespeichert' }]); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

export async function auditPage() {
  let only = false; const box = h('div', {});
  const draw = async () => { const rows = await get('/audit?limit=200' + (only ? '&security=1' : '')); box.replaceChildren(rows.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Wann', 'Wer', 'Was', 'Von wo'].map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.ts)), h('td', {}, r.user ?? '–'), h('td', {}, (r.security ? '🛡 ' : '') + r.action + (r.target ? ` · ${r.target}` : '')), h('td', {}, r.ip ?? '–'))))) : h('p', {}, 'Noch keine Einträge.')); };
  const v = await get('/system/audit-verify');
  const page = h('div', {}, h('h1', {}, 'Protokoll'), h('p', { class: 'lead' }, 'Hier steht, wer wann was getan hat. Einträge können nicht verändert werden.'),
    h('div', { class: 'notice ' + (v.ok ? 'ok' : 'bad') }, v.ok ? '✔ Das Protokoll ist vollständig und unverändert.' : '⚠ Das Protokoll wurde verändert (ab Eintrag ' + v.brokenAt + ').'),
    h('div', { class: 'row', style: 'margin:10px 0' }, h('label', { style: 'margin:0' }, h('input', { type: 'checkbox', onchange: (e) => { only = e.target.checked; draw(); } }), ' Nur Sicherheitsereignisse'), h('span', { class: 'sp' }), h('a', { class: 'btn sec', href: '/api/v1/audit.csv' }, 'Als CSV herunterladen')), box);
  await draw(); return page;
}

export async function settingsPage({ route }) {
  const [s, storage, diag, backup, devices] = await Promise.all([get('/settings'), get('/system/storage'), get('/system/diagnose'), get('/backup/status'), get('/devices')]);
  const sw = (key, label, helpText) => h('label', { style: 'display:flex;gap:10px;align-items:center;min-height:44px' }, h('input', { type: 'checkbox', checked: s[key] === 'true', onchange: async (e) => { await put('/settings', { [key]: String(e.target.checked) }); toast('Gespeichert.'); } }), label, helpText ? help(helpText) : null);
  const site = h('input', { value: s['site.name'], maxlength: 100 }), win = h('input', { value: s['sync.window'], placeholder: 'z. B. 22:00-06:00', maxlength: 11 }), bw = h('input', { type: 'number', min: 0, value: s['sync.bandwidthKbps'] });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Passphrase (mind. 12 Zeichen)' });
  return h('div', {}, h('h1', {}, 'Erweitert'), h('p', { class: 'lead' }, 'Technische Einstellungen. Im Normalfall musst du hier nichts ändern.'),
    h('section', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Allgemein'), field('Name des Museums / Standorts', site), h('button', { class: 'btn', onclick: async () => { await put('/settings', { 'site.name': site.value }); toast('Gespeichert.'); } }, 'Speichern')),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Inhalte aus dem Netz (standardmäßig aus)'), h('p', { class: 'hint' }, 'Diese Funktionen brauchen ein Internetfenster und sind deshalb ausgeschaltet. Sie laufen in einem abgeschotteten Browserprofil.'),
      sw('feature.weburl', 'Webseiten anzeigen', 'Zeigt eine Webseite auf dem Bildschirm. Nur aktivieren, wenn die Seite vertrauenswürdig ist.'), sw('feature.rss', 'Nachrichten (RSS)'), sw('feature.weather', 'Wetter')),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Medien-Abgleich'), field('Nur in diesem Zeitfenster laden', win, 'Damit Videos nicht tagsüber das WLAN belasten. Leer lassen = immer.'), field('Geschwindigkeitsgrenze pro Bildschirm (kbit/s, 0 = keine)', bw),
      h('button', { class: 'btn', onclick: async () => { try { await put('/settings', { 'sync.window': win.value, 'sync.bandwidthKbps': bw.value }); toast('Gespeichert.'); } catch (e) { toast(e.message, 'err'); } } }, 'Speichern')),
    await alertSection(), opsSection(s),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Sicherung (Backup)'), h('p', {}, backup.configured ? 'Die Verschlüsselung ist eingerichtet. Der Hub sichert täglich automatisch (7 Tage und 4 Wochen werden aufbewahrt).' : 'Noch nicht eingerichtet. Wähle eine Passphrase. Sie wird nirgends gespeichert – ohne sie kann kein Backup zurückgespielt werden!'),
      backup.configured ? [h('button', { class: 'btn', onclick: async () => { const r = await api('POST', '/backup/run', {}, { raw: true }); const b = await r.blob(); const a = h('a', { href: URL.createObjectURL(b), download: 'dfm-backup.dfmbak' }); a.click(); } }, 'Backup jetzt herunterladen'), h('p', { class: 'hint' }, `Gespeicherte Backups auf dem Hub: ${backup.files.length}`)] : [pass, h('button', { class: 'btn', style: 'margin-top:8px', onclick: async () => { try { const r = await post('/backup/setup', { passphrase: pass.value }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Verschlüsselung einrichten')]),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Update einspielen'), h('p', {}, 'Wähle eine signierte Update-Datei (.dfmpkg). Updates kommen nie aus dem Internet; ohne gültige Signatur wird nichts installiert.'), await usbUpdateBox(), h('p', { class: 'hint' }, 'Tipp: Steckst du einen USB-Stick mit einer .dfmpkg-Datei am Hub ein, erscheint das Update hier und auf der Startseite.'),
      h('input', { type: 'file', accept: '.dfmpkg', 'aria-label': 'Update-Datei', onchange: async (e) => { const f = e.target.files[0]; if (!f) return; if (!(await confirmDlg('Update installieren?', 'Der Hub startet danach kurz neu. Bildschirme laden das Update anschließend auf Wunsch.', 'Installieren', false))) return; try { const r = await api('POST', '/update/upload', await f.arrayBuffer()); toast(r.text); } catch (er) { toast(er.message, 'err'); } } }),
      h('button', { class: 'btn sec', style: 'margin-top:8px', onclick: async () => { if (await confirmDlg('Zur vorherigen Version zurück?', 'Der Hub startet neu.', 'Zurückgehen')) { try { await post('/update/rollback'); toast('Der Hub geht zur vorherigen Version zurück.'); } catch (e) { toast(e.message, 'err'); } } } }, 'Zur vorherigen Version zurück'),
      h('button', { class: 'btn sec', style: 'margin-top:8px;margin-left:8px', onclick: async () => { for (const d of devices.filter((x) => x.status.level !== 'pending')) await post(`/devices/${d.id}/commands`, { command: 'update' }).catch(() => {}); toast('Alle Bildschirme laden das Update.'); } }, 'Update an alle Bildschirme verteilen')),
    await rolloutSection(devices, route),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'WLAN des Hubs'), h('p', {}, 'Wurde der Hub per Netzwerkkabel eingerichtet, kannst du hier ein WLAN nachtragen.'), wifiForm()),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Sicherheit'), h('p', {}, 'Der Fingerabdruck und das Zertifikat des Hubs stehen unter „Bildschirme → Hub-Adresse & Fingerabdruck“.'), h('a', { class: 'btn sec', href: '/api/v1/system/certificate' }, 'Zertifikat herunterladen'),
      h('p', { class: 'hint', style: 'margin-top:12px' }, 'Fernzugriff (SSH) ist in dieser Version nicht vorgesehen: Auf den Geräten gibt es bewusst keinen Benutzer und keine Anmeldung per Konsole. Alles läuft über diese Oberfläche.')),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Diagnose'), h('table', {}, h('tbody', {}, [['Arbeitsspeicher frei', `${diag.ramFreeMB} von ${diag.ramTotalMB} MB`], ['Prozessorlast (1/5/15 min)', diag.load.map((x) => x.toFixed(2)).join(' / ')], ['Temperatur', diag.tempC != null ? `${diag.tempC.toFixed(1)} °C` : 'nicht verfügbar'], ['Laufzeit', `${Math.round(diag.uptimeS / 3600)} Stunden`], ['Speicher frei', fmtBytes(storage.free)], ['Medien-Datenbank', diag.db]].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))))),
    h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Demo-Inhalte'), h('p', {}, 'Beispielinhalte entfernen, wenn du eigene Inhalte hast.'), h('button', { class: 'btn sec', onclick: async () => { const r = await post('/demo/remove'); toast(`${r.removed} Demo-Inhalte entfernt.`); } }, 'Demo-Inhalte entfernen')));
}

function wifiForm() {
  const n = h('input', { maxlength: 32 }), p = h('input', { type: 'password', autocomplete: 'off' });
  return h('div', {}, field('WLAN-Name', n), field('WLAN-Passwort', p), h('button', { class: 'btn', onclick: async () => { if (!(await confirmDlg('WLAN eintragen?', 'Der Hub verbindet sich mit diesem WLAN. Bitte lasse das Kabel zur Sicherheit zunächst eingesteckt.', 'WLAN eintragen', false))) return; try { await post('/system/wifi', { ssid: n.value, password: p.value }); toast('Das WLAN wurde eingetragen.'); } catch (e) { toast(e.message, 'err'); } } }, 'WLAN eintragen'));
}

async function roleDlg(u, R, route) {
  const groups = await get('/groups'); const gsel = groups.map((g) => ({ g, c: h('input', { type: 'checkbox', checked: !u.groups || u.groups.includes(g.id) }) }));
  const r = h('select', {}, Object.entries(R).map(([k, t]) => h('option', { value: k, selected: k === u.role }, t)));
  dialog(`Rolle von ${u.name}`, h('div', {}, field('Rolle', r, 'Der letzte Admin kann nicht herabgestuft werden, damit immer jemand den Hub verwalten kann.'), groups.length ? h('div', {}, h('b', {}, 'Sichtbare Bildschirmgruppen (Live-Ansicht)'), gsel.map(({ g, c }) => h('label', { style: 'display:flex;gap:8px;min-height:44px;align-items:center' }, c, g.name))) : null), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { const all = gsel.every(({ c }) => c.checked); await patch(`/users/${u.id}`, { role: r.value, groups: all ? null : gsel.filter(({ c }) => c.checked).map(({ g }) => g.id) }); toast('Die Rolle wurde geändert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
function resetDlg(u, route) {
  const p = h('input', { type: 'password', autocomplete: 'new-password' });
  dialog(`Passwort von ${u.name} zurücksetzen`, h('div', {}, h('p', {}, 'Die Person wird überall abgemeldet und meldet sich mit dem neuen Passwort an. Gib es ihr persönlich weiter.'), field('Neues Passwort (mindestens 12 Zeichen)', p)), [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Zurücksetzen', fn: async () => { try { await post(`/users/${u.id}/password`, { password: p.value }); toast('Das Passwort wurde zurückgesetzt.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

async function wallSection(route) {
  const t = await get('/live-tokens'); const n = h('input', { maxlength: 60, placeholder: 'z. B. Technikraum', 'aria-label': 'Name des Monitors' });
  return h('div', {}, h('p', { class: 'hint' }, 'Ein Zugangs-Token erlaubt einem Monitor ausschließlich die Live-Ansicht – ohne Anmeldung und ohne automatische Abmeldung. Öffne dort die Adresse ', h('code', {}, `${location.origin}/#/wand`), ' und gib das Token einmal ein.'),
    t.length ? h('ul', {}, t.map((x) => h('li', {}, `${x.name} `, h('button', { class: 'btn link', style: 'color:var(--dfm-bad)', onclick: async () => { await del(`/live-tokens/${x.id}`); route(); } }, 'Widerrufen')))) : null,
    h('div', { class: 'row' }, n, h('button', { class: 'btn', onclick: async () => { try { const r = await post('/live-tokens', { name: n.value }); dialog('Zugangs-Token', h('div', {}, h('p', {}, r.text), h('p', { class: 'fp' }, r.token)), [{ text: 'Ich habe es notiert', fn: () => route() }]); } catch (e) { toast(e.message, 'err'); } } }, 'Token erzeugen')));
}

/** Betrieb, Veröffentlichen, QR, Datenschutz (Aufbewahrung) */
function opsSection(s) {
  const f = (k, label, help_, attrs = {}) => { const i = h('input', { value: s[k] ?? '', ...attrs }); i.dataset.k = k; return field(label, i, help_); }; const box = h('section', { class: 'card', style: 'margin-top:14px' });
  const sw = (key, label, text) => h('label', { style: 'display:flex;gap:10px;align-items:center;min-height:44px' }, h('input', { type: 'checkbox', checked: s[key] === 'true', 'data-k': key, 'data-bool': '1' }), label, text ? help(text) : null);
  box.append(h('h2', { style: 'margin-top:0' }, 'Betrieb, Veröffentlichen und Datenschutz'),
    sw('publish.editor', 'Redakteure dürfen veröffentlichen', 'Ist das aus, können Redakteure nur Entwürfe anlegen. Ein Admin veröffentlicht.'), sw('commissioning.required', 'Neue Bildschirme erst nach der Prüfung freigeben', 'Ein neuer Bildschirm zeigt nur das Standby-Bild, bis „Bildschirm prüfen“ bestanden ist.'), sw('maintenance.nightlyReboot', 'Nächtlicher Neustart der Bildschirme'),
    f('maintenance.rebootAt', 'Uhrzeit des Neustarts', null, { type: 'time' }), f('wifi.warnDbm', 'WLAN-Warnschwelle (dBm, z. B. -72)', 'Unterhalb dieses Werts erscheint eine Warnung.', { type: 'number', min: -100, max: -30 }), f('screen.diagonalInch', 'Bildschirmgröße in Zoll (für die Lesbarkeitsprüfung)', null, { type: 'number', min: 10, max: 150 }), f('screen.distanceM', 'Typischer Betrachtungsabstand in Metern', null, { type: 'number', min: 1, max: 30 }),
    f('qr.allowedHosts', 'Erlaubte Adressen für QR-Codes von Redakteuren (z. B. dfm.de, leer = alle)', 'Admins sind nicht eingeschränkt.', { maxlength: 200 }),
    f('retention.overrideDays', 'Szenen- und Schnellaktions-Verlauf aufbewahren (Tage)', 'Danach werden Gruppennamen und Namen aus Szenen automatisch gelöscht.', { type: 'number', min: 1, max: 3650 }), f('retention.historyDays', 'WLAN- und Ausfallverlauf aufbewahren (Tage)', null, { type: 'number', min: 7, max: 3650 }), f('retention.auditDays', 'Protokoll aufbewahren (Tage, mindestens 30)', null, { type: 'number', min: 30, max: 3650 }),
    h('button', { class: 'btn', onclick: async () => { const body = {}; for (const el of box.querySelectorAll('[data-k]')) body[el.dataset.k] = el.dataset.bool ? String(el.checked) : el.value; try { await put('/settings', body); toast('Gespeichert.'); } catch (e) { toast(e.message, 'err'); } } }, 'Speichern'),
    h('button', { class: 'btn sec', style: 'margin-left:8px', onclick: async () => { const r = await post('/system/retention-run'); toast(`Datenpflege: ${r.removed} alte Einträge entfernt.`); } }, 'Alte Daten jetzt aufräumen'));
  return box;
}

/** Gestaffelte Updates: erst ein Test-Bildschirm, nach bestätigtem Erfolg schrittweise die übrigen, automatischer Rückfall */
async function rolloutSection(devices, route) {
  const ro = await get('/rollouts').catch(() => []); const cur = ro.find((r) => r.state === 'canary' || r.state === 'rolling'), last = ro[0];
  const sel = h('select', { 'aria-label': 'Test-Bildschirm' }, devices.filter((d) => d.status.level === 'ok').map((d) => h('option', { value: d.id }, d.name))), batch = h('input', { type: 'number', min: 1, max: 50, value: 2, 'aria-label': 'Gruppengröße' }), soak = h('input', { type: 'number', min: 1, max: 120, value: 5, 'aria-label': 'Beobachtungszeit in Minuten' });
  const ST = { pending: '… wartet', sent: '⏳ läuft', ok: '✔ fertig', failed: '✖ Fehler', rolled_back: '↩ zurückgesetzt' };
  const show = (r) => h('div', {}, h('p', {}, h('b', {}, { canary: 'Test-Bildschirm wird aktualisiert …', rolling: 'Die übrigen Bildschirme folgen …', done: '✔ Fertig – alle Bildschirme sind aktualisiert.', aborted: '↩ Abgebrochen – Bildschirme sind zurückgesetzt.' }[r.state])), h('ul', {}, r.steps.map((s) => h('li', {}, `${s.name}${s.canary ? ' (Test)' : ''}: ${ST[s.state] ?? s.state}`))), h('details', {}, h('summary', {}, 'Protokoll'), h('ul', {}, r.log.map((l) => h('li', {}, `${fmtDate(l.ts)} – ${l.text}`)))));
  return h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Gestaffeltes Update'), h('p', { class: 'hint' }, 'Spiele zuerst eine Update-Datei ein (oben). Hier verteilst du sie vorsichtig: erst auf einen Test-Bildschirm, nach der Beobachtungszeit auf die übrigen – bei einem Fehler gehen alle automatisch zur vorherigen Version zurück.'),
    cur ? h('div', {}, show(cur), h('button', { class: 'btn sec', onclick: async () => { await post(`/rollouts/${cur.id}/abort`); route(); } }, 'Abbrechen und zurücksetzen')) : h('div', {}, last ? show(last) : null,
      h('div', { class: 'row' }, field('Test-Bildschirm', sel), field('Gruppengröße', batch), field('Beobachtungszeit (Min.)', soak)), h('button', { class: 'btn', onclick: async () => { try { await post('/rollouts', { testDevice: sel.value, batchSize: Number(batch.value), soakMinutes: Number(soak.value) }); toast('Das Update startet auf dem Test-Bildschirm.'); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Gestaffelt verteilen')));
}
