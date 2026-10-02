/**
 * The God's Eye View panel: an MCP Apps view (`io.modelcontextprotocol/ui`) that shows
 * God's Eye View inside a conversation. The panel is a small page that runs
 * the app inside itself in embed mode and sends it each view the
 * show_in_gods_eye_view tool returns; see docs/TOOLS.md.
 */

export const GLOBE_PANEL_URI = 'ui://gods-eye-view/globe';

/**
 * Sites the app's browser code loads from directly: map imagery, 3D tiles,
 * terrain and fonts. Everything else goes through the app's own server.
 */
const PROVIDER_ORIGINS = Object.freeze([
  'https://tile.googleapis.com',
  'https://maps.googleapis.com',
  'https://api.cesium.com',
  'https://assets.ion.cesium.com',
  'https://assets.cesium.com',
  'https://dev.virtualearth.net',
  'https://ecn.t0.tiles.virtualearth.net',
  'https://ecn.t1.tiles.virtualearth.net',
  'https://ecn.t2.tiles.virtualearth.net',
  'https://ecn.t3.tiles.virtualearth.net',
  'https://services.arcgisonline.com',
  'https://server.arcgisonline.com',
  'https://tile.openstreetmap.org',
  'https://tiles.openfreemap.org',
  'https://gibs.earthdata.nasa.gov',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
]);

/** The WebSocket origin matching an http(s) origin, for live-reload. */
const socketOrigin = (origin) => origin.replace(/^http/, 'ws');
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const PANEL_HEIGHT_PX = 520;

/**
 * The panel page. It completes the MCP Apps handshake with its host, then
 * for each tool result that carries a view: loads the app in embed mode the
 * first time, and posts the view to the app once it is ready, so later views
 * change the globe without reloading.
 */
function panelHtml(appOrigin) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>God's Eye View</title>
<style>
  html, body { margin: 0; height: ${PANEL_HEIGHT_PX}px; background: #05070a; color: #b8c4cc;
    font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
  #status { position: absolute; inset: 0; z-index: 10000; display: flex; align-items: center;
    justify-content: center; }
  #open { position: absolute; right: 10px; top: 10px; z-index: 10001; padding: 6px 10px; border: 1px solid #3a4a55;
    border-radius: 6px; background: rgba(5, 7, 10, 0.75); color: #dfe8ee; font: inherit; cursor: pointer; }
  #open[hidden] { display: none; }
