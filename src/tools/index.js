/**
 * Tools that answer questions from God's Eye View data, independent of the
 * surface that exposes them. See docs/TOOLS.md.
 */

import {
  aircraftInArea,
  findAircraft,
  getAircraftInfo,
  getAircraftTrack,
} from './queries/aviation.js';
import { getHudCaption, situationBrief } from './queries/brief.js';
import {
  findMilitaryInstallations,
  getCyclones,
  getFirePerimeters,
  getMapFeatures,
  getRegionalBrief,
  getTerrainHeight,
  getWeather,
} from './queries/environment.js';
import { getActiveFires, getEarthquakes } from './queries/hazards.js';
import {
  findVessel,
  getVesselTrack,
  vesselsInArea,
} from './queries/maritime.js';
import {
  getBikeShare,
  getTrafficFlow,
  getTransitVehicles,
} from './queries/mobility.js';
import { placesNearby, planRoute, searchPlaces } from './queries/places.js';
import {
  findCctvCameras,
  findRadioStations,
  getCctvSnapshot,
} from './queries/media.js';
import {
  getRecentLaunches,
  nextSatellitePass,
  satellitesOverhead,
} from './queries/space.js';

export {
  defineTool,
  composeCatalog,
  ToolError,
  TOOL_ERROR_CODES,
} from './catalog.js';
export {
  AREA_SCHEMA,
  resolveArea,
  areaCenter,
  areaContains,
  distanceKm,
} from './area.js';
export { LIMIT_SCHEMA, DEFAULT_LIMIT, MAX_LIMIT, capRows } from './results.js';
export {
  createGeocodePlaceService,
  createPlaceSearchService,
  createRouteService,
  placeFromGeocodeResult,
} from './places.js';

/** Every query Core defines, in a stable order. */
export const coreTools = Object.freeze([
  getEarthquakes,
  getActiveFires,
  getRecentLaunches,
  aircraftInArea,
  findAircraft,
  getAircraftTrack,
  getAircraftInfo,
  vesselsInArea,
  findVessel,
  getVesselTrack,
  nextSatellitePass,
  satellitesOverhead,
  findCctvCameras,
  getCctvSnapshot,
  findRadioStations,
  searchPlaces,
  placesNearby,
  planRoute,
  getBikeShare,
  getTransitVehicles,
  getTrafficFlow,
  getWeather,
  getRegionalBrief,
  getCyclones,
  getFirePerimeters,
  getTerrainHeight,
  findMilitaryInstallations,
  getMapFeatures,
  situationBrief,
  getHudCaption,
]);
