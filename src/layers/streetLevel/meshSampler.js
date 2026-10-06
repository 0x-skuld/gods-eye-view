import * as Cesium from 'cesium';
import { metresBetween, whenIdle } from './view.js';

/**
 * Rendered-surface heights for ground casting on Google 3D (see groundCast.js
 * refineHeights). One `scene.sampleHeight` probe per ~11 m cell, cached, so
 * the many sequences that share a street share their samples.
 *
 * `sampleHeight` renders a pick pass per probe (about 1–3 ms), so probes run
 * in idle time within a small budget, nearest the camera first, and only
 * within MESH_SAMPLE_RADIUS_M of the point under the camera: the streamed
 * detail is fine there, and an error is visible at all. Requests are taken
 * in by the same budgeted slices, cells out of range then are not queued
 * (callers ask again when the camera moves), and the queue is a heap ranked
 * from where the camera was, re-ranked only once it has moved MESH_RERANK_M,
 * so no slice walks or sorts the whole queue. A probe that hits
 * nothing (tiles not streamed yet) is retried later rather than latched.
 * Overlays are excluded from the probe, so only 3D tilesets are hit.
 */

/** Cell size, in degrees (~11 m): samples are shared within a cell. */
export const MESH_CELL_DEG = 0.0001;
/** Cells farther than this from the point under the camera are not probed. */
export const MESH_SAMPLE_RADIUS_M = 900;
/** Main-thread time per idle slice, taking requests in and ranking included. */
export const MESH_SAMPLE_BUDGET_MS = 6;
/** The queue is re-ranked once the camera has moved this far, in metres. */
export const MESH_RERANK_M = 100;
/** A cell whose probe missed is tried again after this long. */
export const MESH_MISS_RETRY_MS = 8000;
/** Cached cells (and remembered misses) before they are dropped and refilled. */
const MESH_CACHE_MAX = 80_000;
/** Listeners hear about new samples at most this often. */
const MESH_NOTIFY_MS = 700;

const cellOf = (value) => Math.round(value / MESH_CELL_DEG);

/**
 * The cache key of the mesh cell holding a point, one per ~11 m cell: a
 * number (exact well within 2^53), as a string key would be built per point.
 */
export const meshCellKey = (lon, lat) =>
  (cellOf(lon) + 1_800_001) * 2_000_000 + cellOf(lat) + 1_000_000;

/** Add a queued cell to a min-heap on `distance`. */
function heapPush(heap, cell) {
  let i = heap.push(cell) - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent].distance <= cell.distance) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = cell;
}

/** Restore the heap below `i` after its cell was replaced. */
function siftDown(heap, i) {
  const cell = heap[i];
  const n = heap.length;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= n) break;
    if (child + 1 < n && heap[child + 1].distance < heap[child].distance)
      child++;
    if (heap[child].distance >= cell.distance) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = cell;
}

/** Take the nearest cell off a min-heap. */
function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    siftDown(heap, 0);
  }
  return top;
}

/** Every top-level primitive that is not a 3D tileset: what a probe skips. */
function overlays(scene) {
  const out = [];
  const primitives = scene.primitives;
  for (let i = 0; i < primitives.length; i++) {
    const primitive = primitives.get(i);
    if (!(primitive instanceof Cesium.Cesium3DTileset)) out.push(primitive);
  }
  return out;
}

/**
 * @param {{getViewer: () => object|null, budgetMs?: number, radiusM?: number, cacheMax?: number, now?: () => number}} options
 */
