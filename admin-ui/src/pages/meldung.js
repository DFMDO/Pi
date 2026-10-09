// Erweitert → „Meldung bei Ausfall“: E-Mail über den Mailserver des Museums, Testmail, Statusadresse für die IT-Überwachung.
import { h, toast, field, fmtDate } from '../ui.js';
import { get, post, put } from '../api.js';

const row = (...k) => h('div', { class: 'row', style: 'gap:12px;align-items:flex-end;flex-wrap:wrap' }, ...k);

export async function alertSection() {
  let c; try { c = await get('/alerts/config'); } catch { return null; }
  const on = h('input', { type: 'checkbox', checked: c.enabled, id: 'al-on' }), host = h('input', { value: c.host, maxlength: 200, placeholder: 'mail.museum.local', autocomplete: 'off' }), port = h('input', { type: 'number', min: 1, max: 65535, value: c.port });
  const sec = h('select', {}, [['starttls', 'STARTTLS (Port 587, üblich)'], ['tls', 'TLS (Port 465)'], ['none', 'ohne Verschlüsselung (Port 25, nur ohne Anmeldung)']].map(([k, t]) => h('option', { value: k, selected: k === c.security ? '' : null }, t)));
  const user = h('input', { value: c.user, maxlength: 200, autocomplete: 'off' }), pass = h('input', { type: 'password', maxlength: 200, autocomplete: 'new-password', placeholder: c.hasPassword ? '(unverändert)' : '' });
  const from = h('input', { type: 'email', value: c.from, maxlength: 200, placeholder: 'signage@museum.local' }), to = h('textarea', { rows: 2, placeholder: 'it@museum.local' }, c.to.join('\n'));
  const delay = h('input', { type: 'number', min: 5, max: 1440, value: c.delayMin }), qf = h('input', { type: 'time', value: c.quietFrom }), qt = h('input', { type: 'time', value: c.quietTo });
  const rec = h('input', { type: 'checkbox', checked: c.recovery, id: 'al-rec' }), insecure = h('input', { type: 'checkbox', checked: c.insecureTls, id: 'al-ins' });
  const state = h('p', { class: 'hint', role: 'status' }, c.last ? `${c.last.ok ? '✔' : '✖'} ${fmtDate(c.last.ts)}: ${c.last.text}` : 'Noch keine Meldung gesendet.');
  const body = () => ({ enabled: on.checked, host: host.value, port: Number(port.value) || 587, security: sec.value, user: user.value, ...(pass.value ? { password: pass.value } : {}), from: from.value, to: to.value.split(/[\s,;]+/).filter(Boolean), delayMin: Number(delay.value) || 10, quietFrom: qf.value, quietTo: qt.value, recovery: rec.checked, insecureTls: insecure.checked });
  const save = async () => { const r = await put('/alerts/config', body()); pass.value = ''; pass.placeholder = r.hasPassword ? '(unverändert)' : ''; return r; };
  const out = h('div', {});
  const token = async (btn) => { btn.disabled = true; try { const r = await post('/live-tokens', { name: 'IT-Überwachung' }); out.replaceChildren(h('div', { class: 'notice ok' }, h('b', {}, 'Zugang erzeugt – wird nur jetzt angezeigt:'), h('pre', { class: 'apppreview', style: 'white-space:pre-wrap;word-break:break-all' }, `Adresse:  https://${location.host}/api/v1/status\nHeader:   X-Live-Token: ${r.token}`), h('p', { class: 'hint' }, 'Antwort 200 = alles in Ordnung, 503 = ein Bildschirm ist ausgefallen (mit ?strict=1 auch bei „keine Verbindung“, mit ?format=text als Klartext). Der Zugang erlaubt nur Lesen und kann unter „Benutzer → Wandmodus“ widerrufen werden.'))); } catch (e) { toast(e.message, 'err'); btn.disabled = false; } };
  return h('section', { class: 'card', style: 'margin-top:14px' }, h('h2', { style: 'margin-top:0' }, 'Meldung bei Ausfall'),
    h('p', {}, 'Fällt ein Bildschirm länger aus, schickt der Hub eine E-Mail über den Mailserver des Museums. Standardmäßig aus. Fällt der Hub selbst aus, kann er nichts melden: Dafür gibt es unten die Statusadresse für die IT-Überwachung.'),
    h('label', { class: 'row', for: 'al-on' }, on, h('b', {}, ' Meldung bei Ausfall ist eingeschaltet')),
    row(field('Mailserver', host), field('Port', port), field('Verschlüsselung', sec)),
    row(field('Benutzername (leer = ohne Anmeldung)', user), field('Passwort', pass, 'Wird verschlüsselt gespeichert und nie angezeigt. Leer lassen = unverändert.')),
    row(field('Absender', from), field('Empfänger (einer pro Zeile, höchstens 5)', to)),
    row(field('Melden nach … Minuten ohne Verbindung', delay, 'Kurze Ausfälle (Neustart, WLAN-Wechsel) sollen keine Mail auslösen. Mindestens 5.'), field('Ruhezeit von', qf, 'In der Ruhezeit gehen keine Mails raus, sie werden danach nachgeholt. Leer = immer melden.'), field('bis', qt)),
    h('label', { class: 'row', for: 'al-rec' }, rec, ' Auch melden, wenn der Bildschirm wieder erreichbar ist'),
    h('label', { class: 'row', for: 'al-ins' }, insecure, ' Zertifikat des Mailservers nicht prüfen (nur wenn die IT es nicht ändern kann, weniger sicher)'),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try { await save(); toast('Gespeichert.'); } catch (x) { toast(x.message, 'err'); } e.currentTarget.disabled = false; } }, 'Speichern'),
      h('button', { class: 'btn sec', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await save(); const r = await post('/alerts/test'); toast(r.text); state.textContent = `✔ ${fmtDate(Date.now())}: Test-E-Mail gesendet`; } catch (x) { toast(x.message, 'err'); state.textContent = `✖ ${x.message}`; } b.disabled = false; } }, 'Speichern und Test-E-Mail senden')),
    state,
    h('h3', {}, 'Statusadresse für die IT-Überwachung'), h('p', {}, 'Die Überwachung der IT (z. B. Nagios, Zabbix, Uptime Kuma) kann diese Adresse regelmäßig abfragen und selbst Alarm schlagen, auch wenn der Hub ausfällt.'),
    h('button', { class: 'btn sec', onclick: (e) => token(e.currentTarget) }, 'Zugang für die Überwachung erzeugen'), out);
}
