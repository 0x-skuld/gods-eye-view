/** Composite queries that combine other tools' answers for one area. */

import { defineTool, ToolError } from '../catalog.js';
import { AREA_SCHEMA, areaCenter, resolveArea } from '../area.js';
import { aircraftInArea } from './aviation.js';
import { getCyclones, getWeather } from './environment.js';
import { getActiveFires, getEarthquakes } from './hazards.js';

const SECTION_LIMIT = 5;

/** Brief sections: the tool each one reuses and the services it needs. */
const SECTIONS = [
  {
    key: 'weather',
    tool: getWeather,
    args: (area, center) => ({
      location: { lat: center.lat, lon: center.lon },
    }),
  },
  {
    key: 'earthquakes',
    tool: getEarthquakes,
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'fires',
    tool: getActiveFires,
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'aircraft',
    tool: aircraftInArea,
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'cyclones',
    tool: getCyclones,
    args: (area) => ({ area: area.argument }),
  },
];

/**
 * Run every section whose services are supplied. A failing section is
 * reported as unavailable instead of failing the brief.
 */
async function buildBrief(args, { services, signal }) {
  const resolved = await resolveArea(args.area, { services, signal });
  // Sections receive the resolved box so a place name is looked up once.
  const area = {
    ...resolved,
    argument: resolved.center
      ? {
          lat: resolved.center.lat,
          lon: resolved.center.lon,
          radius_km: resolved.center.radiusKm,
        }
      : {
          bbox: [resolved.west, resolved.south, resolved.east, resolved.north],
        },
  };
  const center = areaCenter(resolved);
  const sections = SECTIONS.filter(({ tool }) =>
    tool.requires.every((key) => services[key] != null),
  );
  const results = await Promise.allSettled(
    sections.map(({ tool, args: build }) =>
      tool.run(build(area, center), { services, signal }),
    ),
  );
  signal?.throwIfAborted();
  const brief = {};
  const lines = [];
  sections.forEach(({ key }, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') {
      brief[key] = { summary: result.value.summary, data: result.value.data };
      lines.push(result.value.summary);
    } else {
      const known = result.reason instanceof ToolError;
      brief[key] = {
        unavailable: true,
        reason: known ? result.reason.message : 'unavailable right now',
      };
    }
  });
  return { area: resolved, center, brief, lines };
}

export const situationBrief = defineTool({
  name: 'situation_brief',
  title: 'Situation brief',
  description:
    'One overview of an area: current weather, recent earthquakes, active ' +
    'fires, aircraft overhead and tropical cyclones, each summarized with ' +
    'its top items. Sections that are unavailable are marked as such.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['weather'],
  async run(args, context) {
    const { area, brief, lines } = await buildBrief(args, context);
    return {
      summary: `Situation in ${area.label}: ${lines.join(' ')}`,
      data: { area: area.label, sections: brief },
    };
  },
});

export const getHudCaption = defineTool({
  name: 'get_hud_caption',
  title: 'Heads-up display caption',
  description:
    "The short heads-up display caption God's Eye View would show for an " +
    'area, written by the app from the same overview situation_brief gives.',
  inputSchema: {
    type: 'object',
    properties: { area: AREA_SCHEMA },
    required: ['area'],
    additionalProperties: false,
  },
  requires: ['weather', 'summary'],
  async run(args, context) {
    const { area, center, lines } = await buildBrief(args, context);
    const response = await context.services.summary.summarize(
      { location: area.label, center, observations: lines },
      { signal: context.signal },
    );
    const caption = response?.data?.summary;
    if (!response?.ok || typeof caption !== 'string' || !caption)
      throw new ToolError('unavailable', 'The caption service did not answer');
    return {
      summary: caption,
      data: { area: area.label, caption },
    };
  },
});
