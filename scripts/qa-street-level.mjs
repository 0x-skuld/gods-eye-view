#!/usr/bin/env node
/**
 * Browser QA for the Street Level layer against a running dev
 * server: the panel's place in the right rail, the provider chips (which
 * switch the layer), the keyless gate, coverage and its credit, the imagery
 * filter and SINCE slider, the viewer (visible without scrolling, expanded
 * dialog, close) and the panel as a floating, resizable window. Run with `npm run qa:street-level -- --url http://localhost:4173`.
 * Without MAPILLARY_CLIENT_TOKEN on the server only the keyless steps run.
 *
 * `--fixtures` makes the run hermetic for Mapillary (the CI mode): the page's
 * Mapillary status and coverage-tile requests are answered with generated
 * fixtures (see fixtureTile) and nothing reaches mapillary.com, so no token
 * is needed. The steps that open a photo need real imagery and are skipped.
 * Fixture runs add what a live run cannot stage: a key Mapillary rejects, and
 * a second page whose server has no key (the keyless gate most installs see).
 * Filter assertions are stricter because the fixture data is known. Every run
 * first asks the server's real status route from Node, before the browser
 * intercepts anything, so a server without the Mapillary routes fails.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import { tileBounds } from '../src/layers/streetLevel/tileMath.js';
import { encodeCoverageTile } from '../src/layers/streetLevel/providers/mapillary/coverageFixture.mjs';
import {
  describePress,
  dockPanelByDoubleClick,
  liftPanelByHeader,
} from './qa-panelDrag.mjs';

const PANEL_ID = 'street-level-panel';

/** Viewports every layout assertion runs at. */
export const VIEWPORTS = Object.freeze([
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]);

/** Provider chips the panel must show, in order (one per registered provider). */
export const EXPECTED_PROVIDERS = Object.freeze(['mapillary']);

/** Street Level's share-link token, as the ledger assigned it. */
const STREET_LEVEL_TOKEN = LAYER_STATE_REGISTRY.find(
  (entry) => entry.id === 'street-level',
).token;

/** Expected right-rail order once the layout controller has run. */
export const RAIL_ORDER = Object.freeze([
  'pp-toggles',
  'cctv-panel',
  'weather-panel',
  'recent-imagery-panel',
  'street-level-panel',
  'global-context-panel',
]);

export function isCollapsed(classList) {
  return [...classList].includes('collapsed');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY_MS = 86_400_000;

/**
 * Synthetic coverage for any tile, so fixture runs are deterministic: at
 * street zooms a grid of four east-west and four north-south sequences (half
 * 360°, half captured three years ago), at overview zooms a few points.
 * @returns {Uint8Array} empty for zooms that carry nothing
 */
export function fixtureTile(z, x, y, now = Date.now()) {
  const tile = { x, y, z };
  const { west, east, south, north } = tileBounds(x, y, z);
  const at = (t, lo, hi) => lo + (hi - lo) * t;
  if (z <= 5)
    return encodeCoverageTile(tile, {
      overview: [0.25, 0.5, 0.75].map((t, i) => ({
        id: `fx-${z}-${x}-${y}-o${i}`,
        lon: at(t, west, east),
        lat: at(t, south, north),
        isPano: i === 1,
        capturedAt: now - 30 * DAY_MS,
      })),
    });
  if (z < 11) return new Uint8Array(0);
  const margin = (east - west) * 0.05;
  const sequences = [];
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const old = i > 2;
    sequences.push({
      id: `fx-${z}-${x}-${y}-h${i}`,
      isPano: i % 2 === 0,
      capturedAt: now - (old ? 1100 : 30) * DAY_MS,
      parts: [
        [
          [west + margin, at(t, south, north)],
          [east - margin, at(t, south, north)],
        ],
      ],
    });
    sequences.push({
      id: `fx-${z}-${x}-${y}-v${i}`,
      isPano: i % 2 === 1,
      capturedAt: now - (old ? 30 : 1100) * DAY_MS,
      parts: [
        [
          [at(t, west, east), south + margin],
          [at(t, west, east), north - margin],
        ],
      ],
    });
  }
  return encodeCoverageTile(tile, { sequences });
}

