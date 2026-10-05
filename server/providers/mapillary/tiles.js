import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { stripTileLayers } from './trim.js';
import {
  MAPILLARY_TILE_HOST,
  TILE_LAYERS,
  TILE_DISK_DIR,
  TILE_DISK_TTL_MS,
  TILE_DISK_SWEEP_INTERVAL_MS,
  TILE_DISK_MAX_BYTES,
  TILE_MAX_BYTES,
  TILE_MEMORY_BUDGET_BYTES,
  TILE_FETCH_TIMEOUT_MS,
  TILE_KEY_REJECTED_HOLD_MS,
  TILE_RATE_LIMIT_HOLD_MS,
  TILE_RATE_LIMIT_MAX_HOLD_MS,
  mapillaryToken,
} from './constants.js';

/** Thrown for a request this proxy refuses before contacting Mapillary. */
export class TileRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TileRequestError';
    this.status = status;
  }
}

/**
 * Thrown when Mapillary answered with an error status. A 401/403 means the
 * token was rejected (`keyRejected`); a 429 carries how long to wait.
 */
export class TileUpstreamError extends Error {
  constructor(status, message, { retryAfterSec = null } = {}) {
    super(message || `Mapillary tiles HTTP ${status}`);
    this.name = 'TileUpstreamError';
    this.status = status;
    this.keyRejected = status === 401 || status === 403;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * The last refusal from Mapillary that every tile miss shares: a rejected
 * token (until the token changes or the hold ends) or a rate limit (until its
 * Retry-After). Cached tiles are still served meanwhile.
 * @type {{status: number, until: number, token: string}|null}
 */
let _upstreamHold = null;

/** Milliseconds to wait from a Retry-After header (seconds or an HTTP date). */
function retryAfterMs(header, now = Date.now()) {
  const text = String(header ?? '').trim();
  let ms = NaN;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else if (text) ms = Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms <= 0) return TILE_RATE_LIMIT_HOLD_MS;
  return Math.min(ms, TILE_RATE_LIMIT_MAX_HOLD_MS);
}

/** The refusal to answer a miss with, while one holds for this token. */
function heldRefusal(token) {
  const hold = _upstreamHold;
  if (!hold) return null;
  const left = hold.until - Date.now();
  if (left <= 0 || hold.token !== token) {
    _upstreamHold = null;
    return null;
  }
  return new TileUpstreamError(hold.status, undefined, {
    retryAfterSec: Math.ceil(left / 1000),
  });
}

/**
 * Validate and normalize a tile address. Layer names are the proxy's public
 * ids (coverage only); zoom must be inside one of the layer's zoom ranges.
 * @returns {{layer:string, upstream:string, z:number, x:number, y:number, key:string}}
 */
export function normalizeTileAddress({ layer, z, x, y }) {
  const spec = Object.hasOwn(TILE_LAYERS, layer) ? TILE_LAYERS[layer] : null;
  if (!spec) throw new TileRequestError(`Unknown tile layer: ${layer}`);
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  if (
    ![zi, xi, yi].every((v) => Number.isInteger(v) && v >= 0) ||
    !spec.zoomRanges.some(([min, max]) => zi >= min && zi <= max)
  )
    throw new TileRequestError(
      `Tile zoom for ${layer} must be ${spec.zoomRanges
        .map(([min, max]) => `${min}–${max}`)
        .join(' or ')}`,
    );
  const n = 2 ** zi;
  if (xi >= n || yi >= n)
    throw new TileRequestError('Tile address out of range');
  return {
    layer,
    upstream: spec.upstream,
    dropLayers: spec.dropLayers || [],
    z: zi,
    x: xi,
    y: yi,
    key: `${layer}/${zi}/${xi}/${yi}`,
  };
}

/** @type {Map<string, {bytes: Buffer, at: number}>} insertion-ordered LRU */
const _memory = new Map();
let _memoryBytes = 0;
/**
 * Upstream fetches in progress, shared by every request for the same tile.
 * A flight owns its controller; callers only count as waiters, and the last
 * waiter to leave cancels it (see `joinFlight`).
 * @type {Map<string, {controller: AbortController, promise: Promise<Buffer>, waiters: number}>}
 */
const _inFlight = new Map();

function memoryGet(key) {
  const hit = _memory.get(key);
  if (!hit) return null;
  // Same 24 h life as the disk copy: a long-running server must not keep
  // serving stale (or empty) coverage until eviction.
  if (Date.now() - hit.at > TILE_DISK_TTL_MS) {
    _memory.delete(key);
    _memoryBytes -= hit.bytes.length;
    return null;
  }
  // Re-insert to mark as most recently used.
  _memory.delete(key);
  _memory.set(key, hit);
  return hit.bytes;
}

/** `at` is when Mapillary served the bytes (a disk tile's mtime). */
function memoryPut(key, bytes, at = Date.now()) {
  if (bytes.length > TILE_MEMORY_BUDGET_BYTES / 2) return;
  const existing = _memory.get(key);
  if (existing) _memoryBytes -= existing.bytes.length;
  _memory.set(key, { bytes, at });
  _memoryBytes += bytes.length;
  while (_memoryBytes > TILE_MEMORY_BUDGET_BYTES && _memory.size) {
    const [oldest, entry] = _memory.entries().next().value;
    _memory.delete(oldest);
    _memoryBytes -= entry.bytes.length;
  }
}

/** Disk cache root; tests point it at a temporary directory. */
let _diskDir = TILE_DISK_DIR;

function diskPath({ layer, z, x, y }, root = _diskDir) {
  return path.join(root, layer, String(z), `${x}-${y}.pbf`);
}

/** Disk-cache read; the tile's age comes from the file's mtime. */
async function readDisk(address) {
  const file = diskPath(address);
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > TILE_DISK_TTL_MS) return null;
    return { bytes: await fsp.readFile(file), at: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Write a tile in the background. `at` dates a rewrite of an existing tile
 * with its original fetch time, so the rewrite does not extend its life.
 */
function writeDisk(address, bytes, at = null) {
  // The sweep after it covers this write's cache root, even if it has moved.
  const root = _diskDir;
  const file = diskPath(address, root);
  fsp
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fsp.writeFile(`${file}.tmp`, bytes))
    .then(
      () => at != null && fsp.utimes(`${file}.tmp`, new Date(), new Date(at)),
    )
    .then(() => fsp.rename(`${file}.tmp`, file))
    .then(() => scheduleSweep(root))
    .catch((error) =>
      console.warn(
        '[Mapillary Proxy] tile cache write failed:',
        error?.message || error,
      ),
    );
}

let _lastSweepAt = 0;
let _sweeping = null;
let _sweepWarned = false;

/** Start a background sweep of `root` unless one ran within the interval. */
function scheduleSweep(root) {
  if (_sweeping || Date.now() - _lastSweepAt < TILE_DISK_SWEEP_INTERVAL_MS)
    return;
  _lastSweepAt = Date.now();
  _sweeping = sweepTileDisk({ root })
    .catch((error) => {
      if (_sweepWarned) return;
      _sweepWarned = true;
      console.warn(
        '[Mapillary Proxy] tile cache sweep failed:',
        error?.message || error,
      );
    })
    .finally(() => {
      _sweeping = null;
    });
}

/** Every file under `dir` with its size and mtime; a missing dir is empty. */
async function listCacheFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listCacheFiles(file)));
    else if (entry.isFile()) {
      // A file renamed or swept away meanwhile is simply skipped.
      const stat = await fsp.stat(file).catch(() => null);
      if (stat) files.push({ file, size: stat.size, at: stat.mtimeMs });
    }
  }
  return files;
}

