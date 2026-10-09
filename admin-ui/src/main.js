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

const app = document.getElementById('app');
const NAV = [['#/', 'Startseite', '🏠', homePage], ['#/live', 'Live', '📺', livePage], ['#/bildschirme', 'Bildschirme', '🖥️', devicesPage], ['#/grundriss', 'Grundriss', '🗺️', grundrissPage], ['#/medien', 'Bilder & Videos', '🖼️', mediaPage], ['#/listen', 'Abspiellisten', '▶️', playlistsPage],
  ['#/kalender', 'Kalender', '📅', calendarPage], ['#/szenen', 'Szenen', '🎬', scenesPage], ['#/betrieb', 'Betrieb', '🩺', betriebPage], ['#/hilfe', 'Hilfe', '❓', helpPage]];
const ADMIN = [['#/benutzer', 'Benutzer', '👥', usersPage, 'users.manage'], ['#/protokoll', 'Protokoll', '📜', auditPage, 'audit.read'], ['#/einstellungen', 'Erweitert', '⚙️', settingsPage, 'settings.manage']];

async function boot() {
  const s = await fetch('/api/v1/setup/state').then((r) => r.json()).catch(() => null);
  if (s?.needsAdmin) return app.replaceChildren(firstSetupPage(boot));
  try { const me = await get('/auth/me'); state.user = me.user; state.csrf = me.csrf; } catch { state.user = null; }
  route();
}
const navFor = () => (state.user?.role === 'anzeige' ? NAV.filter((n) => ['#/live', '#/hilfe'].includes(n[0])) : [...NAV, ...ADMIN.filter((a) => can(a[4]))]);
async function route() {
  const path = location.hash || '#/';
  if (path === '#/wand') return app.replaceChildren(await wallPage());
  if (!state.user) return app.replaceChildren(loginPage(async (u, csrf) => { state.user = u; state.csrf = csrf; location.hash = '#/'; route(); }));
  state.settings = await get('/settings').catch(() => ({}));
  if (state.user.role === 'admin' && state.settings['wizard.done'] !== 'true' && path !== '#/hilfe') return mount(wizardPage(() => { state.settings['wizard.done'] = 'true'; route(); }, route), null);
  if (state.user.role === 'anzeige' && !['#/live', '#/hilfe'].includes(path)) { location.hash = '#/live'; return; }
  const liveId = /^#\/live\/([0-9a-f-]{36})$/.exec(path)?.[1];
  const page = liveId ? [NAV[1][0], NAV[1][1], NAV[1][2], (c) => livePage(c, { openId: liveId })] : navFor().find((n) => n[0] === path) ?? NAV[0];
  const view = h('div', {}, h('p', {}, 'Wird geladen …'));
  mount(view, liveId ? '#/live' : page[0]);
  try { view.replaceWith(await page[3]({ route, pair: pairDialog })); } catch (e) { view.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  $('main')?.querySelector('h1')?.setAttribute('tabindex', '-1'); $('main h1')?.focus({ preventScroll: true });
}
function mount(content, active) {
  const nav = h('nav', { class: 'side', 'aria-label': 'Hauptnavigation' }, h('img', { src: '/logo.svg', alt: 'Deutsches Fußballmuseum' }),
    ...navFor().map(([href, label, icon]) => h('a', { href, 'aria-current': href === active ? 'page' : null, 'data-tour': href }, h('span', { 'aria-hidden': 'true' }, icon), label)),
    h('div', { class: 'grow' }), h('button', { class: 'btn sec', style: 'color:#fff;border-color:#fff', onclick: () => startTour() }, 'Zeig mir, wie das geht'),
    h('button', { class: 'btn sec', style: 'color:#fff;border-color:#fff', 'aria-label': 'Hell oder dunkel umschalten', onclick: toggleTheme }, '🌓 Hell / Dunkel'),
    h('div', { class: 'who' }, `Angemeldet: ${state.user.name} (${ROLES[state.user.role]})`),
    h('button', { class: 'btn sec', style: 'color:#fff;border-color:#fff', onclick: async () => { await post('/auth/logout'); state.user = null; location.hash = '#/login'; route(); } }, 'Abmelden'));
  app.replaceChildren(h('div', { class: 'shell' }, nav, h('main', { id: 'main' }, content)));
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
