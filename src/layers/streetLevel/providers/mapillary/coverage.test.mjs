import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCoverage } from './coverage.js';
import { encodeCoverageTile } from './coverageFixture.mjs';
import {
  COLORS,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
} from './policy.js';
import { createGroundCaster } from '../../groundCast.js';
import { lonToTileX, latToTileY, tileBounds } from '../../tileMath.js';

const RAD = Math.PI / 180;
// Node has no WebGL context to report line-width limits; a browser's
// context sets these on startup, and appearances validate against them.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 10;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A scene collection that remembers what is on the globe. */
function collection() {
  const items = new Set();
  return {
    items,
    add(primitive) {
      items.add(primitive);
      return primitive;
    },
    remove(primitive) {
      return items.delete(primitive);
    },
  };
}

/** The centre of the z14 tile holding a point, so a small view is one tile. */
function tileCentre(lon, lat) {
  const x = lonToTileX(lon, 14);
  const y = latToTileY(lat, 14);
  const { west, east, south, north } = tileBounds(x, y, 14);
  return {
    tile: { x, y, z: 14 },
    lon: (west + east) / 2,
    lat: (south + north) / 2,
  };
}

/** A viewer looking straight down on a 0.004° square around `view`. */
function fakeViewer(view) {
  const postRender = new Set();
  const preRender = new Set();
  return {
    view,
    postRender,
    preRender,
    scene: {
      canvas: { clientWidth: 100, clientHeight: 100 },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
      groundPrimitives: collection(),
      primitives: collection(),
      postRender: {
        addEventListener(listener) {
          postRender.add(listener);
          return () => postRender.delete(listener);
        },
      },
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
    camera: {
      get positionCartographic() {
        return {
          longitude: view.lon * RAD,
          latitude: view.lat * RAD,
          height: view.height,
        };
      },
      pickEllipsoid(point) {
        return Cesium.Cartesian3.fromDegrees(
          view.lon - 0.002 + (point.x / 100) * 0.004,
          view.lat + 0.002 - (point.y / 100) * 0.004,
        );
      },
      computeViewRectangle: () => undefined,
    },
  };
}

/** A source whose tile requests the test resolves, one call at a time. */
function deferredSource() {
  const calls = [];
  return {
    calls,
    getTile(layer, z, x, y, { signal } = {}) {
      return new Promise((resolve, reject) => {
        calls.push({ key: `${z}/${x}/${y}`, z, signal, resolve, reject });
      });
    },
  };
}

function setup({
  surface = 'draped',
  groundCaster = null,
  meshSampler = null,
} = {}) {
  const centre = tileCentre(-121.4944, 38.5816);
  const viewer = fakeViewer({ lon: centre.lon, lat: centre.lat, height: 900 });
  const source = deferredSource();
  const state = {
    viewer,
    services: {},
    filter: { pano: 'all', sinceMs: null },
    keyRequired: false,
    context: {
      isActive: () => true,
      notify() {},
      getSurface: () => surface,
      groundCaster,
      meshSampler,
    },
    coverage: {
      zoom: null,
      kind: null,
      tiles: new Map(),
      stale: new Map(),
      staleTimer: null,
      pending: new Map(),
      loading: 0,
      lastError: null,
      debounceTimer: null,
      removeCameraListener: null,
      // Skip Cesium's one-time terrain table download.
      terrainReady: Promise.resolve(),
      hint: '',
    },
    sequence: { selectedId: null },
  };
  const coverage = createCoverage({ state, source });
  const bytes = encodeCoverageTile(centre.tile, {
    sequences: [
      {
        id: 'seq-1',
        parts: [
          [
            [centre.lon - 0.001, centre.lat],
            [centre.lon + 0.001, centre.lat],
          ],
        ],
      },
    ],
  });
  const tileKey = `14/${centre.tile.x}/${centre.tile.y}`;
  const onGlobe = () =>
    viewer.scene.groundPrimitives.items.size +
    viewer.scene.primitives.items.size;
  return { viewer, source, state, coverage, bytes, tileKey, onGlobe, centre };
}

/** Run one frame's listeners, as Cesium's render loop would. */
function frame(listeners) {
  for (const listener of [...listeners]) listener();
}

test('a superseded tile request cannot strand lines on the globe (review P0 #2)', async () => {
  const { viewer, source, state, coverage, bytes, tileKey, onGlobe } = setup();
  const forTile = () => source.calls.filter((call) => call.key === tileKey);

  coverage.refresh(); // street zoom: request #1 for the tile
  assert.equal(forTile().length, 1);
  viewer.view.height = 100_000; // zoom out: retire() drops request #1
  coverage.refresh();
  viewer.view.height = 900; // back in before #1 settles: request #2
  coverage.refresh();
  assert.equal(forTile().length, 2);
  await settle();

  // The superseded request finishes late. It must not settle request #2's
  // key, or the next refresh would start a duplicate load.
  forTile()[0].resolve(bytes);
  await settle();
  assert.equal(
    state.coverage.pending.has(tileKey),
    true,
    '#2 still owns the key',
  );
  assert.equal(state.coverage.loading, 1);
  coverage.refresh();
  assert.equal(forTile().length, 2, 'no duplicate request');

  forTile()[1].resolve(bytes);
  await settle();
  assert.equal(state.coverage.tiles.size, 1);
  assert.ok(onGlobe() > 0, 'the tile drew its lines');

  // Everything drawn can be removed: nothing is orphaned.
  coverage.clear();
  assert.equal(onGlobe(), 0);
});

test('in terrain mode a tile draws draped, then swaps to cast lines without a blank frame', async () => {
  let heightsReady = false;
  const groundCaster = {
    prepareLines: async () => {
      heightsReady = true;
      return true;
    },
    castLine: (coords) =>
      heightsReady ? coords.flatMap(([lon, lat]) => [lon, lat, 30]) : null,
  };
  const { viewer, source, coverage, bytes, onGlobe } = setup({
    surface: 'terrain',
    groundCaster,
  });
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  await settle();
  const { groundPrimitives, primitives } = viewer.scene;
  // Both are on the globe while the cast lines build: no blink.
  assert.equal(groundPrimitives.items.size, 1, 'draped lines kept');
  assert.equal(primitives.items.size, 1, 'cast lines added');
  assert.ok(
    [...primitives.items][0] instanceof Cesium.Primitive,
    'cast lines are plain polylines at terrain height',
  );
  // Leaving mid-swap removes both sets, not just the new one.
  coverage.clear();
  assert.equal(onGlobe(), 0);
  assert.equal(viewer.postRender.size, 0, 'the swap listener is gone');
});

test('a tile whose lines cannot be cast is not rebuilt for nothing', async () => {
  let prepares = 0;
  const groundCaster = {
    prepareLines: async () => {
      prepares++;
      return false; // terrain proxy down, or tile too big
    },
    castLine: () => null,
  };
  const { viewer, source, coverage, bytes } = setup({
    surface: 'terrain',
    groundCaster,
  });
  const added = [];
  const add = viewer.scene.groundPrimitives.add.bind(
    viewer.scene.groundPrimitives,
  );
  viewer.scene.groundPrimitives.add = (primitive) => {
    added.push(primitive);
    return add(primitive);
  };
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  await settle();
  assert.equal(prepares, 1);
  assert.equal(added.length, 1, 'drawn once, draped; no second draped build');
  assert.equal(viewer.scene.primitives.items.size, 0);
  coverage.clear();
});

test('panning off a tile that is still loading settles the loading count', async () => {
  const { viewer, source, state, coverage } = setup();
  coverage.refresh();
  assert.equal(state.coverage.loading, 1);
  // Same zoom, two tiles east: the first request is dropped, a new one starts.
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls[0].signal.aborted, true);
  assert.equal(state.coverage.pending.size, 1);
  assert.equal(
    state.coverage.loading,
    1,
    'only the live request counts as loading',
  );
  source.calls[0].reject(new DOMException('aborted', 'AbortError'));
  source.calls[1].resolve(new Uint8Array());
  await settle();
  assert.equal(state.coverage.pending.size, 0);
  assert.equal(state.coverage.loading, 0, 'LOADING clears');
  coverage.clear();
});

