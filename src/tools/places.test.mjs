import assert from 'node:assert/strict';
import test from 'node:test';
import { createGeocodePlaceService } from './places.js';

const answer = {
  results: [
    {
      formatted_address: 'Tokyo, Japan',
      geometry: { location: { lat: 35.68, lng: 139.76 } },
    },
  ],
};

test('place lookups are cached by name for a while, and failures are not', async () => {
  let clock = 0;
  const requests = [];
  let fail = true;
  const places = createGeocodePlaceService({
    now: () => clock,
    cacheMs: 1000,
    fetchImpl: async (url) => {
      requests.push(url);
      if (fail) return new Response(null, { status: 503 });
      return Response.json(answer);
    },
  });
  await assert.rejects(places.resolve('Tokyo'), /Geocode HTTP 503/);
  fail = false;
  const first = await places.resolve('Tokyo');
  assert.deepEqual(first.point, { lat: 35.68, lon: 139.76 });
  assert.equal(await places.resolve(' tokyo '), first);
  assert.equal(requests.length, 2);
  clock = 2000;
  await places.resolve('Tokyo');
  assert.equal(requests.length, 3);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(places.resolve('Tokyo', { signal: aborted.signal }));
});
