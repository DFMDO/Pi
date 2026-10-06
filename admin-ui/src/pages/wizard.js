// Einrichtungsassistent im Browser: Konto (schon angelegt) → Sicherheit → Bildschirm → Bild → Termin
import { h, toast, field } from '../ui.js';
import { get, post, put, api, state } from '../api.js';
import { pairDialog } from './devices.js';

export function wizardPage(done, reload) {
  let step = 1; const box = h('main', { class: 'login', id: 'main', style: 'max-width:640px' });
  const bar = () => h('div', { class: 'steps', role: 'img', 'aria-label': `Schritt ${step} von 5` }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= step ? 'on' : '' })));
  const next = () => { step++; draw(); }; const skip = h('button', { class: 'btn link', onclick: async () => { await put('/settings', { 'wizard.done': 'true' }); done(); } }, 'Assistent überspringen');
  async function draw() {
    const body = [bar(), h('p', { class: 'hint' }, `Schritt ${step} von 5`)];
    if (step === 1) body.push(h('h1', {}, 'Willkommen!'), h('p', { class: 'lead' }, `Dein Admin-Konto „${state.user.name}“ ist bereit. Dieser Assistent führt dich in wenigen Minuten zu deinem ersten Termin.`), h('button', { class: 'btn big', onclick: next }, 'Los geht’s'));
    if (step === 2) { const i = await get('/system/hub'); body.push(h('h1', {}, 'Sicherheit prüfen'), h('p', {}, 'Dein Browser hat eine Warnung gezeigt, weil der Hub ein eigenes Zertifikat nutzt (er läuft ohne Internet). Das ist normal. So bist du sicher:'),
      h('ol', {}, h('li', {}, 'Vergleiche diesen Fingerabdruck mit der Anzeige am Bildschirm des Hubs oder mit der gedruckten Karte.'), h('li', {}, 'Stimmen alle Zeichen überein, bist du mit deinem Hub verbunden.')), h('p', { class: 'fp card' }, i.fingerprint), h('p', { class: 'hint' }, 'Stimmen sie nicht überein: Nicht fortfahren und die IT informieren.'), h('button', { class: 'btn big', onclick: next }, 'Die Zeichen stimmen überein')); }
    if (step === 3) body.push(h('h1', {}, 'Ersten Bildschirm verbinden'), h('p', { class: 'lead' }, 'Schalte einen Raspberry Pi mit Bildschirm ein und klicke dann auf den Knopf.'), h('button', { class: 'btn big', onclick: () => pairDialog(() => draw()) }, 'Neuen Bildschirm verbinden'), h('p', {}, h('button', { class: 'btn sec', onclick: next }, 'Weiter')));
    if (step === 4) { const f = h('input', { type: 'file', accept: 'image/*,video/*,application/pdf', 'aria-label': 'Datei wählen' }), out = h('p', {}); f.onchange = async () => { const fd = new FormData(); fd.append('file', f.files[0]); out.textContent = '⏳ Wird hochgeladen …'; try { await api('POST', '/media', fd); out.textContent = '✔ Hochgeladen!'; out.className = 'ok'; } catch (e) { out.textContent = e.message; out.className = 'bad'; } };
      body.push(h('h1', {}, 'Erstes Bild hochladen'), h('p', { class: 'lead' }, 'Wähle ein Bild oder Video von deinem Computer.'), f, out, h('p', {}, h('button', { class: 'btn big', onclick: next }, 'Weiter'))); }
    if (step === 5) body.push(h('h1', {}, 'Ersten Termin anlegen'), h('p', { class: 'lead' }, 'Im Kalender legst du fest, was wann auf welchem Bildschirm läuft.'), h('button', { class: 'btn big', onclick: async () => { await put('/settings', { 'wizard.done': 'true' }); location.hash = '#/kalender'; done(); } }, 'Zum Kalender'));
    box.replaceChildren(...body, h('p', { style: 'margin-top:20px' }, skip));
  }
  draw(); return box;
}
