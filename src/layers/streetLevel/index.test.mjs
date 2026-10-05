import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createStreetLevelLayer } from './index.js';
import { MAPILLARY_CREDIT_HTML } from './providers/mapillary/policy.js';

/**
 * The smallest provider the core accepts. `stats` is what coverageStats()
 * answers; `calls` counts what the core asked of the provider and its viewer.
 */
function fakeProvider({
  id = 'mapillary',
  pickPrefix = 'mly:',
  html = MAPILLARY_CREDIT_HTML,
  nearestImage = async () => null,
} = {}) {
  const calls = { activate: 0, deactivate: 0, mount: 0, open: [], unmount: 0 };
  const stats = {
    count: 0,
    zoom: null,
    kind: null,
    loading: false,
    hint: '',
    error: null,
    keyRequired: false,
  };
  let context = null;
  return {
    calls,
    stats,
    context: () => context,
    id,
    name: 'Mapillary',
    label: 'MAPILLARY',
    requiresKeyId: null,
    pickPrefix,
    colors: { coverage: '#05cb63' },
    credit: { html },
    create: (providerContext) => {
      context = providerContext;
      return {
        status: async () => ({ configured: true }),
        init() {},
        activate: () => calls.activate++,
        deactivate: () => calls.deactivate++,
        destroy() {},
        refreshCoverage() {},
        setFilter() {},
        coverageStats: () => ({ ...stats }),
        handlePick: () => false,
        nearestImage,
        viewer: {
          mount: async () => calls.mount++,
          open: async (imageId) => calls.open.push(imageId),
          close() {},
          unmount: () => calls.unmount++,
          resize() {},
          onPose: () => () => {},
        },
      };
    },
  };
}

/**
 * A stand-in Cesium viewer the layer can be enabled on: a canvas for the
 * click handler, camera events, a primitive list and a credit display.
 */
function fakeViewer() {
  const credits = [];
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  return {
    credits,
    scene: { canvas, primitives: { add: (p) => p, remove() {} } },
    camera: {
      changed: new Cesium.Event(),
      moveStart: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
    },
    creditDisplay: {
      addStaticCredit: (credit) => credits.push(credit),
      removeStaticCredit: (credit) =>
        credits.splice(credits.indexOf(credit), 1),
    },
  };
}

/** A layer over `providers`, initialised and enabled on a stand-in viewer. */
async function enabledLayer(t, providers = [fakeProvider()]) {
  const saved = globalThis.document;
  globalThis.document = new EventTarget();
  const viewer = fakeViewer();
  const layer = createStreetLevelLayer({ providers });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await settle();
  return { layer, viewer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A map stack controller that can be switched between stacks. */
function fakeMapStack(initial) {
  let active = initial;
  const listeners = new Set();
  return {
    getActiveId: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchTo(id) {
      active = id;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('FOLLOW is available only while the Google 3D map stack is active', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  assert.equal(
    layer.getUIState().street.followAvailable,
    false,
    'unknown stack: off',
  );

  const stack = fakeMapStack('esri-imagery');
  layer.attachMapStackController(stack);
  assert.equal(layer.getUIState().street.followAvailable, false);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, false, 'refused on Esri');

  stack.switchTo('photoreal');
  assert.equal(layer.getUIState().street.followAvailable, true);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, true);

  stack.switchTo('osm');
  assert.equal(layer.getUIState().street.followAvailable, false);
  assert.equal(
    layer.getUIState().street.follow,
    false,
    'leaving Google 3D stops following',
  );
});

test('the layer lets go of the map stack when destroyed or re-attached', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  const first = fakeMapStack('photoreal');
  layer.attachMapStackController(first);
  assert.equal(first.listenerCount(), 1);
  const second = fakeMapStack('photoreal');
  layer.attachMapStackController(second);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
  layer.destroy();
  assert.equal(second.listenerCount(), 0);
});

test('the CC BY-SA credit shows while a provider is on and goes with it', async (t) => {
  const { layer, viewer } = await enabledLayer(t);
  const shown = () => viewer.credits.map((credit) => credit.html);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML], 'shown on activate');
  assert.match(shown()[0], /CC BY-SA 4\.0/);
  layer.setProviderEnabled('mapillary', false);
  assert.deepEqual(shown(), [], 'hidden with the provider');
  layer.setProviderEnabled('mapillary', true);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML]);
  layer.disable();
  assert.deepEqual(shown(), [], 'every credit goes with the layer');
});

