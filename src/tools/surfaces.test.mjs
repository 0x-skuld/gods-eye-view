import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_SURFACES, coreTools, toolsForSurface } from './index.js';

const names = (tools) => tools.map((tool) => tool.name);

test('MCP offers every tool and voice leaves out the table entries', () => {
  assert.deepEqual(names(toolsForSurface(coreTools, 'mcp')), names(coreTools));
  const voice = names(toolsForSurface(coreTools, 'voice'));
  assert.equal(
    voice.length,
    coreTools.length - Object.keys(TOOL_SURFACES).length,
  );
  for (const name of Object.keys(TOOL_SURFACES))
    assert.ok(!voice.includes(name), name);
  assert.ok(voice.includes('get_weather'));
  assert.ok(voice.includes('military_awareness'));
});

test('overrides turn a tool on or off for one surface', () => {
  const voice = names(
    toolsForSurface(coreTools, 'voice', {
      get_weather_map: { voice: true },
      get_weather: { voice: false },
    }),
  );
  assert.ok(voice.includes('get_weather_map'));
  assert.ok(!voice.includes('get_weather'));
  assert.ok(
    !names(
      toolsForSurface(coreTools, 'mcp', { get_weather: { mcp: false } }),
    ).includes('get_weather'),
  );
});

test('unknown surfaces and tool names are rejected', () => {
  assert.throws(
    () => toolsForSurface(coreTools, 'email'),
    /Unknown tool surface/,
  );
  assert.throws(
    () => toolsForSurface(coreTools, 'voice', { get_wether: { voice: false } }),
    /Unknown tool: get_wether/,
  );
  assert.throws(
    () =>
      toolsForSurface(coreTools, 'voice', { get_weather: { voise: false } }),
    /Unknown tool surface for get_weather: voise/,
  );
});
