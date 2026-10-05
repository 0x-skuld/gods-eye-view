import * as Cesium from 'cesium';
import { decodeCoverageTile } from './decode.js';
import { passesImageryFilter } from '../../filter.js';
import { groundUnderCamera, viewFocus, visibleBbox } from '../../view.js';
import { densifyLine, MESH_DENSIFY_DEG } from '../../groundCast.js';
import { MESH_CELL_DEG } from '../../meshSampler.js';
import {
  coverageZoomForHeight,
  overviewZoomForHeight,
  tileBounds,
  tilesForBbox,
} from '../../tileMath.js';
import {
  COLORS,
  COVERAGE_LINE_WIDTH_PX,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
  COVERAGE_MOVE_DEBOUNCE_MS,
  COVERAGE_OVERVIEW_MAX_TILES,
  COVERAGE_OVERVIEW_POINT_PX,
  KEY_REJECTED_MESSAGE,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  SEQUENCE_VIEW_NEAR_M,
  SEQUENCE_VIEW_RANGE_MIN_M,
  SEQUENCE_VIEW_RANGE_PER_HEIGHT,
} from './policy.js';

/** Draped lines stay at most this long while a tile's cast lines build. */
const SWAP_MAX_WAIT_MS = 4000;
/** Tiles touched by new mesh samples are redrawn at most this often. */
const REMESH_INTERVAL_MS = 1500;
/** Gap between redrawing one dirty tile and the next. */
const REMESH_STAGGER_MS = 120;
/** Old-zoom tiles are kept at most this long after a zoom change. */
const STALE_TILE_MAX_MS = 6000;
/**
 * Sequences per ground primitive. Ground polyline geometry is built on a
 * worker in proportion to the instance count, so smaller batches put the
 * first lines on screen sooner instead of one big batch arriving late.
 */
const SEQUENCE_PRIMITIVE_BATCH = 120;

const PER_TILE_SEQUENCE_CAP = Math.floor(
  COVERAGE_MAX_SEQUENCES / COVERAGE_MAX_TILES,
);

/** Colour for a sequence: Mapillary green, GEV cyan while selected. */
function sequenceColor({ selected = false } = {}) {
  return selected
    ? Cesium.Color.fromCssColorString(COLORS.selected)
    : Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(0.92);
}

/** Separates a multi-part sequence's part index from its id in pick ids. */
const PART_SEPARATOR = '~';

/** Pick ids for every part of a sequence; the first part is unsuffixed. */
function partIds(sequence) {
  return sequence.parts.map((_, index) =>
    index
      ? `${PICK_PREFIX.sequence}${sequence.id}${PART_SEPARATOR}${index}`
      : `${PICK_PREFIX.sequence}${sequence.id}`,
  );
}

/**
 * Sequence id for a picked line, whichever part was hit: `mly:seq:<id>` and
 * `mly:seq:<id>~<part>` both give `<id>`; null for any other pick.
 * @param {string} pickId
 * @returns {string|null}
 */
export function sequenceIdFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX.sequence))
    return null;
  const rest = pickId.slice(PICK_PREFIX.sequence.length);
  const cut = rest.indexOf(PART_SEPARATOR);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/**
 * Camera-driven coverage: z0–5 `overview` points from orbit down to 60 km,
 * then z11–14 sequence polylines clamped to terrain and 3D tiles. Decoded
 * tiles are kept so the imagery filter can rebuild without refetching.
 *
 * In the core's terrain surface mode (Google 3D at street zoom) a tile's
 * lines are cast to the bare earth instead: draped lines would land on roofs
 * and tree tops. A tile is drawn draped first and swapped for its cast lines
 * once the terrain heights are in, so coverage never waits on the terrain.
 */
