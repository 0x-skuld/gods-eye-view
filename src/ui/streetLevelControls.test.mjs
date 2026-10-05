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

/**
 * Every write the page would see as a mutation: an attribute set or removed,
 * or a reflected property assigned (even to the value it already has).
 */
const mutations = { count: 0 };
const REFLECTED = ['hidden', 'disabled', 'textContent', 'title', 'value'];

class FakeNode {
  constructor(document, tag, { id = null, dataset = {}, classes = [] } = {}) {
    this.listeners = new Map();
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = { ...dataset };
    this.children = [];
    this.parent = null;
    this.props = {
      hidden: false,
      disabled: false,
      textContent: '',
      title: '',
      value: '',
    };
    for (const key of REFLECTED)
      Object.defineProperty(this, key, {
        get: () => this.props[key],
        set: (value) => {
          mutations.count++;
          this.props[key] = value;
        },
      });
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
        mutations.count++;
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
    mutations.count++;
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    if (this.attributes.delete(key)) mutations.count++;
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
  get isConnected() {
    return this.ownerDocument?.contains(this) === true;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  /** `.class` or `#id`. */
  closest(selector) {
    const byId = /^#(.+)$/.exec(selector);
    const name = selector.replace(/^\./, '');
    for (let node = this; node; node = node.parent)
      if (byId ? node.id === byId[1] : node.classList?.contains(name))
        return node;
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
  /** `#id`, `[data-x]`, and the tag / attribute forms of a focusable list. */
  matches(selector) {
    return selector.split(',').some((part) => {
      const one = part.trim();
      const byId = /^#(.+)$/.exec(one);
      if (byId) return this.id === byId[1];
      const byData = /^\[data-([a-z-]+)\]$/.exec(one);
      if (byData)
        return (
          byData[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in
          this.dataset
        );
      if (one === '[tabindex]:not([tabindex="-1"])')
        return ![null, '-1'].includes(this.getAttribute('tabindex'));
      const byTag = /^([a-z]+)(\[href\])?(:not\(\[disabled\]\))?$/.exec(one);
      if (!byTag || this.tagName !== byTag[1].toUpperCase()) return false;
      if (byTag[2] && this.getAttribute('href') === null) return false;
      return !(byTag[3] && this.disabled);
    });
  }
  querySelectorAll(selector) {
    return [...this.walk()].filter((node) => node.matches(selector));
  }
  addEventListener(type, listener, { signal, capture = false } = {}) {
    if (signal?.aborted) return;
    if (!this.listeners.has(type)) this.listeners.set(type, new Map());
    this.listeners.get(type).set(listener, capture);
    signal?.addEventListener('abort', () =>
      this.listeners.get(type)?.delete(listener),
    );
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  /**
   * Capture down from the document, then deliver to this node and bubble
   * back up with the same target; `stopPropagation` ends the trip.
   */
  dispatchEvent(event) {
    let stopped = false;
    const delivered = {
      type: event.type,
      target: this,
      bubbles: event.bubbles,
      key: event.key,
      shiftKey: event.shiftKey === true,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    const path = [];
    for (let node = this; node; node = node.parent) path.push(node);
    const run = (node, phase) => {
      for (const [listener, capture] of [
        ...(node.listeners.get(event.type) || []),
      ])
        if (phase === 'target' || capture === (phase === 'capture'))
          listener(delivered);
    };
    for (const node of path.slice(1).reverse()) {
      run(node, 'capture');
      if (stopped) return true;
    }
    run(this, 'target');
    if (!delivered.bubbles) return true;
    for (const node of path.slice(1)) {
      if (stopped) return true;
      run(node, 'bubble');
    }
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
}

/** The Street Level panel's body, as layer-panels.html lays it out. */
function panelDom() {
  const document = new FakeNode(null, '#document');
  Object.assign(document, {
    ownerDocument: document,
    activeElement: null,
    createElement: (tag) => new FakeNode(document, tag),
  });
  document.body = document.appendChild(new FakeNode(document, 'body'));
  const root = document.body.appendChild(
    new FakeNode(document, 'section', { id: 'street-level-panel' }),
  );
  const add = (parent, tag, options) =>
    parent.appendChild(new FakeNode(document, tag, options));
  add(root, 'button', { id: 'sl-status' });
  const main = add(root, 'div', { classes: ['sl-main'] });
  // The viewer's own tool bar lives inside the wrap, as in the markup.
  const wrap = add(main, 'div', { id: 'sl-viewer-wrap' });
  add(wrap, 'button', { id: 'sl-viewer-expand' });
  for (const mode of ['letterbox', 'fill'])
    add(wrap, 'button', { dataset: { slRender: mode } });
  for (const id of ['sl-follow-btn', 'sl-viewer-close'])
    add(wrap, 'button', { id });
  for (const id of [
    'sl-viewer-placeholder',
    'sl-viewer',
    'sl-image-by',
    'sl-image-when',
    'sl-image-link',
  ])
    add(wrap, id === 'sl-image-link' ? 'a' : 'div', { id });
  const settings = add(main, 'div', { classes: ['sl-settings'] });
  for (const id of ['sl-provider-chips', 'sl-error', 'sl-error-text'])
    add(settings, 'div', { id });
  // A missing key gates the filters only; the chips stay outside the gate.
  const controls = add(settings, 'fieldset', { id: 'sl-controls' });
  for (const pano of ['all', 'pano', 'flat'])
    add(controls, 'button', { dataset: { slPano: pano } });
  add(controls, 'input', { id: 'sl-since' });
  add(controls, 'output', { id: 'sl-since-label' });
  add(settings, 'ul', { id: 'sl-legend' });
  add(settings, 'div', { id: 'sl-coverage-meta' });
  // The globe's canvas is focusable too (tabindex=0).
  const globe = add(
    add(document.body, 'div', { id: 'cesiumContainer' }),
    'canvas',
  );
  globe.setAttribute('tabindex', '0');
  // A field in another panel (the location search).
  const search = add(document.body, 'input', { id: 'location-search' });
  return { document, root, globe, search };
}

/** Run `fn` with the fake document and an immediate animation frame. */
async function withDom(fn) {
  const saved = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const page = panelDom();
  globalThis.document = page.document;
  globalThis.requestAnimationFrame = (task) => setTimeout(task, 0);
  try {
    return await fn(page);
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
      credit: { html: 'Mapillary' },
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

function uiState({
  enabled = true,
  on = true,
  open = false,
  legend,
  pano = 'all',
  renderMode = 'letterbox',
  keyRequired = false,
} = {}) {
  return {
    enabled,
    keyRequired,
    filter: { pano, sinceDays: 0 },
    providers: [
      {
        id: 'mapillary',
        name: 'Mapillary',
        label: 'MAPILLARY',
        color: '#05cb63',
        on,
        configured: !keyRequired,
        keyRequired,
        requiresKeyId: keyRequired ? 'mapillary' : null,
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
      renderMode,
      providerId: open ? 'mapillary' : null,
      imageId: open ? 'img-1' : null,
      error: null,
    },
    surface: 'draped',
  };
}

function stubPanel(dom, state, extraActions = {}) {
  const layer = stubLayer();
  const calls = { setParams: [], setEnabled: [], collapsed: [], toasts: [] };
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
      setPanelCollapsed: (collapsed, options) =>
        calls.collapsed.push([collapsed, options]),
      dockPanel() {},
      showToast: (message) => calls.toasts.push(message),
      ...extraActions,
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

test('the viewer is resized once when it opens, not on every render (review #8, gekh P3)', () =>
  withDom(async (dom) => {
    const { layer } = stubPanel(dom, uiState());
    await settle();
    assert.equal(layer.calls.resize, 0);
    layer.publish(uiState({ open: true }));
    await settle();
    // Opening also opens the panel; the two share one coalesced resize.
    assert.equal(layer.calls.resize, 1, 'once on open');
    for (let i = 0; i < 5; i++) layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 1, 'not again while it stays open');
    layer.publish(uiState({ open: false }));
    layer.publish(uiState({ open: true }));
    await settle();
    assert.equal(layer.calls.resize, 2, 'the next photo resizes again');
  }));

/* ── The expanded viewer as a dialog, and where focus goes ─────────────── */

const keydown = (target, key, { shiftKey = false } = {}) =>
  target.dispatchEvent({ type: 'keydown', bubbles: true, key, shiftKey });

/** The map's own Esc handler (selection.js) listens on the document. */
function mapEscape(dom) {
  const reached = [];
  dom.document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') reached.push(event);
  });
  return reached;
}

test('Esc shrinks the expanded viewer after focus left it, and the map keeps its selection', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ open: true }));
    const reached = mapEscape(dom);
    controls.setViewerExpanded(true);
    dom.globe.focus(); // a click on the globe
    keydown(dom.globe, 'Escape');
    assert.equal(controls.isViewerExpanded(), false);
    assert.equal(reached.length, 0, 'the selected sequence was not cleared');
    keydown(dom.globe, 'Escape');
    assert.equal(reached.length, 1, 'once shrunk, Esc is the map’s again');
    controls.destroy();
  }));

test('Tab from outside the expanded viewer brings focus back into it', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ open: true }));
    controls.setViewerExpanded(true);
    dom.globe.focus();
    keydown(dom.globe, 'Tab');
    const wrap = dom.document.body.querySelector('#sl-viewer-wrap');
    assert.equal(
      dom.document.activeElement,
      wrap.querySelector('#sl-viewer-expand'),
    );
    keydown(dom.document.activeElement, 'Tab', { shiftKey: true });
    assert.equal(
      dom.document.activeElement,
      wrap.querySelector('#sl-viewer-close'),
      'Shift+Tab wraps to the last control',
    );
    controls.destroy();
  }));

