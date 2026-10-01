/** A link that opens God's Eye View on an area. */

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
    "A link that opens God's Eye View looking straight down on an area.",
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
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
    // The share-link camera fields; the app restores its defaults for the rest.
    base.hash = new URLSearchParams({
      v: '2',
      lat: center.lat.toFixed(4),
      lon: center.lon.toFixed(4),
      alt: String(altitude),
      heading: '0',
      pitch: '-90',
    }).toString();
    return {
      summary: `Open ${area.label} in God's Eye View: ${base.href}`,
      data: { url: base.href, center, altitude_m: altitude },
    };
  },
});
