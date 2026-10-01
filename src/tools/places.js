/**
 * Place services backed by the app's own routes. Applications with different
 * providers can supply any objects with the same contracts:
 *
 * - `places.resolve(name, { signal })` turns a name into bounds (`/api/geocode`).
 * - `placeSearch.search(query, near, { signal })` and
 *   `placeSearch.nearby(near, { signal })` find points of interest
 *   (`/api/google/*`), reporting whether search is configured.
 * - `routing.route(points, profile, { signal })` plans a route (`/api/route`).
 */

import { ToolError } from './catalog.js';

const POINT_RADIUS_DEGREES = 0.25;

/** Resolve place names to `{ name, bounds: { west, south, east, north } }` or null. */
export function createGeocodePlaceService({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async resolve(name, { signal } = {}) {
      const query = new URLSearchParams({ q: name });
      const response = await fetchImpl(`/api/geocode?${query}`, { signal });
      if (!response.ok) throw new Error(`Geocode HTTP ${response.status}`);
      const payload = await response.json();
      return placeFromGeocodeResult(payload?.results?.[0]);
    },
  };
}

/** Convert one geocode result to a place with bounds, or null. */
export function placeFromGeocodeResult(result) {
  const location = result?.geometry?.location;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng))
    return null;
  const viewport = result.geometry.viewport;
  const bounds =
    viewport &&
    [
      viewport.southwest?.lat,
      viewport.southwest?.lng,
      viewport.northeast?.lat,
      viewport.northeast?.lng,
    ].every(Number.isFinite)
      ? {
          west: viewport.southwest.lng,
          south: viewport.southwest.lat,
          east: viewport.northeast.lng,
          north: viewport.northeast.lat,
        }
      : {
          west: Math.max(-180, location.lng - POINT_RADIUS_DEGREES),
          south: Math.max(-90, location.lat - POINT_RADIUS_DEGREES),
          east: Math.min(180, location.lng + POINT_RADIUS_DEGREES),
          north: Math.min(90, location.lat + POINT_RADIUS_DEGREES),
        };
  return { name: result.formatted_address || null, bounds };
}

/** Search points of interest; `configured` is false when the server has no search key. */
export function createPlaceSearchService({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function read(path, params, signal) {
    const response = await fetchImpl(`${path}?${new URLSearchParams(params)}`, {
      signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* the status below is authoritative */
    }
    if (!response.ok) throw httpFailure(response, 'Place search');
    return {
      configured: payload?.configured !== false,
      places: Array.isArray(payload?.places) ? payload.places : [],
    };
  }
  return {
    search(query, { latitude, longitude, radiusM }, { signal } = {}) {
      return read(
        '/api/google/text-search',
        { q: query, lat: latitude, lon: longitude, radiusM },
        signal,
      );
    },
    nearby({ latitude, longitude, radiusM }, { signal } = {}) {
      return read(
        '/api/google/nearby-places',
        { lat: latitude, lon: longitude, radiusM },
        signal,
      );
    },
  };
}

/** Plan routes between `[{ lat, lon }]` points; resolves `{ ok, ... }`. */
export function createRouteService({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async route(points, profile, { signal } = {}) {
      const coords = points
        .map((point) => `${point.lon.toFixed(6)},${point.lat.toFixed(6)}`)
        .join(';');
      const response = await fetchImpl(
        `/api/route?${new URLSearchParams({ profile, coords })}`,
        { signal },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        /* the status below is authoritative */
      }
      if (response.status === 429) throw httpFailure(response, 'Routing');
      if (payload?.ok === false || response.status === 400)
        return { ok: false, error: payload?.error || 'no route found' };
      if (!response.ok) throw httpFailure(response, 'Routing');
      return payload;
    },
  };
}

function httpFailure(response, label) {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'));
    return new ToolError('retry_later', `${label} is rate limited`, {
      retryAfterSeconds:
        Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    });
  }
  return new Error(`${label} HTTP ${response.status}`);
}
