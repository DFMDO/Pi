// Hub im Docker-Container: Hinweise statt Fehler bei Funktionen, die nur am Gerät selbst gehen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.js';

async function mitContainer(fn) {
  const alt = { c: process.env.DFM_CONTAINER, h: process.env.DFM_HUB_HOST };
  process.env.DFM_CONTAINER = '1'; process.env.DFM_HUB_HOST = 'signage.museum.example';
  const h = await makeHub();
  try { await fn(h); } finally {
    await h.cleanup();
    for (const [k, v] of [['DFM_CONTAINER', alt.c], ['DFM_HUB_HOST', alt.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('Docker: Hub meldet Container-Betrieb und seinen Namen', async () => {
  await mitContainer(async (h) => {
    const api = await h.as('admin');
    const r = (await api('GET', '/api/v1/system/hub')).json();
    assert.equal(r.container, true);
    assert.equal(r.host, 'signage.museum.example');
  });
});

test('Docker: Uhr stellen und WLAN wechseln geben eine verständliche Antwort (kein Absturz)', async () => {
  await mitContainer(async (h) => {
    const api = await h.as('admin');
    const t = await api('POST', '/api/v1/system/time', { epoch: Date.now() });
    assert.equal(t.statusCode, 409); assert.match(t.json().error, /Docker/);
    const w = await api('POST', '/api/v1/system/wifi', { ssid: 'Test', password: 'abcdefgh1234' });
    assert.equal(w.statusCode, 409); assert.match(w.json().error, /Docker/);
  });
});

test('Ohne Docker bleibt alles wie bisher (kein Container-Kennzeichen)', async () => {
  const h = await makeHub();
  try {
    const api = await h.as('admin');
    const r = (await api('GET', '/api/v1/system/hub')).json();
    assert.equal(r.container, false);
    assert.equal(r.host, 'dfm-signage.local');
  } finally { await h.cleanup(); }
});
