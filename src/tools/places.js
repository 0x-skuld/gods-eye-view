/**
 * A `places` service backed by the app's `/api/geocode` route. Applications
 * with a different place search can supply any object with the same
 * `resolve(name, { signal })` contract.
 */

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
