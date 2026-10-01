/** Space queries: launches. */

import { defineTool, ToolError } from '../catalog.js';
import { LIMIT_SCHEMA, capRows, countNoun } from '../results.js';

const text = (value) => (typeof value === 'string' && value ? value : null);

export const getRecentLaunches = defineTool({
  name: 'get_recent_launches',
  title: 'Recent launches',
  description:
    'Orbital launches from Launch Library 2 over the last 30 days, newest ' +
    'first, with provider, rocket, pad, mission and outcome.',
  inputSchema: {
    type: 'object',
    properties: { limit: LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requires: ['launches'],
  async run(args, { services, signal }) {
    const payload = await services.launches.getLaunches({ signal });
    const launches = Array.isArray(payload) ? payload : payload.results;
    if (!Array.isArray(launches))
      throw new ToolError('malformed', 'The launch feed returned no launches');
    const rows = launches
      .map((launch) => ({
        id: text(launch?.id),
        name: text(launch?.name),
        time: text(launch?.net),
        status: text(launch?.status?.name),
        provider: text(launch?.launch_service_provider?.name),
        rocket: text(
          launch?.rocket?.configuration?.full_name ??
            launch?.rocket?.configuration?.name,
        ),
        pad: text(launch?.pad?.name),
        location: text(launch?.pad?.location?.name),
        mission: text(launch?.mission?.name),
        orbit: text(launch?.mission?.orbit?.name),
      }))
      .filter((launch) => launch.name)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const result = capRows(rows, args.limit);
    return {
      summary: `${countNoun(rows.length, 'launch', 'launches')} in the last 30 days${rows[0] ? `; latest ${rows[0].name}` : ''}.`,
      data: result,
    };
  },
});
