/**
 * The MCP Apps panel build. A panel loads the app through its MCP server,
 * one tool call per file (see src/tools/globePanel.js), so the app must be
 * few files: one app script, one stylesheet, Cesium's own script, and
 * Cesium's workers combined into one script that Cesium runs from memory.
 * The build is served at PANEL_BASE next to the app.
 */

// The panel loads these paths (src/tools/globePanel.js); a test keeps the
// two in step.
export const PANEL_BASE = '/panel/';
/** Cesium's workers as one script, relative to the panel build. */
export const PANEL_WORKERS_PATH = 'cesium/workers.js';
export const PANEL_OUT_DIR = 'dist/panel';

/** A browser Vite config changed to produce the panel build. */
export function panelBuildConfig(config) {
  return {
    ...config,
    base: PANEL_BASE,
    build: {
      ...config.build,
      outDir: PANEL_OUT_DIR,
      emptyOutDir: true,
      modulePreload: false,
      cssCodeSplit: false,
      rollupOptions: {
        ...config.build?.rollupOptions,
        output: { inlineDynamicImports: true },
      },
    },
  };
}

/**
 * Source for Cesium's `CESIUM_WORKERS` script: every worker module, each
 * evaluated only when Cesium starts that worker. `workerNames` are the
 * module names in Cesium's Workers directory, without `.js`.
 */
export function workersEntrySource(workerNames, workersDir) {
  const entries = workerNames.map(
    (name) =>
      `  ${JSON.stringify(name)}: () => import(${JSON.stringify(`${workersDir}/${name}.js`)}),`,
  );
  return `self.CesiumWorkers = {\n${entries.join('\n')}\n};\n`;
}

const CONTENT_TYPES = {
  '.css': 'text/css',
  '.geojsonl': 'application/geo+json-seq',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

/**
 * Vite plugin serving the panel build at PANEL_BASE on the dev server, as
 * the preview server and production builds serve it from the build output.
 */
export function panelBuildPlugin({ outDir = PANEL_OUT_DIR } = {}) {
  return {
    name: 'panel-build',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const { pathname } = new URL(req.url || '/', 'http://localhost');
        if (!pathname.startsWith(PANEL_BASE)) return next();
        const { readFile } = await import('node:fs/promises');
        const { extname, resolve, sep } = await import('node:path');
        const root = resolve(server.config.root, outDir);
        let relative;
        try {
          relative = decodeURIComponent(pathname.slice(PANEL_BASE.length));
        } catch {
          res.statusCode = 400;
          res.end('Bad path');
          return;
        }
        const file = resolve(root, relative || 'index.html');
        if (file !== root && !file.startsWith(root + sep)) return next();
        try {
          const body = await readFile(file);
          res.setHeader(
            'Content-Type',
            CONTENT_TYPES[extname(file)] || 'application/octet-stream',
          );
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end(
            relative ? 'Not found' : 'No panel build; run npm run build:panel',
          );
        }
      });
    },
  };
}
