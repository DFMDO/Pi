import { h, toast, field } from '../ui.js';
import { api, post } from '../api.js';
export function loginPage(onOk) {
  let totp = false; const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); const f = new FormData(form);
    try { const r = await post('/auth/login', { name: f.get('name'), password: f.get('password'), ...(f.get('totp') ? { totp: f.get('totp') } : {}) }); onOk(r.user, r.csrf); }
    catch (err) { if (err.data?.code === 'totp') { totp = true; $totp.hidden = false; $totp.querySelector('input').focus(); } err.status && toast(err.message, 'err'); } } },
    h('h1', {}, 'Anmelden'), h('p', { class: 'lead' }, 'Melde dich mit deinem Benutzernamen und Passwort an.'),
    field('Benutzername', h('input', { name: 'name', autocomplete: 'username', required: true, autofocus: true })), field('Passwort', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })));
  const $totp = h('div', { hidden: true }, field('Code aus der Authenticator-App (oder Wiederherstellungscode)', h('input', { name: 'totp', autocomplete: 'one-time-code', inputmode: 'numeric' })));
  form.append($totp, h('button', { class: 'btn big', style: 'width:100%;margin-top:16px', type: 'submit' }, 'Anmelden'));
  return h('main', { class: 'login', id: 'main' }, h('img', { src: '/logo.svg', alt: 'Deutsches Fußballmuseum', style: 'height:56px;margin-bottom:16px' }), form);
}
/** Allererste Einrichtung im Browser (nur wenn beim Handy-Setup kein Konto angelegt wurde). */
export function firstSetupPage(done) {
  const form = h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(form));
    try { await api('POST', '/setup/admin', f); toast('Fertig! Bitte melde dich jetzt an.'); done(); } catch (er) { toast(er.message, 'err'); } } },
    h('h1', {}, 'Willkommen! Lege dein Admin-Konto an'), h('p', { class: 'lead' }, 'Der Einrichtungscode steht auf dem Bildschirm des Hubs (oder in der Datei hub-einrichtungscode.txt auf der SD-Karte).'),
    field('Einrichtungscode', h('input', { name: 'code', required: true, autocapitalize: 'characters' })), field('Dein Name', h('input', { name: 'name', required: true, autocomplete: 'username' })),
    field('Passwort (mindestens 12 Zeichen)', h('input', { name: 'password', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' }), 'Nimm am besten einen langen Satz, z. B. „Im Museum steht der Ball im Tor“. Lange Sätze sind sicherer als kurze Wörter mit Sonderzeichen.'),
    field('Name des Museums', h('input', { name: 'site', value: 'Deutsches Fußballmuseum' })), h('button', { class: 'btn big', style: 'width:100%;margin-top:16px' }, 'Konto anlegen'));
  return h('main', { class: 'login', id: 'main' }, form);
}
