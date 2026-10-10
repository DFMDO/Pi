// Demo-Hub mit Beispieldaten – zum Ansehen und Prüfen der Oberfläche (Design, Anleitung, Handy-Ansicht).
// Nur lokal: http://127.0.0.1:8765 (ohne Verschlüsselung, Daten liegen in einem Wegwerf-Ordner). Anmeldung: Benutzer „admin“, Passwort siehe unten.
// Aufruf: node tools/demo-hub.mjs      (vorher einmal: npm run build:ui)
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { makeHub, PW, multipart } from '../hub/test/helpers.js';

const PORT = Number(process.env.PORT ?? 8765);
const h = await makeHub({});
setInterval(() => { h.clock.t = Date.now(); }, 1000).unref(); // echte Uhr (die Test-Uhr steht sonst still)
await h.app.listen({ port: PORT, host: '127.0.0.1' });
const admin = await h.as('admin');
const db = h.db, now = Date.now();
db.prepare("INSERT OR REPLACE INTO settings VALUES('wizard.done','true')").run();

// ---- Gruppen und Bildschirme
const grp = async (name, color) => (await admin('POST', '/api/v1/groups', { name, color })).json().id;
const [gFoyer, gAusstellung, gShop] = [await grp('Foyer', '#2a6f97'), await grp('Ausstellung', '#c8102e'), await grp('Shop & Café', '#2d6a4f')];
const dev = (name, ago, model, group, extra = {}) => {
  const id = randomUUID(), st = { cpuTemp: 51 + Math.round(Math.random() * 14), ramUsedMB: 310, ramTotalMB: 1024, signalDbm: -58, diskFreeMB: 18000, version: '0.2.29', uptimeS: 90000, syncState: { done: 12, total: 12 }, ...extra };
  db.prepare("INSERT INTO devices(id,name,profile,status,last_seen,model,group_id,created_at,state_json,location) VALUES(?,?,?,'active',?,?,?,?,?,?)").run(id, name, model.includes('3') ? 'lite' : 'standard', now - ago, model, group, now - 86400000 * 40, JSON.stringify(st), extra.location ?? null);
  return id;
};
const online = [dev('Foyer-Eingang', 5000, 'Raspberry Pi 4 Model B', gFoyer), dev('Foyer-Kasse', 8000, 'Raspberry Pi 4 Model B', gFoyer), dev('Halle 1 – Weltmeister', 4000, 'Raspberry Pi 3 Model B+', gAusstellung), dev('Halle 2 – Legenden', 9000, 'Raspberry Pi 3 Model B+', gAusstellung)];
dev('Museumsshop', 12 * 60000, 'Raspberry Pi 3 Model B+', gShop, { cpuTemp: 74 }); // offline seit 12 Minuten, heiß
dev('Café-Terrasse', 30 * 3600000, 'Raspberry Pi 3 Model B', gShop, { signalDbm: -81 }); // seit 30 Stunden offline, schwaches WLAN
setInterval(() => { for (const id of online) db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(Date.now() - 4000, id); }, 15000).unref();

