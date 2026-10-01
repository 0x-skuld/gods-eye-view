import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

test('links open the app looking straight down on the area', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'https://maps.example/view?x=1' } },
  });
  const result = await catalog.call('open_in_gods_eye_view', {
    area: { lat: 30.2672, lon: -97.7431, radius_km: 5 },
  });
  const url = new URL(result.data.url);
  assert.equal(
    url.origin + url.pathname + url.search,
    'https://maps.example/view?x=1',
  );
  assert.deepEqual(Object.fromEntries(new URLSearchParams(url.hash.slice(1))), {
    v: '2',
    lat: '30.2672',
    lon: '-97.7431',
    alt: '9091',
    heading: '0',
    pitch: '-90',
  });
  assert.equal(
    result.summary,
    `Open 5 km around 30.267, -97.743 in God's Eye View: ${url.href}`,
  );
});

test('altitude is bounded for tiny and planet-sized areas', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:4173/' } },
  });
  const tiny = await catalog.call('open_in_gods_eye_view', {
    area: { lat: 0, lon: 0, radius_km: 0.1 },
  });
  assert.equal(tiny.data.altitude_m, 500);
  const world = await catalog.call('open_in_gods_eye_view', {
    area: { bbox: [-180, -85, 180, 85] },
  });
  assert.equal(world.data.altitude_m, 15000000);
  const broken = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'not a url' } },
  });
  await assert.rejects(
    broken.call('open_in_gods_eye_view', {
      area: { lat: 0, lon: 0, radius_km: 1 },
    }),
    (error) => error.code === 'unavailable',
  );
});
