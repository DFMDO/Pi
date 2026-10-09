// Vorlagen, QR-Code, Massenimport, Sondertage, Laufband/Zonen, Wochenvorlagen, Passwort-Rücksetzung.
import { h, dialog, confirmDlg, toast, field, empty, fmtBytes } from '../ui.js';
import { get, post, put, del, can } from '../api.js';

const warnList = (w) => w.map((x) => h('p', { class: 'notice' + (x.level === 'error' ? ' bad' : '') }, (x.level === 'error' ? '✖ ' : '▲ ') + x.text));

/** Vorlagen (Z.5): Felder ausfüllen, Lesbarkeit wird immer geprüft und in Klartext erklärt */
export async function templateDlg(route) {
  const [tpls, devices] = await Promise.all([get('/templates'), get('/devices')]); const list = tpls.filter((t) => t.state === 'published');
  const sel = h('select', { 'aria-label': 'Vorlage' }, list.map((t) => h('option', { value: t.id }, t.name))), dev = h('select', { 'aria-label': 'Ziel-Bildschirm' }, h('option', { value: '' }, 'Standard (Full HD)'), devices.filter((d) => d.status.level !== 'pending').map((d) => h('option', { value: d.id }, d.name)));
  const fieldsBox = h('div', {}), out = h('div', {}), name = h('input', { maxlength: 100, placeholder: 'Name (optional)' }); let inputs = {};
  const cur = () => list.find((t) => t.id === sel.value);
  const collect = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  async function check() { try { const r = await post(`/templates/${sel.value}/check`, { fields: collect(), ...(dev.value ? { deviceId: dev.value } : {}) }); out.replaceChildren(h('div', { class: 'shot', style: 'padding:12px;text-align:left' }, h('b', {}, r.preview.title), h('div', { style: 'white-space:pre-wrap' }, r.preview.body)), r.readability.length ? warnList(r.readability) : h('p', { class: 'status ok' }, '✔ Lesbarkeit in Ordnung')); } catch (e) { out.replaceChildren(h('p', { class: 'hint bad' }, e.message)); } }
  const draw = () => { inputs = {}; fieldsBox.replaceChildren(...cur().fields.map((f) => { const el = f.type === 'lines' ? h('textarea', { rows: 4, maxlength: f.max ?? 400 }, f.def ?? '') : h('input', { type: f.type === 'date' ? 'date' : 'text', value: f.def ?? '', maxlength: f.max ?? 100 }); el.addEventListener('input', () => { clearTimeout(draw.t); draw.t = setTimeout(check, 400); }); inputs[f.key] = el; return field(f.label, el); })); check(); };
  sel.onchange = draw; dev.onchange = check; draw();
  dialog('Vorlage verwenden', h('div', {}, field('Vorlage', sel), fieldsBox, field('Prüfen für Bildschirm', dev, 'Die Lesbarkeit wird für die Auflösung und Ausrichtung dieses Bildschirms geprüft.'), field('Name in der Bibliothek', name), out),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Speichern', fn: async () => { try { const r = await post(`/templates/${sel.value}/create`, { name: name.value || undefined, fields: collect(), ...(dev.value ? { deviceId: dev.value } : {}) }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

/** QR-Code (Z.12) */
export function qrDlg(route) {
  let kind = 'url'; const f = {}; const mk = (k, ph, type = 'text') => (f[k] = h('input', { type, placeholder: ph, maxlength: 500 })); const box = h('div', {}), out = h('div', {});
  const draw = () => { box.replaceChildren(...(kind === 'url' ? [field('Adresse (http/https)', mk('url', 'https://…'))] : kind === 'wifi' ? [field('WLAN-Name', mk('ssid')), field('WLAN-Passwort', mk('password', '', 'password'))] : kind === 'contact' ? [field('Name', mk('name')), field('Telefon', mk('phone')), field('E-Mail', mk('email')), field('Organisation', mk('org'))] : [field('Text', mk('text'))])); box.querySelectorAll('input').forEach((i) => i.addEventListener('input', () => { clearTimeout(draw.t); draw.t = setTimeout(check, 500); })); };
  const heading = h('input', { maxlength: 80, placeholder: 'z. B. Audioguide öffnen' }), cap = h('input', { maxlength: 200, placeholder: 'kurzer Text (optional)' });
  const body = () => ({ kind, ...Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]).filter(([, v]) => v)), heading: heading.value, caption: cap.value });
  async function check() { try { const r = await post('/qr/check', body()); out.replaceChildren(h('img', { src: r.preview, alt: 'Vorschau des QR-Codes', style: 'max-width:100%;border:1px solid #ccc' }), r.matches ? h('p', { class: 'status ok' }, '✔ Gegenprobe bestanden: der Code liest sich wie eingegeben.') : null, warnList(r.warnings)); } catch (e) { out.replaceChildren(h('p', { class: 'hint bad' }, e.message)); } }
  const types = h('div', { class: 'chips', role: 'group', 'aria-label': 'Art' }); const drawTypes = () => types.replaceChildren(...[['url', 'Adresse'], ['wifi', 'WLAN'], ['contact', 'Kontakt'], ['text', 'Text']].map(([k, t]) => h('button', { type: 'button', class: 'chip', 'aria-pressed': kind === k, onclick: () => { kind = k; drawTypes(); draw(); out.replaceChildren(); } }, t)));
  drawTypes(); draw(); [heading, cap].forEach((x) => x.addEventListener('input', () => { clearTimeout(draw.t); draw.t = setTimeout(check, 500); }));
  dialog('QR-Code erstellen', h('div', {}, h('p', { class: 'hint' }, 'Der Code entsteht lokal im Hub – ohne Kurzlinks und ohne Tracking. Besucher erreichen nur öffentliche Adressen.'), types, box, field('Überschrift', heading), field('Kurzer Text', cap), out),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Prüfen', cls: 'sec', fn: async () => { await check(); return false; } }, { text: 'In die Bibliothek legen', fn: async () => { try { const r = await post('/qr/create', body()); toast(r.decoded ? 'Der QR-Code liegt in der Bibliothek (Gegenprobe bestanden).' : 'Gespeichert, aber bitte prüfen.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}

