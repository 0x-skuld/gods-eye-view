import assert from 'node:assert/strict';
import test from 'node:test';
import { areaContains, distanceKm, resolveArea } from './area.js';
import { placeFromGeocodeResult } from './places.js';

test('an area needs exactly one form', async () => {
  for (const area of [
    {},
    { place: 'Oslo', bbox: [0, 0, 1, 1] },
    { lat: 1, lon: 2 },
  ]) {
    await assert.rejects(
      resolveArea(area),
      (error) => error.code === 'invalid_arguments',
    );
  }
  await assert.rejects(
    resolveArea({ bbox: [0, 10, 1, 5] }),
    /south below north/,
  );
});

test('boxes, including antimeridian boxes, contain the expected points', async () => {
  const box = await resolveArea({ bbox: [-10, 40, 10, 50] });
  assert.equal(areaContains(box, { lat: 45, lon: 0 }), true);
  assert.equal(areaContains(box, { lat: 45, lon: 20 }), false);
  const pacific = await resolveArea({ bbox: [170, -20, -170, 0] });
  assert.equal(areaContains(pacific, { lat: -10, lon: 179 }), true);
  assert.equal(areaContains(pacific, { lat: -10, lon: -175 }), true);
  assert.equal(areaContains(pacific, { lat: -10, lon: 0 }), false);
  assert.equal(areaContains(box, { lat: Number.NaN, lon: 0 }), false);
});

test('radius areas use great-circle distance', async () => {
  const circle = await resolveArea({ lat: 37.77, lon: -122.42, radius_km: 50 });
  assert.equal(circle.center.radiusKm, 50);
  assert.equal(areaContains(circle, { lat: 37.8, lon: -122.27 }), true);
  assert.equal(areaContains(circle, { lat: 38.58, lon: -121.49 }), false);
  assert.ok(
    Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.2) < 0.1,
  );
  // A circle across the antimeridian wraps its box.
  const dateline = await resolveArea({ lat: 0, lon: 179.9, radius_km: 100 });
  assert.ok(dateline.west > dateline.east);
  assert.equal(areaContains(dateline, { lat: 0, lon: -179.9 }), true);
});

test('place names resolve through the places service', async () => {
  const places = {
    resolve: async (name) =>
      name === 'Taiwan'
        ? {
            name: 'Taiwan',
            bounds: { west: 119, south: 21, east: 123, north: 26 },
          }
        : null,
  };
  const taiwan = await resolveArea(
    { place: 'Taiwan' },
    { services: { places } },
  );
  assert.deepEqual(taiwan, {
    label: 'Taiwan',
    west: 119,
    south: 21,
    east: 123,
    north: 26,
  });
  await assert.rejects(
    resolveArea({ place: 'Nowhere' }, { services: { places } }),
    /No place matched "Nowhere"/,
  );
  await assert.rejects(
    resolveArea({ place: 'Taiwan' }),
    (error) => error.code === 'unsupported',
  );
});

test('geocode results become bounded places', () => {
  assert.deepEqual(
    placeFromGeocodeResult({
      formatted_address: 'Oslo, Norway',
      geometry: {
        location: { lat: 59.9, lng: 10.7 },
        viewport: {
          southwest: { lat: 59.8, lng: 10.5 },
          northeast: { lat: 60, lng: 10.9 },
        },
      },
    }),
    {
      name: 'Oslo, Norway',
      bounds: { west: 10.5, south: 59.8, east: 10.9, north: 60 },
    },
  );
  assert.deepEqual(
    placeFromGeocodeResult({ geometry: { location: { lat: 0, lng: 179.9 } } })
      .bounds,
    { west: 179.65, south: -0.25, east: 180, north: 0.25 },
  );
  assert.equal(placeFromGeocodeResult({ geometry: {} }), null);
});
