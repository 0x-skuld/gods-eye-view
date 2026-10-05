import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { PbfWriter } from 'pbf';
import { mapillaryProxy } from 'gods-eye-view/server/providers/mapillary';
import {
  listTileLayers,
  stripTileLayers,
} from '../../server/providers/mapillary/trim.js';
import * as tiles from '../../server/providers/mapillary/tiles.js';
import {
  fetchTile,
  normalizeTileAddress,
  TileRequestError,
  _resetTileMemoryForTest,
  _setTileCacheDirForTest,
} from '../../server/providers/mapillary/tiles.js';

// Every tile these tests cache lands in a throwaway directory, never in the
// developer's .gev-cache.
const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-mly-tiles-'));
_setTileCacheDirForTest(cacheDir);
// The directory is not switched back: a background write still landing must
// never sweep the real cache.
after(() => fsp.rm(cacheDir, { recursive: true, force: true }));
const tileFile = ({ z, x, y }, root = cacheDir) =>
  path.join(root, 'coverage', String(z), `${x}-${y}.pbf`);
const HOUR = 60 * 60 * 1000;

/** Write a cache file dated `ageMs` ago. */
async function writeAged(file, bytes, ageMs) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);
  const at = new Date(Date.now() - ageMs);
  await fsp.utimes(file, at, at);
}

/** Poll until `check()` holds (background cache writes are not awaited). */
async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const exists = (file) =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

/** Mount the plugin and return a caller keyed by route. */
function install(plugin, mode = 'configureServer') {
  const routes = new Map();
  plugin[mode]({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  const call = async (route, url = '/', method = 'GET', body) => {
    const handler = routes.get(route);
    assert.ok(handler, `route ${route} is mounted`);
    const headers = {};
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return headers[name.toLowerCase()];
      },
      writeHead(status, extra) {
        this.statusCode = status;
        Object.assign(headers, extra || {});
      },
      end(payload) {
        this.body = payload;
        this.writableEnded = true;
      },
      on() {},
    };
    const listeners = {};
    const req = {
      url,
      method,
      headers: {},
      on(event, fn) {
        listeners[event] = fn;
      },
      [Symbol.asyncIterator]: async function* () {
        if (body) yield Buffer.from(body);
      },
    };
    await handler(req, res);
    return { ...res, headers };
  };
  return { routes, call };
}

const json = (res) => JSON.parse(String(res.body));

test('the plugin mounts the status and tile routes for dev and preview servers', () => {
  for (const mode of ['configureServer', 'configurePreviewServer']) {
    const { routes } = install(mapillaryProxy(), mode);
    assert.deepEqual([...routes.keys()].sort(), [
      '/api/mapillary/status',
      '/api/mapillary/tiles',
    ]);
  }
});