/** Massenimport (Z.10): Vorschau → Bestätigung → Fortschritt */
export async function importDlg(route, opts = {}) {
  const [r, usb] = await Promise.all([get('/import/roots'), opts.path ? null : get('/import/usb').catch(() => null)]); const start = opts.path ?? (usb?.present ? usb.path : null); const path = h('input', { value: start ?? r.roots[0] ?? '', list: 'roots', 'aria-label': 'Ordner' }), dl = h('datalist', { id: 'roots' }, r.roots.map((x) => h('option', { value: x }))), out = h('div', {});
  let scan = null; const checks = new Map();
  async function doScan() { out.replaceChildren(h('p', {}, '⏳ Ordner wird gelesen …'));
    try { scan = await post('/import/scan', { path: path.value }); checks.clear(); const s = scan.summary;
      out.replaceChildren(h('p', {}, h('b', {}, `${s.importable} neue Dateien`), `, ${s.duplicates} Duplikate (schon vorhanden), ${s.unsupported} nicht unterstützt. Es wurde noch nichts übernommen.`),
        h('table', {}, h('thead', {}, h('tr', {}, ['', 'Datei', 'Name in der Bibliothek', 'Hinweis'].map((x) => h('th', {}, x)))), h('tbody', {}, scan.items.map((i) => { const c = h('input', { type: 'checkbox', checked: !!i.include, disabled: !i.supported, 'aria-label': `${i.rel} übernehmen` }); const n = h('input', { value: i.name ?? '', disabled: !i.supported, maxlength: 100, 'aria-label': 'Name' }); checks.set(i.rel, { c, n, i });
          return h('tr', {}, h('td', {}, c), h('td', {}, i.rel, h('div', { class: 'hint' }, fmtBytes(i.size))), h('td', {}, n), h('td', {}, i.duplicateOf ? `Duplikat von „${i.duplicateOf}“` : i.note ?? (i.hints ?? []).join(' ') ?? '')); }))));
    } catch (e) { out.replaceChildren(h('p', { class: 'bad' }, e.message)); } }
  dialog('Ordner oder USB-Stick importieren', h('div', {}, usb?.present || opts.path ? h('p', { class: 'notice ok' }, '🔌 Ein USB-Stick ist eingesteckt. Unten siehst du, was darauf liegt. Bilder, Videos und PDFs (jede PDF-Seite wird ein Bild) kannst du übernehmen.') : null, h('p', {}, 'Lies einen Ordner von einem USB-Stick oder einer Netzwerkfreigabe ein, zum Beispiel aus Yodeck. ', h('span', { class: 'hint' }, r.hint)), field('Ordner', path), dl, h('button', { class: 'btn sec', type: 'button', onclick: doScan }, 'Ordner einlesen (Vorschau)'), out), [{ text: 'Schließen', cls: 'sec' },
    { text: 'Auswahl übernehmen', fn: async () => { if (!scan) { toast('Bitte lies zuerst den Ordner ein.', 'err'); return false; } const items = [...checks.values()].filter(({ c }) => c.checked).map(({ n, i }) => ({ rel: i.rel, name: n.value || i.name, folder: i.folder }));
      if (!items.length) { toast('Nichts ausgewählt.', 'err'); return false; } if (!(await confirmDlg('Jetzt übernehmen?', `${items.length} Dateien werden in die Bibliothek kopiert.`, 'Übernehmen', false))) return false;
      try { const j = await post('/import/commit', { scanId: scan.scanId, confirmed: true, items }); out.replaceChildren(h('p', {}, '⏳ Wird übernommen …')); for (let n = 0; n < 600; n++) { await new Promise((x) => setTimeout(x, 700)); const st = await get(`/import/jobs/${j.jobId}`); out.replaceChildren(h('p', {}, `${st.done} von ${st.total} übernommen${st.failed ? `, ${st.failed} Fehler` : ''} …`), h('progress', { max: st.total, value: st.done })); if (st.finished) { toast(`${st.done} Dateien übernommen.`); route(); return; } } } catch (e) { toast(e.message, 'err'); } return false; } }]);
  if (start) doScan(); // USB-Stick erkannt oder Ordner vorgegeben: gleich die Vorschau zeigen (übernommen wird erst nach Bestätigung)
}

