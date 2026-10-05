import path from 'node:path';

/** Mapillary vector tile root; the path template is /{layer}/2/{z}/{x}/{y}. */
export const MAPILLARY_TILE_HOST = 'https://tiles.mapillary.com/maps/vtp';

/** Public tile layer names this proxy exposes, mapped to Mapillary's ids. */
export const TILE_LAYERS = Object.freeze({
  // Overview points (z0–5), sequences (z6–14) and image points (z14 only).
  // The app asks for overview z0–5 and sequences z11–14 only (see
  // src/layers/streetLevel/tileMath.js); region-sized z6–10 tiles are refused.
  // The z14 `image` point layer is ~98% of a 10 MB tile and unused here:
  // image positions come from the graph API per sequence. Dropped in transit.
  coverage: Object.freeze({
    upstream: 'mly1_public',
    zoomRanges: Object.freeze([Object.freeze([0, 5]), Object.freeze([11, 14])]),
    dropLayers: Object.freeze(['image']),
  }),
});

/** Disk cache root, alongside the other providers' caches. */
export const MAPILLARY_CACHE_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'mapillary',
);
export const TILE_DISK_DIR = path.join(MAPILLARY_CACHE_DIR, 'tiles');

/**
 * Tiles change when new imagery is processed, which is far slower than the
 * 15-minute upstream Cache-Control. A day keeps a session over one city from
 * re-downloading its tiles on every camera move.
 */
export const TILE_DISK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Disk cache bound. A tile write starts a background sweep at most this often:
 * it deletes files past TILE_DISK_TTL_MS, then the oldest files until the
 * cache fits in TILE_DISK_MAX_BYTES (thousands of trimmed street-level tiles).
 */
export const TILE_DISK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const TILE_DISK_MAX_BYTES = 1024 * 1024 * 1024;

/** A z14 image tile over a dense city is ~11 MB; anything past this is wrong. */
export const TILE_MAX_BYTES = 48 * 1024 * 1024;

/** In-memory tile cache budget (bytes) and upstream fetch timeout. */
export const TILE_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
export const TILE_FETCH_TIMEOUT_MS = 60_000;
/**
 * After Mapillary rejects the token (401/403), tile misses are answered from
 * that verdict for this long instead of asking again on every camera move.
 * A changed token is asked at once.
 */
export const TILE_KEY_REJECTED_HOLD_MS = 5 * 60 * 1000;
/** After a 429 without a usable Retry-After, hold tile misses this long. */
export const TILE_RATE_LIMIT_HOLD_MS = 60_000;
/** The longest Retry-After honoured, so a bad header cannot stall coverage. */
export const TILE_RATE_LIMIT_MAX_HOLD_MS = 10 * 60 * 1000;

/** The client token lives in the browser by design; the server adds it to tile URLs too. */
export function mapillaryToken() {
  return String(process.env.MAPILLARY_CLIENT_TOKEN || '').trim();
}