test('getStats tells a rejected key from a missing one', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  provider.stats.loading = true;
  assert.equal(layer.getStats().loadingLabel, 'loading coverage...');
  assert.equal(layer.getStats().keyRequired, false);

  provider.stats.keyRequired = true;
  assert.deepEqual(
    [layer.getStats().loadingLabel, layer.getStats().error],
    ['KEY REQUIRED', 'KEY REQUIRED'],
  );

  // A rejected key gates the provider exactly like a missing one.
  provider.stats.keyRequired = false;
  provider.stats.keyRejected = true;
  provider.stats.error = 'Mapillary rejected MAPILLARY_CLIENT_TOKEN';
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.loadingLabel, 'KEY REJECTED');
  assert.equal(stats.error, 'Mapillary rejected MAPILLARY_CLIENT_TOKEN');
  const ui = layer.getUIState();
  assert.equal(ui.keyRequired, true);
  assert.equal(ui.keyRejected, true);
  assert.equal(ui.providers[0].keyRequired, true);
});

test('switching a provider off deactivates it and closes the image it shows', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.deepEqual(provider.calls.open, ['img1']);
  assert.equal(layer.getUIState().street.open, true);
  layer.setProviderEnabled('mapillary', false);
  assert.equal(provider.calls.deactivate, 1);
  assert.equal(provider.calls.unmount, 1, 'its viewer is released');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().street.providerId, null);
});

test('openNearest without the panel reports it instead of loading forever (review P3)', async (t) => {
  const provider = fakeProvider({ nearestImage: async () => 'img1' });
  const { layer } = await enabledLayer(t, [provider]);
  assert.equal(await layer.openNearest({ lat: 38.58, lon: -121.49 }), false);
  const { street } = layer.getUIState();
  assert.equal(street.loading, false);
  assert.match(street.error, /Open the Street Level panel/);
  assert.equal(provider.calls.mount, 0);
});

test('openNearest opens nothing once the layer went off during the lookup (review P3)', async (t) => {
  const answer = deferred();
  const provider = fakeProvider({ nearestImage: () => answer.promise });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.disable();
  answer.resolve('img1');
  assert.equal(await opening, false);
  assert.equal(provider.calls.mount, 0, 'no viewer was stood up');
  const { street } = layer.getUIState();
  assert.equal(street.open, false);
  assert.equal(street.loading, false);
  assert.equal(street.error, null);
});

test('openNearest skips a provider switched off during its lookup (review P3)', async (t) => {
  const answer = deferred();
  const provider = fakeProvider({ nearestImage: () => answer.promise });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.setProviderEnabled('mapillary', false);
  answer.resolve('img1');
  assert.equal(await opening, false);
  assert.deepEqual(provider.calls.open, []);
  assert.equal(layer.getUIState().street.loading, false);
});

test('a provider withdraws only the error it reported (review P3)', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  const { actions } = provider.context();
  actions.reportError('Sequence images unavailable');
  assert.equal(layer.getUIState().street.error, 'Sequence images unavailable');
  actions.reportError(null);
  assert.equal(layer.getUIState().street.error, null, 'withdrawn');

  // The viewer's own error is not the provider's to clear.
  layer.attachViewerHost(null);
  actions.reportError('Sequence images unavailable');
  await layer.openImage('mapillary', 'img1');
  actions.reportError(null);
  assert.match(layer.getUIState().street.error, /Open the Street Level panel/);
});
