import { readFileSync } from 'node:fs';

/**
 * Mapillary Graph API and image CDN, answered from fixtures, so the Street
 * Level gate's photo flow runs with no network and no real token (the CI
 * mode). It covers every request the app's provider and the embedded
 * MapillaryJS 4 viewer make while opening, stepping and closing a photo:
 *
 *   provider (src/layers/streetLevel/providers/mapillary/source.js)
 *     GET graph /images?lat&lng&radius&limit&fields       nearest lookup
 *     GET graph /images?sequence_ids&fields&limit         a sequence's cones
 *   MapillaryJS GraphDataProvider (node_modules/mapillary-js)
 *     GET graph /images?image_ids&fields                  image ents (core + spatial)
 *     GET graph /images?s2&fields                         core images of an S2 cell
 *     GET graph /image_ids?sequence_id                    a sequence's image ids
 *     GET graph /{imageId}/tiles?z&fields                 image tiles (imageTiling)
 *     GET thumb_1024_url / thumb_2048_url                 the photo itself
 *   and the CORS preflight of each Graph call (MapillaryJS sends an
 *   Authorization header).
 *
 * MapillaryJS never asks for a mesh or an SfM cluster here: the fixtures have
 * no `merge_cc` (an unmerged image gets an empty mesh without a request) and
 * no `sfm_cluster` url, and the spatial component that reads clusters is off.
 * S2 cells answer empty: the viewer then builds no spatial edges, which the
 * gate does not use (it steps along the sequence through the cones).
 *
 * The photo (street-640x320.jpg) is generated for this repository (a sky and
 * ground gradient with posts; scripts/fixtures/street-level), so it carries
 * no third-party licence.
 */

const DAY_MS = 86_400_000;

/** The one sequence with photos: a north-south line through the parked view. */
export const PHOTO_SEQUENCE_ID = 'fx-photo';
export const PHOTO_LINE = Object.freeze({
  lon: -121.4944,
  south: 38.579,
  north: 38.591,
});
/** Metres between consecutive photos on the line (≥ the 3 m cone thinning). */
export const PHOTO_SPACING_M = 30;
/** Host the fixture thumbnails are served from (answered, never reached). */
export const THUMB_HOST = 'qa-fixture.mapillary.com';

const METRES_PER_DEG_LAT = 110_540;

/** Approximate ground distance in metres, as the app's metresBetween. */
export function metresApart(a, b) {
  const lat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  return Math.hypot(
    (b.lon - a.lon) * 111_320 * Math.cos(lat),
    (b.lat - a.lat) * METRES_PER_DEG_LAT,
  );
}

/**
 * The fixture photos along PHOTO_LINE, south to north: every third one a
 * 360° panorama, the rest flat, all captured a month before `now`.
 * @returns {Array<{id: string, lon: number, lat: number, isPano: boolean, capturedAt: number, compassAngle: number}>}
 */
export function photoImages(now = Date.now()) {
  const step = PHOTO_SPACING_M / METRES_PER_DEG_LAT;
  const count =
    Math.floor((PHOTO_LINE.north - PHOTO_LINE.south) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, i) => ({
    id: String(9_100_000_000_000 + i),
    lon: PHOTO_LINE.lon,
    lat: Number((PHOTO_LINE.south + i * step).toFixed(7)),
    isPano: i % 3 === 0,
    capturedAt: now - 30 * DAY_MS - i * 1000,
    compassAngle: 0,
  }));
}

const point = (image) => ({
  type: 'Point',
  coordinates: [image.lon, image.lat],
});

/** Every field either caller asks for; extra fields are harmless to both. */
function imageRecord(image) {
  const thumb = `https://${THUMB_HOST}/thumb/${image.id}.jpg`;
  return {
    id: image.id,
    sequence: PHOTO_SEQUENCE_ID,
    geometry: point(image),
    computed_geometry: point(image),
    altitude: 12,
    computed_altitude: 12,
    atomic_scale: 1,
    camera_parameters: image.isPano ? [] : [0.85, 0, 0],
    camera_type: image.isPano ? 'spherical' : 'perspective',
    captured_at: image.capturedAt,
    compass_angle: image.compassAngle,
    computed_compass_angle: image.compassAngle,
    // Angle-axis world-to-camera rotation: +90° about east looks north, level.
    computed_rotation: [Math.PI / 2, 0, 0],
    creator: { id: '1', username: 'qa-fixture' },
    exif_orientation: 1,
    height: 320,
    width: 640,
    is_pano: image.isPano,
    merge_cc: null,
    mesh: null,
    organization: null,
    quality_score: 0.9,
    sfm_cluster: null,
    thumb_256_url: thumb,
    thumb_1024_url: thumb,
    thumb_2048_url: thumb,
  };
}

