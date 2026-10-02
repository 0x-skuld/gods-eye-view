/**
 * Suggested views: the God's Eye View view that shows a tool's answer, and
 * the link that opens it when the app's address is known.
 */

import { createView, viewUrl } from '../view/index.js';
import { areaCenter, areaRadiusKm } from './area.js';

const MIN_ALTITUDE_M = 500;
const MAX_ALTITUDE_M = 15_000_000;
// A top-down view sees roughly this many meters of ground per meter of altitude.
const GROUND_PER_ALTITUDE = 0.55;
const POINT_ALTITUDE_M = 50_000;

/** A camera looking straight down that frames a resolved area. */
export function cameraForArea(area) {
  const center = areaCenter(area);
  return {
    lat: center.lat,
    lon: center.lon,
    altitude_m: Math.min(
      MAX_ALTITUDE_M,
      Math.max(
        MIN_ALTITUDE_M,
        (areaRadiusKm(area) * 1000) / GROUND_PER_ALTITUDE,
      ),
    ),
  };
}

/** The app's address, or null when it is not configured. */
function appUrl(services) {
  try {
    return services.app?.baseUrl ? new URL(services.app.baseUrl).href : null;
  } catch {
    return null;
  }
}

/**
 * A view of an area or point with layers on and optionally something
 * followed, plus `url` (null without the app's address). A point is framed
 * from `altitudeM` above it.
 */
export function suggestView(
  services,
  { area, point, layers = [], follow = null, altitudeM = POINT_ALTITUDE_M },
) {
  const camera = area
    ? cameraForArea(area)
    : { lat: point.lat, lon: point.lon, altitude_m: altitudeM };
  const view = createView({ camera, layers, follow });
  const base = appUrl(services);
  return { ...view, url: base ? viewUrl(base, view) : null };
}
