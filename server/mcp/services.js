/**
 * Local composition of tool services: the portable source factories, pointed
 * at a running God's Eye View server's `/api` routes.
 */

import { createCctvSource } from '../../src/layers/cctv/source.js';
import { createUsgsEarthquakeSource } from '../../src/layers/earthquakes/source.js';
import { createFirmsSource } from '../../src/layers/firms/source.js';
import { createLaunchSource } from '../../src/layers/launches/source.js';
import { createRadioSource } from '../../src/layers/radio/source.js';
import { createSatelliteSource } from '../../src/layers/satellites/source.js';
import {
  createAdsbLolSource,
  createOpenSkySource,
} from '../../src/sources/live/standalone.js';
import { createGeocodePlaceService } from '../../src/tools/places.js';

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
  return {
    earthquakes: createUsgsEarthquakeSource({ fetchImpl }),
    fires: createFirmsSource({ fetchImpl }),
    launches: createLaunchSource({ fetchImpl }),
    aircraft: createOpenSkySource({ fetchImpl }),
    military: createAdsbLolSource({ fetchImpl }),
    satellites: createSatelliteSource({ fetchImpl }),
    cctv: createCctvSource({ fetchImpl }),
    radio: createRadioSource({ fetchImpl }),
    places: createGeocodePlaceService({ fetchImpl }),
  };
}
