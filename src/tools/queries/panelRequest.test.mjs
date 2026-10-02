import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { PANEL_PART_BYTES } from './panelRequest.js';

const fromBase64 = (text) => Buffer.from(text, 'base64');
const gunzip = async (bytes) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );

function catalogWith(handler) {
  const requests = [];
  const fetchImpl = async (path, init) => {
    requests.push({ path, ...init });
    return handler(path, init);
  };
  return {
    requests,
    catalog: composeCatalog({
      tools: coreTools,
      services: {
        app: { baseUrl: 'http://localhost:4173/', fetch: fetchImpl },
      },
    }),
  };
}

test('panel_request is for the panel only', () => {
  const { catalog } = catalogWith(() => new Response('x'));
  assert.deepEqual(catalog.get('panel_request').ui, { visibility: ['app'] });
});

test('a small response returns whole, compressed when that helps', async () => {
  const text = 'body { color: red; }\n'.repeat(200);
  const { catalog, requests } = catalogWith(
    () =>
      new Response(text, {
        status: 200,
        headers: { 'content-type': 'text/css', 'set-cookie': 'a=b' },
      }),
  );
  const { data } = await catalog.call('panel_request', {
    path: '/panel/assets/style.css',
    headers: { Accept: 'text/css', Cookie: 'secret', 'X-Other': '1' },
  });
  assert.deepEqual(requests[0].headers, { Accept: 'text/css' });
  assert.equal(data.status, 200);
  assert.equal(data.encoding, 'gzip');
  assert.equal(data.nextOffset, undefined);
  assert.equal(data.headers['content-type'], 'text/css');
  assert.equal(data.headers['set-cookie'], undefined);
  const body = await gunzip(fromBase64(data.body));
  assert.equal(new TextDecoder().decode(body), text);
});

test('a large response comes in parts that join to the original', async () => {
  const bytes = new Uint8Array(PANEL_PART_BYTES * 2 + 10);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = (index * 7919) % 251;
  const { catalog } = catalogWith(
    () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
  );
  let { data } = await catalog.call('panel_request', { path: '/a.png' });
  assert.equal(data.encoding, 'identity');
  assert.equal(data.totalBytes, bytes.length);
  const parts = [fromBase64(data.body)];
  while (data.nextOffset !== undefined) {
    ({ data } = await catalog.call('panel_request', {
      id: data.id,
      offset: data.nextOffset,
    }));
    parts.push(fromBase64(data.body));
  }
  assert.equal(parts.length, 3);
  assert.deepEqual(new Uint8Array(Buffer.concat(parts)), bytes);
});

test('a request body and method pass through; settings and other sites do not', async () => {
  const { catalog, requests } = catalogWith(
    () => new Response('{}', { status: 201 }),
  );
  const { data } = await catalog.call('panel_request', {
    path: '/api/openai/hud-summary',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from('{"a":1}').toString('base64'),
  });
  assert.equal(data.status, 201);
  assert.equal(new TextDecoder().decode(requests[0].body), '{"a":1}');
  for (const path of [
    '/api/setup/status',
    '/api/setup',
    '//evil.example/x',
    'http://evil.example/',
  ])
    await assert.rejects(
      catalog.call('panel_request', { path }),
      (error) => error.code === 'invalid_arguments',
      path,
    );
  await assert.rejects(
    catalog.call('panel_request', { id: 'unknown' }),
    (error) => error.code === 'invalid_arguments',
  );
  assert.equal(requests.length, 1);
});