test('status reports whether a token exists, never its value, and rejects non-GET', async () => {
  const saved = { MAPILLARY_CLIENT_TOKEN: process.env.MAPILLARY_CLIENT_TOKEN };
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install(mapillaryProxy());
    const res = await call('/api/mapillary/status');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(json(res), { configured: false });
    assert.doesNotMatch(String(res.body), /MLY\||planner/);
    const post = await call('/api/mapillary/status', '/', 'POST');
    assert.equal(post.statusCode, 405);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('tile route validates the path and refuses to proxy without a token', async () => {
  const saved = process.env.MAPILLARY_CLIENT_TOKEN;
  delete process.env.MAPILLARY_CLIENT_TOKEN;
  try {
    const { call } = install(mapillaryProxy());
    const bad = await call('/api/mapillary/tiles', '/coverage/14/1/x');
    assert.equal(bad.statusCode, 400);
    const signs = await call('/api/mapillary/tiles', '/signs/14/1/2');
    assert.equal(signs.statusCode, 400, 'only coverage tiles are proxied');
    const noKey = await call('/api/mapillary/tiles', '/coverage/14/1/2');
    assert.equal(noKey.statusCode, 503);
    assert.deepEqual(json(noKey), { error: 'no_key', keyRequired: true });
    const post = await call('/api/mapillary/tiles', '/coverage/14/1/2', 'POST');
    assert.equal(post.statusCode, 405);
  } finally {
    if (saved === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = saved;
  }
});

/**
 * Drive the tile route against a scripted upstream: `answer(call)` returns the
 * Response for each upstream fetch. Refusals are never cached, so no disk tile
 * is written.
 */
async function withUpstream(answer, run) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return answer(calls.length);
  };
  try {
    await run({ calls, call: install(mapillaryProxy()).call });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
}

for (const status of [401, 403])
  test(`an upstream ${status} is a rejected key, and misses stop asking Mapillary (review IC8 P2)`, async () => {
    await withUpstream(
      () => new Response('{}', { status }),
      async ({ calls, call }) => {
        for (const tile of ['/coverage/14/5/5', '/coverage/14/6/6']) {
          const res = await call('/api/mapillary/tiles', tile);
          assert.equal(res.statusCode, 403);
          assert.deepEqual(json(res), {
            error: 'Mapillary rejected the access token',
            keyRejected: true,
          });
          assert.doesNotMatch(String(res.body), /MLY\|/);
        }
        assert.equal(calls.length, 1, 'the second miss is answered locally');
        // A new token is asked at once.
        process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|new|token';
        await call('/api/mapillary/tiles', '/coverage/14/7/7');
        assert.equal(calls.length, 2);
      },
    );
  });

test('a 429 passes its Retry-After on and holds misses until it is over (review IC8 P2)', async (t) => {
  await withUpstream(
    () => new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
    async ({ calls, call }) => {
      const first = await call('/api/mapillary/tiles', '/coverage/14/5/5');
      assert.equal(first.statusCode, 429);
      assert.equal(first.headers['retry-after'], '30');
      assert.deepEqual(json(first), {
        error: 'Mapillary is rate-limiting tile requests',
        retryAfter: 30,
      });
      const held = await call('/api/mapillary/tiles', '/coverage/14/6/6');
      assert.equal(held.statusCode, 429);
      assert.equal(calls.length, 1, 'held: Mapillary is not asked again');
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 31_000);
      await call('/api/mapillary/tiles', '/coverage/14/6/6');
      assert.equal(calls.length, 2, 'asked again once the wait is over');
    },
  );
});

test('normalizeTileAddress enforces layer names, zoom ranges and tile bounds', () => {
  assert.equal(
    normalizeTileAddress({ layer: 'coverage', z: 3, x: 1, y: 2 }).key,
    'coverage/3/1/2',
  );
  assert.deepEqual(
    normalizeTileAddress({ layer: 'coverage', z: '14', x: '5', y: '6' })
      .dropLayers,
    ['image'],
  );
  for (const bad of [
    { layer: 'image', z: 14, x: 1, y: 1 },
    { layer: 'points', z: 14, x: 1, y: 1 },
    { layer: 'signs', z: 14, x: 1, y: 1 },
    { layer: 'coverage', z: 15, x: 1, y: 1 },
    { layer: 'coverage', z: 2, x: 4, y: 0 },
    { layer: 'coverage', z: 2, x: 1.5, y: 0 },
    { layer: 'coverage', z: -1, x: 0, y: 0 },
  ])
    assert.throws(
      () => normalizeTileAddress(bad),
      TileRequestError,
      JSON.stringify(bad),
    );
});

test('normalizeTileAddress refuses prototype keys as layer names', () => {
  for (const layer of ['constructor', '__proto__', 'toString'])
    assert.throws(
      () => normalizeTileAddress({ layer, z: 1, x: 0, y: 0 }),
      TileRequestError,
      layer,
    );
});

test('coverage zooms the app never requests (z6–10) are refused with a 400 (review P2)', async () => {
  for (const z of [6, 7, 8, 9, 10])
    assert.throws(
      () => normalizeTileAddress({ layer: 'coverage', z, x: 0, y: 0 }),
      TileRequestError,
      `z${z}`,
    );
  for (const z of [0, 5, 11, 14])
    assert.equal(
      normalizeTileAddress({ layer: 'coverage', z, x: 0, y: 0 }).z,
      z,
    );
  await withUpstream(
    () => new Response(null, { status: 204 }),
    async ({ calls, call }) => {
      const res = await call('/api/mapillary/tiles', '/coverage/9/5/5');
      assert.equal(res.statusCode, 400);
      assert.deepEqual(json(res), {
        error: 'Tile zoom for coverage must be 0–5 or 11–14',
      });
      assert.equal(calls.length, 0, 'Mapillary is not asked');
    },
  );
});

test('fetchTile serves from memory after one upstream fetch and strips the image layer', async () => {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  const tile = (() => {
    const writer = new PbfWriter();
    for (const name of ['sequence', 'image']) {
      writer.writeMessage(
        3,
        (layer, pbf) => {
          pbf.writeVarintField(15, 2);
          pbf.writeStringField(1, layer.name);
          if (layer.name === 'image')
            pbf.writeBytesField(4, Buffer.alloc(4000, 1));
        },
        { name },
      );
    }
    return Buffer.from(writer.finish());
  })();
  let upstreamCalls = 0;
  globalThis.fetch = async (url) => {
    upstreamCalls++;
    assert.match(
      String(url),
      /tiles\.mapillary\.com\/maps\/vtp\/mly1_public\/2\/14\/0\/0\?access_token=/,
    );
    return new Response(tile, {
      status: 200,
      headers: { 'content-type': 'application/x-protobuf' },
    });
  };
  try {
    // The file is removed first so an earlier test cannot leave a disk hit.
    await fsp.rm(tileFile({ z: 14, x: 0, y: 0 }), { force: true });
    const first = await fetchTile({ layer: 'coverage', z: 14, x: 0, y: 0 });
    assert.equal(first.source, 'upstream');
    assert.deepEqual(listTileLayers(first.bytes), ['sequence']);
    assert.ok(first.bytes.length < 100, 'image layer stripped in transit');
    const second = await fetchTile({ layer: 'coverage', z: 14, x: 0, y: 0 });
    assert.equal(second.source, 'memory');
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
});

test('a tile held in memory past the 24 h TTL is fetched again', async (t) => {
  const tile = { layer: 'coverage', z: 14, x: 3, y: 3 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = fetchTile(tile);
    await settle();
    upstream[0].release();
    assert.equal((await first).source, 'upstream');
    assert.equal((await fetchTile(tile)).source, 'memory');
    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 25 * 60 * 60 * 1000);
    const again = fetchTile(tile);
    await settle();
    assert.equal(upstream.length, 2, 'neither cache answers a stale tile');
    upstream[1].release();
    assert.equal((await again).source, 'upstream');
  });
});