/** Feiertage, Schließtage, Sondertage (Z.6) */
export async function specialDaysDlg(route) {
  const year = new Date().getFullYear(); const [days, lists, media] = await Promise.all([get(`/special-days?year=${year}`), get('/playlists'), get('/media')]); const pubLists = lists.filter((l) => l.state === 'published' && !l.draftOf);
  const ctn = (id) => h('select', { id, 'aria-label': 'Inhalt' }, pubLists.map((l) => h('option', { value: 'playlist:' + l.id }, 'Abspielliste: ' + l.name)), media.map((m) => h('option', { value: 'media:' + m.id }, m.name)));
  const rule = h('select', { 'aria-label': 'Regel' }, [['playlist', 'Diese Abspielliste statt der normalen'], ['notice', 'Hinweisbild zeigen'], ['off', 'Bildschirme aus (Schließtag)']].map(([k, t]) => h('option', { value: k }, t))), c = ctn('c-hol');
  const nm = h('input', { maxlength: 80 }), d1 = h('input', { type: 'date' }), d2 = h('input', { type: 'date' }), kind = h('select', {}, [['sondertag', 'Sondertag'], ['ferien', 'Betriebsferien'], ['schliesstag', 'Schließtag']].map(([k, t]) => h('option', { value: k }, t)));
  const parse = (v) => { const [t, ...i] = v.split(':'); return { type: t, id: i.join(':') }; };
  dialog('Feiertage und Sondertage', h('div', {}, h('p', { class: 'hint' }, 'Die Feiertage für Nordrhein-Westfalen sind eingebaut (ohne Internet). Eigene Tage und Betriebsferien kannst du ergänzen.'),
    h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Regel für alle Feiertage'), h('div', { class: 'row' }, rule, c, h('button', { class: 'btn', type: 'button', onclick: async () => { try { await post('/special-days/apply-rule', { kind: 'feiertag', rule: rule.value, content: rule.value === 'off' ? null : parse(c.value) }); toast('Die Regel gilt jetzt für alle Feiertage.'); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Regel setzen'))),
    h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', { style: 'margin-top:0' }, 'Eigenen Tag eintragen'), field('Name', nm), h('div', { class: 'row' }, kind, 'von', d1, 'bis', d2), h('button', { class: 'btn', type: 'button', onclick: async () => { try { await post('/special-days', { date: d1.value, dateTo: d2.value || null, name: nm.value, kind: kind.value, rule: kind.value === 'schliesstag' ? 'off' : rule.value, content: kind.value === 'schliesstag' || rule.value === 'off' ? null : parse(c.value) }); toast('Eingetragen.'); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Eintragen')),
    h('table', { style: 'margin-top:10px' }, h('tbody', {}, days.map((d) => h('tr', {}, h('td', {}, d.date.split('-').reverse().join('.') + (d.dateTo ? ' – ' + d.dateTo.split('-').reverse().join('.') : '')), h('td', {}, d.name), h('td', {}, d.rule === 'off' ? '⏻ aus' : d.contentName ? `▶ ${d.contentName}` : '– keine Regel'), h('td', {}, d.builtin ? h('span', { class: 'hint' }, 'eingebaut') : h('button', { class: 'btn link', onclick: async () => { await del(`/special-days/${d.id}`); route(); } }, 'Löschen'))))))), [{ text: 'Schließen' }]);
}

