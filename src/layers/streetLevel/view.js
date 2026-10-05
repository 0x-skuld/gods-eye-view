import * as Cesium from 'cesium';

/**
 * Approximate metres between two {lon, lat} points: equirectangular, good
 * for the street-scale distances the layer measures.
 */
export function metresBetween(a, b) {
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  return Math.hypot(
    (b.lon - a.lon) * 111_320 * Math.cos(lat),
    (b.lat - a.lat) * 110_540,
  );
}

/**
 * Run low-priority work when the browser is idle, within `timeout` ms; a
 * browser without idle callbacks (and Node) runs it a frame later. The task
 * gets the idle deadline, or null.
 * @param {(deadline: IdleDeadline|null) => void} task
 * @param {number} timeout
 */
export function whenIdle(task, timeout) {
  if (typeof globalThis.requestIdleCallback === 'function')
    globalThis.requestIdleCallback(task, { timeout });
  else setTimeout(() => task(null), 16);
}

/**
 * Height of the surface under the camera above the ellipsoid, in metres. The
 * globe's terrain answers when the globe is shown; Google 3D hides the globe,
 * so there the bare-earth height from `groundAt(lon, lat)` answers instead.
 * Null when neither has a sample yet.
 * @param {object} viewer
 * @param {{groundAt?: (lon: number, lat: number) => number|null}} [options]
 */
export function groundUnderCamera(viewer, { groundAt } = {}) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const globe = viewer.scene?.globe;
  let ground = globe?.show === false ? null : globe?.getHeight?.(carto);
  if (!Number.isFinite(ground))
    ground = groundAt?.(
      Cesium.Math.toDegrees(carto.longitude),
      Cesium.Math.toDegrees(carto.latitude),
    );
  return Number.isFinite(ground) ? ground : null;
}

/**
 * Camera height above the surface under the camera, in metres (without a
 * ground sample a camera over a city 1,600 m up would read 1,600 m too
 * high). Falls back to the ellipsoidal height when nothing has a sample yet.
 * @param {object} viewer
 * @param {{groundAt?: (lon: number, lat: number) => number|null}} [options]
 */
export function cameraHeightAboveGround(viewer, options = {}) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return carto.height - (groundUnderCamera(viewer, options) ?? 0);
}

/** The ellipsoid `height` metres above `ellipsoid` (the ground at that height). */
function raisedEllipsoid(ellipsoid, height) {
  if (!Number.isFinite(height) || Math.abs(height) < 1) return ellipsoid;
  const { x, y, z } = ellipsoid.radii;
  return new Cesium.Ellipsoid(x + height, y + height, z + height);
}

/**
 * Where a screen point's ray meets the ground, as a Cartographic, or null.
 * `maxRange` (metres from the camera) drops hits near the horizon.
 */
function groundHit(camera, point, ellipsoid, maxRange) {
  let cartesian = null;
  try {
    cartesian = camera.pickEllipsoid(point, ellipsoid);
  } catch {
    cartesian = null;
  }
  if (!cartesian) return null;
  if (
    Number.isFinite(maxRange) &&
    camera.positionWC &&
    Cesium.Cartesian3.distance(cartesian, camera.positionWC) > maxRange
  )
    return null;
  return Cesium.Cartographic.fromCartesian(cartesian, ellipsoid) || null;
}

/**
 * Visible bbox as [west, south, east, north] degrees, or null when the camera
 * does not see the ground. A grid of screen rays is cast onto the ellipsoid
 * and only the rays that hit count, so a view that includes the horizon (or a
 * canvas whose frustum is stale) cannot inflate the box to the whole world;
 * `computeViewRectangle` is the fallback when too few rays land.
 *
 * `groundHeight` raises the ellipsoid to the ground under the camera: Google
 * 3D hides the globe, and a city 1,600 m up otherwise puts every hit
 * kilometres ahead of where the rays really meet the streets. `maxRange`
 * (metres) drops hits near the horizon, which a street-level view would
 * otherwise stretch into a box far bigger than anything it can show.
 * `nearRange` (metres) always includes the ground that far around the camera.
 */
