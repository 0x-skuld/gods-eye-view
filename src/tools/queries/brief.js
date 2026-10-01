/** Composite queries that combine other tools' answers for one area. */

import { defineTool, ToolError } from '../catalog.js';
import {
  AREA_SCHEMA,
  POINT_SCHEMA,
  areaCenter,
  resolveArea,
  resolvePoint,
} from '../area.js';
import { aircraftInArea } from './aviation.js';
import {
  findMilitaryInstallations,
  getCyclones,
  getWeather,
} from './environment.js';
import { getActiveFires, getEarthquakes } from './hazards.js';
import { vesselsInArea } from './maritime.js';

const SECTION_LIMIT = 5;
const AWARENESS_LIMIT = 10;
const AWARENESS_RADIUS_KM = 250;

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
    key: 'vessels',
    tool: vesselsInArea,
    args: (area) => ({ area: area.argument, limit: SECTION_LIMIT }),
  },
  {
    key: 'cyclones',
    tool: getCyclones,
    args: (area) => ({ area: area.argument }),
  },
];

/** Military contacts around a point, as the app's military awareness panel. */
const AWARENESS_SECTIONS = [
  {
    key: 'military_aircraft',
    tool: aircraftInArea,
    args: (area) => ({
      area: area.argument,
      military: true,
      limit: AWARENESS_LIMIT,
    }),
  },
  {
    key: 'aircraft',
    tool: aircraftInArea,
    args: (area) => ({ area: area.argument, limit: AWARENESS_LIMIT }),
  },
  {
    key: 'vessels',
    tool: vesselsInArea,
    args: (area) => ({ area: area.argument, limit: AWARENESS_LIMIT }),
  },
  {
    key: 'installations',
    tool: findMilitaryInstallations,
    args: (area) => ({ area: area.argument, limit: AWARENESS_LIMIT }),
  },
];

/** The resolved area, plus the argument sections receive in its place. */
function sectionArea(resolved) {
  return {
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
}

/**
 * Run every section whose services are supplied. A failing section is
 * reported as unavailable instead of failing the whole answer.
 */
async function runSections(all, area, { services, signal }) {
  const center = areaCenter(area);
  const sections = all.filter(({ tool }) =>
    tool.requires.every((key) => services[key] != null),
  );
  const results = await Promise.allSettled(
    sections.map(({ tool, args: build }) =>
      tool.run(build(area, center), { services, signal }),
    ),
  );
  signal?.throwIfAborted();
  const answers = {};
  const lines = [];
  sections.forEach(({ key }, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') {
      answers[key] = { summary: result.value.summary, data: result.value.data };
      lines.push(result.value.summary);
    } else {
      const known = result.reason instanceof ToolError;
      answers[key] = {
        unavailable: true,
        reason: known ? result.reason.message : 'unavailable right now',
      };
    }
  });
  return { center, answers, lines };
}

async function buildBrief(args, { services, signal }) {
  // Sections receive the resolved box so a place name is looked up once.
  const area = sectionArea(await resolveArea(args.area, { services, signal }));
  const { center, answers, lines } = await runSections(SECTIONS, area, {
    services,
    signal,
  });
  return { area, center, brief: answers, lines };
}

export const situationBrief = defineTool({
  name: 'situation_brief',
  title: 'Situation brief',
  description:
    'One overview of an area: current weather, recent earthquakes, active ' +
    'fires, aircraft overhead, ships and tropical cyclones, each summarized with ' +
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

export const militaryAwareness = defineTool({
  name: 'military_awareness',
  title: 'Military awareness',
  description:
    'Military contacts around a location, as the military awareness panel ' +
    'shows them: military aircraft, other aircraft, ships and mapped ' +
    `military installations within ${AWARENESS_RADIUS_KM} km by default, ` +
    'each nearest first. Sections that are unavailable are marked as such.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      radius_km: { type: 'number', minimum: 1, maximum: AWARENESS_RADIUS_KM },
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['military'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const radiusKm = args.radius_km ?? AWARENESS_RADIUS_KM;
    const area = sectionArea(
      await resolveArea(
        { lat: point.lat, lon: point.lon, radius_km: radiusKm },
        { services, signal },
      ),
    );
    const { answers, lines } = await runSections(AWARENESS_SECTIONS, area, {
      services,
      signal,
    });
    return {
      summary: `Military awareness within ${radiusKm} km of ${point.label}: ${lines.join(' ')}`,
      data: {
        location: point,
        radius_km: radiusKm,
        sections: answers,
      },
    };
  },
});
