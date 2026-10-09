// Hub ersetzen: Vorsorge-Check, Einrichtungsdatei für den Ersatz-Hub (entsteht nur im Browser, Passwörter verlassen ihn nicht) und eine druckbare Notfallkarte.
import { h, toast, field, fmtDate, fmtBytes } from '../ui.js';
import { get, api } from '../api.js';

const DAY = 86400000;
const chk = (level, title, text) => h('li', { class: 'checkrow' }, h('span', { class: `status ${level}` }, level === 'ok' ? '✔' : level === 'warn' ? '▲' : level === 'bad' ? '✖' : 'ℹ'), ' ', h('b', {}, title), h('div', { class: 'hint' }, text));
const STEPS = (hub) => [
  'Eine SD-Karte (mindestens 16 GB) mit dem DFM-Signage-Image beschreiben (Raspberry Pi Imager → „Eigenes Image verwenden“). Im Imager keine eigenen Einstellungen eintragen.',
  'Auf der SD-Karte erscheint das Laufwerk „bootfs“. Dorthin zwei Dateien kopieren: die Backup-Datei (dfm-backup.dfmbak) und die Datei dfm-setup.txt.',
  'SD-Karte in den Ersatz-Pi stecken, Netzwerkkabel und Strom anschließen. 3 bis 5 Minuten warten. Der Hub richtet sich selbst ein und löscht dabei dfm-setup.txt.',
  `Im Browser öffnen: https://${hub.host}${hub.addresses?.[0] ? ` (oder ${hub.addresses[0].ip})` : ''}. Mit dem bisherigen Admin-Konto anmelden, die Konten stehen im Backup.`,
  'Die IT bitten, dem neuen Pi die alte IP-Adresse zu geben (DHCP-Reservierung auf die neue MAC-Adresse umstellen). Die MAC steht im Hub unter „Bildschirme → Hub-Adresse & Fingerabdruck“.',
  'Unter „Live“ prüfen: Nach 1 bis 2 Minuten sollten alle Bildschirme „Läuft“ zeigen. Sie müssen nicht neu verbunden werden, wenn der Hub unter derselben Adresse erreichbar ist.',
  'Mediendateien sind NICHT im Backup. Bilder und Videos erscheinen im neuen Hub ohne Vorschau, bis du die Originale wieder hochlädst oder per USB-Stick importierst („Bilder & Videos → Ordner / USB-Stick importieren“). Die Bildschirme zeigen bis dahin ihre gespeicherten Inhalte weiter.',
];

