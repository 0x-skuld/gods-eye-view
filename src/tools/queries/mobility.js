/** Bike-share and public transit queries. */

import {
  parseStationInformation,
  parseStationStatus,
} from '../../sources/gbfsStations.js';
import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  areaRadiusKm,
  distanceKm,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';

const MAX_SYSTEMS = 3;

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** Systems or feeds whose coverage reaches the area, nearest first. */
function covering(area, entries, centerOf, radiusOf) {
  const center = areaCenter(area);
  const reach = areaRadiusKm(area);
  return entries
    .map((entry) => ({ entry, distance: distanceKm(center, centerOf(entry)) }))
    .filter(({ entry, distance }) => distance <= reach + radiusOf(entry))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_SYSTEMS)
    .map(({ entry }) => entry);
}

export const getBikeShare = defineTool({
  name: 'get_bike_share',
  title: 'Bike-share stations',
  description:
    'Live bike-share stations in an area from public GBFS feeds, nearest the ' +
    'center first, with bikes and docks available.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA, limit: LIMIT_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['bikeshare'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const { bikeshare } = services;
    const systems = covering(
      area,
      bikeshare.systems,
      (system) => ({ lat: system.centerLat, lon: system.centerLon }),
      (system) => system.loadRadiusKm,
    );
    if (!systems.length)
      return {
        summary: `No supported bike-share system covers ${area.label}.`,
        data: { ...capRows([], args.limit), systems: [] },
      };
    const center = areaCenter(area);
    const results = await Promise.allSettled(
      systems.map(async (system) => {
        const [information, status] = await Promise.all([
          bikeshare.getStations(system.stationInformationUrl, { signal }),
          bikeshare.getStations(system.stationStatusUrl, { signal }),
        ]);
        const live = parseStationStatus(status);
        return [...parseStationInformation(information).values()].map(
          (station) => ({ system, station, live: live.get(station.stationId) }),
        );
      }),
    );
    signal?.throwIfAborted();
    if (results.every((result) => result.status === 'rejected'))
      throw new ToolError(
        'unavailable',
        'Bike-share feeds are unavailable right now',
      );
    const rows = results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .filter(({ station }) => areaContains(area, station))
      .map(({ system, station, live }) => ({
        system: system.city,
        provider: system.provider ?? null,
        station_id: station.stationId,
        name: station.name || null,
        lat: round(station.lat, 6),
        lon: round(station.lon, 6),
        bikes_available: live?.bikesAvailable ?? null,
        docks_available: live?.docksAvailable ?? null,
        capacity: station.capacity,
        renting: (live?.isRenting ?? station.isRenting) === true,
        returning: (live?.isReturning ?? station.isReturning) === true,
        last_reported: Number.isFinite(live?.lastReported)
          ? isoTime(live.lastReported * 1000)
          : null,
        distance_km: round(distanceKm(center, station), 2),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    const bikes = rows.reduce(
      (sum, row) => sum + (row.bikes_available ?? 0),
      0,
    );
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    return {
      summary:
        `${countNoun(rows.length, 'bike-share station')} in ${area.label} with ` +
        `${countNoun(bikes, 'bike')} available` +
        (failed ? ` (${countNoun(failed, 'system')} unavailable).` : '.'),
      data: {
        ...capRows(rows, args.limit),
        systems: systems.map((system) => system.city),
        bikes_available: bikes,
      },
    };
  },
});

export const getTransitVehicles = defineTool({
  name: 'get_transit_vehicles',
  title: 'Transit vehicles',
  description:
    'Live positions of buses, trains and other transit vehicles in an area ' +
    'from public GTFS-Realtime feeds, optionally for one route.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      route: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description:
          'Route id or vehicle label to match, such as "1" or "Red".',
      },
      limit: LIMIT_SCHEMA,
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['transit'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const feeds = covering(
      area,
      await services.transit.getFeeds({ signal }),
      (feed) => feed.center,
      (feed) => feed.loadRadiusKm ?? 0,
    );
    if (!feeds.length)
      return {
        summary: `No supported transit feed covers ${area.label}.`,
        data: { ...capRows([], args.limit), feeds: [] },
      };
    const center = areaCenter(area);
    const results = await Promise.allSettled(
      feeds.map(async (feed) => {
        const response = await services.transit.requestSnapshot(feed.id, {
          signal,
        });
        if (!response.ok) throw new Error(`Transit HTTP ${response.status}`);
        const snapshot = await response.json();
        return (snapshot.vehicles || []).map((vehicle) => ({ feed, vehicle }));
      }),
    );
    signal?.throwIfAborted();
    if (results.every((result) => result.status === 'rejected'))
      throw new ToolError(
        'unavailable',
        'Transit feeds are unavailable right now',
      );
    const wanted = args.route?.trim().toLowerCase();
    const rows = results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .filter(({ vehicle }) => areaContains(area, vehicle))
      .filter(
        ({ vehicle }) =>
          !wanted ||
          [vehicle.routeId, vehicle.label].some(
            (value) => String(value || '').toLowerCase() === wanted,
          ),
      )
      .map(({ feed, vehicle }) => ({
        feed: feed.name,
        id: vehicle.id,
        label: vehicle.label ?? null,
        route_id: vehicle.routeId ?? null,
        trip_id: vehicle.tripId ?? null,
        lat: vehicle.lat,
        lon: vehicle.lon,
        bearing_deg: round(vehicle.bearing, 0),
        speed_mps: round(vehicle.speedMps, 1),
        status: vehicle.status ?? null,
        occupancy: vehicle.occupancy ?? null,
        updated: Number.isFinite(vehicle.timestamp)
          ? isoTime(vehicle.timestamp * 1000)
          : null,
        distance_km: round(distanceKm(center, vehicle), 2),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    const failed = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    const what = args.route ? ` on route ${args.route}` : '';
    return {
      summary:
        `${countNoun(rows.length, 'transit vehicle')}${what} in ${area.label}` +
        (failed ? ` (${countNoun(failed, 'feed')} unavailable).` : '.'),
      data: {
        ...capRows(rows, args.limit),
        feeds: feeds.map((feed) => ({
          name: feed.name,
          operator: feed.operator ?? null,
          attribution: feed.attribution ?? null,
          license: feed.license ?? null,
        })),
      },
    };
  },
});
