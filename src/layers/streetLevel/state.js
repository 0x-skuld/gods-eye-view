import { FILTER_DEFAULT } from './policy.js';

/**
 * The open image's fields of `state.street`, as they are with no image open.
 * Closing the viewer resets exactly these; the panel host, the render mode
 * and whether following is available outlive any one image.
 */
export function freshStreet() {
  return {
    open: false,
    follow: false,
    providerId: null,
    providerName: null,
    providerLabel: null,
    imageId: null,
    position: null,
    bearing: null,
    tilt: null,
    altitude: null,
    isPano: false,
    capturedAt: null,
    sequenceId: null,
    creator: null,
    externalUrl: null,
    loading: false,
    error: null,
  };
}

/** Mutable core state, created once per layer instance. */
export function createState({ services }) {
  return {
    services,
    viewer: null,
    enabled: false,
    initialized: false,
    destroyed: false,
    listeners: new Set(),
    notify: null,
    /** Shared imagery filter, in the stored (relative-days) form. */
    filter: { ...FILTER_DEFAULT },
    /** @type {Map<string, {def: object, instance: object, on: boolean}>} */
    providers: new Map(),

    street: {
      host: null,
      /** Whether the active map stack allows following (Google 3D only). */
      followAvailable: false,
      /** 'letterbox' shows the whole image; 'fill' crops it to the frame. */
      renderMode: 'letterbox',
      ...freshStreet(),
    },

    /** 'terrain' on Google 3D at street zoom (overlays on the bare earth), else 'draped'. */
    surface: 'draped',

    marker: { collection: null, billboard: null },
    clickHandler: null,
  };
}