test('zoom 0 is a zoom: the whole-earth view still shows coverage', () => {
  const { viewer, source, state, coverage } = setup();
  viewer.view.height = 20_000_000;
  coverage.refresh();
  assert.equal(state.coverage.zoom, 0);
  assert.equal(state.coverage.hint, '');
  assert.deepEqual(
    source.calls.map((call) => call.key),
    ['0/0/0'],
  );
  coverage.clear();
});

test('a rejected key stops coverage requests until the layer goes off (review IC8 P2)', async () => {
  const { viewer, source, state, coverage } = setup();
  coverage.refresh();
  const rejected = Object.assign(
    new Error('Mapillary rejected the access token'),
    {
      keyRejected: true,
    },
  );
  source.calls[0].reject(rejected);
  await settle();
  assert.equal(state.keyRejected, true);
  assert.match(state.coverage.lastError, /rejected MAPILLARY_CLIENT_TOKEN/);
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'panning asks for nothing more');
  // Turning the provider off forgets the verdict; the next run asks again.
  coverage.clear();
  coverage.resetErrors();
  assert.equal(state.keyRejected, false);
  assert.equal(state.coverage.lastError, null);
  coverage.refresh();
  assert.equal(source.calls.length, 2);
  coverage.clear();
});

test('a rate limit keeps the drawn tiles and asks again once the wait is over (review IC8 P2)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { viewer, source, state, coverage } = setup();
  coverage.refresh();
  source.calls[0].reject(
    Object.assign(new Error('rate limited'), { retryAfterSec: 30 }),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.match(state.coverage.lastError, /rate-limiting/);
  viewer.view.lon += 0.05;
  coverage.refresh();
  assert.equal(source.calls.length, 1, 'held: nothing is requested');
  t.mock.timers.tick(30_000);
  assert.equal(source.calls.length, 2, 'one refresh once the wait is over');
  assert.equal(state.coverage.lastError, null);
  coverage.clear();
  coverage.resetErrors();
});