/**
 * Ask the server's real Mapillary status route, outside the browser's
 * interception, and require its JSON shape. Fixture runs answer the route in
 * the page, so without this a server that never registered it would pass.
 * Node sends no Origin or Sec-Fetch-Site, so the same-site gate admits it.
 * @param {string} url the application's base URL
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{configured: boolean}>}
 */
export async function assertRealStatusRoute(url, fetchImpl = fetch) {
  const route = new URL('/api/mapillary/status', url).href;
  let response;
  try {
    response = await fetchImpl(route, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(`${route} is unreachable: ${error?.message || error}`, {
      cause: error,
    });
  }
  const type = response.headers.get('content-type') || '';
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `${route} must be the server's Mapillary route (HTTP ${response.status}: ${text.slice(0, 120)})`,
  );
  assert.match(type, /application\/json/, `${route} answers JSON, not ${type}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(`${route} answered unparseable JSON: ${text.slice(0, 120)}`);
  }
  assert.equal(
    typeof body?.configured,
    'boolean',
    `${route} reports a boolean \`configured\`: ${text.slice(0, 120)}`,
  );
  return body;
}

/**
 * Answer the page's Mapillary requests from fixtures; nothing reaches
 * mapillary.com. `fixture` is live: `configured` is what the status route
 * says, `tiles: 'rejected'` answers tiles as the proxy does when Mapillary
 * refuses the token, and `tileRequests` counts tile requests.
 * @param {object} page
 * @param {{configured: boolean, tiles: 'ok'|'rejected', tileRequests: number}} fixture
 */
async function serveFixtures(page, fixture) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const address = new URL(request.url());
    if (address.pathname === '/api/mapillary/status')
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: fixture.configured }),
      });
    const tile = address.pathname.match(
      /^\/api\/mapillary\/tiles\/coverage\/(\d+)\/(\d+)\/(\d+)$/,
    );
    if (tile) {
      fixture.tileRequests++;
      if (!fixture.configured)
        return request.respond({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'no_key', keyRequired: true }),
        });
      if (fixture.tiles === 'rejected')
        return request.respond({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Mapillary rejected the access token',
            keyRejected: true,
          }),
        });
      const bytes = fixtureTile(
        Number(tile[1]),
        Number(tile[2]),
        Number(tile[3]),
      );
      return bytes.length
        ? request.respond({
            status: 200,
            contentType: 'application/x-protobuf',
            body: Buffer.from(bytes),
          })
        : request.respond({ status: 204, body: '' });
    }
    if (/(^|\.)mapillary\.com$/.test(address.hostname))
      return request.respond({ status: 503, body: '' });
    return request.continue();
  });
}

/** Load the app and clear the first-run dialog. */
async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.dataManager), {
    timeout: 150_000,
  });
  await page.evaluate(() =>
    document.querySelector('.first-run-explore')?.click(),
  );
  await sleep(800);
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      '#first-run-launcher, [class*=first-run]',
    ))
      el.remove();
  });
}

/** Panel geometry and the bits of state the steps assert on. */
function readPanel(page) {
  return page.evaluate(() => {
    const el = document.getElementById('street-level-panel');
    const rail = document.getElementById('right-context-rail');
    const box = el.getBoundingClientRect();
    return {
      order: rail ? [...rail.children].map((child) => child.id) : [],
      classes: [...el.classList],
      width: Math.round(box.width),
      right: Math.round(box.right),
      status: document.getElementById('sl-status').textContent,
      controlsDisabled: document.getElementById('sl-controls').disabled,
      bodyDisplay: getComputedStyle(document.getElementById('sl-body')).display,
    };
  });
}

/** Wait until Street Level is on, drawn, settled and not key-gated. */
function waitForCoverage(page, { timeout = 90_000 } = {}) {
  return page.waitForFunction(
    () => {
      const dm = window.__godsEyeView.dataManager;
      const u = dm.layers.get('street-level').module.getUIState();
      return (
        dm.isEnabled('street-level') &&
        u.coverage.count > 0 &&
        !u.coverage.loading &&
        !u.keyRequired
      );
    },
    { timeout },
  );
}

