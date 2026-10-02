import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { embedFramingPlugin } from './embed-framing.js';

/** Origins allowed to read the dev and preview servers' responses. */
export const PANEL_CORS_ORIGINS = Object.freeze([
  /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/,
  /^https:\/\/[a-z0-9]+\.claudemcpcontent\.com$/,
]);

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  command,
} = {}) {
  return {
    plugins: [
      cesium(),
      applicationHtmlPlugin(),
      ...plugins,
      embedFramingPlugin(),
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from.
    ...(command === 'build' ? { cacheDir: 'node_modules/.vite-build' } : {}),
    optimizeDeps: {
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // Cross-origin reads: local pages, as Vite allows by default, plus the
      // MCP Apps panels that load the app into a conversation (Claude's
      // sandbox origins). Development and preview only.
      cors: { origin: PANEL_CORS_ORIGINS },
      // These headers protect the document containing Provider Settings.
      // Embed-mode documents are framable instead; see embed-framing.js.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
