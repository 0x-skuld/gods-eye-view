import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createApplicationStreetLevel } from '../app/layers/streetLevel.js';
import {
  fixtureTile,
  EXPECTED_PROVIDERS,
  isCollapsed,
} from '../../scripts/qa-street-level.mjs';

test('the harness expects exactly the providers the app registers, in chip order', () => {
  // Any method a provider asks its source for is a no-op: only ids matter.
  const source = new Proxy({}, { get: () => () => {} });
  const layer = createApplicationStreetLevel({
    surface: null,
    sources: { mapillary: source },
  });
  assert.deepEqual([...EXPECTED_PROVIDERS], [...layer.providerIds]);
});

test('a panel reads as collapsed only with the collapsed class', () => {
  assert.equal(isCollapsed(['panel-collapsible', 'collapsed']), true);
  assert.equal(isCollapsed(['panel-collapsible']), false);
});

test('the harness only runs its browser flow when executed directly', () => {
  const source = fs.readFileSync(
    new URL('../../scripts/qa-street-level.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
  );
  assert.match(source, /PUPPETEER_EXECUTABLE_PATH/);
  assert.match(source, /--url/);
});

test('fixture tiles give the hermetic gate something real to filter', async () => {
  const { decodeCoverageTile } =
    await import('../layers/streetLevel/providers/mapillary/decode.js');
  const now = Date.UTC(2026, 9, 1);
  const street = decodeCoverageTile(fixtureTile(14, 2662, 6286, now), {
    x: 2662,
    y: 6286,
    z: 14,
  });
  assert.equal(street.sequences.length, 8);
  const pano = street.sequences.filter((s) => s.isPano).length;
  assert.ok(pano > 0 && pano < 8, '360° and flat both present');
  const year = 365 * 86_400_000;
  const old = street.sequences.filter((s) => now - s.capturedAt > year).length;
  assert.ok(old > 0 && old < 8, 'recent and older both present');
  const orbit = decodeCoverageTile(fixtureTile(3, 1, 3, now), {
    x: 1,
    y: 3,
    z: 3,
  });
  assert.ok(orbit.overview.length > 0, 'overview points from orbit');
  assert.equal(fixtureTile(8, 1, 1, now).length, 0, 'nothing in between');
});

/* ── The real status route probe (review IC8 P2) ───────────────────────── */

test('the gate requires the server’s real Mapillary status route', async () => {
  const { assertRealStatusRoute } =
    await import('../../scripts/qa-street-level.mjs');
  const asked = [];
  const answer = (body, init) => async (url) => {
    asked.push(url);
    return typeof body === 'string'
      ? new Response(body, init)
      : Response.json(body, init);
  };
  assert.deepEqual(
    await assertRealStatusRoute(
      'http://localhost:4173',
      answer({ configured: false }),
    ),
    { configured: false },
  );
  assert.deepEqual(asked, ['http://localhost:4173/api/mapillary/status']);
  for (const [why, fetchImpl] of [
    [
      'an unregistered route (the API 404)',
      answer({ error: 'Unknown API route' }, { status: 404 }),
    ],
    [
      'the SPA fallback',
      answer('<!doctype html><title>GEV</title>', {
        headers: { 'content-type': 'text/html' },
      }),
    ],
    ['a malformed status', answer({ configured: 'yes' })],
    [
      'an unreachable server',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])
    await assert.rejects(
      assertRealStatusRoute('http://localhost:4173', fetchImpl),
      /api\/mapillary\/status/,
      why,
    );
});

/* ── Header press-and-verify shared with the panel gate (review IC8 P2) ── */

/**
 * A page stand-in whose `evaluate` runs the page function in Node against a
 * fake document. The hit check always sees the header; `presses` says where
 * each real pointerdown lands ('header', or 'other' when the rail moved the
 * panel between the check and the press). A drag from the header lifts the
 * panel and a header double-click docks it, unless `stuck`.
 */
function fakePanelPage({ presses = [], floating = false, stuck = false } = {}) {
  const state = { floating, downs: 0, last: null, dragging: false };
  const listeners = [];
  const node = (tagName, id, classes, inHeader) => ({
    tagName,
    id,
    classList: classes,
    closest: (selector) =>
      inHeader && selector.includes('.panel-header') ? {} : null,
  });
  const header = node('DIV', '', ['panel-title'], true);
  const other = node('SECTION', 'weather-panel', ['panel'], false);
  const rect = (left, top, width, height) => () => ({
    left,
    top,
    width,
    height,
  });
  const document = {
    querySelector: () => ({ getBoundingClientRect: rect(120, 210, 100, 20) }),
    getElementById: () => ({
      getBoundingClientRect: rect(100, 200, 300, 400),
      classList: {
        contains: (name) => name === 'panel-floating' && state.floating,
      },
    }),
    elementFromPoint: () => header,
  };
  const window = {
    addEventListener: (type, listener) => listeners.push(listener),
  };
  /** Run page code (an evaluated function or a page listener) in the page. */
  const inPage = (fn, ...args) => {
    const saved = { document: globalThis.document, window: globalThis.window };
    Object.assign(globalThis, { document, window });
    try {
      return fn(...args);
    } finally {
      Object.assign(globalThis, saved);
    }
  };
  const evaluate = async (fn, ...args) => inPage(fn, ...args);
  const press = () => {
    state.last = presses[state.downs++] ?? 'header';
    const target = state.last === 'header' ? header : other;
    for (const listener of listeners.splice(0)) inPage(listener, { target });
  };
  return {
    state,
    evaluate,
    async waitForFunction(fn, options, ...args) {
      for (let i = 0; i < 3; i++) {
        if (await evaluate(fn, ...args)) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
    mouse: {
      async move() {},
      async down() {
        press();
        state.dragging = true;
      },
      async up() {
        if (state.dragging && state.last === 'header' && !stuck)
          state.floating = true;
        state.dragging = false;
      },
      async click(x, y, { clickCount }) {
        if (clickCount === 1) press();
        else if (state.last === 'header' && !stuck) state.floating = false;
      },
    },
  };
}

test('a header press is retried only when it provably missed the header', async () => {
  const { pressMissed } = await import('../../scripts/qa-panelDrag.mjs');
  assert.equal(pressMissed({ done: true, pressed: null }), false);
  assert.equal(
    pressMissed({ done: false, pressed: { inHeader: true } }),
    false,
  );
  assert.equal(
    pressMissed({ done: false, pressed: { inHeader: false } }),
    true,
  );
  assert.equal(pressMissed({ done: false, pressed: null }), true);
});

test('a lift whose press the rail moved off the header is retried, then lifts', async () => {
  const { liftPanelByHeader, describePress } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ presses: ['other', 'header'] });
  const notes = [];
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: (line) => notes.push(line),
    pauseMs: 0,
  });
  assert.equal(attempt.done, true);
  assert.equal(page.state.downs, 2);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /missed the street-level-panel header/);
  assert.match(notes[0], /section#weather-panel\.panel/, 'names what it hit');
  assert.match(describePress(attempt), /in header: true/);
});

