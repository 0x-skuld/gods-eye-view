#!/usr/bin/env node
/**
 * Build the MCP Apps panel: the app under dist/panel, served at /panel/.
 * See build/panel.js.
 */

import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build } from 'vite';
import standaloneConfig from '../server/standalone/vite.config.js';
import {
  PANEL_BASE,
  PANEL_OUT_DIR,
  PANEL_WORKER_FILES,
  PANEL_WORKERS_PATH,
  panelBuildConfig,
  workerFilesPrelude,
  workersEntrySource,
} from '../build/panel.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(root, PANEL_OUT_DIR);
const cesiumWorkers = join(root, 'node_modules/cesium/Build/Cesium/Workers');

const config = standaloneConfig({ command: 'build', mode: 'production' });
await build({
  configFile: false,
  root,
  ...panelBuildConfig(config),
});

// Cesium's plugin copies its files under the base path inside outDir.
const nested = join(outDir, PANEL_BASE, 'cesium');
await rm(join(outDir, 'cesium'), { recursive: true, force: true });
await rename(nested, join(outDir, 'cesium'));
await rm(join(outDir, PANEL_BASE.split('/')[1]), { recursive: true });

const names = (await readdir(cesiumWorkers))
  .filter((file) => file.endsWith('.js') && !file.startsWith('chunk-'))
  .map((file) => file.slice(0, -3));
const entry = join(outDir, 'cesium', 'workers-entry.js');
await writeFile(entry, workersEntrySource(names, cesiumWorkers));
await esbuild({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile: join(outDir, PANEL_WORKERS_PATH),
  logLevel: 'warning',
});
await rm(entry);
const files = {};
for (const name of PANEL_WORKER_FILES)
  files[name] = await readFile(join(outDir, 'cesium', name), 'utf8');
const workers = join(outDir, PANEL_WORKERS_PATH);
await writeFile(
  workers,
  workerFilesPrelude(files) + (await readFile(workers, 'utf8')),
);
console.log(`Panel build written to ${PANEL_OUT_DIR}`);
