import assert from 'node:assert/strict';
import test from 'node:test';
import { StreetLevelControls } from './streetLevelControls.js';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import { DataLayerManager } from '../data/manager.js';
import { LayerStateCoordinator } from '../data/layerStateCoordinator.js';
import {
  LAYER_STATE_REGISTRY,
  REGISTERED_LAYER_IDS,
  encodeLayerStateParams,
} from '../data/layerState.js';

/* ── A small DOM: just what the panel controls touch ───────────────────── */

class FakeNode {
  constructor(document, tag, { id = null, dataset = {}, classes = [] } = {}) {
    this.listeners = new Map();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = { ...dataset };
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.title = '';
    this.value = '';
    this.attributes = new Map();
    const names = new Set(classes);
    this.classList = {
      add: (name) => names.add(name),
      remove: (name) => names.delete(name),
      contains: (name) => names.has(name),
      toggle: (name, force) => {
        const on = force ?? !names.has(name);
        if (on) names.add(name);
        else names.delete(name);
        return on;
      },
    };
    const style = {};
    this.style = Object.assign(style, {
      setProperty: (key, value) => {
        style[key] = value;
      },
      removeProperty: (key) => {
        delete style[key];
      },
    });
    Object.defineProperty(this, 'className', {
      get: () => [...names].join(' '),
      set: (value) => {
        names.clear();
        for (const name of String(value).split(/\s+/).filter(Boolean))
          names.add(name);
      },
    });
  }
  get childElementCount() {
    return this.children.length;
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, reference) {
    child.remove();
    const index = reference
      ? this.children.indexOf(reference)
      : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parent = this;
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(node) {
    for (let current = node; current; current = current.parent)
      if (current === this) return true;
    return false;
  }
  closest(selector) {
    const name = selector.replace(/^\./, '');
    for (let node = this; node; node = node.parent)
      if (node.classList?.contains(name)) return node;
    return null;
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const byId = /^#(.+)$/.exec(selector);
    const byData = /^\[data-([a-z-]+)\]$/.exec(selector);
    const key = byData?.[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return [...this.walk()].filter((node) =>
      byId ? node.id === byId[1] : key ? key in node.dataset : false,
    );
  }
  addEventListener(type, listener, { signal } = {}) {
    if (signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    signal?.addEventListener('abort', () =>
      this.listeners.get(type)?.delete(listener),
    );
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  /** Deliver to this node, then bubble to its ancestors with the same target. */
  dispatchEvent(event) {
    const delivered = {
      type: event.type,
      target: this,
      bubbles: event.bubbles,
    };
    for (let node = this; node; node = delivered.bubbles ? node.parent : null)
      for (const listener of [...(node.listeners.get(event.type) || [])])
        listener(delivered);
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
}

/** The Street Level panel's body, as layer-panels.html lays it out. */
function panelDom() {
  const document = {
    activeElement: null,
    body: null,
    createElement: (tag) => new FakeNode(document, tag),
  };
  document.body = new FakeNode(document, 'body');
  const root = new FakeNode(document, 'section', { id: 'street-level-panel' });
  const add = (parent, tag, options) =>
    parent.appendChild(new FakeNode(document, tag, options));
  for (const id of [
    'sl-status',
    'sl-provider-chips',
    'sl-error',
    'sl-error-text',
    'sl-since',
    'sl-since-label',
    'sl-legend',
    'sl-follow-btn',
    'sl-viewer-expand',
    'sl-viewer-close',
    'sl-viewer-placeholder',
    'sl-image-by',
    'sl-image-when',
    'sl-image-link',
    'sl-coverage-meta',
  ])
    add(root, id === 'sl-legend' ? 'ul' : 'div', { id });
  const controls = add(root, 'fieldset', { id: 'sl-controls' });
  for (const pano of ['all', 'pano', 'flat'])
    add(controls, 'button', { dataset: { slPano: pano } });
  const wrap = add(root, 'div', { id: 'sl-viewer-wrap' });
  add(wrap, 'div', { id: 'sl-viewer' });
  return { document, root };
}

/** Run `fn` with the fake document and an immediate animation frame. */
async function withDom(fn) {
  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const dom = panelDom();
  globalThis.document = dom.document;
  globalThis.requestAnimationFrame = (task) => setTimeout(task, 0);
  try {
    return await fn(dom);
  } finally {
    globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.requestAnimationFrame;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ── A Street Level layer with one stand-in provider ───────────────────── */

function standInProvider() {
  const filters = [];
  return {
    filters,
    def: {
      id: 'mapillary',
      name: 'Mapillary',
      label: 'MAPILLARY',
      requiresKeyId: null,
      pickPrefix: 'mly:',
      colors: { coverage: '#05cb63' },
      credit: { key: 'mapillary', html: 'Mapillary' },
      capabilities: { coverage: 'tiles', sequences: true, pano: true },
      externalUrl: (id) => `https://example.test/${id}`,
      create: () => ({
        status: async () => ({ configured: true }),
        init() {},
        activate() {},
        deactivate() {},
        destroy() {},
        refreshCoverage() {},
        setFilter: (filter) => filters.push(filter),
        coverageStats: () => ({
          count: 0,
          zoom: null,
          kind: null,
          loading: false,
          hint: '',
          error: null,
          keyRequired: false,
        }),
        handlePick: () => false,
        nearestImage: async () => null,
        viewer: {
          mount: async () => {},
          open: async () => {},
          close() {},
          unmount() {},
          resize() {},
          onPose: () => () => {},
        },
      }),
    },
  };
}

/** Every other registered layer, as a module with no options. */
function plainLayer(id) {
  return {
    id,
    name: id,
    icon: '',
    source: 'test',
    async init() {
      return true;
    },
    async enable() {
      return true;
    },
    async update() {
      return true;
    },
    async disable() {
      return true;
    },
  };
}

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

/**
 * The production path a panel click takes: controls → dataManager
 * .setLayerParams → layer.setParams → LayerStateCoordinator's durable state,
 * which is what share links and saved state encode.
 */
async function productionPanel(dom) {
  const provider = standInProvider();
  const layer = createStreetLevelLayer({ providers: [provider.def] });
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS)
    manager.register(id === 'street-level' ? layer : plainLayer(id));
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
  const coordinator = new LayerStateCoordinator(
    manager,
    {
      setLayerStateProvider() {},
      onLayerStateChange() {},
    },
    { storage: memoryStorage() },
  );
  await coordinator.start();
  const controls = new StreetLevelControls({
    root: dom.root,
    layer,
    actions: {
      isEnabled: () => manager.isEnabled('street-level'),
      setEnabled: (on) =>
        manager.setEnabled('street-level', on, { origin: 'user' }),
      setParams: (params, options) =>
        manager.setLayerParams('street-level', params, options),
      setPanelCollapsed() {},
      dockPanel() {},
      showToast() {},
    },
  });
  controls.connect();
  const share = () => {
    const params = new URLSearchParams([['v', '2']]);
    encodeLayerStateParams(params, coordinator.getDurableState());
    return (params.get('lo') || '').split('_');
  };
  return { provider, layer, manager, coordinator, controls, share };
}

const TOKEN = LAYER_STATE_REGISTRY.find(
  (entry) => entry.id === 'street-level',
).token;

test('a 360° click reaches the share link through the data manager', () =>
  withDom(async (dom) => {
    const { provider, coordinator, controls, share } =
      await productionPanel(dom);
    dom.root.querySelectorAll('[data-sl-pano]')[1].click(); // 360°
    await settle();
    assert.equal(provider.filters.at(-1).pano, 'pano', 'the layer applied it');
    assert.equal(
      coordinator.getDurableState().options['street-level'].pano,
      'pano',
      'durable state recorded it',
    );
    assert.ok(share().includes(`${TOKEN}.p.p`), `share link: ${share()}`);
    controls.destroy?.();
    coordinator.destroy();
  }));

test('releasing the SINCE slider records the window in the share link', () =>
  withDom(async (dom) => {
    const { coordinator, controls, share } = await productionPanel(dom);
    const since = dom.root.querySelector('#sl-since');
    since.value = '5'; // the "last year" stop
    since.dispatchEvent(new Event('change'));
    await settle();
    const days =
      coordinator.getDurableState().options['street-level'].sinceDays;
    assert.ok(days > 0, 'a window was recorded');
    assert.ok(share().includes(`${TOKEN}.s.${days}`), `share link: ${share()}`);
    controls.destroy?.();
    coordinator.destroy();
  }));

/* ── Chip rules and render behaviour, against a stand-in layer ─────────── */

function stubLayer() {
  const listeners = new Set();
  let state = null;
  const calls = { resize: 0 };
  return {
    calls,
    publish(next) {
      state = next;
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUIState: () => state,
    resizeViewer() {
      calls.resize++;
    },
    attachViewerHost() {},
  };
}

function uiState({ enabled = true, on = true, open = false, legend } = {}) {
  return {
    enabled,
    keyRequired: false,
    filter: { pano: 'all', sinceDays: 0 },
    providers: [
      {
        id: 'mapillary',
        name: 'Mapillary',
        label: 'MAPILLARY',
        color: '#05cb63',
        on,
        configured: true,
        keyRequired: false,
        requiresKeyId: null,
        loading: false,
        count: 3,
        hint: '',
        error: null,
      },
    ],
    coverage: { count: 3, loading: false, hint: '', error: null },
    legend: legend || [
      { key: 'mapillary', label: 'Mapillary', color: '#05cb63' },
      { key: 'selected', label: 'Selected', color: '#00d4ff' },
    ],
    sequence: { providerId: null, selectedId: null, images: 0, loading: false },
    street: {
      open,
      loading: false,
      follow: false,
      followAvailable: false,
      renderMode: 'letterbox',
      providerId: open ? 'mapillary' : null,
      imageId: open ? 'img-1' : null,
      error: null,
    },
    surface: 'draped',
  };
}

function stubPanel(dom, state) {
  const layer = stubLayer();
  const calls = { setParams: [], setEnabled: [] };
  let enabled = state.enabled;
  layer.publish(state);
  const controls = new StreetLevelControls({
    root: dom.root,
    layer,
    actions: {
      isEnabled: () => enabled,
      setEnabled: async (on) => {
        calls.setEnabled.push(on);
        enabled = on;
      },
      setParams: (params, options) => calls.setParams.push([params, options]),
      setPanelCollapsed() {},
      dockPanel() {},
      showToast() {},
    },
  });
  controls.connect();
  const chip = () => dom.root.querySelector('#sl-provider-chips').children[0];
  return { layer, calls, controls, chip };
}

test('darkening the only lit chip turns the layer off and keeps the provider switched on', () =>
  withDom(async (dom) => {
    const { calls, chip } = stubPanel(dom, uiState());
    assert.equal(chip().dataset.chipId, 'mapillary');
    chip().click();
    await settle();
    assert.deepEqual(calls.setEnabled, [false]);
    assert.deepEqual(calls.setParams, [], 'the provider switch is untouched');
  }));

test('lighting a dark chip switches the provider on as a user params request, then the layer', () =>
  withDom(async (dom) => {
    const { calls, chip } = stubPanel(
      dom,
      uiState({ enabled: false, on: false }),
    );
    chip().click();
    await settle();
    assert.deepEqual(calls.setParams, [
      [{ mapillary: true }, { origin: 'user' }],
    ]);
    assert.deepEqual(calls.setEnabled, [true]);
  }));

test('the legend rebuilds when a swatch changes, even at the same count (review #9)', () =>
  withDom(async (dom) => {
    const { layer } = stubPanel(dom, uiState());
    const legend = dom.root.querySelector('#sl-legend');
    const swatch = () => legend.children[0].children[0].style.background;
    assert.equal(swatch(), '#05cb63');
    layer.publish(
      uiState({
        legend: [
          { key: 'panoramax', label: 'Panoramax', color: '#a66bff' },
          { key: 'selected', label: 'Selected', color: '#00d4ff' },
        ],
      }),
    );
    assert.equal(legend.childElementCount, 2);
    assert.equal(swatch(), '#a66bff');
  }));

test('the viewer is resized when it opens, not on every render (review #8)', () =>
  withDom(async (dom) => {
    const { layer } = stubPanel(dom, uiState());
    assert.equal(layer.calls.resize, 0);
    layer.publish(uiState({ open: true }));
    assert.equal(layer.calls.resize, 1, 'once on open');
    for (let i = 0; i < 5; i++) layer.publish(uiState({ open: true }));
    assert.equal(layer.calls.resize, 1, 'not again while it stays open');
  }));
