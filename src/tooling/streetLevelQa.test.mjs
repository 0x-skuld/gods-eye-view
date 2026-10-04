import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  fixtureTile,
  EXPECTED_PROVIDERS,
  isCollapsed,
  RAIL_ORDER,
  VIEWPORTS,
} from '../../scripts/qa-street-level.mjs';

test('the QA harness exercises both review viewports', () => {
  assert.deepEqual(
    VIEWPORTS.map((v) => `${v.width}x${v.height}`),
    ['1440x900', '1280x800'],
  );
});

test('the harness expects exactly the registered providers', () => {
  assert.deepEqual(EXPECTED_PROVIDERS, ['mapillary']);
});

test('rail order puts Street Level between CCTV and Context', () => {
  assert.deepEqual(RAIL_ORDER, [
    'pp-toggles',
    'cctv-panel',
    'weather-panel',
    'recent-imagery-panel',
    'street-level-panel',
    'global-context-panel',
  ]);
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
