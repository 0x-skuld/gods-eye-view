/**
 * A view: what God's Eye View shows, independent of how it is shown. Camera,
 * data layers, visual style, map imagery and an entity to follow. Views are
 * written in the share-link format, so the app restores them when a link
 * opens and every surface that produces one agrees on its meaning.
 */

import {
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
} from '../data/layerState.js';

/** Visual styles by internal name, with the name share links use. */
export const STYLE_URL_NAMES = Object.freeze({
  normal: 'normal',
  retro: 'crt',
  surveillance: 'nvg',
  thermal: 'flir',
  anime: 'anime',
  noir: 'noir',
  snow: 'snow',
});

const STYLES_BY_URL_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(STYLE_URL_NAMES).map(([name, url]) => [url, name]),
  ),
);

export const VIEW_STYLES = Object.freeze(Object.keys(STYLE_URL_NAMES));

export const VIEW_MAPS = Object.freeze([
  'photoreal',
  'bing-aerial',
  'bing-labels',
  'esri-imagery',
  'osm',
]);

/**
 * What can be followed, the layer that shows it, and where the layer-state
 * codec keeps its identifier.
 */
const FOLLOWABLE = Object.freeze({
  aircraft: {
    layer: 'flights',
    owner: 'flights',
    key: 'selectedFlightsTrackingId',
  },
  military_aircraft: {
    layer: 'military',
    owner: 'flights',
    key: 'selectedMilitaryTrackingId',
  },
  satellite: {
    layer: 'satellites',
    owner: 'satellites',
    key: 'selectedSatTrackingId',
  },
});

export const VIEW_FOLLOW_KINDS = Object.freeze(Object.keys(FOLLOWABLE));

const MIN_ALTITUDE_M = 50;
const MAX_ALTITUDE_M = 20_000_000;

/** JSON Schema for the parts of a view a caller chooses directly. */
export const VIEW_PROPERTIES = Object.freeze({
  camera: Object.freeze({
    type: 'object',
    description:
      'Camera position: lat and lon it is above, altitude in meters, heading ' +
      '(0 is north) and pitch (-90 looks straight down, 0 at the horizon).',
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lon: { type: 'number', minimum: -180, maximum: 180 },
      altitude_m: {
        type: 'number',
        minimum: MIN_ALTITUDE_M,
        maximum: MAX_ALTITUDE_M,
      },
      heading_deg: { type: 'number', minimum: 0, maximum: 360 },
      pitch_deg: { type: 'number', minimum: -90, maximum: 0 },
    },
    additionalProperties: false,
  }),
  layers: Object.freeze({
    type: 'array',
    maxItems: REGISTERED_LAYER_IDS.length,
    items: { type: 'string', enum: [...REGISTERED_LAYER_IDS] },
    description: 'Data layers to turn on, such as "flights" or "earthquakes".',
  }),
  style: Object.freeze({
    type: 'string',
    enum: [...VIEW_STYLES],
    description:
      'Visual style: retro is CRT, surveillance is night vision, thermal is FLIR.',
  }),
  map: Object.freeze({
    type: 'string',
    enum: [...VIEW_MAPS],
    description: 'Map imagery; photoreal is Google 3D tiles.',
  }),
  follow: Object.freeze({
    type: 'object',
    description:
      'An entity the camera follows: an aircraft or military aircraft by ' +
      'ICAO 24-bit address, or a satellite by NORAD catalog number. Its layer ' +
      'is turned on.',
    properties: {
      kind: { type: 'string', enum: [...VIEW_FOLLOW_KINDS] },
      id: { type: 'string', pattern: '^[0-9A-Za-z~_-]{1,16}$' },
    },
    required: ['kind', 'id'],
    additionalProperties: false,
  }),
});

const round = (value, digits) => Number(value.toFixed(digits));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * A complete view from its parts. `camera` needs lat and lon; the rest has
 * defaults: 800 km up, looking straight down, no layers, the recipient's own
 * style and map.
 */
