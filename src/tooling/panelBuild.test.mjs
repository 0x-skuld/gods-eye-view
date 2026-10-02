import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as PANEL_PATHS from '../tools/globePanel.js';
import {
  PANEL_BASE,
  PANEL_WORKERS_PATH,
  panelBuildConfig,
  panelBuildPlugin,
  workersEntrySource,
} from '../../build/panel.js';

test('the panel loads the paths the panel build writes', () => {
  assert.equal(PANEL_BASE, PANEL_PATHS.PANEL_BASE);
  assert.equal(PANEL_WORKERS_PATH, PANEL_PATHS.PANEL_WORKERS_PATH);
});

test('the panel build is one script and one stylesheet under /panel/', () => {
  const config = panelBuildConfig({
    plugins: [],
    build: { chunkSizeWarningLimit: 1500 },
  });
  assert.equal(config.base, PANEL_BASE);
  assert.equal(config.build.outDir, 'dist/panel');
  assert.equal(config.build.cssCodeSplit, false);
  assert.equal(config.build.rollupOptions.output.inlineDynamicImports, true);
  assert.equal(config.build.chunkSizeWarningLimit, 1500);
});

test("Cesium's workers load lazily from one script", () => {
  const source = workersEntrySource(['createGeometry', 'decodeDraco'], '/w');
  assert.match(source, /^self\.CesiumWorkers = \{/);
  assert.match(
    source,
    /"createGeometry": \(\) => import\("\/w\/createGeometry\.js"\)/,
  );
  assert.match(
    source,
    /"decodeDraco": \(\) => import\("\/w\/decodeDraco\.js"\)/,
  );
});

test('the dev server serves the panel build and nothing outside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-build-'));
  try {
    await mkdir(join(root, 'out', 'assets'), { recursive: true });
    await writeFile(join(root, 'out', 'index.html'), '<p>panel</p>');
    await writeFile(join(root, 'out', 'assets', 'a.js'), 'x');
    await writeFile(join(root, 'secret.txt'), 'secret');
    let middleware;
    panelBuildPlugin({ outDir: 'out' }).configureServer({
      config: { root },
      middlewares: { use: (fn) => (middleware = fn) },
    });
    const get = (url) =>
      new Promise((resolve) => {
        const res = {
          statusCode: 200,
          headers: {},
          setHeader(name, value) {
            this.headers[name] = value;
          },
          end(body) {
            resolve({ status: this.statusCode, headers: this.headers, body });
          },
        };
        middleware({ url }, res, () => resolve({ passed: true }));
      });
    const page = await get('/panel/');
    assert.equal(String(page.body), '<p>panel</p>');
    assert.equal(page.headers['Content-Type'], 'text/html');
    const script = await get('/panel/assets/a.js');
    assert.equal(script.headers['Content-Type'], 'text/javascript');
    assert.equal((await get('/panel/missing.js')).status, 404);
    assert.deepEqual(await get('/panel/..%2Fsecret.txt'), { passed: true });
    assert.deepEqual(await get('/other'), { passed: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
