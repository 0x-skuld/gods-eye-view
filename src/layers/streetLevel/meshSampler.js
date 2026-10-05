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
 * detail is fine there, and an error is visible at all. A probe that hits
 * nothing (tiles not streamed yet) is retried later rather than latched.
 * Overlays are excluded from the probe, so only 3D tilesets are hit.
 */

/** Cell size, in degrees (~11 m): samples are shared within a cell. */
export const MESH_CELL_DEG = 0.0001;
/** Cells farther than this from the point under the camera are not probed. */
export const MESH_SAMPLE_RADIUS_M = 900;
/** Main-thread time spent probing per idle slice. */
export const MESH_SAMPLE_BUDGET_MS = 6;
/** A cell whose probe missed is tried again after this long. */
export const MESH_MISS_RETRY_MS = 8000;
/** Cached cells (and remembered misses) before they are dropped and refilled. */
const MESH_CACHE_MAX = 80_000;
/** Listeners hear about new samples at most this often. */
const MESH_NOTIFY_MS = 700;

const cellOf = (value) => Math.round(value / MESH_CELL_DEG);
const keyOf = (lon, lat) => `${cellOf(lon)},${cellOf(lat)}`;

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
 * @param {{getViewer: () => object|null, budgetMs?: number, radiusM?: number, cacheMax?: number}} options
 */
export function createMeshSampler({
  getViewer,
  budgetMs = MESH_SAMPLE_BUDGET_MS,
  radiusM = MESH_SAMPLE_RADIUS_M,
  cacheMax = MESH_CACHE_MAX,
}) {
  /** cell key → sampled mesh height (ellipsoidal metres). */
  const heights = new Map();
  /**
   * cell key → retry time for probes that hit nothing. An entry goes once
   * its cell is sampled or asked for after the retry time, and with the
   * height cache, so the map stays bounded.
   */
  const misses = new Map();
  /** cell key → {lon, lat} cell centre waiting to be probed. */
  const wanted = new Map();
  const listeners = new Set();
  let enabled = false;
  let running = false;
  let fresh = [];
  let notifyTimer = null;

  /** The sampled mesh height for a point, or undefined when not sampled. */
  function meshAt(lon, lat) {
    return heights.get(keyOf(lon, lat));
  }

  /** Queue the cells under these [lon, lat] points for probing. */
  function request(points) {
    if (!enabled) return;
    const now = Date.now();
    for (const [lon, lat] of points) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const key = keyOf(lon, lat);
      if (heights.has(key) || wanted.has(key)) continue;
      const retryAt = misses.get(key);
      if (retryAt !== undefined) {
        if (retryAt > now) continue;
        misses.delete(key);
      }
      wanted.set(key, {
        lon: cellOf(lon) * MESH_CELL_DEG,
        lat: cellOf(lat) * MESH_CELL_DEG,
      });
    }
    schedule();
  }

  function schedule() {
    if (running || !enabled || !wanted.size) return;
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
    const scene = getViewer()?.scene;
    const carto = getViewer()?.camera?.positionCartographic;
    if (!enabled || !scene?.sampleHeightSupported || !carto) return;
    const centre = {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
    // Nearest first; cells out of range are dropped (they stay bare earth).
    const order = [];
    for (const [key, point] of wanted) {
      const distance = metresBetween(point, centre);
      if (distance > radiusM) wanted.delete(key);
      else order.push([distance, key, point]);
    }
    order.sort((a, b) => a[0] - b[0]);
    const slice = Math.max(
      1,
      Math.min(budgetMs * 2, deadline?.timeRemaining?.() ?? budgetMs),
    );
    const until = performance.now() + Math.min(budgetMs, slice);
    const exclude = overlays(scene);
    let probed = 0;
    for (const [, key, { lon, lat }] of order) {
      if (probed && performance.now() > until) break;
      wanted.delete(key);
      probed++;
      let height;
      try {
        height = scene.sampleHeight(
          Cesium.Cartographic.fromDegrees(lon, lat),
          exclude,
        );
      } catch {
        height = undefined;
      }
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
    if (!enabled) wanted.clear();
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
    wanted.clear();
    listeners.clear();
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }

  return { meshAt, request, setEnabled, onSampled, destroy };
}