export function createView({
  camera,
  layers = [],
  style = null,
  map = null,
  follow = null,
} = {}) {
  if (!Number.isFinite(camera?.lat) || !Number.isFinite(camera?.lon))
    throw new TypeError('A view needs a camera lat and lon');
  if (style !== null && !VIEW_STYLES.includes(style))
    throw new TypeError(`Unknown view style: ${style}`);
  if (map !== null && !VIEW_MAPS.includes(map))
    throw new TypeError(`Unknown view map: ${map}`);
  const followed = follow ? FOLLOWABLE[follow.kind] : null;
  if (follow && !followed)
    throw new TypeError(`Cannot follow a ${follow.kind}`);
  const enabled = new Set(
    layers.filter((layer) => REGISTERED_LAYER_IDS.includes(layer)),
  );
  if (followed) enabled.add(followed.layer);
  return Object.freeze({
    camera: Object.freeze({
      lat: round(clamp(camera.lat, -90, 90), 4),
      lon: round(clamp(camera.lon, -180, 180), 4),
      altitude_m: Math.round(
        clamp(camera.altitude_m ?? 800_000, MIN_ALTITUDE_M, MAX_ALTITUDE_M),
      ),
      heading_deg: Math.round(camera.heading_deg ?? 0) % 360,
      pitch_deg: Math.round(clamp(camera.pitch_deg ?? -90, -90, 0)),
    }),
    layers: Object.freeze(
      REGISTERED_LAYER_IDS.filter((layer) => enabled.has(layer)),
    ),
    style,
    map,
    follow: follow
      ? Object.freeze({
          kind: follow.kind,
          id: String(follow.id).toLowerCase(),
        })
      : null,
  });
}

/** Share-link hash parameters that restore a view. */
export function viewToParams(view) {
  const params = new URLSearchParams({
    v: '2',
    lat: view.camera.lat.toFixed(4),
    lon: view.camera.lon.toFixed(4),
    alt: String(view.camera.altitude_m),
    heading: String(view.camera.heading_deg),
    pitch: String(view.camera.pitch_deg),
    roll: '0',
  });
  if (view.style) params.set('style', STYLE_URL_NAMES[view.style]);
  if (view.map) params.set('map', view.map);
  if (view.layers.length) {
    const state = createDefaultLayerState();
    state.enabledLayerIds = [...view.layers];
    const followed = view.follow ? FOLLOWABLE[view.follow.kind] : null;
    if (followed)
      state.options[followed.owner] = {
        ...state.options[followed.owner],
        [followed.key]: view.follow.id,
      };
    encodeLayerStateParams(params, state);
  }
  return params;
}

/** The view a set of share-link hash parameters restores, or null. */
export function viewFromParams(params) {
  const lat = Number.parseFloat(params.get('lat'));
  const lon = Number.parseFloat(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const number = (name) => {
    const value = Number.parseFloat(params.get(name));
    return Number.isFinite(value) ? value : undefined;
  };
  const state = decodeLayerStateParams(params);
  let follow = null;
  for (const [kind, followed] of Object.entries(FOLLOWABLE)) {
    const id = state?.options?.[followed.owner]?.[followed.key];
    if (id !== null && id !== undefined && !follow)
      follow = { kind, id: String(id) };
  }
  const map = params.get('map');
  return createView({
    camera: {
      lat,
      lon,
      altitude_m: number('alt'),
      heading_deg: number('heading'),
      pitch_deg: number('pitch'),
    },
    layers: state?.enabledLayerIds ?? [],
    style: STYLES_BY_URL_NAME[params.get('style')] ?? null,
    map: VIEW_MAPS.includes(map) ? map : null,
    follow,
  });
}

/** The address that opens the app at a view. */
export function viewUrl(baseUrl, view) {
  const url = new URL(baseUrl);
  url.hash = viewToParams(view).toString();
  return url.href;
}
