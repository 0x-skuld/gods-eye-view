import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapillaryProvider, mapillaryImageUrl } from './index.js';
import { sequenceIdFromPick } from './coverage.js';
import { thinImages } from './sequences.js';
import { validateProviders } from '../../registry.js';
import { PROVIDER_COLORS } from '../../policy.js';
import { resolveFilter } from '../../filter.js';

function fakeSource({ nearest = [] } = {}) {
  return {
    hasToken: () => true,
    getStatus: async () => ({ configured: true }),
    getTile: async () => new Uint8Array(0),
    getSequenceImages: async () => [],
    nearestImages: async () => nearest,
  };
}

function fakeContext(filter = { pano: 'all', sinceMs: null }) {
  const opened = [];
  return {
    opened,
    services: {},
    getFilter: typeof filter === 'function' ? filter : () => filter,
    isActive: () => true,
    notify: () => {},
    actions: {
      openImage: (id) => {
        opened.push(id);
      },
      reportError: () => {},
    },
  };
}

test('the definition satisfies the Street Level provider contract', () => {
  const def = createMapillaryProvider({ source: fakeSource() });
  assert.doesNotThrow(() => validateProviders([def]));
  assert.equal(def.id, 'mapillary');
  assert.equal(def.label, 'MAPILLARY');
  assert.equal(def.requiresKeyId, 'mapillary');
  assert.equal(def.pickPrefix, 'mly:');
  assert.match(def.credit.html, /CC BY-SA 4\.0/);
  // One colour per source: Mapillary is green everywhere it draws.
  assert.deepEqual(Object.keys(def.colors).sort(), ['coverage', 'selected']);
  assert.equal(def.colors.coverage, PROVIDER_COLORS.mapillary);
  assert.equal(PROVIDER_COLORS.mapillary, '#05cb63');
  assert.throws(() => createMapillaryProvider({ source: {} }), /source/);
});

test('image deep links match the mapillary.com share format', () => {
  assert.equal(
    mapillaryImageUrl(1814275685699406),
    'https://www.mapillary.com/app/?pKey=1814275685699406&focus=photo',
  );
  assert.equal(mapillaryImageUrl('  '), 'https://www.mapillary.com/app/');
});

test('picks route sequences to selection and images to the core opener', () => {
  const context = fakeContext();
  const instance = createMapillaryProvider({ source: fakeSource() }).create(
    context,
  );
  assert.equal(instance.handlePick('mly:img:77'), true);
  assert.deepEqual(context.opened, ['77']);
  assert.equal(instance.handlePick('cctv:1'), false);
  assert.deepEqual(instance.sequenceStats(), {
    selectedId: null,
    images: 0,
    loading: false,
  });
});

test('nearestImage honours the imagery filter and reports key status', async () => {
  const nearest = [
    { id: 1, is_pano: false, captured_at: 10 },
    { id: 2, is_pano: true, captured_at: 20 },
  ];
  const source = fakeSource({ nearest });
  const flat = createMapillaryProvider({ source }).create(fakeContext());
  assert.equal(await flat.nearestImage({ lat: 1, lon: 2 }), '1');
  const pano = createMapillaryProvider({ source }).create(
    fakeContext({ pano: 'pano', sinceMs: null }),
  );
  assert.equal(await pano.nearestImage({ lat: 1, lon: 2 }), '2');
  const none = createMapillaryProvider({ source }).create(
    fakeContext({ pano: 'all', sinceMs: 100 }),
  );
  assert.equal(await none.nearestImage({ lat: 1, lon: 2 }), null);
  assert.deepEqual(await flat.status(), { configured: true });
  assert.equal(flat.coverageStats().keyRequired, false);
});

test('any part of a multi-part sequence picks the whole sequence', () => {
  assert.equal(sequenceIdFromPick('mly:seq:abc'), 'abc');
  assert.equal(sequenceIdFromPick('mly:seq:abc~2'), 'abc');
  assert.equal(sequenceIdFromPick('mly:img:abc'), null);
  assert.equal(sequenceIdFromPick(null), null);
});

test('nearestImage picks the closest image, not the first the API returned', async () => {
  const at = (id, lon, lat) => ({
    id,
    is_pano: false,
    captured_at: 10,
    geometry: { type: 'Point', coordinates: [lon, lat] },
  });
  const source = fakeSource({
    nearest: [
      at('far', 2.0004, 1), // ~45 m east
      at('near', 2.00005, 1), // ~5 m east
      at('mid', 2, 1.0002), // ~22 m north
    ],
  });
  const instance = createMapillaryProvider({ source }).create(fakeContext());
  assert.equal(await instance.nearestImage({ lat: 1, lon: 2 }), 'near');
});

test('a "since N days" window follows the clock in a long-open tab (review P3)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 1) });
  const day = 86_400_000;
  const capturedAt = Date.now() - day / 2;
  const source = fakeSource({
    nearest: [{ id: 'recent', is_pano: false, captured_at: capturedAt }],
  });
  // The core's context resolves the stored filter whenever it is asked.
  const instance = createMapillaryProvider({ source }).create(
    fakeContext(() => resolveFilter({ pano: 'all', sinceDays: 1 })),
  );
  assert.equal(await instance.nearestImage({ lat: 1, lon: 2 }), 'recent');
  t.mock.timers.tick(2 * day);
  assert.equal(
    await instance.nearestImage({ lat: 1, lon: 2 }),
    null,
    'two days on, the image is older than the window',
  );
});

test('nearestImage measures the short way round the date line (review IC8 P2)', async () => {
  const at = (id, lon, lat) => ({
    id,
    is_pano: false,
    captured_at: 10,
    geometry: { type: 'Point', coordinates: [lon, lat] },
  });
  const source = fakeSource({
    nearest: [
      at('same-side', 179.9995, 0), // ~45 m west, on the camera's side
      at('across', -179.9999, 0), // ~11 m east, across ±180°
    ],
  });
  const instance = createMapillaryProvider({ source }).create(fakeContext());
  assert.equal(
    await instance.nearestImage({ lat: 0, lon: 179.9999 }),
    'across',
  );
  // And from the other side.
  const west = createMapillaryProvider({
    source: fakeSource({
      nearest: [at('same-side', -179.9995, 0), at('across', 179.9999, 0)],
    }),
  }).create(fakeContext());
  assert.equal(await west.nearestImage({ lat: 0, lon: -179.9999 }), 'across');
});

test('cone thinning across the date line drops images metres apart (review IC8 P2)', () => {
  const image = (id, lon) => ({ id, lon, lat: 0 });
  // A sequence driving east over ±180° with images ~1 m apart, then ~11 m on.
  const kept = thinImages(
    [
      image('a', 179.99999),
      image('b', -179.99999), // ~2 m from a, across the date line
      image('c', -179.9999), // ~11 m from a
    ],
    3,
  );
  assert.deepEqual(
    kept.map(({ id }) => id),
    ['a', 'c'],
  );
});