test('a disk tile keeps its age in memory and through a retrim rewrite (review P2)', async (t) => {
  const address = { layer: 'coverage', z: 14, x: 8, y: 8 };
  const file = tileFile(address);
  const untrimmed = tile([
    { name: 'sequence' },
    { name: 'image', payload: Buffer.alloc(4000, 1) },
  ]);
  await writeAged(file, untrimmed, 23 * HOUR);
  const writtenAt = (await fsp.stat(file)).mtimeMs;
  await withUpstream(
    () => new Response(tile([{ name: 'sequence' }]), { status: 200 }),
    async ({ calls }) => {
      const first = await fetchTile(address);
      assert.equal(first.source, 'disk');
      assert.deepEqual(listTileLayers(first.bytes), ['sequence']);
      // The untrimmed file is replaced by the trimmed tile, still dated when
      // Mapillary served it.
      await waitFor(
        async () => (await fsp.stat(file)).size === first.bytes.length,
        'the trimmed rewrite',
      );
      assert.ok(
        Math.abs((await fsp.stat(file)).mtimeMs - writtenAt) < 1000,
        'the rewrite keeps the original mtime',
      );
      const now = Date.now();
      t.mock.method(Date, 'now', () => now + 2 * HOUR);
      const later = await fetchTile(address);
      assert.equal(later.source, 'upstream', '25 h old: no cache serves it');
      assert.equal(calls.length, 1);
      // Let the refetched tile land before the next test moves the cache.
      await waitFor(
        async () => (await fsp.stat(file)).mtimeMs > writtenAt + HOUR,
        'the refetched tile write',
      );
    },
  );
});

