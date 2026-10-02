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

  // The panel page lives on the host's site, which serves none of the app.
  // Hosts may refuse <base>, so the app's own addresses (relative ones, and
  // absolute ones on this page's site) are sent to the app's server instead.
  // The page's own site; location.origin is "null" in a srcdoc document.
  const PAGE_ORIGIN = new URL(document.baseURI).origin;
  const toApp = (value) => {
    let url;
    try {
      url = new URL(String(value), document.baseURI);
    } catch {
      return value;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== PAGE_ORIGIN)
      return value;
    return APP_ORIGIN + url.pathname + url.search + url.hash;
  };
  const isRemote = (value) => {
    try {
      return new URL(String(value), document.baseURI).origin === APP_ORIGIN;
    } catch {
      return false;
    }
  };

  function redirectRequests() {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) =>
      nativeFetch.call(
        window,
        input instanceof Request
          ? new Request(toApp(input.url), input)
          : typeof input === 'string' || input instanceof URL
            ? toApp(input)
            : input,
        init,
      );
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      return nativeOpen.call(this, method, toApp(url), ...rest);
    };
    const nativeBeacon = navigator.sendBeacon?.bind(navigator);
    if (nativeBeacon)
      navigator.sendBeacon = (url, data) => nativeBeacon(toApp(url), data);
    for (const [type, attribute] of [
      [HTMLImageElement, 'src'],
      [HTMLMediaElement, 'src'],
      [HTMLSourceElement, 'src'],
      [HTMLLinkElement, 'href'],
    ]) {
      const property = Object.getOwnPropertyDescriptor(type.prototype, attribute);
      Object.defineProperty(type.prototype, attribute, {
        ...property,
        set(value) {
          const target = toApp(value);
          // The app treated the address as its own site; now that it is
          // another site, images must load with CORS or WebGL refuses them.
          if (target !== value && 'crossOrigin' in this && this.crossOrigin === null)
            this.crossOrigin = 'anonymous';
          property.set.call(this, target);
        },
      });
    }
    // Workers must come from this page's site; one on the app's server
    // starts through a small worker here that imports it.
    const NativeWorker = window.Worker;
    window.Worker = function Worker(url, options) {
      const target = toApp(url);
      if (!isRemote(target)) return new NativeWorker(url, options);
      const source =
        options && options.type === 'module'
          ? 'import ' + JSON.stringify(String(target)) + ';'
          : 'importScripts(' + JSON.stringify(String(target)) + ');';
      return new NativeWorker(
        URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
        options,
      );
    };
    window.Worker.prototype = NativeWorker.prototype;
    // Styles the app adds while it runs name images by root-relative url().
    const rewriteStyle = (style) => {
      const text = style.textContent;
      const next = text.replace(/url\\((['"]?)\\//g, 'url($1' + APP_ORIGIN + '/');
      if (next !== text) style.textContent = next;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target.nodeName === 'STYLE' ? [record.target] : [];
        for (const node of [...target, ...record.addedNodes]) {
          if (node.nodeName === 'STYLE') rewriteStyle(node);
          // Markup the app adds as HTML text sets src without the setters.
          if (node.nodeType !== 1) continue;
          for (const element of [node, ...node.querySelectorAll('[src]')]) {
            const value = element.getAttribute('src');
            if (!value || toApp(value) === value) continue;
            if ('crossOrigin' in element && element.crossOrigin === null)
              element.crossOrigin = 'anonymous';
            element.setAttribute('src', toApp(value));
          }
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  /** Point an imported element's own addresses at the app's server. */
  function absolutize(root) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      for (const attribute of ['src', 'href', 'poster']) {
        const value = element.getAttribute(attribute);
        if (value && !value.startsWith('#'))
          element.setAttribute(attribute, new URL(value, APP_ORIGIN + '/').href);
      }
    }
    return root;
  }

  /**
   * Load God's Eye View into this page. Hosts may not frame other sites, so
   * the panel runs the app itself: its requests go to the app's server, its
   * styles and markup are copied in, and its scripts run here with the app
   * in inline embed mode.
   */
  async function startApp() {
    window.GEV_EMBED_INLINE = true;
    redirectRequests();
    const response = await fetch(APP_ORIGIN + '/?embed=1');
    if (!response.ok) throw new Error('the app answered ' + response.status);
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    for (const node of page.head.querySelectorAll('link[rel="stylesheet"], style'))
      document.head.appendChild(absolutize(document.importNode(node, true)));
    for (const node of [...page.body.childNodes]) {
      if (node.nodeName === 'SCRIPT') continue;
      const copy = document.importNode(node, true);
      document.body.insertBefore(copy.nodeType === 1 ? absolutize(copy) : copy, status);
    }
    for (const original of page.querySelectorAll('script')) {
      const script = document.createElement('script');
      if (original.type) script.type = original.type;
      if (original.getAttribute('src'))
        script.src = new URL(original.getAttribute('src'), APP_ORIGIN + '/').href;
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
        },
        prefersBorder: true,
      },
      // The same policy under the key OpenAI's clients read.
      'openai/widgetCSP': {
        connect_domains: [
          appOrigin,
          socketOrigin(appOrigin),
          ...PROVIDER_ORIGINS,
        ],
        resource_domains: [appOrigin, ...PROVIDER_ORIGINS],
      },
    },
  });
}
