/**
 * The globe panel: an MCP Apps view (`io.modelcontextprotocol/ui`) that shows
 * God's Eye View inside a conversation. The panel is a small page that loads
 * the app in embed mode and sends it each view the show_on_globe tool
 * returns; see docs/TOOLS.md.
 */

export const GLOBE_PANEL_URI = 'ui://gods-eye-view/globe';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
const PANEL_HEIGHT_PX = 520;

/**
 * The panel page. It completes the MCP Apps handshake with its host, then
 * for each tool result that carries a view: loads the app at that view in
 * embed mode the first time, and afterwards posts the view to the loaded app
 * so the globe changes without reloading.
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
  #globe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  #open { position: absolute; right: 10px; top: 10px; z-index: 1; padding: 6px 10px; border: 1px solid #3a4a55;
    border-radius: 6px; background: rgba(5, 7, 10, 0.75); color: #dfe8ee; font: inherit; cursor: pointer; }
  #open[hidden] { display: none; }
</style>
</head>
<body>
<div id="status">Waiting for a view of the globe…</div>
<button id="open" type="button" hidden>Open in God's Eye View</button>
<script>
(() => {
  const APP_ORIGIN = ${JSON.stringify(appOrigin)};
  const status = document.getElementById('status');
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

  let frame = null;
  let frameReady = false;
  let queued = null;
  let currentUrl = null;

  const embedUrl = (url) => {
    const target = new URL(url);
    target.searchParams.set('embed', '1');
    return target.href;
  };
  const postView = (view) =>
    frame.contentWindow.postMessage(
      { type: 'gev:view', id: nextId++, view },
      APP_ORIGIN,
    );

  function show(result) {
    const data = result && result.structuredContent;
    const view = data && data.view;
    const url = (data && data.url) || (view && view.url);
    if (!view || !url || new URL(url).origin !== APP_ORIGIN) return;
    currentUrl = url;
    open.hidden = false;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'globe';
      frame.title = "God's Eye View";
      frame.allow = 'fullscreen';
      frame.src = embedUrl(url);
      document.body.appendChild(frame);
      status.textContent = 'Loading the globe…';
      return;
    }
    if (frameReady) postView(view);
    else queued = view;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (frame && event.source === frame.contentWindow) {
      if (message && message.type === 'gev:ready') {
        frameReady = true;
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

  request('ui/initialize', {
    protocolVersion: ${JSON.stringify(MCP_APPS_PROTOCOL_VERSION)},
    clientInfo: { name: 'gods-eye-view-globe', version: '1' },
    capabilities: {},
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
  }).then(() => {
    notify('ui/notifications/initialized', {});
    notify('ui/notifications/size-changed', {
      width: document.body.clientWidth,
      height: ${PANEL_HEIGHT_PX},
    });
  });
})();
</script>
</body>
</html>
`;
}

/**
 * The panel as an MCP resource for an app served at `appUrl`. Only that
 * origin may be framed inside the panel.
 */
export function createGlobePanelResource({ appUrl }) {
  const appOrigin = new URL(appUrl).origin;
  return Object.freeze({
    uri: GLOBE_PANEL_URI,
    name: 'globe',
    title: "God's Eye View globe",
    description: 'The live globe, showing the view a tool returns.',
    mimeType: MCP_APP_MIME_TYPE,
    text: panelHtml(appOrigin),
    _meta: {
      ui: { csp: { frameDomains: [appOrigin] }, prefersBorder: true },
    },
  });
}
