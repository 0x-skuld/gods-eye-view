import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

const system = (id, city, centerLat, centerLon) => ({
  id,
  city,
  centerLat,
  centerLon,
  loadRadiusKm: 30,
  provider: 'Test Bikes',
  stationInformationUrl: `https://gbfs.example/${id}/station_information.json`,
  stationStatusUrl: `https://gbfs.example/${id}/station_status.json`,
});
const documents = {
  'https://gbfs.example/austin/station_information.json': {
    data: {
      stations: [
        {
          station_id: 's1',
          name: 'Congress & 2nd',
          lat: 30.2645,
          lon: -97.7445,
          capacity: 12,
        },
        {
          station_id: 's2',
          name: 'Far Station',
          lat: 30.4,
          lon: -97.9,
          capacity: 8,
        },
        {
          station_id: 's3',
          name: 'Lamar & 5th',
          lat: 30.268,
          lon: -97.753,
          capacity: '10',
        },
      ],
    },
  },
  'https://gbfs.example/austin/station_status.json': {
    data: {
      stations: [
        {
          station_id: 's1',
          num_bikes_available: 4,
          num_docks_available: 8,
          is_renting: 1,
          last_reported: 1767225600,
        },
        {
          station_id: 's3',
          num_bikes_available: 0,
          num_docks_available: 10,
          is_renting: 0,
        },
      ],
    },
  },
};
const bikeshare = (systems, failing = new Set()) => ({
  systems,
  async getStations(url) {
    if ([...failing].some((id) => url.includes(`/${id}/`)))
      throw new Error('GBFS HTTP 502');
    return documents[url];
  },
});
const downtown = { lat: 30.2672, lon: -97.7431, radius_km: 2 };

test('bike share joins station information with live status inside the area', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      bikeshare: bikeshare([
        system('austin', 'Austin, TX', 30.27, -97.74),
        system('oslo', 'Oslo', 59.9, 10.7),
      ]),
    },
  });
  const result = await catalog.call('get_bike_share', { area: downtown });
  assert.equal(
    result.summary,
    '2 bike-share stations in 2 km around 30.267, -97.743 with 4 bikes available.',
  );
  assert.deepEqual(result.data.systems, ['Austin, TX']);
  assert.deepEqual(result.data.rows[0], {
    system: 'Austin, TX',
    provider: 'Test Bikes',
    station_id: 's1',
    name: 'Congress & 2nd',
    lat: 30.2645,
    lon: -97.7445,
    bikes_available: 4,
    docks_available: 8,
    capacity: 12,
    renting: true,
    returning: true,
    last_reported: '2026-01-01T00:00:00.000Z',
    distance_km: 0.33,
  });
  assert.equal(result.data.rows[1].renting, false);
  assert.equal(result.data.rows[1].capacity, 10);
});

test('bike share reports uncovered areas and failed systems honestly', async () => {
  const none = composeCatalog({
    tools: coreTools,
    services: { bikeshare: bikeshare([system('oslo', 'Oslo', 59.9, 10.7)]) },
  });
  const empty = await none.call('get_bike_share', { area: downtown });
  assert.equal(
    empty.summary,
    'No supported bike-share system covers 2 km around 30.267, -97.743.',
  );
  assert.equal(empty.data.total, 0);
  const both = [
    system('austin', 'Austin, TX', 30.27, -97.74),
    system('round-rock', 'Round Rock', 30.5, -97.68),
  ];
  const partial = composeCatalog({
    tools: coreTools,
    services: { bikeshare: bikeshare(both, new Set(['round-rock'])) },
  });
  assert.match(
    (
      await partial.call('get_bike_share', {
        area: { lat: 30.4, lon: -97.7, radius_km: 20 },
      })
    ).summary,
    /\(1 system unavailable\)\.$/,
  );
  const down = composeCatalog({
    tools: coreTools,
    services: { bikeshare: bikeshare(both, new Set(['austin', 'round-rock'])) },
  });
  await assert.rejects(
    down.call('get_bike_share', { area: downtown }),
    (error) => error.code === 'unavailable',
  );
});

const feed = {
  id: 'capmetro',
  name: 'CapMetro',
  operator: 'Capital Metro',
  center: { lat: 30.27, lon: -97.74 },
  loadRadiusKm: 50,
  attribution: 'Capital Metro',
  license: 'Open data',
};
const vehicles = [
  {
    id: 'v1',
    lat: 30.2675,
    lon: -97.7425,
    bearing: 91.6,
    speedMps: 8.23,
    timestamp: 1767225600,
    routeId: '1',
    tripId: 't1',
    label: '1 North',
    status: 'IN_TRANSIT_TO',
    occupancy: 'FEW_SEATS_AVAILABLE',
  },
  {
    id: 'v2',
    lat: 30.268,
    lon: -97.745,
    bearing: null,
    speedMps: null,
    timestamp: null,
    routeId: '801',
    label: 'Rapid',
  },
  { id: 'v3', lat: 30.5, lon: -97.6, routeId: '1' },
];
const transit = (
  snapshot = { ok: true, status: 200, json: async () => ({ vehicles }) },
) => ({
  requested: [],
  async getFeeds() {
    return [
      feed,
      { ...feed, id: 'far', name: 'Far Away', center: { lat: 0, lon: 0 } },
    ];
  },
  async requestSnapshot(id) {
    this.requested.push(id);
    return snapshot;
  },
});

test('transit vehicles come from nearby feeds and can be limited to a route', async () => {
  const source = transit();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { transit: source },
  });
  const all = await catalog.call('get_transit_vehicles', { area: downtown });
  assert.equal(
    all.summary,
    '2 transit vehicles in 2 km around 30.267, -97.743.',
  );
  assert.deepEqual(source.requested, ['capmetro']);
  assert.deepEqual(all.data.rows[0], {
    feed: 'CapMetro',
    id: 'v1',
    label: '1 North',
    route_id: '1',
    trip_id: 't1',
    lat: 30.2675,
    lon: -97.7425,
    bearing_deg: 92,
    speed_mps: 8.2,
    status: 'IN_TRANSIT_TO',
    occupancy: 'FEW_SEATS_AVAILABLE',
    updated: '2026-01-01T00:00:00.000Z',
    distance_km: 0.07,
  });
  assert.deepEqual(all.data.feeds, [
    {
      name: 'CapMetro',
      operator: 'Capital Metro',
      attribution: 'Capital Metro',
      license: 'Open data',
    },
  ]);
  const rapid = await catalog.call('get_transit_vehicles', {
    area: downtown,
    route: 'rapid',
  });
  assert.equal(
    rapid.summary,
    '1 transit vehicle on route rapid in 2 km around 30.267, -97.743.',
  );
  assert.equal(rapid.data.rows[0].id, 'v2');
});

test('transit reports uncovered areas and unavailable feeds', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { transit: transit() },
  });
  const oslo = await catalog.call('get_transit_vehicles', {
    area: { lat: 59.9, lon: 10.7, radius_km: 5 },
  });
  assert.equal(
    oslo.summary,
    'No supported transit feed covers 5 km around 59.900, 10.700.',
  );
  const down = composeCatalog({
    tools: coreTools,
    services: { transit: transit({ ok: false, status: 503 }) },
  });
  await assert.rejects(
    down.call('get_transit_vehicles', { area: downtown }),
    (error) => error.code === 'unavailable',
  );
});