/** Point the disk cache at a fresh directory for one test. */
async function withCacheDir(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-mly-sweep-'));
  tiles._setTileCacheDirForTest(dir);
  try {
    await run(dir);
  } finally {
    tiles._setTileCacheDirForTest(cacheDir);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('the disk sweep removes expired tiles and keeps fresh ones (review P2)', async () => {
  await withCacheDir(async (dir) => {
    const expired = tileFile({ z: 14, x: 1, y: 1 }, dir);
    const fresh = tileFile({ z: 14, x: 2, y: 2 }, dir);
    await writeAged(expired, Buffer.alloc(100, 1), 25 * HOUR);
    await writeAged(fresh, Buffer.alloc(100, 2), 23 * HOUR);
    const result = await tiles.sweepTileDisk();
    assert.equal(result.removed, 1);
    assert.equal(await exists(expired), false);
    assert.equal(await exists(fresh), true);
  });
});

test('the disk sweep evicts the oldest tiles past the size cap (review P2)', async () => {
  await withCacheDir(async (dir) => {
    const files = [3, 2, 1].map((age) => {
      const file = tileFile({ z: 13, x: age, y: age }, dir);
      return { file, age };
    });
    for (const { file, age } of files)
      await writeAged(file, Buffer.alloc(100, age), age * HOUR);
    const result = await tiles.sweepTileDisk({ maxBytes: 250 });
    assert.deepEqual(result, { removed: 1, bytes: 200 });
    assert.equal(await exists(files[0].file), false, 'the oldest goes first');
    assert.equal(await exists(files[1].file), true);
    assert.equal(await exists(files[2].file), true);
  });
});

test('caching a tile sweeps expired files off the disk in the background (review P2)', async () => {
  await withCacheDir(async (dir) => {
    const expired = tileFile({ z: 12, x: 1, y: 1 }, dir);
    const fresh = tileFile({ z: 12, x: 2, y: 2 }, dir);
    await writeAged(expired, Buffer.alloc(100, 1), 30 * HOUR);
    await writeAged(fresh, Buffer.alloc(100, 2), HOUR);
    await withUpstream(
      () => new Response(tile([{ name: 'sequence' }]), { status: 200 }),
      async () => {
        const address = { layer: 'coverage', z: 14, x: 4, y: 4 };
        assert.equal((await fetchTile(address)).source, 'upstream');
        await waitFor(() => exists(tileFile(address, dir)), 'the tile write');
        await waitFor(async () => !(await exists(expired)), 'the sweep');
        assert.equal(await exists(fresh), true);
      },
    );
  });
});

/**
 * A deferred upstream for in-flight tests: every fetch waits until released,
 * and records whether its signal was aborted. Their disk files are removed
 * first.
 */
async function withDeferredUpstream(tiles, run) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.MAPILLARY_CLIENT_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = 'MLY|test|token';
  _resetTileMemoryForTest();
  for (const tile of tiles) await fsp.rm(tileFile(tile), { force: true });
  const body = (() => {
    const writer = new PbfWriter();
    writer.writeMessage(
      3,
      (layer, pbf) => {
        pbf.writeVarintField(15, 2);
        pbf.writeStringField(1, layer.name);
      },
      { name: 'sequence' },
    );
    return Buffer.from(writer.finish());
  })();
  const upstream = [];
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const call = { url: String(url), signal, aborted: false };
      call.release = () =>
        resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/x-protobuf' },
          }),
        );
      signal?.addEventListener(
        'abort',
        () => {
          call.aborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
      upstream.push(call);
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await run({ upstream, settle, body });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.MAPILLARY_CLIENT_TOKEN;
    else process.env.MAPILLARY_CLIENT_TOKEN = savedToken;
    _resetTileMemoryForTest();
  }
}

