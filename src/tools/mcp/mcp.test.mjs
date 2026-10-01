import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, defineTool, ToolError } from '../catalog.js';
import {
  createMcpHttpHandler,
  createMcpServer,
  MCP_PROTOCOL_VERSIONS,
  toMcpTools,
} from './index.js';

const tool = (name, run) =>
  defineTool({
    name,
    title: 'Count',
    description: 'Counts things.',
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      additionalProperties: false,
    },
    run,
  });
const catalog = composeCatalog({
  tools: [
    tool('count', async ({ n = 1 }) => ({
      summary: `${n} things.`,
      data: { n },
    })),
    tool('busy', async () => {
      throw new ToolError('retry_later', 'Upstream is busy', {
        retryAfterSeconds: 10,
      });
    }),
    tool('crash', async () => {
      throw new Error('database password is hunter2');
    }),
  ],
});
const server = createMcpServer({
  catalog,
  name: 'test',
  version: '1.0.0',
  instructions: 'Be brief.',
});
const request = (method, params, id = 1) =>
  server.handle({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates a supported protocol version', async () => {
  const known = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(known.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'test', version: '1.0.0' },
    instructions: 'Be brief.',
  });
  const unknown = await request('initialize', {
    protocolVersion: '1999-01-01',
  });
  assert.equal(unknown.result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  assert.deepEqual((await request('ping')).result, {});
});

test('notifications and client responses get no reply', async () => {
  assert.equal(
    await server.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
    null,
  );
  assert.equal(
    await server.handle({ jsonrpc: '2.0', id: 9, result: {} }),
    null,
  );
});

test('invalid messages and unknown methods are JSON-RPC errors', async () => {
  assert.equal(
    (await server.handle({ id: 1, method: 'ping' })).error.code,
    -32600,
  );
  assert.equal(
    (await server.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).error
      .code,
    -32600,
  );
  assert.equal(
    (await server.handle({ jsonrpc: '2.0', id: 1 })).error.code,
    -32600,
  );
  assert.equal((await request('tools/remove')).error.code, -32601);
  assert.equal((await request('toString')).error.code, -32601);
  assert.equal((await request('tools/list', [])).error.code, -32602);
  assert.equal(
    (await request('tools/call', { name: 'missing' })).error.code,
    -32602,
  );
});

test('tools are listed with titles, schemas and annotations, with surface overrides', async () => {
  const { tools } = (await request('tools/list')).result;
  assert.deepEqual(tools[0], {
    name: 'count',
    title: 'Count',
    description: 'Counts things.',
    inputSchema: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      additionalProperties: false,
    },
    annotations: { title: 'Count', readOnlyHint: true },
  });
  const [custom] = toMcpTools(catalog, {
    descriptions: { count: { description: 'Counts for this surface.' } },
    decorate: (definition, source) => ({
      _meta: { kind: source.kind, seen: definition.name },
    }),
  });
  assert.equal(custom.description, 'Counts for this surface.');
  assert.deepEqual(custom._meta, { kind: 'query', seen: 'count' });
});

test('tool results carry text and structured content; failures stay generic', async () => {
  assert.deepEqual(
    (await request('tools/call', { name: 'count', arguments: { n: 3 } }))
      .result,
    {
      content: [{ type: 'text', text: '3 things.' }],
      structuredContent: { n: 3 },
      isError: false,
    },
  );
  assert.deepEqual((await request('tools/call', { name: 'busy' })).result, {
    content: [{ type: 'text', text: 'Upstream is busy' }],
    structuredContent: { error: 'retry_later', retry_after_seconds: 10 },
    isError: true,
  });
  const invalid = (
    await request('tools/call', { name: 'count', arguments: { n: 'x' } })
  ).result;
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error, 'invalid_arguments');
  const crash = (await request('tools/call', { name: 'crash' })).result;
  assert.equal(crash.isError, true);
  assert.equal(JSON.stringify(crash).includes('hunter2'), false);
});

test('the HTTP transport accepts one JSON message per POST', async () => {
  const handle = createMcpHttpHandler(server);
  const post = (body, headers = {}) =>
    handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  const ok = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/json');
  assert.deepEqual(await ok.json(), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(
    (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }))
      .status,
    202,
  );
  const parse = await post('{');
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);
  assert.equal(
    (await post({}, { 'MCP-Protocol-Version': '1999-01-01' })).status,
    400,
  );
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('x'.repeat(1024 * 1024 + 1))).status, 413);
  const get = await handle(new Request('http://localhost/mcp'));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});
