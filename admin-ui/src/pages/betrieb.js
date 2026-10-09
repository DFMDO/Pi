// Betrieb: Gesundheit & Wartung (Z.3), WLAN-Empfang (Z.15), Wochenbericht, Geräteprofil, Bildschirm ersetzen (Z.4).
import { h, dialog, confirmDlg, toast, field, statusEl, fmtDate, empty } from '../ui.js';
import { get, post, put, can } from '../api.js';
import { layoutPanel } from './tools.js';
import { lineChart } from './charts.js';
import { playsView } from './nachweis.js';
import { prognoseView } from './prognose.js';

const dur = (s) => (s < 90 ? `${s} Sekunden` : s < 5400 ? `${Math.round(s / 60)} Minuten` : s < 172800 ? `${Math.round(s / 3600)} Stunden` : `${Math.round(s / 86400)} Tage`);
const bars = (n) => h('span', { class: 'sigbars', 'aria-hidden': 'true' }, [1, 2, 3, 4].map((i) => h('i', { class: i <= n ? 'on' : '' })));
const spark = (series) => { const pts = series.map((p) => p.dbm).filter((x) => x != null); if (!pts.length) return h('span', { class: 'hint' }, 'noch keine Messwerte');
  return h('span', { class: 'spark', role: 'img', 'aria-label': `Verlauf, zuletzt ${pts[pts.length - 1]} dBm` }, series.map((p) => h('i', { style: `height:${p.dbm == null ? 2 : Math.max(4, Math.min(30, (p.dbm + 95) * 0.75))}px` }))); };

export async function betriebPage({ route }) {
  let tab = 'gesundheit'; const root = h('div', {}, h('h1', {}, 'Betrieb'), h('p', { class: 'lead' }, 'Geht es den Bildschirmen gut? Hier siehst du Warnungen, Empfang und den Wochenbericht.')), tabs = h('div', { class: 'row', role: 'tablist' }), view = h('div', {});
  const TABS = [['gesundheit', '🩺 Gesundheit'], ['verlauf', '📈 Verlauf'], ['prognose', '🔮 Prognose'], ['verbindung', '🔌 Verbindung'], ['empfang', '📶 WLAN-Empfang'], ['bericht', '📄 Wochenbericht'], ['layout', '🧱 Laufband & Zonen'], ['wiedergabe', '🎞️ Wiedergabe']];
  const show = async () => { tabs.replaceChildren(...TABS.map(([k, t]) => h('button', { class: 'chip', role: 'tab', 'aria-pressed': tab === k, onclick: () => { tab = k; show(); } }, t)));
    view.replaceChildren(h('p', {}, 'Wird geladen …')); try { view.replaceChildren(await { gesundheit: health, verlauf: history, prognose: prognoseView, verbindung: connection, empfang: reception, bericht: report, layout: layoutPanel, wiedergabe: playsView }[tab](route)); } catch (e) { view.replaceChildren(h('div', { class: 'notice bad' }, e.message)); } };
  root.append(tabs, view); await show(); return root;
}

async function health(route) {
  const hl = await get('/health'); if (!hl.length) return empty('Noch kein Bildschirm', 'Verbinde zuerst einen Bildschirm.');
  return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr))' }, hl.map((d) => h('article', { class: 'card' }, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, d.name), h('span', { class: 'sp' }), d.maintenance ? h('span', { class: 'status warn' }, '🔧 Wartung') : statusEl(d.status)),
    d.warnings.length ? d.warnings.map((w) => h('p', { class: 'notice' + (w.level === 'bad' ? ' bad' : '') }, (w.level === 'bad' ? '✖ ' : '▲ ') + w.text)) : h('p', {}, d.maintenance ? 'Im Wartungsmodus sind Warnungen stumm.' : '✔ Alles in Ordnung.'),
    d.metrics ? h('p', { class: 'hint' }, `${d.metrics.tempC ?? '–'} °C · frei ${d.metrics.diskFreeMB ?? '–'} MB · Signal ${d.metrics.signalDbm ?? '–'} dBm · Version ${d.metrics.version ?? '–'}`) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => deviceDlg(d.id, route) }, 'Profil & Verlauf'), can('devices.manage') ? h('button', { class: 'btn sec', onclick: () => commissioning(d.id, d.name, route) }, 'Bildschirm prüfen') : null))));
}

