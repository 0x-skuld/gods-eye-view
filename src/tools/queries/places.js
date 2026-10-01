/** Place search and routing queries. */

import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  areaContains,
  areaRadiusKm,
  resolveArea,
  resolvePoint,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun, thinEvenly } from '../results.js';

const MODES = { walk: 'foot', drive: 'car', bike: 'bike' };
const MAX_ROUTE_POINTS = 100;
const NOT_CONFIGURED =
  'Place search needs a Google Places key configured for this server';

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function placeRow(place) {
  return {
    id: place.id ?? null,
    name: place.name ?? null,
    address: place.address ?? null,
    type: place.primaryType ?? null,
    lat: round(place.latitude, 6),
    lon: round(place.longitude, 6),
    distance_m: Number.isFinite(place.distanceM) ? place.distanceM : null,
  };
}

export const searchPlaces = defineTool({
  name: 'search_places',
  title: 'Search places',
  description:
    'Find businesses, landmarks and other points of interest matching a ' +
    'query within an area, using Google Places.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      area: AREA_SCHEMA,
      limit: LIMIT_SCHEMA,
    },
    required: ['query', 'area'],
    additionalProperties: false,
  },
  requires: ['placeSearch'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const center = areaCenter(area);
    const radiusM = Math.round(
      Math.min(50000, Math.max(500, areaRadiusKm(area) * 1000)),
    );
    const result = await services.placeSearch.search(
      args.query,
      { latitude: center.lat, longitude: center.lon, radiusM },
      { signal },
    );
    if (!result.configured) throw new ToolError('unavailable', NOT_CONFIGURED);
    const rows = result.places
      .filter((place) =>
        areaContains(area, { lat: place.latitude, lon: place.longitude }),
      )
      .map(placeRow);
    return {
      summary: `${countNoun(rows.length, 'place')} matching "${args.query}" in ${area.label}.`,
      data: capRows(rows, args.limit),
    };
  },
});

export const placesNearby = defineTool({
  name: 'places_nearby',
  title: 'Places nearby',
  description:
    'Notable places around a point within a radius, most notable first, ' +
    'using Google Places.',
  inputSchema: {
    type: 'object',
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lon: { type: 'number', minimum: -180, maximum: 180 },
      radius_m: { type: 'number', minimum: 10, maximum: 5000 },
      limit: LIMIT_SCHEMA,
    },
    required: ['lat', 'lon'],
    additionalProperties: false,
  },
  requires: ['placeSearch'],
  async run(args, { services, signal }) {
    const radiusM = Math.round(args.radius_m ?? 250);
    const result = await services.placeSearch.nearby(
      { latitude: args.lat, longitude: args.lon, radiusM },
      { signal },
    );
    if (!result.configured) throw new ToolError('unavailable', NOT_CONFIGURED);
    const rows = result.places.map(placeRow);
    return {
      summary: `${countNoun(rows.length, 'place')} within ${radiusM} m.`,
      data: capRows(rows, args.limit),
    };
  },
});

export const planRoute = defineTool({
  name: 'plan_route',
  title: 'Plan a route',
  description:
    'Walking, driving or cycling route between two locations over ' +
    'OpenStreetMap, with distance, duration and a simplified path.',
  inputSchema: {
    type: 'object',
    properties: {
      from: POINT_SCHEMA,
      to: POINT_SCHEMA,
      mode: { type: 'string', enum: Object.keys(MODES) },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  requires: ['routing'],
  async run(args, { services, signal }) {
    const [from, to] = await Promise.all([
      resolvePoint(args.from, { services, signal }),
      resolvePoint(args.to, { services, signal }),
    ]);
    const mode = args.mode ?? 'walk';
    const route = await services.routing.route([from, to], MODES[mode], {
      signal,
    });
    if (!route?.ok)
      throw new ToolError(
        'invalid_arguments',
        `No ${mode} route from ${from.label} to ${to.label}: ${route?.error || 'no route found'}`,
      );
    const path = thinEvenly(route.geometry, MAX_ROUTE_POINTS).map(
      ([lon, lat]) => [round(lon, 5), round(lat, 5)],
    );
    const km = route.distanceM / 1000;
    const minutes = Math.round(route.durationS / 60);
    return {
      summary: `${mode[0].toUpperCase()}${mode.slice(1)} from ${from.label} to ${to.label}: ${km.toFixed(1)} km, about ${minutes} minutes.`,
      data: {
        mode,
        from,
        to,
        distance_m: route.distanceM,
        duration_s: route.durationS,
        path_lon_lat: path,
        path_points: route.geometry.length,
      },
    };
  },
});