/** Laufband-Meldungen und Zonen-Layouts (Z.7) – nur Standard/Pro */
export async function layoutPanel(route) {
  const [tk, lay, devices] = await Promise.all([get('/tickers'), get('/layouts'), get('/devices')]); const txt = h('input', { maxlength: 200, 'aria-label': 'Meldung' }), from = h('input', { type: 'date', 'aria-label': 'von' }), to = h('input', { type: 'date', 'aria-label': 'bis' });
  return h('div', {}, h('h2', {}, 'Laufband'), h('p', { class: 'hint' }, 'Kurze Meldungen laufen unten über den Bildschirm – auf Geräten mit einem Zonen-Layout (Standard/Pro).'),
    can('tickers.write') ? h('div', { class: 'row' }, txt, 'von', from, 'bis', to, h('button', { class: 'btn', onclick: async () => { try { await post('/tickers', { text: txt.value, validFrom: from.value || null, validTo: to.value || null }); toast('Meldung angelegt.'); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Hinzufügen')) : null,
    tk.length ? h('ul', {}, tk.map((t) => h('li', {}, `${t.text} (${t.validFrom ?? 'immer'} – ${t.validTo ?? 'offen'}) `, can('tickers.write') ? h('button', { class: 'btn link', onclick: async () => { await del(`/tickers/${t.id}`); route(); } }, 'Löschen') : null))) : h('p', { class: 'hint' }, 'Keine Meldungen.'),
    can('devices.manage') ? h('div', {}, h('h2', {}, 'Zonen-Layout je Bildschirm'), h('p', { class: 'hint' }, lay.note), h('table', {}, h('tbody', {}, devices.filter((d) => d.status.level !== 'pending').map((d) => { const s = h('select', { 'aria-label': 'Layout', disabled: d.profile === 'lite' }, h('option', { value: '' }, 'Vollbild'), lay.presets.map((p) => h('option', { value: p.id }, `${p.name} (${p.zones} Zonen)`)));
      return h('tr', {}, h('td', {}, d.name, d.profile === 'lite' ? h('div', { class: 'hint' }, 'Lite: immer Vollbild') : null), h('td', {}, s), h('td', {}, d.profile === 'lite' ? null : h('button', { class: 'btn sec', onclick: async () => { try { await put(`/devices/${d.id}/layout`, { preset: s.value || null }); toast('Layout gespeichert.'); } catch (e) { toast(e.message, 'err'); } } }, 'Speichern'))); })))) : null);
}

/** Wochenwerkzeuge im Kalender (Z.13) */
export async function weekDlg(route, week) {
  const tpls = await get('/week-templates'), nm = h('input', { maxlength: 80, placeholder: 'z. B. Normalwoche' }), target = h('input', { type: 'date', value: week });
  dialog('Woche kopieren oder als Vorlage', h('div', {}, h('p', {}, 'Alles landet zuerst als Entwurf. Du prüfst es und veröffentlichst es danach.'), h('h3', {}, 'Diese Woche kopieren'), h('div', { class: 'row' }, 'in die Woche mit dem', target, h('button', { class: 'btn', onclick: async () => { try { const r = await post('/schedules/duplicate-week', { fromWeek: week, toWeek: target.value }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Kopieren')),
    h('h3', {}, 'Als Wochenvorlage speichern'), h('div', { class: 'row' }, nm, h('button', { class: 'btn', onclick: async () => { try { const r = await post('/week-templates', { name: nm.value, week }); toast(`Vorlage mit ${r.count} Terminen gespeichert.`); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Speichern')),
    h('h3', {}, 'Wochenvorlage anwenden'), tpls.length ? h('ul', {}, tpls.map((t) => h('li', {}, `${t.name} (${t.count} Termine) `, h('button', { class: 'btn link', onclick: async () => { try { const r = await post(`/week-templates/${t.id}/apply`, { week: target.value }); toast(r.text); route(); } catch (e) { toast(e.message, 'err'); } } }, 'Auf die gewählte Woche anwenden'), h('button', { class: 'btn link', onclick: async () => { await del(`/week-templates/${t.id}`); route(); } }, 'Löschen')))) : h('p', { class: 'hint' }, 'Noch keine Vorlagen.')), [{ text: 'Schließen' }]);
}

/** Passwort vergessen (Z.9): mit Wiederherstellungscode, ohne E-Mail */
export function resetDlg() {
  const n = h('input', { autocomplete: 'username' }), c = h('input', { autocomplete: 'off' }), p = h('input', { type: 'password', autocomplete: 'new-password' });
  dialog('Passwort zurücksetzen', h('div', {}, h('p', {}, 'Hast du die zusätzliche Sicherheit (Code aus App) eingerichtet, kannst du einen deiner Wiederherstellungscodes benutzen. Sonst bitte einen Admin, dein Passwort zurückzusetzen.'), field('Benutzername', n), field('Wiederherstellungscode', c), field('Neues Passwort (mindestens 12 Zeichen)', p)),
    [{ text: 'Abbrechen', cls: 'sec' }, { text: 'Passwort ändern', fn: async () => { try { const r = await post('/auth/reset-with-recovery', { name: n.value, code: c.value, password: p.value }); toast(r.text); } catch (e) { toast(e.message, 'err'); return false; } } }]);
}
void empty;