/**
 * Bound the disk cache: delete tiles past TILE_DISK_TTL_MS, then the oldest
 * until the rest fit in `maxBytes`. Runs in the background after tile writes.
 * @returns {Promise<{removed: number, bytes: number}>} files deleted, bytes kept
 */
export async function sweepTileDisk({
  root = _diskDir,
  maxBytes = TILE_DISK_MAX_BYTES,
} = {}) {
  const now = Date.now();
  const files = (await listCacheFiles(root)).sort((a, b) => a.at - b.at);
  let bytes = files.reduce((sum, { size }) => sum + size, 0);
  let removed = 0;
  for (const { file, size, at } of files) {
    if (now - at <= TILE_DISK_TTL_MS && bytes <= maxBytes) break;
    await fsp.rm(file, { force: true });
    bytes -= size;
    removed++;
  }
  return { removed, bytes };
}

async function fetchUpstream(address, signal) {
  const token = mapillaryToken();
  if (!token) throw new TileRequestError('Mapillary token not configured', 503);
  const held = heldRefusal(token);
  if (held) throw held;
  const url = `${MAPILLARY_TILE_HOST}/${address.upstream}/2/${address.z}/${address.x}/${address.y}?access_token=${encodeURIComponent(token)}`;
  const timeout = AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/x-protobuf' },
  });
  if (response.status === 404 || response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return Buffer.alloc(0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new TileUpstreamError(response.status);
    if (error.keyRejected)
      _upstreamHold = {
        status: response.status,
        until: Date.now() + TILE_KEY_REJECTED_HOLD_MS,
        token,
      };
    else if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'));
      _upstreamHold = { status: 429, until: Date.now() + wait, token };
      error.retryAfterSec = Math.ceil(wait / 1000);
    }
    throw error;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > TILE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new TileUpstreamError(502, 'Mapillary tile exceeds size cap');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > TILE_MAX_BYTES)
    throw new TileUpstreamError(502, 'Mapillary tile exceeds size cap');
  return bytes;
}

