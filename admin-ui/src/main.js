// Oberfläche: kleiner Hash-Router, Navigation, Anmeldung. Jede Seite beantwortet:
// Wo bin ich? Was kann ich tun? Was passiert danach?
import { h, $, toast } from './ui.js';
import { api, get, post, state, can, ROLES } from './api.js';
import { loginPage, firstSetupPage } from './pages/login.js';
import { homePage } from './pages/home.js';
import { devicesPage, pairDialog } from './pages/devices.js';
import { mediaPage } from './pages/media.js';
import { playlistsPage } from './pages/playlists.js';
import { calendarPage } from './pages/calendar.js';
import { settingsPage, usersPage, auditPage } from './pages/admin.js';
import { helpPage, startTour } from './pages/help.js';
import { livePage, wallPage } from './pages/live.js';
import { scenesPage } from './pages/quick.js';
import { betriebPage } from './pages/betrieb.js';
import { wizardPage } from './pages/wizard.js';
import { grundrissPage } from './pages/grundriss.js';
import { appsPage } from './pages/apps.js';
import { hubErsatzPage } from './pages/ersatz.js';
import { regelnPage } from './pages/regeln.js';
import { einschuebePage } from './pages/einschuebe.js';

const app = document.getElementById('app');
const NAV = [['#/', 'Startseite', '🏠', homePage], ['#/live', 'Live', '📺', livePage], ['#/bildschirme', 'Bildschirme', '🖥️', devicesPage], ['#/grundriss', 'Grundriss', '🗺️', grundrissPage], ['#/medien', 'Bilder & Videos', '🖼️', mediaPage], ['#/listen', 'Abspiellisten', '▶️', playlistsPage],
  ['#/kalender', 'Kalender', '📅', calendarPage], ['#/szenen', 'Szenen', '🎬', scenesPage], ['#/regeln', 'Regeln', '🤖', regelnPage], ['#/einschuebe', 'Einschübe', '📌', einschuebePage], ['#/apps', 'Apps', '🧩', appsPage], ['#/betrieb', 'Betrieb', '🩺', betriebPage], ['#/hilfe', 'Hilfe', '❓', helpPage]];
const ADMIN = [['#/benutzer', 'Benutzer', '👥', usersPage, 'users.manage'], ['#/protokoll', 'Protokoll', '📜', auditPage, 'audit.read'], ['#/hub-ersatz', 'Hub ersetzen', '🛟', hubErsatzPage, 'backup.manage'], ['#/einstellungen', 'Erweitert', '⚙️', settingsPage, 'settings.manage']];

// Seitenleiste: Gruppen mit Überschrift (nur bei vielen Einträgen sichtbar) und die Zuordnung Seite → Kapitel der Anleitung
const GROUPS = [[null, ['#/', '#/live']], ['Inhalte', ['#/medien', '#/listen', '#/apps']], ['Planen', ['#/kalender', '#/szenen', '#/regeln', '#/einschuebe']], ['Bildschirme', ['#/bildschirme', '#/grundriss']], ['Betrieb', ['#/betrieb', '#/hilfe']], ['Verwaltung', ['#/benutzer', '#/protokoll', '#/hub-ersatz', '#/einstellungen']]];
const HELP_FOR = { '#/': 'startseite', '#/live': 'live', '#/bildschirme': 'bildschirme', '#/grundriss': 'grundriss', '#/medien': 'medien', '#/listen': 'listen', '#/kalender': 'kalender', '#/szenen': 'szenen', '#/regeln': 'regeln', '#/einschuebe': 'einschuebe', '#/apps': 'apps', '#/betrieb': 'gesundheit', '#/benutzer': 'benutzer', '#/protokoll': 'protokoll', '#/hub-ersatz': 'backup', '#/einstellungen': 'einstellungen' };

