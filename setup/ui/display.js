// Bildschirmanzeige im Einrichtungsmodus: nie schwarz, nie Konsolentext.
const app = document.getElementById('app');
const h = (t, a = {}, ...k) => { const e = document.createElement(t); for (const [x, v] of Object.entries(a)) e.setAttribute(x, v); e.append(...k.flat().filter((y) => y != null)); return e; };
const logo = () => h('img', { src: '/logo.svg', alt: 'Deutsches Fußballmuseum', style: 'height:9vh' });
const qr = (svg) => { const d = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR-Code' }); d.innerHTML = svg; return d; }; // SVG stammt vom lokalen Server (qrcode), nicht aus Nutzereingaben
let last = '';
async function tick() {
  let s; try { s = await (await fetch('/state', { cache: 'no-store' })).json(); } catch { return; }
  const key = JSON.stringify(s); if (key === last) return; last = key;
  if (s.phase === 'step1') app.replaceChildren(logo(), h('h1', { class: 'big' }, 'Schritt 1: Handy verbinden'), h('div', { class: 'cols' }, qr(s.qrSvg),
    h('div', {}, h('p', {}, 'Mit dem Handy scannen'), h('p', {}, 'Netzwerk: ', h('b', {}, s.ssid)), h('p', {}, 'Passwort: ', h('b', {}, s.password)), h('ol', {}, s.steps.map((x) => h('li', {}, x))))));
  else if (s.phase === 'step2') app.replaceChildren(logo(), h('h1', { class: 'big' }, 'Schritt 2: Einrichtung öffnen'), h('div', { class: 'cols' }, qr(s.qrSvg),
    h('div', {}, h('p', {}, 'Scanne diesen Code oder öffne ', h('b', {}, s.url), ' im Browser.'), h('p', {}, 'Gib dort diese PIN ein:'), h('p', { class: 'pin' }, s.pin))));
  else app.replaceChildren(logo(), h('h1', { class: 'big' }, s.phase === 'done' ? 'Fertig!' : 'Einen Moment bitte …'), h('p', {}, s.message ?? 'Der Bildschirm wird vorbereitet …'));
}
setInterval(tick, 1000); tick();
