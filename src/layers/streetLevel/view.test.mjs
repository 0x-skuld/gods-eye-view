import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraHeightAboveGround } from './view.js';

const RAD = Math.PI / 180;
/** A viewer 300 m above a street 1,600 m up (Denver-like). */
function viewer({ globeShown, globeHeight }) {
  return {
    camera: {
      positionCartographic: {
        longitude: -104.99 * RAD,
        latitude: 39.74 * RAD,
        height: 1900,
      },
    },
    scene: { globe: { show: globeShown, getHeight: () => globeHeight } },
  };
}

test('a shown globe answers the ground under the camera', () => {
  assert.equal(
    cameraHeightAboveGround(viewer({ globeShown: true, globeHeight: 1600 })),
    300,
  );
});

test('a hidden globe (Google 3D) falls back to the bare-earth height', () => {
  const calls = [];
  const groundAt = (lon, lat) => {
    calls.push([+lon.toFixed(2), +lat.toFixed(2)]);
    return 1600;
  };
  // A hidden globe's getHeight is ignored even when it returns a number.
  const hidden = viewer({ globeShown: false, globeHeight: 0 });
  assert.equal(cameraHeightAboveGround(hidden, { groundAt }), 300);
  assert.deepEqual(calls, [[-104.99, 39.74]]);
});

test('with no ground sample the ellipsoidal height is used', () => {
  const hidden = viewer({ globeShown: false, globeHeight: 0 });
  assert.equal(cameraHeightAboveGround(hidden), 1900);
  assert.equal(cameraHeightAboveGround(hidden, { groundAt: () => null }), 1900);
  assert.equal(cameraHeightAboveGround({}), null);
});
