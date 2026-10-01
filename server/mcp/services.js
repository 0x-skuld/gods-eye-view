/**
 * Local composition of tool services: the portable source factories, pointed
 * at a running God's Eye View server's `/api` routes.
 */

import { GBFS_CITY_REGISTRY } from '../../src/layers/bikeshare/registry.js';
import { createBikeshareSource } from '../../src/layers/bikeshare/source.js';
import { createCctvSource } from '../../src/layers/cctv/source.js';
import { createCycloneSource } from '../../src/layers/cyclones/source.js';
import { createUsgsEarthquakeSource } from '../../src/layers/earthquakes/source.js';
import { createFirmsSource } from '../../src/layers/firms/source.js';
import { createInstallationSource } from '../../src/layers/installations/source.js';
import { createLaunchSource } from '../../src/layers/launches/source.js';
import { createWfigsPerimeterSource } from '../../src/layers/perimeters/source.js';
import { createRadioSource } from '../../src/layers/radio/source.js';
import { createSatelliteSource } from '../../src/layers/satellites/source.js';
import { createTrafficSource } from '../../src/layers/traffic/source.js';
import { createTransitSource } from '../../src/layers/transit/source.js';
import { createApplicationRequestServices } from '../../src/services/requests.js';
import {
  createAdsbLolSource,
  createAisStreamSource,
  createOpenSkySource,
} from '../../src/sources/live/standalone.js';
import {
  createGeocodePlaceService,
  createPlaceSearchService,
  createRouteService,
} from '../../src/tools/places.js';

export const DEFAULT_API_BASE = 'http://localhost:4173';

/** Resolve the sources' relative `/api/...` requests against `apiBase`. */
export function createApiFetch({
  apiBase = DEFAULT_API_BASE,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const base = new URL(apiBase);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new TypeError(`apiBase must be an http(s) URL: ${apiBase}`);
  return (input, init) =>
    fetchImpl(
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, base)
        : input,
      init,
    );
}

/** Construct every service Core's tools read, backed by the local server. */
export function createLocalToolServices(options = {}) {
  const fetchImpl = createApiFetch(options);
  const requests = createApplicationRequestServices({ fetchImpl });
  return {
    earthquakes: createUsgsEarthquakeSource({ fetchImpl }),
    fires: createFirmsSource({ fetchImpl }),
    launches: createLaunchSource({ fetchImpl }),
    aircraft: createOpenSkySource({ fetchImpl }),
    military: createAdsbLolSource({ fetchImpl }),
    vessels: createAisStreamSource({
      fetchImpl,
      origin: () => new URL(options.apiBase ?? DEFAULT_API_BASE).origin,
    }),
    satellites: createSatelliteSource({ fetchImpl }),
    cctv: createCctvSource({ fetchImpl }),
    radio: createRadioSource({ fetchImpl }),
    placeSearch: createPlaceSearchService({ fetchImpl }),
    routing: createRouteService({ fetchImpl }),
    bikeshare: {
      systems: GBFS_CITY_REGISTRY,
      getStations: createBikeshareSource({ fetchImpl }).getStations,
    },
    transit: createTransitSource({ fetchImpl }),
    traffic: createTrafficSource({ fetchImpl, tileFetchImpl: fetchImpl }),
    weather: requests.weather,
    regional: requests.regional,
    terrain: requests.terrain,
    summary: requests.summary,
    features: requests.features,
    cyclones: createCycloneSource({ fetchImpl }),
    perimeters: createWfigsPerimeterSource({ fetchImpl }),
    installations: createInstallationSource({
      fetchImpl,
      tileFetchImpl: fetchImpl,
    }),
    places: createGeocodePlaceService({ fetchImpl }),
  };
}