async function boot() {
  const s = await fetch('/api/v1/setup/state').then((r) => r.json()).catch(() => null);
  if (s?.needsAdmin) return app.replaceChildren(firstSetupPage(boot));
  try { const me = await get('/auth/me'); state.user = me.user; state.csrf = me.csrf; } catch { state.user = null; }
  route();
}
const navFor = () => (state.user?.role === 'anzeige' ? NAV.filter((n) => ['#/live', '#/hilfe'].includes(n[0])) : [...NAV, ...ADMIN.filter((a) => can(a[4]))]);
let lastPath = null;
async function route() {
  const path = location.hash || '#/';
  if (path === '#/wand') return app.replaceChildren(await wallPage());
  if (!state.user) return app.replaceChildren(loginPage(async (u, csrf) => { state.user = u; state.csrf = csrf; location.hash = '#/'; route(); }));
  state.settings = await get('/settings').catch(() => ({}));
  if (state.user.role === 'admin' && state.settings['wizard.done'] !== 'true' && !path.startsWith('#/hilfe')) return mount(wizardPage(() => { state.settings['wizard.done'] = 'true'; route(); }, route), null);
  if (state.user.role === 'anzeige' && !['#/live', '#/hilfe'].includes(path)) { location.hash = '#/live'; return; }
  const liveId = /^#\/live\/([0-9a-f-]{36})$/.exec(path)?.[1];
  const helpId = /^#\/hilfe\/([a-z0-9-]+)$/.exec(path)?.[1], helpNav = NAV.find((n) => n[0] === '#/hilfe');
  const page = liveId ? [NAV[1][0], NAV[1][1], NAV[1][2], (c) => livePage(c, { openId: liveId })] : helpId ? [helpNav[0], helpNav[1], helpNav[2], (c) => helpPage(c, { openId: helpId })] : navFor().find((n) => n[0] === path.split('?')[0]) ?? NAV[0];
  const view = h('div', { 'aria-busy': 'true' }, h('span', { class: 'sr' }, 'Wird geladen …'), h('div', { class: 'skel skel-title' }), h('div', { class: 'skel skel-line' }), h('div', { class: 'skelgrid' }, h('div', { class: 'skel skel-card' }), h('div', { class: 'skel skel-card' }), h('div', { class: 'skel skel-card' })));
  if (path !== lastPath) window.scrollTo({ top: 0, behavior: 'instant' }); lastPath = path; // neue Seite: nach oben (beim bloßen Neuladen derselben Seite bleibt die Stelle)
  mount(view, liveId ? '#/live' : page[0]);
  try { view.replaceWith(await page[3]({ route, pair: pairDialog })); } catch (e) { view.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  addHelpLink(path.split('?')[0]);
  $('main')?.querySelector('h1')?.setAttribute('tabindex', '-1'); $('main h1')?.focus({ preventScroll: true });
}
function mount(content, active) {
  const items = navFor(), link = ([href, label, icon]) => h('a', { href, 'aria-current': href === active ? 'page' : null, 'data-tour': href }, h('span', { class: 'ni', 'aria-hidden': 'true' }, icon), label);
  const used = new Set(), parts = [];
  for (const [title, hrefs] of GROUPS) { const g = hrefs.map((x) => items.find((n) => n[0] === x)).filter(Boolean); if (!g.length) continue; g.forEach((n) => used.add(n[0])); if (title && items.length > 4) parts.push(h('div', { class: 'navgroup' }, title)); parts.push(...g.map(link)); }
  parts.push(...items.filter((n) => !used.has(n[0])).map(link));
  const nav = h('nav', { class: 'side', 'aria-label': 'Hauptnavigation' }, h('div', { class: 'brand' }, h('img', { src: '/logo.svg', alt: 'Deutsches Fußballmuseum' })), ...parts, h('div', { class: 'grow' }),
    h('div', { class: 'userbox' }, h('div', { class: 'who' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, (state.user.name.trim()[0] ?? '?').toUpperCase()), h('span', {}, h('b', {}, state.user.name), h('small', {}, `Angemeldet als ${ROLES[state.user.role]}`))),
      h('button', { class: 'sidebtn', onclick: () => startTour() }, 'Zeig mir, wie das geht'),
      h('button', { class: 'sidebtn', 'aria-label': 'Hell oder dunkel umschalten', onclick: toggleTheme }, '🌓 Hell / Dunkel'),
      h('button', { class: 'sidebtn', onclick: async () => { await post('/auth/logout'); state.user = null; location.hash = '#/login'; route(); } }, 'Abmelden')));
  app.replaceChildren(h('div', { class: 'shell' }, nav, h('main', { id: 'main' }, content)));
}
/** Link „Anleitung zu dieser Seite“ unter der Überschrift (öffnet das passende Kapitel der Hilfe) */
function addHelpLink(path) {
  const id = HELP_FOR[path], main = $('main'), h1 = main?.querySelector('h1'); if (!id || !h1 || main.querySelector('.pagehelp')) return;
  const head = h('div', { class: 'pagehead' }); h1.before(head); head.append(h1, h('a', { class: 'pagehelp', href: '#/hilfe/' + id }, '❓ Anleitung zu dieser Seite'));
}
/** Hell/Dunkel: folgt dem Gerät, kann aber umgeschaltet werden (wird nur lokal im Browser gemerkt) */
function applyTheme() { try { const t = localStorage.getItem('dfm-theme'); if (t) document.documentElement.dataset.theme = t; } catch {} }
function toggleTheme() { const cur = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const n = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('dfm-theme', n); } catch {} }
applyTheme();
window.addEventListener('hashchange', route);
// Abmeldung nach 30 Minuten ohne Aktivität (der Server prüft zusätzlich)
let idle; const bump = () => { clearTimeout(idle); idle = setTimeout(() => { if (state.user) { state.user = null; toast('Du wurdest aus Sicherheitsgründen abgemeldet.', 'err'); route(); } }, 30 * 60000); };
['click', 'keydown', 'pointermove'].forEach((e) => addEventListener(e, bump, { passive: true })); bump();
boot();
