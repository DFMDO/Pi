import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeHub } from './helpers.js';
import { schedulePayload } from '../lib/plan.js';
import { resolvePlaylist } from '../../shared/sequencer.js';

const TOM = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
const mkDev = (h, name = 'Dev', group = null) => { const id = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,group_id,last_seen,created_at) VALUES(?,?,'standard','active',?,?,?)").run(id, name, group, h.clock.t, h.clock.t); return id; };
const txt = async (a, n) => (await a('POST', '/api/v1/media/text', { name: n, title: n })).json().id;
const plist = async (a, name, m, def = false) => { const id = (await a('POST', '/api/v1/playlists', { name, publish: true })).json().id; await a('PUT', `/api/v1/playlists/${id}`, { items: [{ mediaId: m }], publish: true, ...(def ? { isDefault: true } : {}) }); return id; };
const plan = (h, id) => schedulePayload(h.db, h.db.prepare('SELECT * FROM devices WHERE id=?').get(id), h.clock.t);

test('Übersteuerung: Bestätigung nötig, schlägt Termine, läuft ab, auch ohne Hub (until im Plan)', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h);
  const m1 = await txt(a, 'Normal'), m2 = await txt(a, 'Sofort'), p1 = await plist(a, 'P1', m1, true), p2 = await plist(a, 'P2', m2);
  await a('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: dv, content: { type: 'playlist', id: p1 }, startLocal: `${TOM}T00:00`, endLocal: `${TOM}T23:59` });
  assert.equal((await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'playlist', id: p2 }, minutes: 30 })).statusCode, 409);
  const r = await a('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'playlist', id: p2 }, minutes: 30, confirm: true }); assert.equal(r.statusCode, 201); assert.match(r.json().text, /Danach läuft der normale Plan/);
  const pl = plan(h, dv); assert.equal(pl.overrides.length, 1);
  assert.equal(resolvePlaylist(pl, h.clock.t).source, 'uebersteuerung'); assert.equal(resolvePlaylist(pl, h.clock.t).playlistId, p2);
  assert.equal(resolvePlaylist(pl, h.clock.t + 31 * 60000).source, 'standard', 'nach Ablauf zurück zum Plan – auch bei einem Player, der den Hub nicht erreicht');
  const live = (await a('GET', `/api/v1/live/${dv}`)).json(); assert.match(live.soll.origin, /Schnellaktion für alle Bildschirme von admin/); assert.equal(live.overrides.length, 1);
  assert.equal((await a('DELETE', `/api/v1/overrides/${pl.overrides[0].id}`)).statusCode, 200);
  assert.equal(plan(h, dv).overrides.length, 0);
  assert.ok(h.db.prepare("SELECT 1 FROM audit_log WHERE action='uebersteuerung.gestartet'").get() && h.db.prepare("SELECT 1 FROM audit_log WHERE action='uebersteuerung.beendet'").get(), 'Audit');
  const ed = await h.as('edi'); assert.equal((await ed('POST', '/api/v1/overrides', { scope: 'device', targetId: dv, content: { type: 'playlist', id: p2 }, endOfDay: true })).statusCode, 201);
  const v = await h.as('vera'); assert.equal((await v('POST', '/api/v1/overrides', { scope: 'all', content: { type: 'playlist', id: p2 }, confirm: true })).statusCode, 403);
  await h.cleanup();
});

test('Szenen: Entwurf → veröffentlichen → starten/stoppen für mehrere Bildschirme', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const d1 = mkDev(h, 'A'), d2 = mkDev(h, 'B');
  const m = await txt(a, 'Eröffnung'), p = await plist(a, 'Eröffnung', m);
  const sc = (await a('POST', '/api/v1/scenes', { name: 'Eröffnung', items: [{ scope: 'device', targetId: d1, content: { type: 'playlist', id: p } }, { scope: 'device', targetId: d2, content: { type: 'playlist', id: p } }] })).json();
  assert.equal((await a('POST', `/api/v1/scenes/${sc.id}/start`, { confirm: true })).statusCode, 400, 'Entwurf läuft nie');
  await a('POST', `/api/v1/scenes/${sc.id}/publish`);
  assert.equal((await a('POST', `/api/v1/scenes/${sc.id}/start`, {})).statusCode, 409);
  assert.equal((await a('POST', `/api/v1/scenes/${sc.id}/start`, { confirm: true, endOfDay: true })).statusCode, 200);
  assert.equal(plan(h, d1).overrides[0].label, 'Eröffnung'); assert.equal(plan(h, d2).overrides.length, 1);
  assert.equal((await a('GET', '/api/v1/scenes')).json()[0].active, true);
  await a('POST', `/api/v1/scenes/${sc.id}/stop`); assert.equal(plan(h, d1).overrides.length, 0);
  await h.cleanup();
});

