/** The local MCP server: Core's tools over services backed by a running app. */

import { readFileSync } from 'node:fs';
import {
  composeCatalog,
  coreTools,
  catalogForSurface,
} from '../../src/tools/index.js';
import { createGlobePanelResource } from '../../src/tools/globePanel.js';
import { createMcpServer } from '../../src/tools/mcp/index.js';
import { DEFAULT_API_BASE, createLocalToolServices } from './services.js';

const INSTRUCTIONS =
  "Tools answer questions from God's Eye View's live public data. Location " +
  'tools take an area: a place name, a bbox, or lat/lon with radius_km. ' +
  'Results are capped; check truncated and total before concluding there is nothing more. ' +
  'Answers that can be seen on the globe include data.view; to show one, call ' +
  'show_on_globe with that view, adding layers, style, a camera or marks as ' +
  'needed. It shows the live globe where the client displays apps and ' +
  'returns a link everywhere.';

/** Construct the local MCP server for Core's tools. */
export function createLocalMcpServer({
  apiBase = DEFAULT_API_BASE,
  fetchImpl,
} = {}) {
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  return createMcpServer({
    catalog: catalogForSurface(
      composeCatalog({
        tools: coreTools,
        services: createLocalToolServices({ apiBase, fetchImpl }),
      }),
      'mcp',
    ),
    name: 'gods-eye-view',
    version,
    instructions: INSTRUCTIONS,
    resources: [createGlobePanelResource({ appUrl: apiBase })],
  });
}