test('overview points behind the horizon are hidden, not drawn through the globe', async () => {
  const { viewer, source, state, coverage } = setup();
  const { view } = viewer;
  view.height = 20_000_000;
  Object.defineProperty(viewer.camera, 'positionWC', {
    get: () => Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
  });
  coverage.refresh();
  // One dot under the camera (Sacramento), one near its antipode.
  source.calls[0].resolve(
    encodeCoverageTile(
      { x: 0, y: 0, z: 0 },
      {
        overview: [
          { id: 'near', lon: -121.5, lat: 38.6 },
          { id: 'far', lon: 58.5, lat: -38.6 },
        ],
      },
    ),
  );
  await settle();
  const [entry] = state.coverage.tiles.values();
  const points = [0, 1].map((i) => entry.primitive.get(i));
  const west = (point) =>
    Cesium.Cartographic.fromCartesian(point.position).longitude < 0;
  const near = points.find(west);
  const far = points.find((point) => !west(point));
  frame(viewer.preRender);
  assert.equal(near.show, true, 'the near side stays visible');
  assert.equal(far.show, false, 'the far side does not show through');
  // Fly round to the other hemisphere: the two swap.
  view.lon = 58.5;
  view.lat = -38.6;
  frame(viewer.preRender);
  assert.equal(near.show, false);
  assert.equal(far.show, true);
  coverage.clear();
  assert.equal(viewer.preRender.size, 0, 'the cull listener is gone');
});