// ---- Medien: erzeugte Bilder, Text-Folien
const palette = [['#c8102e', '#5a0b16', 'Willkommen im DFM'], ['#0b3d91', '#06214d', 'Die Weltmeister'], ['#1b7f3b', '#0b3d1c', 'Fußball erleben'], ['#f2a900', '#8a5a00', 'Sonderausstellung'], ['#4a2c82', '#22123f', 'Legenden des Spiels'], ['#14213d', '#000814', 'Das Wunder von Bern']];
const mediaIds = [];
for (const [c1, c2, t] of palette) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="1500" cy="260" r="180" fill="#ffffff22"/><circle cx="1650" cy="780" r="320" fill="#ffffff14"/><text x="140" y="600" font-family="DejaVu Sans, Arial, sans-serif" font-size="130" font-weight="700" fill="#fff">${t}</text></svg>`;
  const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer(); const m = multipart('file', `${t}.jpg`, jpg);
  const r = await admin('POST', '/api/v1/media', m.payload, m.headers); mediaIds.push(r.json().id ?? r.json().ids?.[0]);
}
const text = async (name, title, body, template) => (await admin('POST', '/api/v1/media/text', { name, title, body, template })).json().id;
const t1 = await text('Heute geöffnet', 'Heute geöffnet bis 18 Uhr', 'Letzter Einlass um 17 Uhr. Führungen starten um 11 und 14 Uhr.', 'standard');
const t2 = await text('Sommer-Aktion', 'Sommer-Aktion im Shop', 'Alle Trikots 20 % günstiger – nur diese Woche.', 'highlight');
const t3 = await text('Hinweis Garderobe', 'Garderobe im Untergeschoss', 'Große Taschen und Rucksäcke bitte an der Garderobe abgeben.', 'hinweis');
const t4 = await text('Frage des Tages', 'Wer schoss das Tor zum 3:2 in Bern?', 'Die Antwort sehen Sie in der nächsten Folie.', 'frage');
await h.app.variants.idle();

// ---- Listen, Termine, Szene
const defaultList = db.prepare('SELECT id FROM playlists WHERE is_default=1').get().id;
await admin('PUT', `/api/v1/playlists/${defaultList}`, { items: [{ mediaId: mediaIds[0], duration: 10 }, { mediaId: t1, duration: 8 }, { mediaId: mediaIds[1], duration: 10 }, { mediaId: t3, duration: 8 }], publish: true });
const mkList = async (name, items, publish = true) => { const id = (await admin('POST', '/api/v1/playlists', { name })).json().id; await admin('PUT', `/api/v1/playlists/${id}`, { items, publish }); return id; };
const listA = await mkList('Ausstellung – Weltmeister', [{ mediaId: mediaIds[1], duration: 12 }, { mediaId: mediaIds[5], duration: 12 }, { mediaId: t4, duration: 8 }]);
const listShop = await mkList('Shop-Aktion', [{ mediaId: t2, duration: 10 }, { mediaId: mediaIds[3], duration: 10 }]);
await mkList('Neue Sonderausstellung (Entwurf)', [{ mediaId: mediaIds[3], duration: 10 }, { mediaId: mediaIds[4], duration: 10 }], false);
const d0 = new Date(), mon = new Date(d0); mon.setDate(d0.getDate() - ((d0.getDay() + 6) % 7));
const day = (n) => { const x = new Date(mon); x.setDate(mon.getDate() + n); return x.toISOString().slice(0, 10); };
const sched = (target, id, a, from, to, pri = 5) => admin('POST', '/api/v1/schedules', { publish: true, targetType: 'group', targetId: target, content: { type: 'playlist', id }, startLocal: `${day(a)}T${from}`, endLocal: `${day(a)}T${to}`, priority: pri });
await sched(gAusstellung, listA, 0, '09:00', '18:00'); await sched(gAusstellung, listA, 2, '09:00', '18:00'); await sched(gShop, listShop, 1, '10:00', '14:00'); await sched(gShop, listShop, 4, '08:00', '18:00'); await sched(gFoyer, listShop, 3, '12:00', '15:00');
await admin('POST', '/api/v1/scenes', { name: 'Eröffnung Sonderausstellung', items: [{ scope: 'all', content: { type: 'playlist', id: listA } }], publish: true });
await admin('POST', '/api/v1/scenes', { name: 'Schulklassen-Tag', items: [{ scope: 'group', targetId: gAusstellung, content: { type: 'playlist', id: listA } }, { scope: 'group', targetId: gFoyer, content: { type: 'playlist', id: defaultList } }], publish: true });
// ein paar Wiedergaben und Messwerte, damit Betrieb und Nachweis nicht leer sind
console.log(`\nDemo-Hub läuft: http://127.0.0.1:${PORT}   Anmeldung: admin / ${PW}   (Redakteur: edi, Anzeige: vera – gleiches Passwort)\n`);