export function visibleBbox(
  viewer,
  { grid = 5, groundHeight = null, maxRange = null, nearRange = null } = {},
) {
  const scene = viewer?.scene;
  const camera = viewer?.camera;
  if (!scene || !camera) return null;
  const width = scene.canvas?.clientWidth || scene.canvas?.width || 0;
  const height = scene.canvas?.clientHeight || scene.canvas?.height || 0;
  const hits = [];
  if (width > 0 && height > 0) {
    const ellipsoid = raisedEllipsoid(
      scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
      groundHeight,
    );
    const point = new Cesium.Cartesian2();
    for (let i = 0; i <= grid; i++) {
      for (let j = 0; j <= grid; j++) {
        point.x = (width * i) / grid;
        point.y = (height * j) / grid;
        const carto = groundHit(camera, point, ellipsoid, maxRange);
        if (carto) hits.push(carto);
      }
    }
  }
  // The ground around the camera always counts: a street-level view's screen
  // rows skip from the horizon to the first few metres, and turning the
  // camera should not wait for a reload.
  const nadir = camera.positionCartographic;
  if (Number.isFinite(nearRange) && nearRange > 0 && nadir) {
    const dLat = nearRange / 111_320;
    const dLon = dLat / Math.max(0.05, Math.cos(nadir.latitude));
    const lat = Cesium.Math.toDegrees(nadir.latitude);
    const lon = Cesium.Math.toDegrees(nadir.longitude);
    for (const [dx, dy] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ])
      hits.push(
        Cesium.Cartographic.fromDegrees(
          lon + dx * dLon,
          Math.max(-85, Math.min(85, lat + dy * dLat)),
        ),
      );
  }
  if (hits.length >= 4) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const carto of hits) {
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    // Hits on both sides of ±180° read as a box around the whole globe;
    // measured in 0–360° they are a narrow box across the date line, which
    // comes back as west > east (the convention tilesForBbox splits).
    if (east - west > 180) {
      let west360 = Infinity;
      let east360 = -Infinity;
      for (const carto of hits) {
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const shifted = lon < 0 ? lon + 360 : lon;
        west360 = Math.min(west360, shifted);
        east360 = Math.max(east360, shifted);
      }
      if (east360 - west360 < east - west) {
        west = west360 > 180 ? west360 - 360 : west360;
        east = east360 > 180 ? east360 - 360 : east360;
      }
    }
    if (west !== east && north - south > 0) return [west, south, east, north];
  }
  const rectangle = camera.computeViewRectangle?.(scene.globe?.ellipsoid);
  if (!rectangle) return null;
  return [
    Cesium.Math.toDegrees(rectangle.west),
    Cesium.Math.toDegrees(rectangle.south),
    Cesium.Math.toDegrees(rectangle.east),
    Cesium.Math.toDegrees(rectangle.north),
  ];
}

/** Centre of the visible ground, or the camera's own footprint. */
export function viewCentre(viewer) {
  if (!viewer) return null;
  const bbox = visibleBbox(viewer);
  if (bbox) {
    // Across the date line (west > east) the middle is on the far side of 0°.
    const span = bbox[2] - bbox[0] + (bbox[0] > bbox[2] ? 360 : 0);
    let lon = bbox[0] + span / 2;
    if (lon > 180) lon -= 360;
    return { lat: (bbox[1] + bbox[3]) / 2, lon };
  }
  const carto = viewer.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * The ground the camera is looking at, for ranking coverage tiles: the point
 * under the camera (`nadir`) and the ground hit at the centre of the screen
 * (`ahead`, null when the centre ray misses or is out of `maxRange`).
 * @returns {{nadir: {lon: number, lat: number}, ahead: {lon: number, lat: number}|null}|null}
 */
export function viewFocus(
  viewer,
  { groundHeight = null, maxRange = null } = {},
) {
  const camera = viewer?.camera;
  const carto = camera?.positionCartographic;
  if (!carto) return null;
  const nadir = {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
  const canvas = viewer.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width || 0;
  const height = canvas?.clientHeight || canvas?.height || 0;
  let ahead = null;
  if (width > 0 && height > 0) {
    const hit = groundHit(
      camera,
      new Cesium.Cartesian2(width / 2, height / 2),
      raisedEllipsoid(
        viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84,
        groundHeight,
      ),
      maxRange,
    );
    if (hit)
      ahead = {
        lon: Cesium.Math.toDegrees(hit.longitude),
        lat: Cesium.Math.toDegrees(hit.latitude),
      };
  }
  return { nadir, ahead };
}
