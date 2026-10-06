import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  cameraHeightAboveGround,
  metresBetween,
  viewCentre,
  viewFocus,
  visibleBbox,
} from './view.js';
import { rayCamera } from '../../testSupport/streetLevelFakes.mjs';

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

/** A camera whose screen rays land on a grid of lon/lat points. */
function gridViewer(lons, lats) {
  const points = [];
  for (const lat of lats)
    for (const lon of lons)
      points.push(Cesium.Cartesian3.fromDegrees(lon, lat));
  let next = 0;
  return {
    scene: { canvas: { clientWidth: 100, clientHeight: 100 }, globe: {} },
    camera: {
      pickEllipsoid: () => points[next++ % points.length],
      positionCartographic: { longitude: 0, latitude: 0, height: 1000 },
    },
  };
}

test('a view across the date line is a narrow box with west > east', () => {
  const viewer = gridViewer([178, 179, -179, -178], [-1, 0, 1]);
  const bbox = visibleBbox(viewer);
  assert.ok(bbox[0] > 177 && bbox[0] < 179, `west ${bbox[0]}`);
  assert.ok(bbox[2] < -177 && bbox[2] > -179, `east ${bbox[2]}`);
  const centre = viewCentre(viewer);
  assert.ok(Math.abs(Math.abs(centre.lon) - 180) < 0.5, `centre ${centre.lon}`);
});

test('an ordinary view keeps west < east', () => {
  const bbox = visibleBbox(gridViewer([10, 11, 12], [50, 51]));
  assert.ok(bbox[0] < bbox[2]);
  assert.ok(
    Math.abs(viewCentre(gridViewer([10, 11, 12], [50, 51])).lon - 11) < 1e-6,
  );
});

/** A pinhole viewer `agl` m above ground `ground` m up, looking north. */
function pinhole({ lon, lat, ground, agl, pitch, w = 1600, h = 900 }) {
  return {
    scene: {
      canvas: { clientWidth: w, clientHeight: h },
      globe: { show: false, ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: rayCamera({
      lon,
      lat,
      altitude: ground + agl,
      pitch,
      width: w,
      height: h,
    }),
  };
}

test('a tilted street view over high ground boxes the streets it looks at, not the horizon (review IC8 P1)', () => {
  // Denver, 600 m above a street 1,610 m up, looking 20° down: the centre of
  // the screen meets the street about 1.65 km north of the camera.
  const view = pinhole({
    lon: -104.99,
    lat: 39.74,
    ground: 1610,
    agl: 600,
    pitch: -20,
  });
  const ahead = 39.74 + 1648 / 111_000;
  const unranged = visibleBbox(view);
  // Rays to the bare ellipsoid travel 1.6 km further down: the old box was
  // 20 km wide and started past the street at the centre of the screen.
  assert.ok(unranged[2] - unranged[0] > 0.2);
  assert.ok(unranged[1] > ahead, 'the old box missed the street in view');
  const options = { groundHeight: 1610, maxRange: 6000, nearRange: 1000 };
  const [west, south, east, north] = visibleBbox(view, options);
  assert.ok(north - south < 0.08 && east - west < 0.08, 'a street-sized box');
  assert.ok(south < 39.74 && north > ahead, 'camera and screen centre inside');
  const focus = viewFocus(view, options);
  assert.ok(Math.abs(focus.nadir.lat - 39.74) < 1e-9);
  assert.ok(
    Math.abs(focus.ahead.lat - ahead) < 0.002,
    'centre ray on the street',
  );
  assert.ok(Math.abs(focus.ahead.lon - -104.99) < 1e-6);
});

test('looking at the horizon from eye height still boxes the ground around the camera', () => {
  const view = pinhole({
    lon: -121.4944,
    lat: 38.5816,
    ground: 10,
    agl: 2,
    pitch: -5,
  });
  const [west, south, east, north] = visibleBbox(view, {
    groundHeight: 10,
    maxRange: 2500,
    nearRange: 1000,
  });
  assert.ok(north - 38.5816 > 0.008 && 38.5816 - south > 0.008);
  assert.ok(east - -121.4944 > 0.008 && -121.4944 - west > 0.008);
});

test('metresBetween measures the short way round the date line (review IC8 P2)', () => {
  const east = { lon: 179.9999, lat: 0 };
  const west = { lon: -179.9999, lat: 0 };
  // 0.0002° of longitude at the equator, not 40,000 km round the other way.
  assert.ok(Math.abs(metresBetween(east, west) - 22.264) < 1e-6);
  assert.ok(Math.abs(metresBetween(west, east) - 22.264) < 1e-6);
  assert.ok(
    Math.abs(
      metresBetween({ lon: 180, lat: 0 }, { lon: -180, lat: 0.0001 }) - 11.054,
    ) < 1e-6,
    'the two names of the same meridian',
  );
  // Away from the date line nothing changes.
  assert.ok(
    Math.abs(
      metresBetween({ lon: 10, lat: 0 }, { lon: 10.001, lat: 0 }) - 111.32,
    ) < 1e-9,
  );
});