/** Verlauf: freier Speicher, Temperatur und Last von Hub und Bildschirmen (Lecks und Hitze sieht man als Kurve) */
async function history() {
  let src = 'hub', hours = '24'; const devices = (await get('/devices')).filter((d) => d.status.level !== 'pending');
  const sel = h('select', { 'aria-label': 'Gerät wählen', onchange: () => { src = sel.value; draw(); } }, h('option', { value: 'hub' }, 'Hub'), devices.map((d) => h('option', { value: d.id }, d.name)));
  const bar = h('div', { class: 'row', style: 'margin:8px 0' }), box = h('div', {});
  async function draw() {
    bar.replaceChildren(h('label', { class: 'hint' }, 'Gerät: '), sel, h('span', { class: 'sp' }), ...[['6', '6 Stunden'], ['24', '24 Stunden'], ['168', '7 Tage']].map(([k, t]) => h('button', { class: 'chip', 'aria-pressed': hours === k, onclick: () => { hours = k; draw(); } }, t)));
    box.replaceChildren(h('p', {}, 'Wird geladen …'));
    try {
      const r = await get(`/metrics?src=${encodeURIComponent(src)}&hours=${hours}`), hr = Number(hours);
      box.replaceChildren(...r.hints.map((t) => h('div', { class: 'notice' }, '▲ ', t)),
        lineChart({ points: r.points, key: 'memAvailMB', title: 'Freier Arbeitsspeicher', unit: 'MB', warn: 100, hours: hr }),
        lineChart({ points: r.points, key: 'tempC', title: 'Temperatur', unit: '°C', decimals: 1, warn: 80, hours: hr }),
        lineChart({ points: r.points, key: 'load1', title: 'Prozessorlast (1 Minute, 4 = voll ausgelastet)', unit: '', decimals: 2, hours: hr }),
        h('p', { class: 'hint' }, 'Gemessen wird etwa einmal pro Minute, die Werte bleiben 14 Tage gespeichert. Ein dauerhaft sinkender freier Speicher spricht für ein Speicherleck; ein Wert dauerhaft unter der gestrichelten Linie ist knapp.'));
    } catch (e) { box.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  }
  await draw(); return h('div', {}, bar, box);
}

/** Verbindungstest: Was funktioniert, was nicht – und was tun? (z. B. Firewall zwischen Netzen) */
async function connection(route) {
  const r = await get('/system/connectivity'); const skew = Math.abs(r.now - Date.now());
  const ICON = { ok: '✔', warn: '▲', bad: '✖', info: 'ℹ' }, checks = [...r.checks];
  checks.splice(2, 0, { id: 'browser', level: 'ok', title: 'Dieser Computer', text: `Du bist über ${location.host} mit dem Hub verbunden.`, hint: null });
  if (skew > 120000) checks.push({ id: 'browseruhr', level: 'warn', title: 'Uhr dieses Computers', text: 'Die Uhr des Hubs weicht um mehr als 2 Minuten von der Uhr dieses Computers ab.', hint: 'Auf der Startseite „Uhr mit diesem Computer abgleichen“ wählen (wenn diese Uhr stimmt).' });
  const itText = `Wir testen ein lokales Beschilderungssystem auf einem Raspberry Pi (Hostname dfm-signage${r.addresses.length ? ', Adresse ' + r.addresses.join(' / ') : ''}).\nBitte erlauben Sie von den Verwaltungs-PCs und den Bildschirm-Pis TCP 443 und 80 zu dieser Adresse, gern mit fester IP-Reservierung.\nEs wird keine Verbindung ins Internet benötigt.`;
  const head = r.worst === 'ok' ? h('div', { class: 'notice' }, '✔ Alles in Ordnung.') : h('div', { class: 'notice' + (r.worst === 'bad' ? ' bad' : '') }, (r.worst === 'bad' ? '✖ ' : '▲ ') + 'Es gibt Punkte, die du dir ansehen solltest.');
  return h('div', {}, head,
    h('div', { class: 'checks' }, checks.map((c) => h('article', { class: 'card check ' + c.level }, h('div', { class: 'row' }, h('span', { class: 'status ' + (c.level === 'info' ? '' : c.level), 'aria-hidden': 'true' }, ICON[c.level]), h('h3', { style: 'margin:0' }, c.title)), h('p', { style: 'margin:6px 0 0' }, c.text), c.hint ? h('p', { class: 'hint', style: 'margin:4px 0 0' }, c.hint) : null))),
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn', onclick: () => route() }, '🔄 Erneut prüfen')),
    h('details', { style: 'margin-top:16px' }, h('summary', {}, 'Text für die IT (zum Kopieren)'), h('pre', { class: 'itbox' }, itText),
      h('button', { class: 'btn sec', onclick: async () => { try { await navigator.clipboard.writeText(itText); toast('Kopiert.'); } catch { toast('Bitte den Text markieren und mit Strg+C kopieren.', 'err'); } } }, 'Text kopieren')));
}

async function reception(route) {
  let range = '24h'; const box = h('div', {}), bar = h('div', { class: 'row', style: 'margin:8px 0' });
  async function draw() {
    const r = await get(`/reception?range=${range}`); bar.replaceChildren(...[['24h', '24 Stunden'], ['7d', '7 Tage']].map(([k, t]) => h('button', { class: 'chip', 'aria-pressed': range === k, onclick: () => { range = k; draw(); } }, t)), h('span', { class: 'sp' }), h('span', { class: 'hint' }, r.explain));
    box.replaceChildren(r.hint ? h('div', { class: 'notice' }, '📡 ', r.hint) : null, ...r.devices.filter((d) => d.warning).map((d) => h('div', { class: 'notice' }, '▲ ', d.warning)),
      h('table', {}, h('thead', {}, h('tr', {}, ['Bildschirm', 'Empfang', 'Verlauf', 'Wiederverbindungen', 'Aussetzer heute', 'Access Point', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.devices.map((d) => h('tr', {}, h('td', {}, d.name, d.location ? h('div', { class: 'hint' }, d.location) : null), h('td', {}, bars(d.quality.bars), ' ', d.quality.label, h('div', { class: 'hint' }, d.signalDbm != null ? `${d.signalDbm} dBm` : '')), h('td', {}, spark(d.series), d.apChanges.length ? h('div', { class: 'hint' }, `↔ ${d.apChanges.length}× Access-Point-Wechsel`) : null),
          h('td', {}, String(d.reconnects)), h('td', {}, String(d.dropoutsToday)), h('td', {}, d.ssid ? `${d.ssid} · Kanal ${d.channel ?? '–'} · ${d.band ?? '–'}` : '–', d.bssid ? h('div', { class: 'hint' }, d.bssid) : null),
          h('td', {}, h('button', { class: 'btn sec', onclick: () => placing(d) }, 'Aufstellmodus'))))))); }
  await draw(); return h('div', {}, bar, box);
}

/** Aufstellmodus: Signal alle 2 s, endet automatisch nach 15 Minuten */
async function placing(d) {
  const r0 = await post(`/devices/${d.id}/signal-watch`).catch((e) => { toast(e.message, 'err'); return null; }); if (!r0) return;
  const big = h('div', { class: 'sigbig', 'aria-live': 'polite' }, '…'), det = h('details', {}, h('summary', {}, 'Erweitert'), h('p', { id: 'dbm' }, '')); let timer = null;
  const dlg = dialog(`Aufstellmodus: ${d.name}`, h('div', {}, h('p', {}, 'Bewege den Bildschirm langsam und beobachte das Signal. Der Modus endet nach 15 Minuten von selbst.'), big, det), [{ text: 'Beenden', fn: () => clearInterval(timer) }]);
  const poll = async () => { if (!document.body.contains(dlg)) return clearInterval(timer); try { const s = await get(`/devices/${d.id}/signal`); big.replaceChildren(bars(s.bars), ' ', h('b', {}, s.label), s.level === 'schwach' || s.level === 'zu_schwach' ? h('div', { class: 'notice' }, 'Bitte den Bildschirm näher an den Access Point stellen.') : null); det.querySelector('#dbm').textContent = s.dbm != null ? `${s.dbm} dBm` : 'kein Wert'; if (!s.active) { clearInterval(timer); big.append(h('p', { class: 'hint' }, 'Der Aufstellmodus ist beendet.')); } } catch {} };
  timer = setInterval(poll, 2000); poll();
}

async function report() {
  const r = await get('/report/weekly');
  return h('div', {}, h('p', { class: 'hint' }, `Zeitraum: ${fmtDate(r.from)} bis ${fmtDate(r.to)}${r.site ? ' · ' + r.site : ''}`), h('p', {}, h('button', { class: 'btn sec', onclick: () => window.print() }, '🖨 Drucken / als PDF speichern'), ' ', h('a', { class: 'btn sec', href: '/api/v1/devices.csv' }, 'Geräteliste (Excel/CSV)')),
    h('table', {}, h('thead', {}, h('tr', {}, ['Bildschirm', 'Verfügbarkeit', 'Ausfälle', 'Längster Ausfall', 'Neustarts', 'Warnungen'].map((x) => h('th', {}, x)))), h('tbody', {}, r.devices.map((d) => h('tr', {}, h('td', {}, d.name), h('td', {}, `${d.uptimePercent} %`), h('td', {}, String(d.outages)), h('td', {}, d.longestOutageS ? dur(d.longestOutageS) : '–'), h('td', {}, String(d.reboots)), h('td', {}, d.warnings.length ? d.warnings.join(' ') : '✔ keine'))))));
}

/** Profil, Verfügbarkeit, Wartungsmodus, Kopieren, Prüfprotokolle */
async function deviceDlg(id, route) {
  const [p, a30, rep] = await Promise.all([get(`/devices/${id}/profile`), get(`/devices/${id}/availability?days=30`), get(`/devices/${id}/commissioning`).catch(() => [])]);
  const f = (k, v, ph = '') => h('input', { value: v ?? '', placeholder: ph, maxlength: 200, 'data-k': k }); const inputs = { location: f('location', p.location, 'z. B. Shop'), floor: f('floor', p.floor, 'z. B. 1.OG'), serial: f('serial', p.serial), mac: f('mac', p.mac), installedAt: h('input', { type: 'date', value: p.installedAt ?? '' }), docUrl: f('docUrl', p.docUrl, 'Adresse der Anleitung'), notes: h('textarea', { rows: 3, maxlength: 2000 }, p.notes ?? '') };
  const body = h('div', {}, h('div', { class: 'grid' }, field('Standort / Raum', inputs.location), field('Etage', inputs.floor), field('Seriennummer', inputs.serial), field('MAC-Adresse', inputs.mac), field('Einbaudatum', inputs.installedAt), field('Link zur Anleitung (Technik-Wiki)', inputs.docUrl)), field('Notizen', inputs.notes),
    h('h3', {}, 'Verfügbarkeit (30 Tage)'), h('p', {}, h('b', {}, `${a30.uptimePercent} %`), ` · ${a30.outages.length} Ausfälle · ${a30.reboots} Neustarts`), a30.outages.length ? h('ul', {}, a30.outages.slice(0, 8).map((o) => h('li', {}, `${fmtDate(o.from)} – ${o.ongoing ? 'dauert an' : fmtDate(o.to)} (${dur(o.durationS)})`))) : null,
    p.docUrl ? h('p', {}, h('a', { href: p.docUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Anleitung öffnen')) : null,
    rep.length ? h('div', {}, h('h3', {}, 'Prüfprotokolle'), h('ul', {}, rep.slice(0, 5).map((x) => h('li', {}, `${fmtDate(x.ts)} – ${x.userName ?? '–'}: ${{ ok: '✔ bestanden', warn: '▲ mit Hinweisen', fail: '✖ nicht bestanden', skipped: '↷ übersprungen' }[x.result]} `, h('a', { href: `#/pruefprotokoll/${x.id}`, onclick: (e) => { e.preventDefault(); printReport(x); } }, 'ansehen'))))) : null);
  const acts = [{ text: 'Schließen', cls: 'sec' }];
  if (can('devices.manage')) acts.unshift({ text: p.maintenance ? 'Wartungsmodus beenden' : 'Wartungsmodus', cls: 'sec', fn: async () => { await post(`/devices/${id}/maintenance`, { on: !p.maintenance }); route(); } },
    { text: 'Speichern', fn: async () => { try { await put(`/devices/${id}/profile`, Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value || null]))); toast('Gespeichert.'); route(); } catch (e) { toast(e.message, 'err'); return false; } } });
  dialog(p.name, body, acts);
}

/** Bildschirm prüfen (Z.14): Inbetriebnahme-Test; Ja/Nein-Fragen am Handy/Computer, während der Bildschirm das Testbild zeigt */
export async function commissioning(id, name, route) {
  const out = h('div', {}, h('p', {}, 'Der Hub prüft jetzt Verbindung, Uhrzeit, Netzteil, Speicher und Synchronisation. Danach stellst du ein paar Fragen zum Bild.')); let q = {};
  const start = async () => { out.replaceChildren(h('p', {}, '⏳ Wird geprüft …'));
    try { const r = await post(`/devices/${id}/commissioning/run`, { answers: q }); draw(r); } catch (e) { out.replaceChildren(h('div', { class: 'notice bad' }, e.message)); } };
  const ICON = { ok: '✔', warn: '▲', fail: '✖', ask: '❓', skip: '–' };
  function draw(r) {
    out.replaceChildren(h('p', {}, h('b', {}, r.result === 'ok' ? '✔ Bestanden – der Bildschirm ist bereit.' : r.result === 'warn' ? '▲ Mit Hinweisen – bitte Hinweise lesen.' : r.result === 'pending' ? '❓ Bitte beantworte die Fragen unten.' : '✖ Nicht bestanden.')),
      h('table', {}, h('tbody', {}, r.items.map((i) => h('tr', {}, h('td', {}, `${ICON[i.status]} ${i.title}`), h('td', {}, i.text, i.hint ? h('div', { class: 'hint' }, i.hint) : null, i.question ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { q[i.id] = true; start(); } }, 'Ja'), h('button', { class: 'btn sec', onclick: () => { q[i.id] = false; start(); } }, 'Nein')) : null))))),
      r.result === 'fail' && can('devices.manage') ? h('button', { class: 'btn sec', onclick: async () => { if (await confirmDlg('Prüfung überspringen?', 'Der Bildschirm gilt dann ohne bestandene Prüfung als bereit. Das wird im Protokoll festgehalten.', 'Bewusst überspringen')) { await post(`/devices/${id}/commissioning/skip`); toast('Übersprungen und protokolliert.'); route(); } } }, 'Bewusst überspringen (Admin)') : null,
      r.reportId ? h('button', { class: 'btn sec', onclick: () => printReport(r) }, '🖨 Protokoll drucken') : null);
  }
  dialog(`Bildschirm prüfen: ${name}`, out, [{ text: 'Schließen', cls: 'sec', fn: () => route?.() }, { text: 'Prüfung starten', fn: () => { start(); return false; } }]); start();
}
function printReport(r) {
  const d = dialog('Prüfprotokoll', h('div', { class: 'printable' }, h('p', {}, `${fmtDate(r.ts ?? Date.now())} · ${r.userName ?? ''}`), h('table', {}, h('tbody', {}, (r.items ?? []).map((i) => h('tr', {}, h('td', {}, `${{ ok: '✔', warn: '▲', fail: '✖', ask: '❓', skip: '–' }[i.status]} ${i.title}`), h('td', {}, i.text))))), h('pre', { class: 'hint' }, JSON.stringify(r.device ?? {}, null, 1))), [{ text: 'Drucken / PDF', fn: () => { window.print(); return false; } }, { text: 'Schließen', cls: 'sec' }]); return d;
}