test('a joined tile request survives the first caller abandoning it', async () => {
  const tile = { layer: 'coverage', z: 14, x: 1, y: 1 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = new AbortController();
    const second = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await settle();
    const b = fetchTile(tile, { signal: second.signal });
    await settle();
    assert.equal(upstream.length, 1, 'one upstream request for both');
    first.abort();
    await assert.rejects(a, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, false, 'the shared fetch keeps going');
    upstream[0].release();
    const joined = await b;
    assert.equal(joined.source, 'inflight');
    assert.deepEqual(listTileLayers(joined.bytes), ['sequence']);
    assert.equal(upstream.length, 1);
  });
});

test('a joined caller that aborts leaves at once and the first still gets the tile', async () => {
  const tile = { layer: 'coverage', z: 14, x: 2, y: 2 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = new AbortController();
    const second = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await settle();
    const b = fetchTile(tile, { signal: second.signal });
    await settle();
    second.abort();
    await assert.rejects(b, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, false);
    upstream[0].release();
    assert.equal((await a).source, 'upstream');
  });
});

test('the upstream tile fetch is cancelled once every waiter has left', async () => {
  const tile = { layer: 'coverage', z: 14, x: 3, y: 3 };
  await withDeferredUpstream([tile], async ({ upstream, settle }) => {
    const first = new AbortController();
    const second = new AbortController();
    const a = fetchTile(tile, { signal: first.signal });
    await settle();
    const b = fetchTile(tile, { signal: second.signal });
    await settle();
    first.abort();
    await assert.rejects(a, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, false, 'one waiter is still there');
    second.abort();
    await assert.rejects(b, { name: 'AbortError' });
    assert.equal(upstream[0].aborted, true, 'the last waiter cancels it');
    // A later request for the same tile starts a fresh fetch.
    const again = fetchTile(tile);
    await settle();
    assert.equal(upstream.length, 2);
    upstream[1].release();
    assert.equal((await again).source, 'upstream');
  });
});

// ── Tile trimming (relocated from server/providers/mapillary/trim.test.mjs) ──
/** Build a minimal MVT: layers with a name, a version and one opaque feature. */
function tile(layers) {
  const writer = new PbfWriter();
  for (const { name, payload } of layers) {
    writer.writeMessage(
      3,
      (layer, pbf) => {
        pbf.writeVarintField(15, 2); // version
        pbf.writeStringField(1, layer.name);
        pbf.writeMessage(2, (_f, p) => p.writeVarintField(1, 7), null); // feature
        pbf.writeVarintField(5, 4096); // extent
        if (layer.payload) pbf.writeBytesField(4, layer.payload); // a big key
      },
      { name, payload },
    );
  }
  return Buffer.from(writer.finish());
}

test('dropping a layer keeps the others byte-for-byte', () => {
  const big = Buffer.alloc(50_000, 7);
  const bytes = tile([
    { name: 'sequence' },
    { name: 'image', payload: big },
    { name: 'overview' },
  ]);
  const trimmed = stripTileLayers(bytes, ['image']);
  assert.deepEqual(listTileLayers(trimmed), ['sequence', 'overview']);
  assert.ok(trimmed.length < 200, `trimmed to ${trimmed.length} bytes`);
  assert.deepEqual(trimmed, tile([{ name: 'sequence' }, { name: 'overview' }]));
});

test('a tile without the layer is returned untouched', () => {
  const bytes = tile([{ name: 'sequence' }]);
  assert.equal(stripTileLayers(bytes, ['image']), bytes);
  assert.equal(stripTileLayers(bytes, []), bytes);
  assert.equal(stripTileLayers(Buffer.alloc(0), ['image']).length, 0);
});

test('layer names are read without decoding features', () => {
  assert.deepEqual(listTileLayers(tile([{ name: 'a' }, { name: 'b' }])), [
    'a',
    'b',
  ]);
});