/** Pick the requested fields (plus id), as the Graph API answers. */
function withFields(record, fields) {
  if (!fields) return record;
  const out = { id: record.id };
  for (const field of fields.split(','))
    if (field in record) out[field] = record[field];
  return out;
}

const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
  'Access-Control-Max-Age': '600',
});

const json = (status, body) => ({
  status,
  contentType: 'application/json',
  headers: CORS,
  body: JSON.stringify(body),
});

let photoBytes = null;
/** The checked-in fixture photo, read once. */
export function photoJpeg() {
  photoBytes ??= readFileSync(new URL('./street-640x320.jpg', import.meta.url));
  return photoBytes;
}

/**
 * The query parameters that name a Graph call (not their values), so a run
 * can report which calls it answered without echoing the access token.
 */
export function describeCall(method, url) {
  const keys = [...url.searchParams.keys()]
    .filter((key) => key !== 'access_token')
    .sort();
  const path = url.pathname
    .replace(/^\/\d{6,}(?=\/|$)/, '/{imageId}')
    .replace(/^\/thumb\/[\w-]+\.jpg$/, '/thumb/{imageId}.jpg');
  return `${method} ${url.hostname}${path}${keys.length ? `?${keys.join('&')}` : ''}`;
}

/**
 * Answer one Mapillary request from fixtures.
 * @param {{method: string, url: string, images?: ReturnType<typeof photoImages>}} request
 * @returns {{status: number, contentType?: string, headers?: object, body: string|Buffer, known: boolean}}
 *   `known` is false for a request no fixture covers (answered 404); the gate
 *   fails on those so a new MapillaryJS call cannot pass unnoticed.
 */
export function answerMapillaryRequest({ method, url, images }) {
  const address = new URL(url);
  const photos = images ?? photoImages();
  const byId = new Map(photos.map((image) => [image.id, image]));
  if (method === 'OPTIONS')
    return { status: 204, headers: CORS, body: '', known: true };
  if (address.hostname === THUMB_HOST) {
    if (/^\/thumb\/[\w-]+\.jpg$/.test(address.pathname))
      return {
        status: 200,
        contentType: 'image/jpeg',
        headers: CORS,
        body: photoJpeg(),
        known: true,
      };
    return { ...json(404, { error: 'no such fixture' }), known: false };
  }
  if (address.hostname !== 'graph.mapillary.com')
    return { ...json(404, { error: 'no such fixture host' }), known: false };
  const q = address.searchParams;
  const fields = q.get('fields');
  const path = address.pathname;
  if (path === '/images') {
    if (q.has('image_ids')) {
      const data = q
        .get('image_ids')
        .split(',')
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((image) => withFields(imageRecord(image), fields));
      return { ...json(200, { data }), known: true };
    }
    if (q.has('sequence_ids')) {
      const ids = q.get('sequence_ids').split(',');
      const limit = Number(q.get('limit')) || photos.length;
      const data = ids.includes(PHOTO_SEQUENCE_ID)
        ? photos
            .slice(0, limit)
            .map((image) => withFields(imageRecord(image), fields))
        : [];
      return { ...json(200, { data }), known: true };
    }
    if (q.has('lat') && q.has('lng')) {
      const at = { lat: Number(q.get('lat')), lon: Number(q.get('lng')) };
      const radius = Math.min(50, Number(q.get('radius')) || 50);
      const limit = Number(q.get('limit')) || 10;
      // In no particular order, as the real API answers.
      const data = photos
        .filter((image) => metresApart(at, image) <= radius)
        .reverse()
        .slice(0, limit)
        .map((image) => withFields(imageRecord(image), fields));
      return { ...json(200, { data }), known: true };
    }
    if (q.has('s2')) return { ...json(200, { data: [] }), known: true };
    return {
      ...json(400, { error: 'unsupported images query' }),
      known: false,
    };
  }
  if (path === '/image_ids' && q.has('sequence_id')) {
    const data =
      q.get('sequence_id') === PHOTO_SEQUENCE_ID
        ? photos.map((image) => ({ id: image.id }))
        : [];
    return { ...json(200, { data }), known: true };
  }
  const tiles = path.match(/^\/([\w-]+)\/tiles$/);
  if (tiles) return { ...json(200, { data: [] }), known: true };
  const entity = path.match(/^\/([\w-]+)$/);
  if (entity && byId.has(entity[1]))
    return {
      ...json(200, withFields(imageRecord(byId.get(entity[1])), fields)),
      known: true,
    };
  return { ...json(404, { error: 'no such fixture' }), known: false };
}