</style>
</head>
<body>
<div id="status">Waiting for a view…</div>
<button id="open" type="button" hidden>Open in God's Eye View</button>
<script>
(() => {
  const APP_ORIGIN = ${JSON.stringify(appOrigin)};
  const LOAD_TIMEOUT_MS = 20000;
  const status = document.getElementById('status');
  // When the host's security policy blocks part of the panel, say what was
  // blocked; otherwise a refused frame only shows as a load that never ends.
  let blocked = null;
  document.addEventListener('securitypolicyviolation', (event) => {
    blocked = event.effectiveDirective + ' blocked ' + (event.blockedURI || 'a resource');
    if (status.isConnected)
      status.textContent = "God's Eye View could not load here: " + blocked + '.';
  });
  const open = document.getElementById('open');
  let nextId = 1;
  const pending = new Map();
  const send = (message) =>
    window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  let started = false;
  let ready = false;
  let queued = null;
  let currentUrl = null;

  const postView = (view) =>
    window.postMessage({ type: 'gev:view', id: nextId++, view }, '*');

  /**
   * Load God's Eye View into this page. Hosts may not frame other sites, so
   * the panel runs the app itself: relative addresses resolve to the app's
   * server through <base>, the app's styles and markup are copied in, and
   * its scripts run here with the app in inline embed mode.
   */
  async function startApp() {
    window.GEV_EMBED_INLINE = true;
    const base = document.createElement('base');
    base.href = APP_ORIGIN + '/';
    document.head.prepend(base);
    const response = await fetch(APP_ORIGIN + '/?embed=1');
    if (!response.ok) throw new Error('the app answered ' + response.status);
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    for (const node of page.head.querySelectorAll('link[rel="stylesheet"], style'))
      document.head.appendChild(document.importNode(node, true));
    for (const node of [...page.body.childNodes]) {
      if (node.nodeName !== 'SCRIPT')
        document.body.insertBefore(document.importNode(node, true), status);
    }
    for (const original of page.querySelectorAll('script')) {
      const script = document.createElement('script');
      if (original.type) script.type = original.type;
      if (original.getAttribute('src'))
        script.src = new URL(original.getAttribute('src'), base.href).href;
      else script.textContent = original.textContent;
      document.body.appendChild(script);
    }
  }

  function show(result) {
    const data = result && result.structuredContent;
    const view = data && data.view;
    const url = (data && data.url) || (view && view.url);
    if (!view || !url || new URL(url).origin !== APP_ORIGIN) return;
    currentUrl = url;
    open.hidden = false;
    if (ready) return postView(view);
    queued = view;
    if (started) return;
    started = true;
    status.textContent = "Loading God's Eye View…";
    startApp().catch((error) => {
      status.textContent =
        "God's Eye View could not load here: " + (error && error.message) + '.';
    });
    // Say so, rather than wait forever, when the app cannot load here.
    setTimeout(() => {
      if (!ready)
        status.textContent =
          "God's Eye View did not load here" +
          (blocked ? ' (' + blocked + ')' : '') +
          ". Use Open in God's Eye View above.";
    }, LOAD_TIMEOUT_MS);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source === window) {
      if (message && message.type === 'gev:ready') {
        ready = true;
        status.remove();
        if (queued) postView(queued);
        queued = null;
      }
      return;
    }
    if (event.source !== window.parent || !message || message.jsonrpc !== '2.0')
      return;
    if (message.id !== undefined && pending.has(message.id) && !message.method) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(message.error);
      else resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') show(message.params);
  });

  open.addEventListener('click', () => {
    if (!currentUrl) return;
    request('ui/open-link', { url: currentUrl }).catch(() =>
      window.open(currentUrl, '_blank', 'noopener'),
    );
  });

  // The handshake the MCP Apps SDK's App.connect performs: hosts validate
  // these parameters, and keep a view hidden until it is initialized.
  request('ui/initialize', {
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    appInfo: { name: 'gods-eye-view', title: "God's Eye View", version: '1.0.0' },
    protocolVersion: ${JSON.stringify(MCP_APPS_PROTOCOL_VERSION)},
  }).then(() => {
    send({ method: 'ui/notifications/initialized' });
    notify('ui/notifications/size-changed', {
      width: document.body.clientWidth,
      height: ${PANEL_HEIGHT_PX},
    });
  }, (error) => {
    status.textContent =
      "This client did not accept the God's Eye View panel" +
      (error && error.message ? ': ' + error.message : '.');
  });
})();
</script>
</body>
</html>
`;
}

/**
 * The panel as an MCP resource for an app served at `appUrl`. Its security
 * policy lets the panel load the app's code from that origin and reach the
 * map and imagery providers the app uses directly.
 */
export function createGlobePanelResource({ appUrl }) {
  const appOrigin = new URL(appUrl).origin;
  return Object.freeze({
    uri: GLOBE_PANEL_URI,
    name: 'globe',
    title: "God's Eye View globe",
    description: "Live God's Eye View, showing the view a tool returns.",
    mimeType: MCP_APP_MIME_TYPE,
    text: panelHtml(appOrigin),
    _meta: {
      ui: {
        csp: {
          resourceDomains: [appOrigin, ...PROVIDER_ORIGINS],
          connectDomains: [
            appOrigin,
            socketOrigin(appOrigin),
            ...PROVIDER_ORIGINS,
          ],
          baseUriDomains: [appOrigin],
        },
        prefersBorder: true,
      },
    },
  });
}
