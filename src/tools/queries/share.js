/** A link that opens God's Eye View on an area. */

import {
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  encodeLayerStateParams,
} from '../../data/layerState.js';
import { defineTool, ToolError } from '../catalog.js';
import { AREA_SCHEMA, areaCenter, areaRadiusKm, resolveArea } from '../area.js';

const MIN_ALTITUDE_M = 500;
const MAX_ALTITUDE_M = 15_000_000;
// A top-down view sees roughly this many meters of ground per meter of altitude.
const GROUND_PER_ALTITUDE = 0.55;

export const openInGodsEyeView = defineTool({
  name: 'open_in_gods_eye_view',
  title: "Open in God's Eye View",
  description:
    "A link that opens God's Eye View looking straight down on an area, " +
    'optionally with chosen data layers turned on.',
  inputSchema: {
    type: 'object',
    properties: {
      area: AREA_SCHEMA,
      layers: {
        type: 'array',
        maxItems: REGISTERED_LAYER_IDS.length,
        items: { type: 'string', enum: [...REGISTERED_LAYER_IDS] },
        description: 'Layers to turn on, such as "flights" or "earthquakes".',
      },
    },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['app'],
  async run(args, { services, signal }) {
    let base;
    try {
      base = new URL(services.app.baseUrl);
    } catch {
      throw new ToolError('unavailable', "The app's address is not configured");
    }
    const area = await resolveArea(args.area, { services, signal });
    const center = areaCenter(area);
    const altitude = Math.round(
      Math.min(
        MAX_ALTITUDE_M,
        Math.max(
          MIN_ALTITUDE_M,
          (areaRadiusKm(area) * 1000) / GROUND_PER_ALTITUDE,
        ),
      ),
    );
    // The share-link camera and layer fields; the app restores its defaults
    // for everything else.
    const params = new URLSearchParams({
      v: '2',
      lat: center.lat.toFixed(4),
      lon: center.lon.toFixed(4),
      alt: String(altitude),
      heading: '0',
      pitch: '-90',
    });
    const layers = [...new Set(args.layers || [])];
    if (layers.length)
      encodeLayerStateParams(params, {
        ...createDefaultLayerState(),
        enabledLayerIds: layers,
      });
    base.hash = params.toString();
    return {
      summary: `Open ${area.label} in God's Eye View: ${base.href}`,
      data: { url: base.href, center, altitude_m: altitude, layers },
    };
  },
});