test('closing the image from its × button leaves focus on the panel, not <body>', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-close').focus();
    layer.publish(uiState({ open: false }));
    assert.equal(dom.root.querySelector('#sl-viewer-wrap').hidden, true);
    assert.equal(
      dom.document.activeElement,
      dom.root.querySelector('#sl-status'),
    );
    controls.destroy();
  }));

test('an image closed while expanded does not return focus into the hidden viewer', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    dom.root.querySelector('#sl-viewer-expand').focus();
    controls.setViewerExpanded(true); // remembers EXPAND to return to
    layer.publish(uiState({ open: false }));
    assert.equal(controls.isViewerExpanded(), false);
    assert.equal(
      dom.document.activeElement,
      dom.root.querySelector('#sl-status'),
    );
    controls.destroy();
  }));

/* ── gekh review on #768 ───────────────────────────────────────────────── */

test('a restored layer does not reopen a panel the user collapsed, and automatic opens are never stored (P2-1)', () =>
  withDom(async (dom) => {
    // The panel chrome restored the user's stored "collapsed" before connect.
    dom.root.dataset.collapsedPreference = 'stored';
    const { layer, calls, controls } = stubPanel(
      dom,
      uiState({ enabled: false }),
    );
    layer.publish(uiState({ enabled: true })); // saved layer state restored
    assert.deepEqual(calls.collapsed, [], 'the collapsed panel stays shut');
    // Later, a user switches the layer off and on: that opens the panel,
    // without overwriting the stored preference.
    dom.document.body.dispatchEvent({ type: 'pointerdown', bubbles: true });
    layer.publish(uiState({ enabled: false }));
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    layer.publish(uiState({ enabled: true, open: true }));
    assert.deepEqual(calls.collapsed.at(-1), [false, { persist: false }]);
    controls.destroy();
  }));

