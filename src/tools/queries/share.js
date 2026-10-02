/** Links that open God's Eye View at a view. */

import { VIEW_PROPERTIES, createView, viewUrl } from '../../view/index.js';
import { defineTool, ToolError } from '../catalog.js';
import { AREA_SCHEMA, resolveArea } from '../area.js';
import { cameraForArea } from '../views.js';

/** Tool arguments that describe a view: an area to frame, or a camera. */
export const VIEW_ARGUMENTS = Object.freeze({
  area: AREA_SCHEMA,
  ...VIEW_PROPERTIES,
});

/**
 * The view described by tool arguments. An area frames the camera straight
 * down over it; camera fields given alongside it override the framing.
 */
export async function resolveViewArguments(args, { services, signal }) {
  let camera = { ...args.camera };
  let label = null;
  if (args.area) {
    const area = await resolveArea(args.area, { services, signal });
    label = area.label;
    camera = { ...cameraForArea(area), ...camera };
  }
  if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lon))
    throw new ToolError(
      'invalid_arguments',
      'Give an area, or a camera with lat and lon',
    );
  const view = createView({
    camera,
    layers: args.layers,
    style: args.style ?? null,
    map: args.map ?? null,
    follow: args.follow ?? null,
  });
  return {
    view,
    label:
      label ?? `${view.camera.lat.toFixed(3)}, ${view.camera.lon.toFixed(3)}`,
  };
}

function appBase(services) {
  try {
    return new URL(services.app.baseUrl).href;
  } catch {
    throw new ToolError('unavailable', "The app's address is not configured");
  }
}

export const openInGodsEyeView = defineTool({
  name: 'open_in_gods_eye_view',
  title: "Open in God's Eye View",
  description:
    "A link that opens God's Eye View at a view: an area framed from above " +
    'or a camera position, with chosen data layers, visual style and map, ' +
    'optionally following an aircraft or satellite.',
  inputSchema: {
    type: 'object',
    properties: VIEW_ARGUMENTS,
    additionalProperties: false,
  },
  requires: ['app'],
  async run(args, { services, signal }) {
    const base = appBase(services);
    const { view, label } = await resolveViewArguments(args, {
      services,
      signal,
    });
    const url = viewUrl(base, view);
    return {
      summary: `Open ${label} in God's Eye View: ${url}`,
      data: { url, view },
    };
  },
});
