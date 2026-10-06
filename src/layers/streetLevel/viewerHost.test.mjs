import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createViewerHost } from './viewerHost.js';

// MapillaryJS needs a browser; the adapter tests swap in a stand-in library.
// Every import gets a fresh copy that waits for the current test's gate, so
// each test controls when its "download" finishes.
let libraryImports = 0;
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('mapillary-js')) return next(specifier, context);
    const kind = specifier === 'mapillary-js' ? 'library' : 'asset';
    return {
      url: `gev-test-stub:mapillary-js/${kind}?${++libraryImports}`,
      shortCircuit: true,
    };
  },
  load(url, context, next) {
    if (!url.startsWith('gev-test-stub:mapillary-js/'))
      return next(url, context);
    const source = url.includes('/library?')
      ? 'const lib = await globalThis.__gevMapillaryLibrary();\n' +
        'export const Viewer = lib.Viewer;\n' +
        'export const RenderMode = lib.RenderMode;\n'
      : 'export default {};\n';
    return { format: 'module', shortCircuit: true, source };
  },
});
const { createMapillaryViewer } =
  await import('./providers/mapillary/viewer.js');

function harness(adapter) {
  const state = {
    enabled: true,
    notify() {},
    providers: new Map(),
    street: { host: {}, renderMode: 'letterbox', follow: false },
  };
  const def = { id: 'mapillary', name: 'Mapillary', label: 'MAPILLARY' };
  state.providers.set('mapillary', { def, instance: { viewer: adapter } });
  const framing = { started: 0, cancelled: 0 };
  const parts = {
    marker: { set() {}, clear() {} },
    follow: {
      followCamera() {},
      lookAtPosition: () => framing.started++,
      cancelFraming: () => framing.cancelled++,
    },
  };
  return { state, framing, host: createViewerHost({ state, parts }) };
}

/**
 * A stand-in adapter. Like the real one, concurrent mounts share one
 * construction (`gate` holds it open) and `unmount` destroys the viewer that
 * every later `open` needs.
 */
function fakeAdapter({ failMounts = 0, gate = null } = {}) {
  const calls = { mount: 0, open: [], unmount: 0, listeners: 0 };
  let emit = null;
  let mounted = false;
  return {
    calls,
    async mount() {
      calls.mount++;
      const attempt = calls.mount;
      await gate?.promise;
      if (attempt <= failMounts) throw new Error('library failed to load');
      mounted = true;
    },
    /** A pose event from the library, as MapillaryJS fires them. */
    emitPose(id) {
      emit?.({
        providerId: 'mapillary',
        imageId: id,
        sequenceId: `seq-${id}`,
        position: { lon: 1, lat: 2 },
        bearing: 90,
        isPano: false,
        externalUrl: `https://example.test/${id}`,
      });
    },
    async open(id) {
      if (!mounted) throw new Error('viewer is not mounted');
      calls.open.push(id);
      this.emitPose(id);
    },
    close() {},
    unmount() {
      calls.unmount++;
      mounted = false;
    },
    resize() {},
    onPose(listener) {
      calls.listeners++;
      emit = listener;
      return () => {
        calls.listeners--;
        emit = null;
      };
    },
  };
}

test('a failed mount is retried on the next open instead of being cached', async () => {
  const adapter = fakeAdapter({ failMounts: 1 });
  const { state, host } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.equal(state.street.error, 'library failed to load');
  assert.equal(adapter.calls.listeners, 0, 'the pose listener was released');
  await host.open('mapillary', 'b');
  assert.equal(state.street.error, null);
  assert.equal(adapter.calls.mount, 2);
  assert.deepEqual(adapter.calls.open, ['b']);
  assert.equal(state.street.imageId, 'b');
  assert.equal(state.street.externalUrl, 'https://example.test/b');
});

test('concurrent opens share one mount and one pose listener', async () => {
  const adapter = fakeAdapter();
  const { host } = harness(adapter);
  await Promise.all([host.open('mapillary', 'a'), host.open('mapillary', 'b')]);
  assert.equal(adapter.calls.mount, 1);
  assert.equal(adapter.calls.listeners, 1);
});

test('unmounting while a mount is in flight does not leave it active', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  const opening = host.open('mapillary', 'a');
  host.unmount();
  await opening;
  assert.equal(adapter.calls.listeners, 0);
  assert.equal(adapter.calls.unmount, 1);
  assert.equal(state.street.open, false);
  // Not left active: the next open mounts again.
  await host.open('mapillary', 'b');
  assert.equal(adapter.calls.mount, 2);
  assert.equal(state.street.imageId, 'b');
});

test('a prewarmed viewer is released when the layer goes off, or at once if it went off mid-load', async () => {
  const adapter = fakeAdapter();
  let release = null;
  adapter.prewarm = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const { state, host } = harness(adapter);
  const entry = state.providers.get('mapillary');
  entry.on = true;

  // Warmed, then the layer is switched off: unmount releases the warm viewer.
  const warming = host.prewarm([entry]);
  release();
  await warming;
  assert.equal(adapter.calls.unmount, 0);
  host.unmount();
  assert.equal(adapter.calls.unmount, 1, 'the WebGL viewer is destroyed');

  // Switched off while the library was still loading: released on arrival.
  const late = host.prewarm([entry]);
  state.enabled = false;
  release();
  await late;
  assert.equal(adapter.calls.unmount, 2);
});