test('without a stored choice, a restored layer still opens its panel, unstored (P2-1)', () =>
  withDom(async (dom) => {
    dom.root.dataset.collapsedPreference = 'default';
    const { layer, calls, controls } = stubPanel(
      dom,
      uiState({ enabled: false }),
    );
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    controls.destroy();
  }));

test('with request origins, only a user switch-on opens the panel; a restore never does (P2-1)', () =>
  withDom(async (dom) => {
    // No stored choice: the restore window alone would open the panel.
    dom.root.dataset.collapsedPreference = 'default';
    let announce = null;
    const { layer, calls, controls } = stubPanel(
      dom,
      uiState({ enabled: false }),
      {
        subscribeEnableRequests: (listener) => {
          announce = listener;
          return () => {
            announce = null;
          };
        },
      },
    );
    announce('restore');
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [], 'a restore leaves the panel be');
    layer.publish(uiState({ enabled: false }));
    announce('user');
    layer.publish(uiState({ enabled: true }));
    assert.deepEqual(calls.collapsed, [[false, { persist: false }]]);
    controls.destroy();
    assert.equal(announce, null, 'destroy unsubscribes');
  }));

test('Esc and Tab from a field outside the expanded viewer stay with that field (P3)', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ open: true }));
    const reached = mapEscape(dom);
    controls.setViewerExpanded(true);
    dom.search.focus();
    keydown(dom.search, 'Escape');
    assert.equal(controls.isViewerExpanded(), true, 'the search keeps its Esc');
    assert.equal(reached.length, 1, 'and the event was not swallowed');
    keydown(dom.search, 'Tab');
    assert.equal(dom.document.activeElement, dom.search, 'Tab stays put');
    // From <body> (focus nowhere), Esc is still the viewer's.
    keydown(dom.document.body, 'Escape');
    assert.equal(controls.isViewerExpanded(), false);
    controls.destroy();
  }));

