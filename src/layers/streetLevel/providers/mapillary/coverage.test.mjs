import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCoverage } from './coverage.js';
import { encodeCoverageTile } from './coverageFixture.mjs';
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
  return {
    view,
    postRender,
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

function setup({ surface = 'draped', groundCaster = null } = {}) {
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
      meshSampler: null,
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
  return { viewer, source, state, coverage, bytes, tileKey, onGlobe };
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