test('a cast tile whose heights were evicted is cast again, not left draped', async () => {
  const terrain = {
    calls: 0,
    async resolveEllipsoidalGround(coords) {
      this.calls++;
      return coords.map(() => ({ ellipsoid: 20, source: 'reearth' }));
    },
  };
  // Room for one tile's corners at a time.
  const groundCaster = createGroundCaster({
    terrain,
    maxCorners: 16,
    cacheMax: 20,
  });
  let sampled = null;
  const meshSampler = {
    onSampled: (listener) => (sampled = listener),
    request() {},
    meshAt: () => undefined,
  };
  const { source, state, coverage, bytes, centre } = setup({
    surface: 'terrain',
    groundCaster,
    meshSampler,
  });
  const isCast = () => {
    const [entry] = state.coverage.tiles.values();
    return (
      entry.primitives.length > 0 &&
      entry.primitives.every(({ onGround }) => !onGround)
    );
  };
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  await settle();
  assert.ok(isCast(), 'cast once the heights are in');
  // Another region fills the cache and evicts this tile's corners...
  await groundCaster.prepare([[centre.lon + 0.05, centre.lat + 0.05]]);
  assert.equal(groundCaster.groundAt(centre.lon - 0.001, centre.lat), null);
  // ...then mesh samples redraw the tile, which can only drape now.
  sampled([[centre.lon, centre.lat]]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  coverage.refresh();
  await settle();
  await settle();
  assert.ok(isCast(), 'the tile is cast again');
  coverage.clear();
});

test('a tile left draped by a failed terrain lookup is cast on the next refresh', async () => {
  let up = false;
  let prepares = 0;
  let heightsReady = false;
  const groundCaster = {
    prepareLines: async () => {
      prepares++;
      heightsReady = up;
      return up;
    },
    castLine: (coords) =>
      heightsReady ? coords.flatMap(([lon, lat]) => [lon, lat, 30]) : null,
  };
  const { viewer, source, coverage, bytes } = setup({
    surface: 'terrain',
    groundCaster,
  });
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  await settle();
  assert.equal(prepares, 1);
  assert.equal(viewer.scene.primitives.items.size, 0, 'draped');
  await settle();
  assert.equal(prepares, 1, 'no retry loop while the proxy is down');
  up = true; // the proxy is back
  coverage.refresh();
  await settle();
  assert.equal(prepares, 2, 'the next refresh tries again');
  assert.equal(viewer.scene.primitives.items.size, 1, 'cast lines added');
  coverage.clear();
});

test('the per-tile cap applies after the imagery filter, so a dense tile keeps its 360° lines', async () => {
  const { state, source, coverage, centre } = setup();
  const line = (n) => [
    [
      [centre.lon - 0.001, centre.lat + n * 1e-6],
      [centre.lon + 0.001, centre.lat + n * 1e-6],
    ],
  ];
  // 700 newer flat sequences, then 300 older 360° ones.
  const sequences = [];
  for (let i = 0; i < 700; i++)
    sequences.push({
      id: `flat-${i}`,
      parts: line(i),
      capturedAt: 2_000_000_000_000 + i,
    });
  for (let i = 0; i < 300; i++)
    sequences.push({
      id: `pano-${i}`,
      parts: line(i),
      capturedAt: 1_000_000_000_000 + i,
      isPano: true,
    });
  state.filter = { pano: 'pano', sinceMs: null };
  coverage.refresh();
  source.calls[0].resolve(encodeCoverageTile(centre.tile, { sequences }));
  await settle();
  const [entry] = state.coverage.tiles.values();
  const cap = Math.floor(COVERAGE_MAX_SEQUENCES / COVERAGE_MAX_TILES);
  assert.equal(entry.count, Math.min(300, cap), 'every 360° line is drawn');
  assert.equal(coverage.sequenceCount(), Math.min(300, cap));
  assert.ok(coverage.findSequence('pano-0'), 'drawn lines can be looked up');
  assert.equal(coverage.findSequence('flat-699'), null);
  state.filter = { pano: 'all', sinceMs: null };
  coverage.rebuild();
  assert.equal(entry.count, cap, 'all imagery is capped as before');
  assert.ok(coverage.findSequence('flat-699'), 'the newest flat line is drawn');
  assert.equal(coverage.findSequence('pano-299'), null, 'over the cap');
  coverage.clear();
});

test('a selection made or cleared while a tile builds is applied once it is ready', async () => {
  const { viewer, source, state, coverage, bytes } = setup();
  coverage.refresh();
  source.calls[0].resolve(bytes);
  await settle();
  const [entry] = state.coverage.tiles.values();
  const value = (selected) =>
    Array.from(
      Cesium.ColorGeometryInstanceAttribute.toValue(
        selected
          ? Cesium.Color.fromCssColorString(COLORS.selected)
          : Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92),
      ),
    );
  /** Stand in for a primitive the worker has not finished, with its colours. */
  function building(record) {
    const control = { ready: false, attributes: { color: undefined } };
    Object.defineProperty(record.primitive, 'ready', {
      get: () => control.ready,
    });
    record.primitive.getGeometryInstanceAttributes = (id) =>
      id === 'mly:seq:seq-1' ? control.attributes : undefined;
    return control;
  }

  // Selected while its line is still building: nothing to recolour yet...
  const first = building(entry.primitives[0]);
  state.sequence.selectedId = 'seq-1';
  coverage.recolorSequence('seq-1', true);
  assert.equal(first.attributes.color, undefined);
  // ...so the highlight lands once it is ready.
  first.ready = true;
  frame(viewer.postRender);
  assert.deepEqual(Array.from(first.attributes.color), value(true));

  // Rebuilt with the highlight baked in, then cleared mid-build: not stuck.
  coverage.rebuild();
  const second = building(entry.primitives[0]);
  coverage.recolorSequence('seq-1', false);
  state.sequence.selectedId = null;
  second.ready = true;
  frame(viewer.postRender);
  assert.deepEqual(Array.from(second.attributes.color), value(false));
  coverage.clear();
  assert.equal(viewer.postRender.size, 0, 'the selection watch is gone');
});