test('a hidden expanded viewer (Clean View, recording, cockpit) holds neither Esc nor Tab (P2-5)', () =>
  withDom(async (dom) => {
    const { controls } = stubPanel(dom, uiState({ open: true }));
    const reached = mapEscape(dom);
    controls.setViewerExpanded(true);
    const wrap = dom.document.body.querySelector('#sl-viewer-wrap');
    wrap.checkVisibility = () => false; // the mode's CSS hides it
    dom.globe.focus();
    keydown(dom.globe, 'Tab');
    assert.equal(dom.document.activeElement, dom.globe);
    keydown(dom.globe, 'Escape');
    assert.equal(controls.isViewerExpanded(), true);
    assert.equal(reached.length, 1, 'Esc went on to the map');
    controls.destroy();
  }));

test('FIT / FILL show the selection while the viewer is expanded (P3)', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    controls.setViewerExpanded(true);
    layer.publish(uiState({ open: true, renderMode: 'fill' }));
    const wrap = dom.document.body.querySelector('#sl-viewer-wrap');
    const [fit, fill] = wrap.querySelectorAll('[data-sl-render]');
    assert.equal(fill.getAttribute('aria-checked'), 'true');
    assert.equal(fit.getAttribute('aria-checked'), 'false');
    assert.equal(fill.classList.contains('is-active'), true);
    controls.destroy();
  }));

test('a hidden (0×0) viewer is not resized, so no z=NaN tile request (P3)', () =>
  withDom(async (dom) => {
    const saved = globalThis.ResizeObserver;
    const observers = [];
    globalThis.ResizeObserver = class {
      constructor(callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
    try {
      const { layer, controls } = stubPanel(dom, uiState({ open: true }));
      await settle();
      const resizes = layer.calls.resize;
      const viewer = dom.root.querySelector('#sl-viewer');
      Object.assign(viewer, { clientWidth: 0, clientHeight: 0 });
      observers[0]();
      await settle();
      assert.equal(layer.calls.resize, resizes, 'skipped while 0×0');
      Object.assign(viewer, { clientWidth: 640, clientHeight: 400 });
      observers[0]();
      await settle();
      assert.equal(layer.calls.resize, resizes + 1, 'resized once it shows');
      controls.destroy();
    } finally {
      globalThis.ResizeObserver = saved;
    }
  }));

test('identical renders write nothing to the DOM (P3: rail MutationObserver)', () =>
  withDom(async (dom) => {
    const { layer, controls } = stubPanel(dom, uiState({ open: true }));
    layer.publish(uiState({ open: true }));
    const before = mutations.count;
    for (let i = 0; i < 10; i++) layer.publish(uiState({ open: true }));
    assert.equal(mutations.count - before, 0);
    controls.destroy();
  }));

test('arrow keys move the selection within a radiogroup, which has one tab stop (P3)', () =>
  withDom(async (dom) => {
    const { layer, calls, controls } = stubPanel(dom, uiState());
    const [all, pano, flat] = dom.root.querySelectorAll('[data-sl-pano]');
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      ['0', '-1', '-1'],
    );
    all.focus();
    keydown(all, 'ArrowRight');
    assert.equal(dom.document.activeElement, pano);
    assert.deepEqual(calls.setParams.at(-1), [
      { pano: 'pano' },
      { origin: 'user' },
    ]);
    keydown(all, 'ArrowLeft'); // wraps to the end
    assert.equal(dom.document.activeElement, flat);
    keydown(flat, 'Home');
    assert.equal(dom.document.activeElement, all);
    layer.publish(uiState({ pano: 'flat' }));
    assert.deepEqual(
      [all, pano, flat].map((button) => button.getAttribute('tabindex')),
      ['-1', '-1', '0'],
    );
    controls.destroy();
  }));

test('under KEY REQUIRED the provider chip stays live and explains the key instead of toggling (P3)', () =>
  withDom(async (dom) => {
    const { calls, chip, controls } = stubPanel(
      dom,
      uiState({ keyRequired: true }),
    );
    assert.equal(dom.root.querySelector('#sl-controls').disabled, true);
    assert.equal(
      dom.root.querySelector('#sl-controls').contains(chip()),
      false,
      'the chip is outside the disabled fieldset',
    );
    chip().click();
    await settle();
    assert.deepEqual(calls.setEnabled, []);
    assert.deepEqual(calls.setParams, []);
    assert.equal(calls.toasts.length, 1);
    assert.match(calls.toasts[0], /^Mapillary: Needs /);
    controls.destroy();
  }));