/** Without a key on the server the panel gates its controls and says why. */
async function assertKeylessGate(page) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('street-level', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () => document.getElementById('sl-status').textContent === 'KEY REQUIRED',
    { timeout: 30_000 },
  );
  const info = await readPanel(page);
  assert.equal(info.controlsDisabled, true);
  assert.equal(info.status, 'KEY REQUIRED');
  const chip = await page.$eval(
    '#sl-provider-chips [data-chip-id="mapillary"]',
    (node) => ({
      error: node.classList.contains('chip-error'),
      title: node.title,
    }),
  );
  assert.equal(chip.error, true, 'the keyless provider chip reads as an error');
  assert.match(chip.title, /MAPILLARY_CLIENT_TOKEN/);
}

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
  const fixtures = args.includes('--fixtures');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    defaultViewport: VIEWPORTS[0],
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  let passed = 0;
  const step = async (label, fn) => {
    const result = await fn();
    passed++;
    console.log(`ok ${passed} ${label}`);
    return result;
  };
  // Opening a photo needs MapillaryJS and real imagery: live runs only.
  const photoStep = fixtures
    ? async (label) => console.log(`skip (fixtures) ${label}`)
    : step;
  const errors = [];
  /** Collect page errors, and the listener exceptions the layer only warns about. */
  const watchErrors = (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (/listener error/i.test(message.text())) errors.push(message.text());
    });
  };
  try {
    // Before any interception: fixture runs answer this route in the page.
    await step(
      'the server registers the real Mapillary status route',
      async () => {
        const real = await assertRealStatusRoute(url);
        console.log(`  (server status: configured=${real.configured})`);
      },
    );
    const page = await browser.newPage();
    const fixture = { configured: true, tiles: 'ok', tileRequests: 0 };
    if (fixtures) await serveFixtures(page, fixture);
    watchErrors(page);
    await boot(page, url);
    const module = () =>
      window.__godsEyeView.dataManager.layers.get('street-level').module;
    const panel = () => readPanel(page);
    const status = await page.evaluate(() =>
      fetch('/api/mapillary/status').then((res) => res.json()),
    );
    for (const viewport of VIEWPORTS) {
      await page.setViewport(viewport);
      await sleep(600);
      await step(
        `panel is a collapsed right-rail strip at ${viewport.width}×${viewport.height}`,
        async () => {
          const info = await panel();
          assert.deepEqual(info.order, RAIL_ORDER);
          assert.ok(isCollapsed(info.classes));
          assert.equal(info.bodyDisplay, 'none');
          assert.ok(info.width <= 200 && info.right <= viewport.width);
        },
      );
    }
    await page.setViewport(VIEWPORTS[0]);
    await page.click(
      '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
    );
    await sleep(500);
    await step(
      'expanding the strip shows the body, one chip per provider and the legend',
      async () => {
        const info = await panel();
        assert.ok(!isCollapsed(info.classes));
        assert.equal(info.bodyDisplay, 'flex');
        const chips = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '#sl-provider-chips .data-toggle-chip',
            ),
          ].map((chip) => chip.dataset.chipId),
        );
        assert.deepEqual(chips, EXPECTED_PROVIDERS);
        // One swatch per source plus "Selected"; each chip wears its colour.
        assert.equal(
          await page.evaluate(
            () => document.querySelectorAll('#sl-legend li').length,
          ),
          EXPECTED_PROVIDERS.length + 1,
        );
        assert.equal(
          await page.$eval('[data-chip-id="mapillary"]', (chip) =>
            chip.style.getPropertyValue('--chip-color'),
          ),
          '#05cb63',
        );
      },
    );
    if (!status.configured) {
      await step(
        'keyless install gates the controls and reports KEY REQUIRED',
        () => assertKeylessGate(page),
      );
      console.log(
        'keyless run complete (no MAPILLARY_CLIENT_TOKEN on the server)',
      );
      return;
    }
    // The startup flight can still be running: cancel it, park the camera over
    // downtown Sacramento and confirm it stays put before enabling the layer.
    const park = () =>
      page.evaluate(() => {
        const v = window.__godsEyeView.viewer;
        v.camera.cancelFlight?.();
        const C = v.camera.positionCartographic.constructor;
        v.camera.setView({
          destination: v.scene.globe.ellipsoid.cartographicToCartesian(
            C.fromDegrees(-121.4944, 38.5816, 900),
          ),
          orientation: { heading: 0, pitch: -1.3, roll: 0 },
        });
      });
    for (let attempt = 0; attempt < 6; attempt++) {
      await park();
      await sleep(1500);
      const stable = await page.evaluate(() => {
        const c = window.__godsEyeView.viewer.camera.positionCartographic;
        return Math.abs((c.longitude * 180) / Math.PI + 121.4944) < 0.01;
      });
      if (stable) break;
    }
    await step(
      'enabling draws coverage and registers the on-globe credit',
      async () => {
        await page.evaluate(() =>
          window.__godsEyeView.dataManager.setEnabled('street-level', true, {
            origin: 'user',
          }),
        );
        await waitForCoverage(page);
        const info = await panel();
        assert.equal(info.controlsDisabled, false);
        // Cesium paints on-screen credits a frame or two after they register.
        await page.waitForFunction(
          () => document.body.innerHTML.includes('Mapillary</a> contributors'),
          { timeout: 15_000 },
        );
      },
    );
    const ui = () =>
      page.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('street-level')
          .module.getUIState(),
      );
    const chip = '#sl-provider-chips [data-chip-id="mapillary"]';
    let firstImageId = null;
    await step(
      'the header ON/OFF pill switches the layer off and on',
      async () => {
        assert.equal(
          await page.$eval('#sl-status', (node) =>
            [
              node.tagName,
              node.textContent,
              node.getAttribute('aria-pressed'),
            ].join(':'),
          ),
          'BUTTON:ON:true',
        );
        await page.click('#sl-status');
        await page.waitForFunction(
          () => !window.__godsEyeView.dataManager.isEnabled('street-level'),
          { timeout: 15_000 },
        );
        await page.waitForFunction(
          () => document.getElementById('sl-status').textContent === 'OFF',
          { timeout: 5_000 },
        );
        assert.equal((await ui()).coverage.count, 0);
        await page.click('#sl-status');
        await waitForCoverage(page);
        assert.equal(
          await page.$eval('#sl-status', (node) =>
            node.getAttribute('aria-pressed'),
          ),
          'true',
        );
      },
    );
    await step(
      'the only lit provider chip switches the whole layer off, credit and all',
      async () => {
        await page.click(chip);
        await page.waitForFunction(
          () =>
            !window.__godsEyeView.dataManager.isEnabled('street-level') &&
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().coverage.count === 0,
          { timeout: 15_000 },
        );
        await page.waitForFunction(
          () => !document.body.innerHTML.includes('Mapillary</a> contributors'),
          { timeout: 15_000 },
        );
        assert.equal(
          await page.$eval(chip, (node) => node.getAttribute('aria-pressed')),
          'false',
        );
        // The provider stays switched on, so the layer comes back with it.
        assert.equal((await ui()).providers[0].on, true);
      },
    );
    await step(
      'lighting the chip turns the layer back on with coverage',
      async () => {
        await page.click(chip);
        await waitForCoverage(page);
        assert.equal(
          await page.$eval(chip, (node) => node.getAttribute('aria-pressed')),
          'true',
        );
      },
    );
    await step(
      'the 360° filter keeps at most the unfiltered sequence count',
      async () => {
        const before = (await ui()).coverage.count;
        await page.click('[data-sl-pano="pano"]');
        await sleep(600);
        const after = (await ui()).coverage.count;
        assert.ok(after <= before, `${after} ≤ ${before}`);
        // The fixtures hold flat sequences too, so the filter must drop some.
        if (fixtures) assert.ok(after < before, `${after} < ${before}`);
        assert.equal((await ui()).filter.pano, 'pano');
        // The click is a user params request, so the share link records it
        // under Street Level's share token, whatever the ledger assigned.
        await page.waitForFunction(
          (option) =>
            (new URLSearchParams(location.hash.slice(1)).get('lo') || '')
              .split('_')
              .includes(option),
          { timeout: 10_000 },
          `${STREET_LEVEL_TOKEN}.p.p`,
        );
        await page.click('[data-sl-pano="all"]');
        await sleep(600);
        assert.equal((await ui()).coverage.count, before);
      },
    );
    await step(
      'the SINCE slider narrows coverage and names its cut-off date',
      async () => {
        const before = (await ui()).coverage.count;
        const setStop = (index) =>
          page.$eval(
            '#sl-since',
            (input, value) => {
              input.value = String(value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            },
            index,
          );
        await setStop(5);
        await sleep(600);
        const narrowed = await ui();
        assert.equal(narrowed.filter.sinceDays, 365);
        if (fixtures)
          assert.ok(
            narrowed.coverage.count < before,
            `fixtures hold older sequences: ${narrowed.coverage.count} < ${before}`,
          );
        assert.ok(
          narrowed.coverage.count <= before,
          `${narrowed.coverage.count} ≤ ${before}`,
        );
        assert.match(
          await page.$eval('#sl-since-label', (node) => node.textContent),
          /^LAST YEAR · SINCE \d{4}-\d{2}-\d{2}$/,
        );
        await setStop(0);
        await sleep(600);
        assert.equal((await ui()).filter.sinceDays, 0);
        assert.equal(
          await page.$eval('#sl-since-label', (node) => node.textContent),
          'ANY DATE',
        );
      },
    );
    await step(
      'the MapillaryJS viewer loads ahead of the first photo',
      async () => {
        // Prewarm stands the lazily imported viewer up in the panel's host; a
        // broken dynamic import would otherwise only show at the first click.
        await page.waitForSelector(
          '#sl-viewer.mapillary-viewer .mapillary-dom',
          {
            timeout: 60_000,
          },
        );
      },
    );
    if (fixtures)
      await step(
        'a key Mapillary rejects reads KEY REJECTED, stops asking, and clears when switched off',
        async () => {
          const statusText = (text) =>
            page.waitForFunction(
              (expected) =>
                document.getElementById('sl-status').textContent === expected,
              { timeout: 30_000 },
              text,
            );
          fixture.tiles = 'rejected';
          await page.click('#sl-status');
          await statusText('OFF');
          await page.click('#sl-status');
          await statusText('KEY REJECTED');
          const shown = await page.evaluate(() => ({
            error: document.getElementById('sl-error').textContent,
            errorHidden: document.getElementById('sl-error').hidden,
            controls: document.getElementById('sl-controls').disabled,
            chip: document
              .querySelector('#sl-provider-chips [data-chip-id="mapillary"]')
              .classList.contains('chip-error'),
          }));
          assert.match(shown.error, /rejected MAPILLARY_CLIENT_TOKEN/);
          assert.equal(shown.errorHidden, false);
          assert.equal(shown.controls, true);
          assert.equal(shown.chip, true);
          // Panning asks for nothing more: the verdict holds for every tile.
          const asked = fixture.tileRequests;
          await page.evaluate(() => {
            const v = window.__godsEyeView.viewer;
            const C = v.camera.positionCartographic.constructor;
            v.camera.setView({
              destination: v.scene.globe.ellipsoid.cartographicToCartesian(
                C.fromDegrees(-121.47, 38.6, 900),
              ),
              orientation: { heading: 0, pitch: -1.3, roll: 0 },
            });
          });
          await sleep(1500);
          assert.equal(
            fixture.tileRequests,
            asked,
            'no tile requests while rejected',
          );
          // Off clears the message; with a good key it comes back as ON.
          await page.click('#sl-status');
          await statusText('OFF');
          assert.equal(
            await page.$eval(
              '#sl-error',
              (node) => node.hidden || !node.textContent,
            ),
            true,
            'no stale error while the layer is off',
          );
          fixture.tiles = 'ok';
          await page.click('#sl-status');
          await waitForCoverage(page);
          await statusText('ON');
        },
      );
    await photoStep(
      'opening the nearest image shows the viewer with a caption',
      async () => {
        // Fire and forget: the open can outlive one CDP call, so poll instead.
        await page.evaluate(() => {
          void window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.openNearest();
        });
        await page.waitForFunction(
          () => {
            const s = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street;
            return s.imageId || s.error;
          },
          { timeout: 90_000 },
        );
        const street = await page.evaluate(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street,
        );
        assert.equal(street.error, null, `viewer error: ${street.error}`);
        // Some images carry no creator name; the date/bearing side always fills.
        try {
          await page.waitForFunction(
            () =>
              document.getElementById('sl-image-when').textContent.trim()
                .length > 0,
            { timeout: 30_000 },
          );
        } catch (error) {
          const dump = await page.evaluate(() => {
            const u = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState();
            // Force one more render: a caption that fills now means an update
            // was missed; one that stays empty means the render path is wrong.
            u.street.renderMode &&
              window.__godsEyeView.dataManager.layers
                .get('street-level')
                .module.setViewerRenderMode(u.street.renderMode);
            return {
              street: u.street,
              captionNodes: document.querySelectorAll('#sl-image-when').length,
              captionNow: document.getElementById('sl-image-when').textContent,
              wrapHidden: document.getElementById('sl-viewer-wrap').hidden,
              collapsed: document
                .getElementById('street-level-panel')
                .classList.contains('collapsed'),
            };
          });
          throw new Error(
            `caption never filled: ${JSON.stringify(dump)}; errors=${JSON.stringify(errors)}`,
            { cause: error },
          );
        }
        const view = await page.evaluate(() => ({
          hidden: document.getElementById('sl-viewer-wrap').hidden,
          when: document.getElementById('sl-image-when').textContent.trim(),
          link: document.getElementById('sl-image-link').textContent.trim(),
          href: document.getElementById('sl-image-link').href,
          width: Math.round(
            document.getElementById('sl-viewer').getBoundingClientRect().width,
          ),
        }));
        assert.equal(view.hidden, false);
        assert.ok(view.width > 200);
        assert.ok(view.when.length > 0, 'caption shows the capture date');
        assert.equal(street.providerId, 'mapillary');
        firstImageId = street.imageId;
        assert.equal(view.link, 'MAPILLARY ↗');
        const fit = await page.evaluate(() => {
          const inner = document.querySelector('.street-level-panel-inner');
          const box = inner.getBoundingClientRect();
          const wrap = document
            .getElementById('sl-viewer-wrap')
            .getBoundingClientRect();
          return {
            scrollTop: inner.scrollTop,
            top: wrap.top - box.top,
            overflowBottom: wrap.bottom - box.bottom,
          };
        });
        assert.equal(fit.scrollTop, 0, 'panel not scrolled');
        assert.ok(
          fit.top >= 0 && fit.top < 80,
          `viewer right under the header (${fit.top}px)`,
        );
        assert.ok(
          fit.overflowBottom <= 1,
          `whole viewer visible (${fit.overflowBottom}px cut)`,
        );
        assert.match(view.href, /mapillary\.com\/app\/\?pKey=/);
      },
    );
    // FOLLOW needs an open photo as well as Google 3D: a photo step.
    await photoStep('FOLLOW is offered only on the Google 3D map', async () => {
      const stacks = () => window.__godsEyeView.mapStackController;
      const follow = () =>
        page.$eval('#sl-follow-btn', (node) => ({
          disabled: node.disabled,
          pressed: node.getAttribute('aria-pressed'),
          title: node.title,
        }));
      const setStack = async (id) => {
        await page.evaluate(
          (stackId) =>
            window.__godsEyeView.mapStackController.setStack(stackId),
          id,
        );
        await sleep(800);
      };
      const original = await page.evaluate(() =>
        window.__godsEyeView.mapStackController.getActiveId(),
      );
      await setStack('esri-imagery');
      let state = await follow();
      assert.equal(state.disabled, true, 'disabled on Esri');
      assert.match(state.title, /needs the Google 3D map/);
      const photoreal = await page.evaluate(() =>
        window.__godsEyeView.mapStackController.isStackAvailable('photoreal'),
      );
      if (photoreal) {
        await setStack('photoreal');
        state = await follow();
        assert.equal(state.disabled, false, 'enabled on Google 3D');
        await page.click('#sl-follow-btn');
        await sleep(300);
        assert.equal((await follow()).pressed, 'true');
        await setStack('esri-imagery');
        state = await follow();
        assert.equal(
          state.pressed,
          'false',
          'leaving Google 3D stops following',
        );
        assert.equal(state.disabled, true);
      } else {
        console.log(
          '  (Google 3D unavailable here: only the disabled path ran)',
        );
      }
      await setStack(original);
      void stacks;
    });
    await step(
      'coverage sits on the bare earth on Google 3D and drapes elsewhere',
      async () => {
        const surface = () =>
          page.evaluate(() => {
            const u = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState();
            return { surface: u.surface, count: u.coverage.count };
          });
        const setStack = (id) =>
          page.evaluate(
            (stackId) =>
              window.__godsEyeView.mapStackController.setStack(stackId),
            id,
          );
        const original = await page.evaluate(() =>
          window.__godsEyeView.mapStackController.getActiveId(),
        );
        // FOLLOW left the camera at eye height; look down on the city again.
        await park();
        await sleep(1500);
        await setStack('esri-imagery');
        await page.waitForFunction(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().surface === 'draped',
          { timeout: 10_000 },
        );
        const coverageLoaded = () => waitForCoverage(page, { timeout: 60_000 });
        await coverageLoaded();
        assert.equal((await surface()).surface, 'draped', 'draped on Esri');
        const photoreal = await page.evaluate(() =>
          window.__godsEyeView.mapStackController.isStackAvailable('photoreal'),
        );
        if (photoreal) {
          await setStack('photoreal');
          await page.waitForFunction(
            () =>
              window.__godsEyeView.dataManager.layers
                .get('street-level')
                .module.getUIState().surface === 'terrain',
            { timeout: 15_000 },
          );
          await coverageLoaded();
          assert.equal((await surface()).surface, 'terrain');
        } else {
          console.log(
            '  (Google 3D unavailable here: only the draped path ran)',
          );
        }
        await setStack(original);
      },
    );
    await photoStep(
      'EXPAND opens a modal dialog and Esc returns focus to the button',
      async () => {
        await page.click('#sl-viewer-expand');
        await sleep(600);
        const dialog = await page.evaluate(() => {
          const wrap = document.getElementById('sl-viewer-wrap');
          return {
            role: wrap.getAttribute('role'),
            modal: wrap.getAttribute('aria-modal'),
            inside: wrap.contains(document.activeElement),
            width: Math.round(wrap.getBoundingClientRect().width),
          };
        });
        assert.equal(dialog.role, 'dialog');
        assert.equal(dialog.modal, 'true');
        assert.equal(dialog.inside, true);
        assert.ok(dialog.width > 900);
        await page.keyboard.press('Escape');
        await sleep(400);
        assert.equal(
          await page
            .evaluate(() => ({
              expanded: document
                .getElementById('sl-viewer-wrap')
                .classList.contains('sl-viewer-wrap-expanded'),
              focus: document.activeElement?.id,
            }))
            .then((r) => `${r.expanded}:${r.focus}`),
          'false:sl-viewer-expand',
        );
      },
    );
    await photoStep(
      '× closes the image and deselects it on the globe',
      async () => {
        await page.click('#sl-viewer-close');
        await sleep(500);
        const after = await page.evaluate(() => {
          const u = window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.getUIState();
          return { open: u.street.open, sequence: u.sequence.selectedId };
        });
        assert.equal(after.open, false);
        assert.equal(after.sequence, null);
      },
    );
    const floating = () =>
      page.$eval('#street-level-panel', (node) =>
        node.classList.contains('panel-floating'),
      );
    const center = (selector) =>
      page.$eval(selector, (node) => {
        const r = node.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    // Lifting and docking re-resolve the header and retry only a press that
    // provably missed it: right after a dock the rail is still animating, and
    // a title point read once can be under another panel (scripts/
    // qa-panelDrag.mjs, shared with the panel-resize gate).
    const floatPanel = async () => {
      const attempt = await liftPanelByHeader(page, PANEL_ID, {
        dx: -400,
        dy: 80,
      });
      assert.equal(
        attempt.done,
        true,
        `a header drag lifts the panel out of the rail (${describePress(attempt)})`,
      );
      assert.equal(await floating(), true);
    };
    await photoStep(
      'the panel floats on a header drag, resizes, and the viewer takes the room',
      async () => {
        await page.evaluate((id) => {
          void window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.openImage('mapillary', id);
        }, firstImageId);
        await page.waitForFunction(
          () => {
            const s = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street;
            return (s.imageId && !s.loading) || s.error;
          },
          { timeout: 90_000 },
        );
        assert.equal((await ui()).street.error, null);
        await floatPanel();
        const viewerHeight = () =>
          page.$eval('#sl-viewer', (node) =>
            Math.round(node.getBoundingClientRect().height),
          );
        const before = await viewerHeight();
        const grip = await center('#street-level-panel .panel-resize-grip');
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        await page.mouse.move(grip.x + 120, grip.y + 160, { steps: 10 });
        await page.mouse.up();
        await sleep(600);
        const after = await viewerHeight();
        assert.ok(
          after > before + 60,
          `viewer grew with the window (${before} → ${after}px)`,
        );
        assert.equal(
          await page.$eval(
            '.sl-settings',
            (node) => getComputedStyle(node).overflowY,
          ),
          'auto',
          'only the settings block scrolls',
        );
      },
    );
    await photoStep(
      'SHRINK after EXPAND docks the window back in the rail at its default size',
      async () => {
        await page.click('#sl-viewer-expand');
        await sleep(500);
        await page.click('#sl-viewer-expand');
        await sleep(600);
        assert.equal(await floating(), false, 'docked again');
        const style = await page.$eval('#street-level-panel', (node) => ({
          width: node.style.width,
          height: node.style.height,
          parent: node.parentElement.id,
        }));
        assert.deepEqual(style, {
          width: '',
          height: '',
          parent: 'right-context-rail',
        });
      },
    );
    await step('a header double-click docks a floating window', async () => {
      await floatPanel();
      // Waits on the docked state itself, not a fixed sleep.
      const attempt = await dockPanelByDoubleClick(page, PANEL_ID);
      assert.equal(
        attempt.done,
        true,
        `docked again (${describePress(attempt)})`,
      );
    });
    await step(
      'collapsing a floating window docks it as the rail strip',
      async () => {
        await floatPanel();
        await page.click(
          '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
        );
        await sleep(600);
        const state = await page.$eval('#street-level-panel', (node) => ({
          floating: node.classList.contains('panel-floating'),
          collapsed: node.classList.contains('collapsed'),
          height: node.style.height,
        }));
        assert.deepEqual(state, {
          floating: false,
          collapsed: true,
          height: '',
        });
      },
    );
    await photoStep(
      'on a phone the whole photo fits in the docked panel',
      async () => {
        // Width alone drives the phone layout; toggling isMobile would reload.
        await page.setViewport({ width: 390, height: 844 });
        await sleep(800);
        if (
          await page.$eval('#street-level-panel', (node) =>
            node.classList.contains('collapsed'),
          )
        )
          await page.click(
            '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
          );
        await page.evaluate((id) => {
          void window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.openImage('mapillary', id);
        }, firstImageId);
        await page.waitForFunction(
          () => {
            const s = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street;
            return (s.imageId && !s.loading) || s.error;
          },
          { timeout: 90_000 },
        );
        await sleep(600);
        const fit = await page.evaluate(() => {
          const inner = document
            .querySelector('.street-level-panel-inner')
            .getBoundingClientRect();
          const meta = document
            .getElementById('sl-image-meta')
            .getBoundingClientRect();
          const viewer = document
            .getElementById('sl-viewer')
            .getBoundingClientRect();
          return {
            cut: Math.round(meta.bottom - inner.bottom),
            top: Math.round(viewer.top - inner.top),
            height: Math.round(viewer.height),
            overflowX: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.ok(fit.cut <= 1, `photo and caption fit (${fit.cut}px cut)`);
        assert.ok(fit.height >= 100, `viewer stays usable (${fit.height}px)`);
        assert.equal(fit.overflowX, false, 'no sideways scroll');
        await page.setViewport(VIEWPORTS[0]);
        await sleep(600);
      },
    );
    if (fixtures)
      await step(
        'keyless install (a second page, no key on the server) gates the controls and reports KEY REQUIRED',
        async () => {
          const keyless = await browser.newPage();
          await keyless.setViewport(VIEWPORTS[0]);
          await serveFixtures(keyless, {
            configured: false,
            tiles: 'ok',
            tileRequests: 0,
          });
          watchErrors(keyless);
          await boot(keyless, url);
          await keyless.click(
            '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
          );
          await assertKeylessGate(keyless);
          await keyless.close();
        },
      );
    await step('no page errors', () => {
      assert.deepEqual(errors, []);
    });
    void module;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