export function createCoverage({ state, source }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-coverage');
  }

  function ensureTerrainReady() {
    return (state.coverage.terrainReady ||=
      Cesium.GroundPolylinePrimitive.initializeTerrainHeights());
  }

  function tileKey({ x, y, z }) {
    return `${z}/${x}/${y}`;
  }

  function filter() {
    return state.filter;
  }

  function terrainMode() {
    return (
      state.context.getSurface?.() === 'terrain' &&
      Boolean(state.context.groundCaster)
    );
  }

  /**
   * The sequences a tile draws: newest first, past the imagery filter, then
   * capped. Capping before the filter could leave a dense tile of newer flat
   * captures with no 360° lines at all.
   */
  function drawnSequences(entry) {
    const drawn = [];
    for (const sequence of entry.sequenceList) {
      if (drawn.length >= PER_TILE_SEQUENCE_CAP) break;
      if (passesImageryFilter(sequence, filter())) drawn.push(sequence);
    }
    return drawn;
  }

  /**
   * Primitives for a tile's sequences, in draw batches: ground primitives
   * draped on the globe, plus (in terrain mode) plain polylines at the cast
   * heights for every part whose heights are cached. Each part of a sequence
   * with a capture gap is its own line. Each batch remembers the selection
   * its colours were built with.
   */
  function buildSequencePrimitives(sequences) {
    const ground = terrainMode() ? state.context.groundCaster : null;
    const meshAt = ground ? state.context.meshSampler?.meshAt : undefined;
    const selectedId = state.sequence.selectedId ?? null;
    const draped = [];
    const cast = [];
    for (const sequence of sequences) {
      const color = Cesium.ColorGeometryInstanceAttribute.fromColor(
        sequenceColor({ selected: sequence.id === selectedId }),
      );
      const ids = partIds(sequence);
      sequence.parts.forEach((coordinates, index) => {
        const flat = ground?.castLine(coordinates, { meshAt });
        let positions;
        try {
          positions = flat
            ? Cesium.Cartesian3.fromDegreesArrayHeights(flat)
            : Cesium.Cartesian3.fromDegreesArray(coordinates.flat());
        } catch {
          return;
        }
        if (positions.length < 2) return;
        const geometry = flat
          ? new Cesium.PolylineGeometry({
              positions,
              width: COVERAGE_LINE_WIDTH_PX,
              vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
              arcType: Cesium.ArcType.NONE,
            })
          : new Cesium.GroundPolylineGeometry({
              positions,
              width: COVERAGE_LINE_WIDTH_PX,
            });
        (flat ? cast : draped).push(
          new Cesium.GeometryInstance({
            geometry,
            id: ids[index],
            attributes: { color },
          }),
        );
      });
    }
    const primitives = [];
    for (let i = 0; i < draped.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push({
        onGround: true,
        selectedId,
        primitive: new Cesium.GroundPolylinePrimitive({
          geometryInstances: draped.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance(),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
          allowPicking: true,
        }),
      });
    for (let i = 0; i < cast.length; i += SEQUENCE_PRIMITIVE_BATCH)
      primitives.push({
        onGround: false,
        selectedId,
        primitive: new Cesium.Primitive({
          geometryInstances: cast.slice(i, i + SEQUENCE_PRIMITIVE_BATCH),
          appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
          asynchronous: true,
          allowPicking: true,
        }),
      });
    return { primitives, draped, cast: cast.length };
  }

  /**
   * Fetch the terrain heights a tile's lines need, then redraw the tile cast.
   * `castRequested` holds while the tile's castable lines are cast; a cast
   * that resolves nothing (terrain proxy down, tile too big) clears it, so
   * the next refresh tries again rather than this retrying in a loop.
   */
  function castTile(entry) {
    // `castAbort` is set while a cast is in flight.
    if (entry.castRequested || entry.castAbort || !terrainMode()) return;
    entry.castRequested = true;
    entry.castAbort = new AbortController();
    const { signal } = entry.castAbort;
    const lines = [...entry.sequences.values()].flatMap(
      (sequence) => sequence.parts,
    );
    const caster = state.context.groundCaster;
    caster.prepareLines(lines, { signal }).then(() => {
      if (entry.castAbort?.signal === signal) entry.castAbort = null;
      const attached = [...state.coverage.tiles.values()].includes(entry);
      if (signal.aborted || !attached || !terrainMode()) return;
      // Nothing new to cast: keep it draped until the next refresh.
      if (!lines.some((coords) => caster.castLine(coords))) {
        entry.castRequested = false;
        return;
      }
      // A remesh may have cleared the flag while this was in flight.
      entry.castRequested = true;
      // Keep the draped lines until the cast ones are built, so nothing blinks.
      const previous = entry.primitives;
      entry.primitives = [];
      attachPrimitive(entry);
      removeWhenReady(entry, previous);
      requestMesh(entry);
    });
  }

  /** The mesh cells under a tile's drawn lines, built once per filter. */
  function meshCells(entry) {
    if (entry.meshCells) return entry.meshCells;
    const cells = new Map();
    for (const sequence of entry.sequences.values())
      for (const [lon, lat] of sequence.parts.flatMap((part) =>
        densifyLine(part, MESH_DENSIFY_DEG),
      ))
        cells.set(
          `${Math.round(lon / MESH_CELL_DEG)},${Math.round(lat / MESH_CELL_DEG)}`,
          [lon, lat],
        );
    entry.meshCells = [...cells.values()];
    return entry.meshCells;
  }

  /** Ask for mesh samples under a cast tile's lines (the sampler keeps the near ones). */
  function requestMesh(entry) {
    const sampler = state.context.meshSampler;
    if (!sampler || entry.kind !== 'sequence' || !terrainMode()) return;
    sampler.request(meshCells(entry));
  }

  /**
   * New mesh samples landed: redraw the tiles they fall in, throttled, with
   * the same no-blink swap as the bare-earth cast.
   */
  function onMeshSampled(batch) {
    if (!terrainMode() || !state.context.isActive()) return;
    for (const entry of state.coverage.tiles.values()) {
      if (entry.kind !== 'sequence' || !entry.bounds) continue;
      const { west, south, east, north } = entry.bounds;
      if (
        batch.some(
          ([lon, lat]) =>
            lon >= west && lon <= east && lat >= south && lat <= north,
        )
      )
        state.coverage.remeshDirty.add(entry);
    }
    if (!state.coverage.remeshDirty.size || state.coverage.remeshTimer) return;
    const wait = Math.max(
      0,
      REMESH_INTERVAL_MS - (Date.now() - (state.coverage.remeshAt || 0)),
    );
    state.coverage.remeshTimer = setTimeout(remesh, wait);
  }

  /** Redraw one dirty tile per idle slice, so a burst of samples never stalls a frame. */
  function remesh() {
    state.coverage.remeshTimer = null;
    state.coverage.remeshAt = Date.now();
    if (!terrainMode() || !state.context.isActive()) {
      state.coverage.remeshDirty.clear();
      return;
    }
    const attached = new Set(state.coverage.tiles.values());
    const [entry] = state.coverage.remeshDirty;
    if (!entry) return;
    state.coverage.remeshDirty.delete(entry);
    if (attached.has(entry)) {
      const previous = entry.primitives;
      entry.primitives = [];
      attachPrimitive(entry);
      removeWhenReady(entry, previous);
      requestRender();
    }
    if (state.coverage.remeshDirty.size)
      state.coverage.remeshTimer = setTimeout(
        () => idleTask(remesh),
        REMESH_STAGGER_MS,
      );
  }

  function idleTask(task) {
    if (typeof globalThis.requestIdleCallback === 'function')
      globalThis.requestIdleCallback(() => task(), { timeout: 500 });
    else task();
  }

  state.coverage.remeshDirty = new Set();
  state.context.meshSampler?.onSampled(onMeshSampled);

  /**
   * Remove a tile's previous primitives once all its current ones are ready
   * (or after a few seconds); detaching the tile removes them at once.
   */
  function removeWhenReady(entry, old) {
    const scene = state.viewer?.scene;
    finishSwap(entry);
    if (!scene?.postRender) {
      removePrimitives(old);
      return;
    }
    const fresh = entry.primitives;
    const started = Date.now();
    const stop = scene.postRender.addEventListener(() => {
      const ready = fresh.every(
        ({ primitive }) => primitive.ready || primitive.isDestroyed?.(),
      );
      if (!ready && Date.now() - started < SWAP_MAX_WAIT_MS) {
        requestRender();
        return;
      }
      finishSwap(entry);
      requestRender();
    });
    entry.swap = { old, stop };
    requestRender();
  }

  function finishSwap(entry) {
    if (!entry.swap) return;
    entry.swap.stop();
    removePrimitives(entry.swap.old);
    entry.swap = null;
  }

  function buildOverviewCollection(points) {
    const collection = new Cesium.PointPrimitiveCollection({
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    const green = Cesium.Color.fromCssColorString(COLORS.coverage).withAlpha(
      0.85,
    );
    const drawn = [];
    for (const point of points) {
      if (!passesImageryFilter(point, filter())) continue;
      drawn.push(
        collection.add({
          position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
          color: green,
          pixelSize: COVERAGE_OVERVIEW_POINT_PX,
          // Google 3D terrain and clouds must not hide the near side's dots;
          // `cullHorizon` hides the far side's, which this lets through.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
    return { collection, points: drawn };
  }

  /**
   * Hide the overview points behind the horizon, as the cyclones layer does.
   * They skip the depth test, so nothing else stops the far hemisphere's
   * coverage drawing over this one at whole-earth zooms; a finite skip
   * distance cannot do it, as the horizon's distance moves with the camera.
   */
  function cullHorizon() {
    const position = state.viewer?.camera?.positionWC;
    if (!position) return;
    const entries = [
      ...state.coverage.tiles.values(),
      ...state.coverage.stale.values(),
    ].filter((entry) => entry.overviewPoints);
    if (!entries.length) {
      stopHorizonCull();
      return;
    }
    const from = state.coverage.cullFrom;
    if (from && Cesium.Cartesian3.equals(from, position)) return;
    state.coverage.cullFrom = Cesium.Cartesian3.clone(position, from);
    let changed = false;
    for (const entry of entries)
      if (cullPoints(entry.overviewPoints, position)) changed = true;
    if (changed) requestRender();
  }

  /** Show the points in front of the horizon seen from `position`, hide the rest. */
  function cullPoints(points, position) {
    const occluder = (state.coverage.occluder ||=
      new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84));
    occluder.cameraPosition = position;
    let changed = false;
    for (const point of points) {
      const show = occluder.isPointVisible(point.position);
      if (point.show !== show) {
        point.show = show;
        changed = true;
      }
    }
    return changed;
  }

  function stopHorizonCull() {
    state.coverage.stopHorizonCull?.();
    state.coverage.stopHorizonCull = null;
    state.coverage.cullFrom = null;
  }

  function attachPrimitive(entry) {
    const scene = state.viewer?.scene;
    if (!scene) return;
    if (entry.kind === 'sequence') {
      // Lookup, picking and counts follow what is drawn, not the whole tile.
      const sequences = drawnSequences(entry);
      entry.sequences = new Map(sequences.map((s) => [s.id, s]));
      const { primitives, draped, cast } = buildSequencePrimitives(sequences);
      entry.primitives = primitives;
      entry.count = sequences.length;
      for (const { primitive, onGround } of primitives)
        (onGround ? scene.groundPrimitives : scene.primitives).add(primitive);
      // Fewer lines cast than last time: the caster has dropped heights this
      // tile used (a full cache), so it must be cast again.
      if (cast < (entry.castLines || 0)) entry.castRequested = false;
      entry.castLines = cast;
      entry.drapedLines = draped.length;
      if (draped.length) castTile(entry);
      watchSelection();
    } else {
      const { collection, points } = buildOverviewCollection(entry.points);
      entry.primitive = collection;
      entry.overviewPoints = points;
      entry.count = points.length;
      scene.primitives.add(collection);
      // Cull the new points now, then every frame the camera has moved.
      const camera = state.viewer.camera?.positionWC;
      if (camera) cullPoints(points, camera);
      state.coverage.stopHorizonCull ||=
        scene.preRender?.addEventListener(cullHorizon) || null;
    }
  }

  function removePrimitives(list) {
    const scene = state.viewer?.scene;
    for (const { primitive, onGround } of list || []) {
      try {
        (onGround ? scene?.groundPrimitives : scene?.primitives)?.remove(
          primitive,
        );
      } catch {
        /* already gone */
      }
    }
  }

  function detachPrimitive(entry) {
    const scene = state.viewer?.scene;
    finishSwap(entry);
    removePrimitives(entry.primitives);
    entry.primitives = [];
    if (entry.primitive) {
      try {
        scene?.primitives?.remove(entry.primitive);
      } catch {
        /* already gone */
      }
      entry.primitive = null;
      entry.overviewPoints = null;
    }
  }

  /** Stop a tile's pending terrain lookup (tile dropped or retired). */
  function cancelCast(entry) {
    entry.castAbort?.abort();
    entry.castAbort = null;
  }

  function removeTile(key) {
    const entry = state.coverage.tiles.get(key);
    if (!entry) return;
    cancelCast(entry);
    detachPrimitive(entry);
    state.coverage.tiles.delete(key);
  }

  async function loadTile(tile, kind) {
    const key = tileKey(tile);
    if (state.coverage.tiles.has(key) || state.coverage.pending.has(key))
      return;
    const controller = new AbortController();
    state.coverage.pending.set(key, controller);
    state.coverage.loading++;
    notify();
    try {
      // Fetch and the one-time terrain-height table load run side by side.
      const fetching = source.getTile('coverage', tile.z, tile.x, tile.y, {
        signal: controller.signal,
      });
      if (kind === 'sequence') await ensureTerrainReady();
      const bytes = await fetching;
      // A refresh that still wants this tile must not throw the bytes away;
      // only an abort (tile no longer wanted, or zoom changed) does.
      // A retire, clear or newer request for this tile owns it now.
      const current = () =>
        state.coverage.pending.get(key) === controller &&
        !state.coverage.tiles.has(key);
      if (
        controller.signal.aborted ||
        !current() ||
        kind !== state.coverage.kind ||
        tile.z !== state.coverage.zoom
      )
        return;
      const decoded = decodeCoverageTile(bytes, tile);
      const entry = { kind, primitive: null, primitives: [], count: 0 };
      // Padded: vector tiles carry a small buffer past their edge.
      const bounds = tileBounds(tile.x, tile.y, tile.z);
      const pad = (bounds.east - bounds.west) * 0.05;
      entry.bounds = {
        west: bounds.west - pad,
        east: bounds.east + pad,
        south: bounds.south - pad,
        north: bounds.north + pad,
      };
      if (kind === 'sequence') {
        // Newest first; the per-tile cap applies to what passes the filter.
        entry.sequenceList = decoded.sequences.sort(
          (a, b) => (b.capturedAt || 0) - (a.capturedAt || 0),
        );
        entry.sequences = new Map();
        entry.total = decoded.sequences.length;
      } else {
        entry.points = decoded.overview;
        entry.sequences = new Map();
        entry.total = decoded.overview.length;
      }
      attachPrimitive(entry);
      state.coverage.tiles.set(key, entry);
      state.coverage.lastError = null;
      requestRender();
    } catch (error) {
      if (
        controller.signal.aborted ||
        state.coverage.pending.get(key) !== controller
      )
        return;
      state.coverage.lastError = error?.message || 'Coverage tile failed';
      if (error?.keyRequired) state.keyRequired = true;
      if (error?.keyRejected) {
        // Every other tile would be refused too: stop asking.
        state.keyRejected = true;
        state.coverage.lastError = KEY_REJECTED_MESSAGE;
      }
      if (error?.retryAfterSec) holdFor(error.retryAfterSec);
    } finally {
      // Only the request that still owns the key settles it: a superseded one
      // must not drop a newer request's entry or its loading count.
      if (state.coverage.pending.get(key) === controller) {
        state.coverage.pending.delete(key);
        state.coverage.loading = Math.max(0, state.coverage.loading - 1);
        if (!state.coverage.pending.size) purgeStale();
      }
      notify();
    }
  }

  /**
   * Mapillary is rate-limiting: keep what is drawn, request nothing until the
   * wait is over, then refresh once.
   */
  function holdFor(seconds) {
    clearTimeout(state.coverage.holdTimer);
    state.coverage.holdUntil = Date.now() + seconds * 1000;
    state.coverage.lastError = RATE_LIMITED_MESSAGE;
    state.coverage.holdTimer = setTimeout(() => {
      state.coverage.holdTimer = null;
      state.coverage.holdUntil = 0;
      if (state.coverage.lastError === RATE_LIMITED_MESSAGE)
        state.coverage.lastError = null;
      refresh();
    }, seconds * 1000);
  }

  /** Forget refusals when the provider goes off, so the next run asks again. */
  function resetErrors() {
    clearTimeout(state.coverage.holdTimer);
    state.coverage.holdTimer = null;
    state.coverage.holdUntil = 0;
    state.coverage.lastError = null;
    state.keyRejected = false;
  }

  /** Drop the previous zoom's tiles once the new ones are on screen. */
  function purgeStale() {
    clearTimeout(state.coverage.staleTimer);
    state.coverage.staleTimer = null;
    if (!state.coverage.stale.size) return;
    for (const entry of state.coverage.stale.values()) detachPrimitive(entry);
    state.coverage.stale.clear();
    requestRender();
  }

  /**
   * Move every loaded tile to the stale set instead of removing it, so the
   * old zoom stays visible while the new zoom streams in (no blank globe).
   */
  function retire() {
    for (const controller of state.coverage.pending.values())
      controller.abort();
    state.coverage.pending.clear();
    state.coverage.loading = 0;
    for (const [key, entry] of state.coverage.tiles) {
      cancelCast(entry);
      const previous = state.coverage.stale.get(key);
      if (previous) detachPrimitive(previous);
      state.coverage.stale.set(key, entry);
    }
    state.coverage.tiles.clear();
    clearTimeout(state.coverage.staleTimer);
    state.coverage.staleTimer = setTimeout(purgeStale, STALE_TILE_MAX_MS);
  }

  function notify() {
    state.context.notify();
  }

  /**
   * Whether the screen centre meets the ground further ahead than the camera
   * is high (a view tilted above 45°), or misses it.
   */
  function isTilted({ nadir, ahead }, height) {
    if (!ahead) return true;
    const dLat = (ahead.lat - nadir.lat) * 111_320;
    const dLon =
      (ahead.lon - nadir.lon) * 111_320 * Math.cos((nadir.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLon) > Math.max(1, height);
  }

  /** Recompute the tile set for the current camera and reconcile primitives. */
  function refresh() {
    const viewer = state.viewer;
    if (!viewer || !state.context.isActive() || state.keyRequired) return;
    if (state.keyRejected || state.coverage.holdUntil > Date.now()) return;
    const ground = groundUnderCamera(viewer, {
      groundAt: state.context.groundCaster?.groundAt,
    });
    const cameraHeight = viewer.camera?.positionCartographic?.height;
    const height = Number.isFinite(cameraHeight)
      ? cameraHeight - (ground ?? 0)
      : null;
    const sequenceZoom = coverageZoomForHeight(height);
    const overviewZoom = sequenceZoom ? null : overviewZoomForHeight(height);
    const zoom = sequenceZoom ?? overviewZoom;
    const kind = sequenceZoom ? 'sequence' : 'overview';
    // At street zooms the rays meet the ground where it really is (1,600 m up
    // in Denver; Google 3D hides the globe) and stop short of the horizon.
    const ranged =
      kind === 'sequence'
        ? {
            groundHeight: ground,
            maxRange: Math.max(
              SEQUENCE_VIEW_RANGE_MIN_M,
              height * SEQUENCE_VIEW_RANGE_PER_HEIGHT,
            ),
          }
        : {};
    // Tilted street views rank tiles along the line of sight, from the ground
    // under the camera to the ground at the centre of the screen.
    const focus = kind === 'sequence' ? viewFocus(viewer, ranged) : null;
    let bbox = visibleBbox(viewer, {
      ...ranged,
      // A tilted view's screen rows jump from the first metres to the horizon:
      // keep the ground around the camera too. Looking down needs no help.
      nearRange: focus && isTilted(focus, height) ? SEQUENCE_VIEW_NEAR_M : null,
    });
    if (kind === 'overview' && (!bbox || zoom <= 1))
      bbox = [-180, -85, 180, 85];
    if (zoom == null || !bbox) {
      state.coverage.hint =
        'Point the camera at the globe for street-level coverage';
      clear();
      notify();
      return;
    }
    state.coverage.hint = '';
    if (zoom !== state.coverage.zoom || kind !== state.coverage.kind) {
      retire();
      state.coverage.zoom = zoom;
      state.coverage.kind = kind;
    }
    const { tiles } = tilesForBbox(bbox, zoom, {
      limit:
        kind === 'sequence' ? COVERAGE_MAX_TILES : COVERAGE_OVERVIEW_MAX_TILES,
      focus: focus && { from: focus.nadir, to: focus.ahead },
    });
    const wanted = new Set(tiles.map(tileKey));
    for (const key of [...state.coverage.tiles.keys()])
      if (!wanted.has(key)) removeTile(key);
    for (const [key, controller] of [...state.coverage.pending])
      if (!wanted.has(key)) {
        // The aborted request no longer owns its key, so its `finally` will
        // not settle the count: settle it here.
        controller.abort();
        state.coverage.pending.delete(key);
        state.coverage.loading = Math.max(0, state.coverage.loading - 1);
      }
    for (const tile of tiles) loadTile(tile, kind);
    if (!state.coverage.pending.size) purgeStale();
    // The camera moved: cells that were out of the sampler's range may not be,
    // and a tile left draped by a failed or dropped cast gets another try.
    if (terrainMode())
      for (const entry of state.coverage.tiles.values())
        if (entry.castRequested) requestMesh(entry);
        else if (entry.drapedLines) castTile(entry);
    notify();
  }

  function scheduleRefresh() {
    clearTimeout(state.coverage.debounceTimer);
    state.coverage.debounceTimer = setTimeout(
      refresh,
      COVERAGE_MOVE_DEBOUNCE_MS,
    );
  }

  function attach(viewer) {
    detach();
    const remove = viewer.camera.changed.addEventListener(scheduleRefresh);
    const removeEnd = viewer.camera.moveEnd.addEventListener(scheduleRefresh);
    state.coverage.removeCameraListener = () => {
      remove();
      removeEnd();
    };
    refresh();
  }

  function detach() {
    clearTimeout(state.coverage.debounceTimer);
    state.coverage.debounceTimer = null;
    state.coverage.removeCameraListener?.();
    state.coverage.removeCameraListener = null;
  }

  function clear() {
    for (const controller of state.coverage.pending.values())
      controller.abort();
    state.coverage.pending.clear();
    state.coverage.loading = 0;
    for (const key of [...state.coverage.tiles.keys()]) removeTile(key);
    purgeStale();
    state.coverage.zoom = null;
    state.coverage.kind = null;
    clearTimeout(state.coverage.remeshTimer);
    state.coverage.remeshTimer = null;
    state.coverage.remeshDirty.clear();
    stopSelectionWatch();
    stopHorizonCull();
    requestRender();
  }

  /** Rebuild every loaded tile from its decoded cache (after a filter change). */
  function rebuild() {
    purgeStale();
    for (const entry of state.coverage.tiles.values()) {
      cancelCast(entry);
      entry.castRequested = false;
      entry.meshCells = null;
      detachPrimitive(entry);
      attachPrimitive(entry);
    }
    requestRender();
    notify();
  }

  /**
   * Redraw loaded tiles draped or cast after the core's surface mode changes,
   * then re-pick the zoom: the bare-earth height under the camera that the
   * change brings in can move it (a high city reads much closer to the street).
   */
  function setSurface() {
    if (!state.context.isActive()) return;
    rebuild();
    refresh();
  }

  /** Look a sequence up across loaded tiles. */
  function findSequence(id) {
    for (const entry of state.coverage.tiles.values()) {
      const hit = entry.sequences.get(id);
      if (hit) return hit;
    }
    return null;
  }

  /** Recolour every part of a sequence in one ready primitive. */
  function recolorInstances(primitive, sequence, selected) {
    const value = sequenceColor({ selected });
    for (const instanceId of partIds(sequence)) {
      try {
        const attributes = primitive.getGeometryInstanceAttributes(instanceId);
        if (attributes)
          attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            value,
            attributes.color,
          );
      } catch {
        /* instance not in this primitive */
      }
    }
  }

  /** Recolour one sequence, every part of it, in place (selection highlight). */
  function recolorSequence(id, selected) {
    for (const entry of state.coverage.tiles.values()) {
      const sequence = entry.sequences.get(id);
      if (!sequence) continue;
      for (const record of entry.primitives || []) {
        // Still building: `syncSelection` catches it up once it is ready.
        if (!record.primitive.ready) continue;
        recolorInstances(record.primitive, sequence, selected);
        if (selected) record.selectedId = id;
        else if (record.selectedId === id) record.selectedId = null;
      }
    }
    requestRender();
  }

  /**
   * Bring a ready primitive's highlight up to the current selection, when
   * it was built with another one (or none). True when it changed.
   */
  function syncSelection(entry, record) {
    const current = state.sequence.selectedId ?? null;
    if (record.selectedId === current || !record.primitive.ready) return false;
    const previous =
      record.selectedId && entry.sequences.get(record.selectedId);
    if (previous) recolorInstances(record.primitive, previous, false);
    const next = current && entry.sequences.get(current);
    if (next) recolorInstances(record.primitive, next, true);
    record.selectedId = current;
    return true;
  }

  /**
   * Colours are baked in when a tile's lines are built, and a primitive
   * cannot be recoloured until it is ready. Cast swaps and remeshes rebuild
   * tiles all the time, so while any primitive is building, catch each one
   * up with the selection made or cleared meanwhile as it becomes ready.
   */
  function watchSelection() {
    const scene = state.viewer?.scene;
    if (state.coverage.stopSelectionWatch || !scene?.postRender) return;
    const stop = scene.postRender.addEventListener(() => {
      let building = false;
      let changed = false;
      for (const entry of state.coverage.tiles.values())
        for (const record of entry.primitives || []) {
          if (!record.primitive.ready) building = true;
          else if (syncSelection(entry, record)) changed = true;
        }
      if (changed) requestRender();
      if (!building) stopSelectionWatch();
    });
    state.coverage.stopSelectionWatch = stop;
  }

  function stopSelectionWatch() {
    state.coverage.stopSelectionWatch?.();
    state.coverage.stopSelectionWatch = null;
  }

  function sequenceCount() {
    let count = 0;
    for (const entry of state.coverage.tiles.values()) count += entry.count;
    return count;
  }

  return {
    attach,
    detach,
    refresh,
    clear,
    resetErrors,
    rebuild,
    setSurface,
    findSequence,
    recolorSequence,
    sequenceCount,
  };
}