test('Gesundheit: Netzteil, Wartungsmodus (stumm + Halt im Plan + Mahnung nach 24 h), Verfügbarkeit', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const dv = mkDev(h, 'Foyer');
  h.db.prepare('UPDATE devices SET state_json=? WHERE id=?').run(JSON.stringify({ throttled: 0x50005, cpuTemp: 81, signalDbm: -80, diskFreeMB: 100 }), dv);
  let hl = (await a('GET', '/api/v1/health')).json()[0]; assert.equal(hl.level, 'bad'); assert.ok(hl.warnings.some((w) => /Netzteil zu schwach/.test(w.text))); assert.ok(hl.warnings.some((w) => /zu heiß/.test(w.text))); assert.ok(hl.warnings.some((w) => /WLAN/.test(w.text)));
  assert.equal((await a('POST', `/api/v1/devices/${dv}/maintenance`, { on: true })).statusCode, 200);
  assert.equal(plan(h, dv).hold, 'wartung'); assert.equal(resolvePlaylist(plan(h, dv), h.clock.t).playlistId, null);
  hl = (await a('GET', '/api/v1/health')).json()[0]; assert.equal(hl.warnings.length, 0, 'Wartung: stumm');
  h.clock.t += 25 * 3600000; h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(h.clock.t, dv);
  const a2 = await h.as('admin'); hl = (await a2('GET', '/api/v1/health')).json()[0]; assert.match(hl.warnings[0].text, /seit über 24 Stunden im Wartungsmodus/);
  await a2('POST', `/api/v1/devices/${dv}/maintenance`, { on: false });
  // Ausfall erfassen
  h.app.extras.eventTick(); h.clock.t += 120000; h.app.extras.eventTick(); h.clock.t += 300000; h.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(h.clock.t, dv); h.app.extras.eventTick();
  const av = (await a2('GET', `/api/v1/devices/${dv}/availability?days=30`)).json(); assert.equal(av.outages.length, 1); assert.ok(av.outages[0].durationS >= 300); assert.ok(av.uptimePercent < 100);
  const wk = (await a2('GET', '/api/v1/report/weekly')).json(); assert.equal(wk.devices[0].outages, 1);
  await h.cleanup();
});

test('Gerät austauschen: Name, Gruppe, Termine und Einstellungen wandern, alter Token gesperrt', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const old = mkDev(h, 'Shop-Screen');
  h.db.prepare('UPDATE devices SET orientation=90, location=? WHERE id=?').run('Shop', old);
  const m = await txt(a, 'X'), p = await plist(a, 'P', m);
  const s = (await a('POST', '/api/v1/schedules', { publish: true, targetType: 'device', targetId: old, content: { type: 'playlist', id: p }, startLocal: `${TOM}T10:00`, endLocal: `${TOM}T12:00` })).json();
  const nw = randomUUID(); h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?, 'standard','pending',?)").run(nw, 'Neuer Pi', h.clock.t);
  assert.equal((await a('POST', `/api/v1/devices/${nw}/approve`, { replaces: old })).statusCode, 200);
  const n = h.db.prepare('SELECT * FROM devices WHERE id=?').get(nw), o = h.db.prepare('SELECT * FROM devices WHERE id=?').get(old);
  assert.equal(n.name, 'Shop-Screen'); assert.equal(n.orientation, 90); assert.equal(n.location, 'Shop'); assert.equal(n.ready, 1, 'Ersatz erbt „bereit“');
  assert.equal(h.db.prepare('SELECT target_id FROM schedules WHERE id=?').get(s.id).target_id, nw);
  assert.equal(o.status, 'blocked'); assert.equal(o.token_hash, null); assert.match(o.name, /ersetzt/);
  await h.cleanup();
});

test('Neues Gerät ist erst nach Inbetriebnahme „bereit“ (Standby statt Plan)', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const nw = randomUUID();
  h.db.prepare("INSERT INTO devices(id,name,profile,status,created_at) VALUES(?,?, 'standard','pending',?)").run(nw, 'Neu', h.clock.t);
  await a('POST', `/api/v1/devices/${nw}/approve`, {}); assert.equal(h.db.prepare('SELECT ready FROM devices WHERE id=?').get(nw).ready, 0);
  assert.equal(plan(h, nw).hold, 'nicht_bereit'); await h.cleanup();
});