/** Strip the layers this proxy never serves for the address's layer spec. */
function trim(address, bytes) {
  if (!address.dropLayers.length || !bytes.length) return bytes;
  try {
    return stripTileLayers(bytes, address.dropLayers);
  } catch (error) {
    console.warn(
      '[Mapillary Proxy] tile trim failed, serving raw:',
      error?.message || error,
    );
    return bytes;
  }
}

/**
 * Fetch one tile through memory, disk and in-flight coalescing, then
 * Mapillary. Returns the raw protobuf bytes (empty for a tile with no data).
 * @param {{layer:string,z:number|string,x:number|string,y:number|string}} request
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{bytes: Buffer, source: 'memory'|'disk'|'inflight'|'upstream', address: object}>}
 */
export async function fetchTile(request, { signal } = {}) {
  const address = normalizeTileAddress(request);
  const memory = memoryGet(address.key);
  if (memory) return { bytes: memory, source: 'memory', address };
  const disk = await readDisk(address);
  if (disk) {
    // Older cache files may still hold the untrimmed tile: trim and replace,
    // keeping the original fetch time so the tile still expires on schedule.
    const bytes = trim(address, disk.bytes);
    if (bytes !== disk.bytes) writeDisk(address, bytes, disk.at);
    memoryPut(address.key, bytes, disk.at);
    return { bytes, source: 'disk', address };
  }
  let flight = _inFlight.get(address.key);
  const joined = Boolean(flight) && !flight.controller.signal.aborted;
  if (!joined) flight = startFlight(address);
  const bytes = await joinFlight(flight, signal);
  return { bytes, source: joined ? 'inflight' : 'upstream', address };
}

/** Start the one upstream fetch for a tile, owned by the flight itself. */
function startFlight(address) {
  const controller = new AbortController();
  const flight = { controller, waiters: 0, promise: null };
  flight.promise = fetchUpstream(address, controller.signal)
    .then((raw) => trim(address, raw))
    .then((bytes) => {
      memoryPut(address.key, bytes);
      writeDisk(address, bytes);
      return bytes;
    })
    .finally(() => {
      if (_inFlight.get(address.key) === flight) _inFlight.delete(address.key);
    });
  // Every waiter may have left before it settles; nobody awaits it then.
  flight.promise.catch(() => {});
  _inFlight.set(address.key, flight);
  return flight;
}

/**
 * Wait on a shared flight as one caller. The caller's own abort rejects it at
 * once without disturbing the others; the upstream fetch is cancelled only
 * when the last waiter leaves.
 * @param {{controller: AbortController, promise: Promise<Buffer>, waiters: number}} flight
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer>}
 */
function joinFlight(flight, signal) {
  signal?.throwIfAborted();
  flight.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      flight.waiters--;
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (flight.waiters === 0) flight.controller.abort();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (bytes) => leave() && resolve(bytes),
      (error) => leave() && reject(error),
    );
  });
}

/** Test seam: forget every cached tile held in memory. */
export function _resetTileMemoryForTest() {
  _memory.clear();
  _memoryBytes = 0;
  _inFlight.clear();
  _upstreamHold = null;
}

/** Test seam: keep the disk cache in `dir` (null restores the default). */
export function _setTileCacheDirForTest(dir) {
  _diskDir = dir || TILE_DISK_DIR;
  _lastSweepAt = 0;
}
