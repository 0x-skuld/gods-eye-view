import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLOBE_PANEL_URI,
  MCP_APP_MIME_TYPE,
  createGlobePanelResource,
} from './globePanel.js';
import { composeCatalog, coreTools } from './index.js';

test('the globe panel is an MCP Apps resource that runs the app inside itself', () => {
  const resource = createGlobePanelResource({
    appUrl: 'http://localhost:5173/some/path',
  });
  assert.equal(resource.uri, GLOBE_PANEL_URI);
  assert.equal(resource.mimeType, MCP_APP_MIME_TYPE);
  assert.equal(MCP_APP_MIME_TYPE, 'text/html;profile=mcp-app');
  const { csp } = resource._meta.ui;
  // Hosts may not let a panel frame other sites, so it declares no frames
  // and instead loads the app's code and data from the app's origin.
  assert.equal(csp.frameDomains, undefined);
  assert.equal(csp.resourceDomains[0], 'http://localhost:5173');
  assert.deepEqual(csp.connectDomains.slice(0, 2), [
    'http://localhost:5173',
    'ws://localhost:5173',
  ]);
  assert.ok(csp.resourceDomains.includes('https://tile.googleapis.com'));
  assert.deepEqual(csp.baseUriDomains, ['http://localhost:5173']);
  assert.match(resource.text, /window\.GEV_EMBED_INLINE = true/);
  assert.match(resource.text, /fetch\(APP_ORIGIN \+ '\/\?embed=1'\)/);
  assert.doesNotMatch(resource.text, /<iframe|createElement\('iframe'\)/);
  assert.match(resource.text, /const APP_ORIGIN = "http:\/\/localhost:5173";/);
  assert.match(resource.text, /'ui\/initialize'/);
  assert.match(resource.text, /'ui\/notifications\/tool-result'/);
  assert.match(resource.text, /protocolVersion: "2026-01-26"/);
  // The MCP Apps SDK's initialize parameters; hosts reject anything else.
  assert.match(resource.text, /appInfo: \{ name: 'gods-eye-view'/);
  assert.doesNotMatch(resource.text, /clientInfo/);
});

test('show_in_gods_eye_view names the panel and shows a view another answer returned', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { app: { baseUrl: 'http://localhost:5173/' } },
  });
  assert.deepEqual(catalog.get('show_in_gods_eye_view').ui, {
    resourceUri: GLOBE_PANEL_URI,
  });
  const earlier = {
    camera: {
      lat: 25,
      lon: 121,
      altitude_m: 300000,
      heading_deg: 0,
      pitch_deg: -90,
    },
    layers: ['ais-live-vessels'],
    style: null,
    map: null,
    follow: null,
    annotations: [],
    url: 'http://localhost:5173/#v=2',
  };
  const shown = await catalog.call('show_in_gods_eye_view', {
    view: earlier,
    layers: ['ais-live-vessels', 'military'],
    style: 'thermal',
  });
  assert.deepEqual(shown.data.view.camera, earlier.camera);
  assert.deepEqual(shown.data.view.layers, ['ais-live-vessels', 'military']);
  assert.equal(shown.data.view.style, 'thermal');
  await assert.rejects(
    catalog.call('show_in_gods_eye_view', { view: { camera: { lat: 'x' } } }),
    (error) => error.code === 'invalid_arguments',
  );
});