test('switching one provider off releases only its viewer', async () => {
  const adapter = fakeAdapter();
  adapter.prewarm = async () => {};
  const { state, host } = harness(adapter);
  const entry = state.providers.get('mapillary');
  entry.on = true;
  await host.prewarm([entry]);
  host.unmount('panoramax');
  assert.equal(adapter.calls.unmount, 0, 'another provider leaves it alone');
  host.unmount('mapillary');
  assert.equal(adapter.calls.unmount, 1);
});

test('a pose that arrives after the photo was closed does not bring it back', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  await host.open('mapillary', 'a');
  host.close();
  const before = { ...state.street };
  // The library's `image` event for a photo that was still loading.
  adapter.emitPose('a');
  assert.equal(state.street.open, false);
  assert.equal(state.street.imageId, null);
  assert.equal(state.street.sequenceId, null);
  assert.deepEqual(state.street, before);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('switching the layer off and on during a cold first open keeps the shared viewer', async () => {
  const gate = deferred();
  const adapter = fakeAdapter({ gate });
  const { state, host } = harness(adapter);
  const first = host.open('mapillary', 'a'); // the library is still loading
  host.unmount(); // layer off …
  const second = host.open('mapillary', 'b'); // … on again, and a new click
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(adapter.calls.unmount, 0, 'the outdated mount left it alone');
  assert.equal(adapter.calls.listeners, 1);
  assert.equal(state.street.error, null);
  assert.equal(state.street.imageId, 'b');
  await host.open('mapillary', 'c');
  assert.equal(state.street.error, null, 'later opens are not stuck');
  assert.equal(state.street.imageId, 'c');
});

/** MapillaryJS, counting live viewers (each holds a WebGL context). */
function fakeLibrary() {
  const gate = deferred();
  const viewers = { created: 0, live: 0, instances: [] };
  class Viewer {
    constructor() {
      viewers.created++;
      viewers.live++;
      viewers.instances.push(this);
      this.removed = false;
      this.playback = { stops: 0 };
    }
    /** The sequence component's play/stop API, as MapillaryJS 4 exposes it. */
    getComponent(name) {
      if (name !== 'sequence') return undefined;
      return { stop: () => this.playback.stops++ };
    }
    on() {}
    async getPosition() {
      return { lng: 1, lat: 2 };
    }
    async getPointOfView() {
      return { bearing: 10, tilt: 0 };
    }
    async moveTo(id) {
      return { id, cameraType: 'perspective', sequenceId: 's' };
    }
    remove() {
      if (this.removed) return;
      this.removed = true;
      viewers.live--;
    }
    setRenderMode() {}
    resize() {}
  }
  globalThis.__gevMapillaryLibrary = async () => {
    await gate.promise;
    return { Viewer, RenderMode: {} };
  };
  return { gate, viewers };
}

test('the Mapillary viewer survives the layer going off and on during its first download', async () => {
  const { gate, viewers } = fakeLibrary();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const { state, host } = harness(adapter);
  const first = host.open('mapillary', 'img1');
  await Promise.resolve();
  host.unmount();
  const second = host.open('mapillary', 'img2');
  await Promise.resolve();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(state.street.error, null);
  assert.equal(state.street.imageId, 'img2');
  await host.open('mapillary', 'img3');
  assert.equal(state.street.error, null, 'later opens are not stuck');
  assert.equal(state.street.imageId, 'img3');
  assert.equal(viewers.live, 1);
});

test('a Mapillary viewer unmounted mid-download is never built; the next mount builds afresh', async () => {
  const { gate, viewers } = fakeLibrary();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const element = {};
  const stale = adapter.mount(element);
  adapter.unmount();
  const fresh = adapter.mount(element);
  gate.resolve();
  await assert.rejects(stale, /unmounted/);
  await fresh;
  assert.equal(viewers.created, 1, 'only the fresh mount built one');
  await adapter.open('x');
  adapter.unmount();
  assert.equal(viewers.live, 0, 'nothing left holding a WebGL context');
});

test('a prewarm that gave up when the layer went off and on mid-download is followed by one that builds', async () => {
  const { gate, viewers } = fakeLibrary();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const element = {};
  const first = adapter.prewarm(element);
  adapter.unmount(); // layer off while MapillaryJS downloads
  const second = adapter.prewarm(element); // layer on again
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(viewers.created, 1, 'the second prewarm built the viewer');
  assert.equal(viewers.live, 1);
  adapter.unmount();
});

test('closing the photo stops sequence playback in the hidden viewer (review P2-6)', async () => {
  const { gate, viewers } = fakeLibrary();
  gate.resolve();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const { host } = harness(adapter);
  await host.open('mapillary', 'img1');
  const [viewer] = viewers.instances;
  assert.equal(viewer.playback.stops, 0);
  host.close();
  assert.equal(viewer.playback.stops, 1, 'playback stopped with the photo');
  assert.equal(viewers.live, 1, 'the viewer itself stays warm');
});

test('closing the photo or switching the layer off stops its framing flight (review IC8 P1)', async () => {
  const adapter = fakeAdapter();
  const { framing, host } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.equal(framing.started, 1, 'the open framed the photo');
  host.close();
  assert.equal(framing.cancelled, 1, 'closed: the globe stops flying to it');
  await host.open('mapillary', 'b');
  host.unmount('panoramax');
  assert.equal(framing.cancelled, 1, 'another provider leaves it alone');
  host.unmount();
  assert.equal(framing.cancelled, 2, 'layer off: likewise');
});