test('a press in the header that does not lift fails at once, naming the target', async () => {
  const { liftPanelByHeader, describePress } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ stuck: true });
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: () => assert.fail('no retry'),
    pauseMs: 0,
  });
  assert.equal(attempt.done, false);
  assert.equal(page.state.downs, 1);
  assert.match(describePress(attempt), /on div\.panel-title, in header: true/);
});

test('presses that keep missing stop after the retries and report the miss', async () => {
  const { liftPanelByHeader, PRESS_RETRIES } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ presses: ['other', 'other', 'other', 'other'] });
  const attempt = await liftPanelByHeader(page, 'street-level-panel', {
    dx: -400,
    dy: 80,
    log: () => {},
    pauseMs: 0,
  });
  assert.equal(attempt.done, false);
  assert.equal(page.state.downs, PRESS_RETRIES + 1);
  assert.equal(attempt.pressed.inHeader, false);
});

test('a header double-click docks, waiting on the docked state', async () => {
  const { dockPanelByDoubleClick } =
    await import('../../scripts/qa-panelDrag.mjs');
  const page = fakePanelPage({ floating: true, presses: ['other', 'header'] });
  const attempt = await dockPanelByDoubleClick(page, 'street-level-panel', {
    log: () => {},
    pauseMs: 0,
  });
  assert.equal(attempt.done, true);
  assert.equal(page.state.floating, false);
  assert.equal(page.state.downs, 2, 'the missed first press was retried');
});

test('both panel gates press the header through the shared helper', () => {
  for (const script of ['qa-street-level.mjs', 'qa-panel-resize.mjs']) {
    const source = fs.readFileSync(
      new URL(`../../scripts/${script}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /from '\.\/qa-panelDrag\.mjs'/, script);
    assert.match(source, /liftPanelByHeader\(page, PANEL_ID/, script);
    assert.match(source, /dockPanelByDoubleClick\(page, PANEL_ID/, script);
  }
});
