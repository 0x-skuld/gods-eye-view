import assert from 'node:assert/strict';
import test from 'node:test';
import { applyView, installViews, isEmbedded } from './embed.js';
import { createView } from '../view/index.js';

const fakeViewer = () => {
  const flights = [];
  return {
    flights,
    camera: {
      flyTo(options) {
        flights.push(options);
        options.complete();
      },
    },
  };
};
const fakeLayers = (enabled) => ({
  getAll: () =>
    ['flights', 'earthquakes', 'ais-live-vessels'].map((id) => ({
      id,
      enabled: enabled.has(id),
    })),
  isEnabled: (id) => enabled.has(id),
});
const recorder = (answers = {}) => {
  const calls = [];
  const run = async (name, args) => {
    calls.push([name, args]);
    const answer = answers[name];
    return typeof answer === 'function'
      ? answer(calls)
      : (answer ?? { ok: true });
  };
  return { calls, run };
};

test('embed mode is opt-in by query parameter', () => {
  assert.equal(isEmbedded({ search: '?embed=1' }), true);
  assert.equal(isEmbedded({ search: '?welcome=0' }), false);
});

test('a view is applied through the app actions in order', async () => {
  const viewer = fakeViewer();
  const { calls, run } = recorder();
  const view = createView({
    camera: { lat: 25, lon: 121, altitude_m: 300000, pitch_deg: -40 },
    layers: ['ais-live-vessels'],
    style: 'thermal',
    map: 'osm',
    annotations: [{ type: 'pin', target: 'Taipei 101' }],
  });
  const steps = await applyView(view, {
    viewer,
    dataManager: fakeLayers(new Set(['earthquakes'])),
    run,
  });
  assert.deepEqual(
    calls.map(([name, args]) => [
      name,
      args.layerId ?? args.style ?? args.stack ?? null,
      args.enabled ?? null,
    ]),
    [
      ['set_visual_style', 'thermal', null],
      ['set_map_stack', 'osm', null],
      ['set_layer_visibility', 'earthquakes', false],
      ['set_layer_visibility', 'ais-live-vessels', true],
      ['stop_tracking', null, null],
      ['clear_annotations', null, null],
      ['annotate_map', null, null],
    ],
  );
  assert.equal(viewer.flights.length, 1);
  assert.ok(steps.every((step) => step.ok));
  assert.ok(steps.some((step) => step.step === 'camera'));
});

test('a followed entity is retried until its layer has it', async () => {
  let tries = 0;
  const { run } = recorder({
    track_entity: () => ({ ok: ++tries >= 3 }),
  });
  const view = createView({
    camera: { lat: 0, lon: 0 },
    follow: { kind: 'aircraft', id: 'abc123' },
  });
  const steps = await applyView(view, {
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    retryMs: 1,
  });
  assert.equal(tries, 3);
  assert.deepEqual(steps.at(-1), { step: 'follow', ok: true });
});

test('an embedded page takes views only from its parent and answers it', async () => {
  const posted = [];
  const parent = { postMessage: (message) => posted.push(message) };
  const windowRef = new EventTarget();
  windowRef.parent = parent;
  windowRef.document = { body: { classList: new Set() } };
  windowRef.document.body.classList.add = Set.prototype.add;
  const shell = {
    initialRestorePromise: Promise.resolve(),
    clean: null,
    setCleanView(value) {
      this.clean = value;
    },
  };
  const { calls, run } = recorder();
  const remove = installViews({
    shell,
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: { search: '?embed=1', hash: '' },
    windowRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shell.clean, true);
  assert.deepEqual(posted, [{ type: 'gev:ready' }]);
  const send = (source, data) => {
    const event = new Event('message');
    Object.assign(event, { source, data });
    windowRef.dispatchEvent(event);
  };
  send({}, { type: 'gev:view', id: 1, view: { camera: { lat: 1, lon: 2 } } });
  send(parent, { type: 'gev:view', id: 2, view: { camera: {} } });
  send(parent, {
    type: 'gev:view',
    id: 3,
    view: { camera: { lat: 1, lon: 2 }, layers: ['flights'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(posted[1], {
    type: 'gev:view-applied',
    id: 2,
    ok: false,
    error: 'A view needs a camera lat and lon',
  });
  assert.equal(posted[2].id, 3);
  assert.equal(posted[2].ok, true);
  assert.ok(
    calls.some(
      ([name, args]) =>
        name === 'set_layer_visibility' && args.layerId === 'flights',
    ),
  );
  assert.equal(posted.filter((message) => message.id === 1).length, 0);
  remove();
});

test('annotations in a link are drawn after it restores, embedded or not', async () => {
  const { calls, run } = recorder();
  const an = encodeURIComponent(
    JSON.stringify([{ type: 'pin', target: 'Austin' }]),
  );
  installViews({
    shell: { initialRestorePromise: Promise.resolve() },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: { search: '', hash: `#v=2&lat=1&lon=2&an=${an}` },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    ['annotate_map', { annotations: [{ type: 'pin', target: 'Austin' }] }],
  ]);
});
