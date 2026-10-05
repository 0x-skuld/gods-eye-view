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
