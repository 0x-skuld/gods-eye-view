import * as Cesium from 'cesium';
import { FOLLOW_EYE_HEIGHT_M } from './policy.js';

/** Plausible ellipsoidal land heights: Dead Sea to Everest, with geoid slack. */
const SURFACE_MIN_M = -500;
const SURFACE_MAX_M = 9000;
/** Rendered mesh window around the bare earth: roofs and bridges, not whole towers. */
const MESH_BELOW_DEM_M = 15;
const MESH_ABOVE_DEM_M = 80;

/** Drive the globe camera from the street-level pose: continuously (follow) or once (framing). */
export function createCameraFollow({ state, parts }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-follow');
  }

  /**
   * Ground under a photo. `sampleHeight` can return kilometres below the
   * ellipsoid before tiles load, so a sample counts only when plausible and
   * within the mesh window around bare earth (once that is known).
   */
  function groundHeightAt(lon, lat, fallback) {
    const scene = state.viewer?.scene;
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const caster = parts?.groundCaster;
    const dem = caster?.groundAt(lon, lat) ?? null;
    if (dem === null) caster?.prepare([[lon, lat]]);
    const plausible = (height) =>
      Number.isFinite(height) &&
      height >= SURFACE_MIN_M &&
      height <= SURFACE_MAX_M &&
      (dem === null ||
        (height >= dem - MESH_BELOW_DEM_M && height <= dem + MESH_ABOVE_DEM_M));
    let height = null;
    try {
      if (scene?.sampleHeightSupported) height = scene.sampleHeight(carto);
    } catch {
      /* not sampleable yet */
    }
    if (!plausible(height)) height = dem;
    if (!plausible(height)) height = scene?.globe?.getHeight?.(carto);
    if (!plausible(height)) height = fallback;
    return plausible(height) ? height : 0;
  }

  /** Put the Cesium camera where the street-level camera is. */
  function followCamera() {
    const { position, bearing, tilt, follow, altitude } = state.street;
    if (!follow || !position || !state.viewer) return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    state.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        position.lon,
        position.lat,
        ground + FOLLOW_EYE_HEIGHT_M,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(bearing || 0),
        pitch: Cesium.Math.toRadians(Number.isFinite(tilt) ? tilt : 0),
        roll: 0,
      },
    });
    requestRender();
  }

  /** Our framing flight while it is current; Cesium calls `cancel` when another flight starts. */
  let framing = null;

  /** Frame the current image from a short distance behind it. */
  function lookAtPosition() {
    const { position, bearing, altitude } = state.street;
    if (!position || !state.viewer) return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    // Owned before the call: starting it cancels the previous flight (ours
    // included) synchronously, and a zero-length one completes at once.
    const flight = {};
    framing = flight;
    const release = () => {
      if (framing === flight) framing = null;
    };
    state.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(position.lon, position.lat, ground + 2),
        4,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(bearing || 0),
          Cesium.Math.toRadians(-32),
          140,
        ),
        duration: 1.6,
        complete: release,
        cancel: release,
      },
    );
  }

  /** Stop our framing flight if it is still in the air; another feature's flight is left alone. */
  function cancelFraming() {
    if (!framing) return;
    // Give up ownership first: cancelFlight delivers `cancel` synchronously.
    framing = null;
    state.viewer?.camera?.cancelFlight?.();
  }

  function setFollow(enabled) {
    state.street.follow = enabled === true && state.street.followAvailable;
    // The framing tween would keep overwriting the follow view until it lands.
    if (state.street.follow) {
      cancelFraming();
      followCamera();
    }
    state.notify?.();
  }

  return { followCamera, lookAtPosition, cancelFraming, setFollow };
}
