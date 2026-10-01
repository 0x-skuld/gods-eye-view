/**
 * The `area` argument shared by location-scoped tools: a bounding box, a
 * center point with radius, or a place name resolved through the `places`
 * service.
 */

import { ToolError } from './catalog.js';

const EARTH_RADIUS_KM = 6371.0088;
const MAX_RADIUS_KM = 2000;

/** JSON Schema for the `area` argument. */
export const AREA_SCHEMA = Object.freeze({
  type: 'object',
  description:
    'Where to look. Give exactly one of: place (a name such as "Taiwan" or ' +
    '"San Francisco Bay"), bbox ([west, south, east, north] in degrees), or ' +
    'lat and lon with radius_km.',
  properties: {
    place: { type: 'string', minLength: 1, maxLength: 200 },
    bbox: {
      type: 'array',
      items: { type: 'number' },
      minItems: 4,
      maxItems: 4,
    },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
    radius_km: { type: 'number', minimum: 0.1, maximum: MAX_RADIUS_KM },
  },
  additionalProperties: false,
});

/**
 * Resolve an `area` argument to `{ label, west, south, east, north, center? }`.
 * A box whose west edge exceeds its east edge crosses the antimeridian.
 */
export async function resolveArea(area, { services, signal } = {}) {
  const given = ['place', 'bbox', 'lat'].filter((key) => area?.[key] != null);
  if (given.length !== 1)
    throw new ToolError(
      'invalid_arguments',
      'area needs exactly one of place, bbox, or lat/lon with radius_km',
    );
  if (area.bbox) {
    const [west, south, east, north] = area.bbox;
    if (
      [west, east].some((value) => Math.abs(value) > 180) ||
      [south, north].some((value) => Math.abs(value) > 90) ||
      south >= north
    )
      throw new ToolError(
        'invalid_arguments',
        'area.bbox must be [west, south, east, north] with south below north',
      );
    return { label: 'the requested box', west, south, east, north };
  }
  if (area.lat != null) {
    if (area.lon == null || area.radius_km == null)
      throw new ToolError(
        'invalid_arguments',
        'area with lat also needs lon and radius_km',
      );
    return circleArea(area.lat, area.lon, area.radius_km);
  }
  const places = services?.places;
  if (!places)
    throw new ToolError(
      'unsupported',
      'Place names cannot be resolved here; give a bbox or lat/lon instead',
    );
  const place = await places.resolve(area.place, { signal });
  if (!place)
    throw new ToolError(
      'invalid_arguments',
      `No place matched "${area.place}"; try a more specific name or a bbox`,
    );
  return { label: place.name || area.place, ...place.bounds };
}

function circleArea(lat, lon, radiusKm) {
  const latSpan = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lonSpan = cosLat < 1e-6 ? 180 : Math.min(180, latSpan / cosLat);
  const wrap = (value) => ((((value + 180) % 360) + 360) % 360) - 180;
  return {
    label: `${radiusKm} km around ${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    west: lonSpan >= 180 ? -180 : wrap(lon - lonSpan),
    east: lonSpan >= 180 ? 180 : wrap(lon + lonSpan),
    south: Math.max(-90, lat - latSpan),
    north: Math.min(90, lat + latSpan),
    center: { lat, lon, radiusKm },
  };
}

/** JSON Schema for a single location: a place name, or lat and lon. */
export const POINT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'A place name, or lat and lon.',
  properties: {
    place: { type: 'string', minLength: 1, maxLength: 200 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
  },
  additionalProperties: false,
});

/** Resolve a point argument to `{ label, lat, lon }`. */
export async function resolvePoint(point, { services, signal } = {}) {
  if (point?.place != null && point.lat == null && point.lon == null) {
    const area = await resolveArea(
      { place: point.place },
      { services, signal },
    );
    return { label: area.label, ...areaCenter(area) };
  }
  if (point?.place == null && point?.lat != null && point?.lon != null)
    return {
      label: `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`,
      lat: point.lat,
      lon: point.lon,
    };
  throw new ToolError(
    'invalid_arguments',
    'A location needs either place, or lat and lon',
  );
}

/** Distance in kilometers from an area's center to its farthest edge point. */
export function areaRadiusKm(area) {
  if (area.center) return area.center.radiusKm;
  const center = areaCenter(area);
  return Math.max(
    ...[
      { lat: area.north, lon: area.west },
      { lat: area.north, lon: area.east },
      { lat: area.south, lon: area.west },
      { lat: area.south, lon: area.east },
    ].map((corner) => distanceKm(center, corner)),
  );
}

/** Great-circle distance in kilometers. */
export function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The center of a resolved area, handling boxes across the antimeridian. */
export function areaCenter(area) {
  if (area.center) return { lat: area.center.lat, lon: area.center.lon };
  const width =
    area.west <= area.east
      ? area.east - area.west
      : area.east + 360 - area.west;
  const lon = area.west + width / 2;
  return {
    lat: (area.south + area.north) / 2,
    lon: lon > 180 ? lon - 360 : lon,
  };
}

/** Whether a point lies inside a resolved area, including radius areas. */
export function areaContains(area, point) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
    return false;
  if (point.lat < area.south || point.lat > area.north) return false;
  const inLongitude =
    area.west <= area.east
      ? point.lon >= area.west && point.lon <= area.east
      : point.lon >= area.west || point.lon <= area.east;
  if (!inLongitude) return false;
  return area.center
    ? distanceKm(area.center, point) <= area.center.radiusKm
    : true;
}
