import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCameraFollow } from './cameraFollow.js';
import { FOLLOW_EYE_HEIGHT_M } from './policy.js';

/** Height (m) of a Cartesian above the WGS84 ellipsoid. */
const heightOf = (cartesian) =>
  Cesium.Cartographic.fromCartesian(cartesian).height;

/**
 * A viewer whose scene sample is `sampled` (the Austin case: −14,886 m before
 * the tiles under the photo had loaded) and whose bare earth is `dem`.
 */
function setup({ sampled, dem = null, globe = null, altitude = 149 }) {
  const flights = [];
  const views = [];
  const state = {
    services: {},
    street: {
      position: { lon: -97.7364, lat: 30.2672 },
      bearing: 105,
      tilt: -10,
      altitude,
      follow: false,
      followAvailable: true,
    },
    viewer: {
      scene: {
        sampleHeightSupported: true,
        sampleHeight: () => sampled,
        globe: { getHeight: () => globe },
      },
      camera: {
        flyToBoundingSphere: (sphere, options) =>
          flights.push({ sphere, options }),
        setView: (view) => views.push(view),
      },
    },
  };
  const parts = {
    groundCaster: dem === null ? null : { groundAt: () => dem, prepare() {} },
  };
  return {
    follow: createCameraFollow({ state, parts }),
    state,
    flights,
    views,
  };
}

test('framing a photo ignores a sample kilometres underground and uses bare earth', () => {
  const { follow, flights } = setup({ sampled: -14_886, dem: 117 });
  follow.lookAtPosition();
  assert.equal(flights.length, 1);
  const centre = heightOf(flights[0].sphere.center);
  assert.ok(
    Math.abs(centre - 119) < 0.01,
    `centre at ${centre} m, not underground`,
  );
});

test('a plausible mesh sample near bare earth wins (a street, or a modest roof)', () => {
  const { follow, flights } = setup({ sampled: 121, dem: 117 });
  follow.lookAtPosition();
  assert.ok(Math.abs(heightOf(flights[0].sphere.center) - 123) < 0.01);
});

test('without bare earth an absurd sample falls back to the image altitude, never below the surface range', () => {
  const { follow, flights } = setup({
    sampled: -14_886,
    dem: null,
    globe: undefined,
    altitude: 149,
  });
  follow.lookAtPosition();
  assert.ok(Math.abs(heightOf(flights[0].sphere.center) - 151) < 0.01);
});

test('following stands the camera at eye height above the checked ground', () => {
  const { follow, state, views } = setup({ sampled: -14_886, dem: 117 });
  state.street.follow = true;
  follow.followCamera();
  assert.equal(views.length, 1);
  assert.ok(
    Math.abs(heightOf(views[0].destination) - (117 + FOLLOW_EYE_HEIGHT_M)) <
      0.01,
  );
});