export async function hubErsatzPage({ route }) {
  const [ov, hub] = await Promise.all([get('/backup/overview'), get('/system/hub')]); const now = Date.now();
  const age = ov.last ? (now - ov.last.ts) / DAY : null, dl = ov.lastDownload ? (now - ov.lastDownload) / DAY : null;
  const list = h('ul', { class: 'checklist' },
    ov.configured ? chk('ok', 'Backup-Verschlüsselung ist eingerichtet', 'Der Hub sichert täglich automatisch.') : chk('bad', 'Backup ist noch nicht eingerichtet', 'Ohne Backup lässt sich der Hub nicht wiederherstellen. Erweitert → Sicherung → Verschlüsselung einrichten und die Passphrase gut aufbewahren.'),
    ov.last ? chk(age <= 2 ? 'ok' : age <= 7 ? 'warn' : 'bad', `Letztes Backup: ${fmtDate(ov.last.ts)}`, age <= 2 ? `${ov.count} Sicherungen liegen im Hub.` : 'Das Backup ist älter als zwei Tage. Der Hub sollte täglich sichern. Bitte die IT oder die Betreuung informieren.') : chk(ov.configured ? 'bad' : 'warn', 'Es gibt noch kein Backup', 'Die erste automatische Sicherung entsteht nach der Einrichtung; du kannst unten jederzeit eines herunterladen.'),
    ov.lastDownload ? chk(dl <= 31 ? 'ok' : 'warn', `Backup auf einen anderen Rechner geladen: ${fmtDate(ov.lastDownload)}`, dl <= 31 ? 'Eine Kopie liegt außerhalb des Hubs.' : 'Das ist länger als einen Monat her. Bitte eine frische Kopie herunterladen und auf einem anderen Rechner oder Netzlaufwerk ablegen.') : chk('warn', 'Noch keine Kopie außerhalb des Hubs', 'Die Backups liegen nur auf dem Hub selbst. Geht dessen SD-Karte kaputt, sind sie mit weg. Bitte jetzt eines herunterladen und auf einem anderen Rechner oder Netzlaufwerk ablegen, danach etwa einmal im Monat.'),
    chk('info', `Mediendateien sind nicht im Backup (${ov.media.count} Dateien${ov.media.bytes ? ', ' + fmtBytes(ov.media.bytes) : ''})`, 'Behalte die Originale auf einem Laufwerk oder USB-Stick. Nach einem Hub-Wechsel lädst du sie wieder hoch oder importierst sie vom Stick.'),
    chk('info', `Im Backup stehen: ${ov.devices} Bildschirme, ${ov.users} Konten, Termine, Abspiellisten, Einstellungen und die Schlüssel`, 'Wegen der Schlüssel müssen die Bildschirme nach der Wiederherstellung nicht neu verbunden werden.'));
  const download = h('button', { class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { const r = await api('POST', '/backup/run', {}, { raw: true }); const blob = await r.blob(); h('a', { href: URL.createObjectURL(blob), download: 'dfm-backup.dfmbak' }).click(); toast('Das Backup wurde heruntergeladen. Bitte auf einem anderen Rechner ablegen.'); route(); } catch (x) { toast(x.message, 'err'); b.disabled = false; } } }, '⬇️ Backup jetzt herunterladen');

  // Einrichtungsdatei: entsteht nur hier im Browser
  const bname = h('input', { value: 'dfm-backup.dfmbak', maxlength: 80 }), pass = h('input', { type: 'password', autocomplete: 'off', maxlength: 200, placeholder: 'Backup-Passphrase' }), ssid = h('input', { maxlength: 32, autocomplete: 'off' }), wpw = h('input', { type: 'password', maxlength: 63, autocomplete: 'off' });
  const make = () => {
    if (!/^[\w.\- ]{1,80}\.dfmbak$/.test(bname.value)) return toast('Der Dateiname des Backups muss auf .dfmbak enden (zum Beispiel dfm-backup.dfmbak).', 'err');
    if (!pass.value) return toast('Bitte gib die Backup-Passphrase ein.', 'err'); if (pass.value !== pass.value.trim() || /^".*"$/.test(pass.value) || /[\r\n]/.test(pass.value)) return toast('Die Passphrase darf nicht mit einem Leerzeichen oder Anführungszeichen beginnen oder enden.', 'err');
    if (ssid.value && (wpw.value.length < 8 || wpw.value.length > 63)) return toast('Das WLAN-Passwort muss 8 bis 63 Zeichen lang sein. Bei Netzwerkkabel beide WLAN-Felder leer lassen.', 'err');
    const text = ['# DFM Signage – Einrichtung des Ersatz-Hubs (erzeugt am ' + new Date().toLocaleDateString('de-DE') + ')', '# Diese Datei enthält Passwörter. Sie wird beim ersten Start eingelesen und danach GELÖSCHT.', 'rolle = hub', `backup_datei = ${bname.value}`, `backup_passphrase = ${pass.value}`, ...(ssid.value ? [`wlan_name = ${ssid.value}`, `wlan_passwort = ${wpw.value}`] : []), ''].join('\r\n');
    h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: 'dfm-setup.txt' }).click(); toast('Die Datei dfm-setup.txt wurde erzeugt. Sie gehört auf die SD-Karte des Ersatz-Hubs, nicht in eine E-Mail.');
  };
  const wrap = (kids) => h('div', { class: 'row', style: 'gap:12px;align-items:flex-end;flex-wrap:wrap' }, ...kids);

  const card = h('section', { class: 'card printcard', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Notfallkarte: Hub ausgefallen'),
    h('p', {}, 'Die Bildschirme laufen weiter, Besucher merken nichts. Nur Änderungen sind bis zum Ersatz nicht möglich. Ein Ersatz-Hub ist in etwa 15 Minuten einsatzbereit.'),
    h('table', {}, h('tbody', {}, [['Adresse', `https://${hub.host}`], ['IP-Adresse(n)', (hub.addresses ?? []).map((a) => a.ip).join(', ') || '–'], ['MAC-Adresse(n)', (hub.addresses ?? []).map((a) => a.mac).join(', ') || '–'], ['Fingerabdruck', hub.fingerprint], ['Hub-Version', ov.hubVersion ?? '–'], ['Letztes Backup im Hub', ov.last ? fmtDate(ov.last.ts) : 'keins'], ['Passphrase aufbewahrt bei', '______________________________'], ['Ansprechpartner IT', '______________________________']].map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v))))),
    h('ol', {}, STEPS(hub).map((s) => h('li', {}, s))), h('p', { class: 'hint' }, 'Diese Anleitung ist noch nicht auf echter Hardware durchgespielt. Bitte einmal in Ruhe üben, bevor der Ernstfall eintritt.'));

  return h('div', {}, h('h1', {}, 'Hub ersetzen'), h('p', { class: 'lead' }, 'Fällt der Hub aus, laufen die Bildschirme weiter. Hier prüfst du die Vorsorge und bereitest alles vor, damit ein Ersatz-Hub schnell läuft.'),
    h('section', { class: 'card noprint' }, h('h2', { style: 'margin-top:0' }, '1. Vorsorge-Check'), list, h('div', { class: 'row' }, download)),
    h('section', { class: 'card noprint', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, '2. Einrichtungsdatei für den Ersatz-Hub'),
      h('p', {}, 'Mit dieser Datei stellt sich der neue Hub beim ersten Start selbst aus dem Backup wieder her. Sie entsteht nur in deinem Browser: Die Passwörter werden nirgends gespeichert oder an den Hub geschickt.'),
      wrap([field('Dateiname des Backups', bname), field('Backup-Passphrase', pass, 'Die Passphrase steht in eurem Passwortsafe. Ohne sie lässt sich kein Backup lesen.')]),
      wrap([field('WLAN-Name (leer bei Netzwerkkabel)', ssid), field('WLAN-Passwort', wpw)]), h('button', { class: 'btn', onclick: make }, '📄 Datei dfm-setup.txt erzeugen')),
    card, h('p', { class: 'noprint', style: 'margin-top:14px' }, h('button', { class: 'btn sec', onclick: () => window.print() }, '🖨️ Notfallkarte drucken')));
}