test('WLAN: Aufstellmodus, Empfangsübersicht (schlechtester zuerst, AP-Wechsel), Klartext-Warnung', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const d1 = mkDev(h, 'Foyer'), d2 = mkDev(h, 'Shop');
  h.db.prepare('UPDATE devices SET floor=? WHERE id=?').run('1.OG', d1);
  const set = (id, dbm, bssid) => h.db.prepare('UPDATE devices SET state_json=?, last_seen=? WHERE id=?').run(JSON.stringify({ signalDbm: dbm, wifi: { bssid, ssid: 'DFM', channel: 6, band: '2,4 GHz' }, reconnects: 1 }), h.clock.t, id);
  set(d1, -80, 'aa:aa:aa:aa:aa:aa'); set(d2, -50, 'bb:bb:bb:bb:bb:bb'); h.app.extras.eventTick(); h.clock.t += 301000; set(d1, -80, 'cc:cc:cc:cc:cc:cc'); set(d2, -50, 'bb:bb:bb:bb:bb:bb'); h.app.extras.eventTick();
  const r = (await a('GET', '/api/v1/reception?range=24h')).json(); assert.equal(r.devices[0].name, 'Foyer', 'schlechtester Empfang zuerst'); assert.equal(r.devices[0].quality.label, 'Zu schwach');
  assert.match(r.devices[0].warning, /Foyer \(1\.OG\): Empfang zu schwach/); assert.equal(r.devices[0].apChanges.length, 1); assert.ok(r.hint, 'gleicher 2,4-GHz-Kanal erkannt'); assert.match(r.explain, /keine Funkmessung/);
  const w = (await a('POST', `/api/v1/devices/${d1}/signal-watch`)).json(); assert.ok(w.expiresAt - h.clock.t <= 15 * 60000 + 1);
  h.app.devices.signals.set(d1, { dbm: -60, ts: h.clock.t, wifi: null }); const s = (await a('GET', `/api/v1/devices/${d1}/signal`)).json(); assert.equal(s.label, 'Gut'); assert.equal(s.bars, 3);
  await h.cleanup();
});

test('Geräteliste als CSV (Excel-tauglich, mit Schutz vor Formel-Einschleusung); Anzeige darf nicht', async () => {
  const h = await makeHub(); const a = await h.as('admin'); const d = mkDev(h, '=HYPERLINK("x")');
  const r = await a('GET', '/api/v1/devices.csv'); assert.equal(r.statusCode, 200); assert.ok(r.body.startsWith('﻿Name;Modell;Seriennummer;MAC;Standort;Etage;Gruppe;Einbaudatum;Version;Status'));
  assert.ok(r.body.includes("'=HYPERLINK"), 'führendes = entschärft'); void d;
  const v = await h.as('vera'); assert.equal((await v('GET', '/api/v1/devices.csv')).statusCode, 403); await h.cleanup();
});

test('Rechte: Gruppeneinschränkung in der Live-Ansicht; Wandmodus-Token liest nur', async () => {
  const h = await makeHub(); const a = await h.as('admin');
  const g1 = (await a('POST', '/api/v1/groups', { name: 'EG', color: '#c8102e' })).json().id, g2 = (await a('POST', '/api/v1/groups', { name: 'OG', color: '#2a6f97' })).json().id;
  const d1 = mkDev(h, 'Unten', g1), d2 = mkDev(h, 'Oben', g2);
  const users = (await a('GET', '/api/v1/users')).json(), vera = users.find((u) => u.name === 'vera');
  assert.equal((await a('PATCH', `/api/v1/users/${vera.id}`, { groups: [g1] })).statusCode, 200);
  const v = await h.as('vera'); const live = (await v('GET', '/api/v1/live')).json(); assert.deepEqual(live.map((x) => x.name), ['Unten']);
  assert.equal((await v('GET', `/api/v1/live/${d2}`)).statusCode, 404, 'nicht erlaubte Gruppe'); assert.equal((await v('GET', `/api/v1/live/${d1}`)).statusCode, 200);
  // Wandmodus
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/live' })).statusCode, 401, 'ohne Anmeldung');
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/live', headers: { 'x-live-token': 'falsch' } })).statusCode, 401, 'falsches Token');
  const tk = (await a('POST', '/api/v1/live-tokens', { name: 'Technikraum' })).json().token;
  const ok = await h.app.inject({ method: 'GET', url: '/api/v1/live', headers: { 'x-live-token': tk } }); assert.equal(ok.statusCode, 200); assert.equal(ok.json().length, 2);
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { 'x-live-token': tk } })).statusCode, 401, 'Token gilt nur für die Live-Ansicht');
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/overrides', headers: { 'x-live-token': tk }, payload: {} })).statusCode, 401);
  const wl = await h.app.inject({ method: 'POST', url: '/api/v1/live/wall-login', payload: { token: tk } }); assert.equal(wl.statusCode, 200); assert.match(wl.headers['set-cookie'], /__Host-dfm_wall=.*HttpOnly.*Secure/);
  assert.equal((await h.app.inject({ method: 'POST', url: '/api/v1/live/wall-login', payload: { token: 'nein' } })).statusCode, 401);
  await h.cleanup();
});