export function createMeshSampler({
  getViewer,
  budgetMs = MESH_SAMPLE_BUDGET_MS,
  radiusM = MESH_SAMPLE_RADIUS_M,
  cacheMax = MESH_CACHE_MAX,
  now = () => performance.now(),
}) {
  /** cell key → sampled mesh height (ellipsoidal metres). */
  const heights = new Map();
  /**
   * cell key → retry time for probes that hit nothing. An entry goes once
   * its cell is sampled or asked for after the retry time, and with the
   * height cache, so the map stays bounded.
   */
  const misses = new Map();
  /** cell key → queued cell, so a cell is queued once. */
  const wanted = new Map();
  /** Queued {key, lon, lat, distance} cells, a min-heap on distance from `rankedFrom`. */
  let queue = [];
  /** Requests not yet taken in: {points, next, centre} (centre: the camera then). */
  let intake = [];
  /** Where the camera was when the queue was ranked. */
  let rankedFrom = null;
  /** Running estimate of one probe's cost, so a slice stops before overrunning. */
  let probeMs = 1;
  const listeners = new Set();
  let enabled = false;
  let running = false;
  let fresh = [];
  let notifyTimer = null;

  /** The sampled mesh height for a point, or undefined when not sampled. */
  function meshAt(lon, lat) {
    return heights.get(meshCellKey(lon, lat));
  }

  /** The point under the camera, or null. */
  function cameraCentre() {
    const carto = getViewer()?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  /**
   * Ask for the cells under these [lon, lat] points (read later, so do not
   * change the list). Nothing is done here: idle slices take requests in
   * within their budget, and drop cells out of range of where the camera was
   * when asked; callers ask again once it moves.
   */
  function request(points) {
    if (!enabled || !points?.length) return;
    const centre = cameraCentre();
    if (!centre) return;
    intake.push({ points, next: 0, centre });
    schedule();
  }

  /** Queue requested cells, oldest request first, until the slice reaches `until`. */
  function takeIn(until) {
    const time = Date.now();
    while (intake.length) {
      const pending = intake[0];
      const { points, centre } = pending;
      while (pending.next < points.length) {
        if ((pending.next & 255) === 255 && now() > until) return;
        const [lon, lat] = points[pending.next++];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const key = meshCellKey(lon, lat);
        if (heights.has(key) || wanted.has(key)) continue;
        const cell = {
          key,
          lon: cellOf(lon) * MESH_CELL_DEG,
          lat: cellOf(lat) * MESH_CELL_DEG,
          distance: 0,
        };
        if (metresBetween(cell, centre) > radiusM) continue;
        const retryAt = misses.get(key);
        if (retryAt !== undefined) {
          if (retryAt > time) continue;
          misses.delete(key);
        }
        cell.distance = metresBetween(cell, rankedFrom);
        wanted.set(key, cell);
        heapPush(queue, cell);
      }
      intake.shift();
    }
  }

  /**
   * Rank the queue from where the camera is now, dropping cells it has left
   * out of range: one linear heapify, run only after the camera has moved.
   */
  function rerank(centre) {
    rankedFrom = centre;
    const kept = [];
    for (const cell of queue) {
      cell.distance = metresBetween(cell, centre);
      if (cell.distance > radiusM) wanted.delete(cell.key);
      else kept.push(cell);
    }
    queue = kept;
    for (let i = (queue.length >> 1) - 1; i >= 0; i--) siftDown(queue, i);
  }

  function clearQueue() {
    intake = [];
    wanted.clear();
    queue = [];
    rankedFrom = null;
  }

  function schedule() {
    if (running || !enabled || !(queue.length || intake.length)) return;
    running = true;
    whenIdle(step, 300);
  }

  function emit() {
    notifyTimer = null;
    const batch = fresh;
    fresh = [];
    for (const listener of [...listeners]) {
      try {
        listener(batch);
      } catch (error) {
        console.warn('[Data:StreetLevel] mesh listener error:', error);
      }
    }
  }

  function step(deadline) {
    running = false;
    // The slice starts now: taking requests in and ranking count too.
    const started = now();
    const until =
      started +
      Math.min(budgetMs, Math.max(1, deadline?.timeRemaining?.() ?? budgetMs));
    const scene = getViewer()?.scene;
    const centre = cameraCentre();
    if (!enabled || !scene?.sampleHeightSupported || !centre) return;
    // Nearest first, ranked from where the camera was; out-of-range cells
    // are dropped (they stay bare earth).
    let worked = false;
    if (!rankedFrom || metresBetween(rankedFrom, centre) > MESH_RERANK_M) {
      rerank(centre);
      worked = true;
    }
    if (intake.length) {
      // Leave room for a probe, so a stream of requests cannot starve them.
      takeIn(until - probeMs);
      worked = true;
    }
    const exclude = overlays(scene);
    let probed = 0;
    while (queue.length) {
      // Stop before a probe would overrun the slice. A slice that did
      // nothing else always probes once, so the queue drains.
      if ((probed || worked) && now() + probeMs > until) break;
      const { key, lon, lat } = heapPop(queue);
      wanted.delete(key);
      // Ranked from up to MESH_RERANK_M away: check the range from here.
      if (metresBetween({ lon, lat }, centre) > radiusM) continue;
      probed++;
      const probeStarted = now();
      let height;
      try {
        height = scene.sampleHeight(
          Cesium.Cartographic.fromDegrees(lon, lat),
          exclude,
        );
      } catch {
        height = undefined;
      }
      probeMs = probeMs * 0.75 + (now() - probeStarted) * 0.25;
      if (!Number.isFinite(height)) {
        if (misses.size >= cacheMax) misses.clear();
        misses.set(key, Date.now() + MESH_MISS_RETRY_MS);
        continue;
      }
      if (heights.size >= cacheMax) forget();
      misses.delete(key);
      heights.set(key, height);
      fresh.push([lon, lat]);
    }
    if (fresh.length && !notifyTimer)
      notifyTimer = setTimeout(emit, MESH_NOTIFY_MS);
    schedule();
  }

  /** Drop every sample and remembered miss. */
  function forget() {
    heights.clear();
    misses.clear();
  }

  /** Probe only while overlays are cast (Google 3D at street zoom). */
  function setEnabled(on) {
    enabled = on === true;
    if (!enabled) clearQueue();
    else schedule();
  }

  /** Hear about newly sampled cells, as [lon, lat] cell centres. */
  function onSampled(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function destroy() {
    enabled = false;
    forget();
    clearQueue();
    listeners.clear();
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }

  return { meshAt, request, setEnabled, onSampled, destroy };
}
