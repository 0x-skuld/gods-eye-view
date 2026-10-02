/**
 * The God's Eye View panel's requests. A panel cannot reach the app's server
 * itself: hosts serve panels from their own sites and may refuse other
 * addresses, such as a server on the user's machine. The panel asks this
 * tool instead, which only an app may call, and it requests the path from
 * the app's server. Large responses come back in parts.
 */

import { defineTool, ToolError } from '../catalog.js';

/** Bytes of response body per call, before base64. */
export const PANEL_PART_BYTES = 512 * 1024;
const HELD_MS = 2 * 60 * 1000;
const HELD_LIMIT_BYTES = 256 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
// Provider Settings write the app's keys; only the app's own page may.
const REFUSED_PATHS = [/^\/api\/setup(?:\/|$)/];
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type'];
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
]);
// Already compressed, so gzip would only cost time.
const INCOMPRESSIBLE =
  /^(?:image\/(?!svg)|video\/|audio\/|font\/woff2)|zip|compressed/;
const COMPRESS_MIN_BYTES = 1024;

// Bodies too large for one call, kept for the calls that read the rest.
const held = new Map();
let heldBytes = 0;

function base64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function gzip(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function forget(now = Date.now()) {
  for (const [id, entry] of held) {
    if (entry.expires > now && heldBytes <= HELD_LIMIT_BYTES) continue;
    held.delete(id);
    heldBytes -= entry.bytes.length;
  }
}

function part(response, bytes, offset) {
  const end = Math.min(bytes.length, offset + PANEL_PART_BYTES);
  return {
    ...response,
    offset,
    body: base64(bytes.subarray(offset, end)),
    ...(end < bytes.length ? { nextOffset: end } : {}),
  };
}

function checkedPath(path) {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//')
  )
    throw new ToolError('invalid_arguments', 'path must start with one /');
  const { pathname } = new URL(path, 'http://app.invalid');
  if (REFUSED_PATHS.some((pattern) => pattern.test(pathname)))
    throw new ToolError('invalid_arguments', `${pathname} is not available`);
  return path;
}

export const panelRequest = defineTool({
  name: 'panel_request',
  title: "God's Eye View panel request",
  description:
    "Loads a file or data for the God's Eye View panel from the app's " +
    'server. Only the panel calls this; it does not answer questions.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: "A path on the app's server, starting with /.",
      },
      method: { type: 'string', enum: [...METHODS] },
      headers: {
        type: 'object',
        description: 'Request headers; only Accept and Content-Type are sent.',
      },
      body: { type: 'string', description: 'The request body, base64.' },
      id: {
        type: 'string',
        description: 'Continue a response an earlier call returned in parts.',
      },
      offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  requires: ['app'],
  ui: { visibility: ['app'] },
  async run(args, { services, signal }) {
    forget();
    if (args.id !== undefined) {
      const entry = held.get(args.id);
      if (!entry)
        throw new ToolError(
          'invalid_arguments',
          'That response is no longer held; request the path again',
        );
      return {
        summary: `Part of ${entry.path}`,
        data: part(entry.response, entry.bytes, args.offset ?? 0),
      };
    }
    const path = checkedPath(args.path);
    const method = args.method ?? 'GET';
    if (!METHODS.has(method))
      throw new ToolError('invalid_arguments', `Unsupported method ${method}`);
    const headers = {};
    for (const [name, value] of Object.entries(args.headers ?? {})) {
      if (FORWARDED_REQUEST_HEADERS.includes(name.toLowerCase()))
        headers[name] = String(value);
    }
    let answer;
    try {
      answer = await services.app.fetch(path, {
        method,
        headers,
        ...(args.body !== undefined && method === 'POST'
          ? { body: fromBase64(args.body) }
          : {}),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ToolError('unavailable', "The app's server did not answer");
    }
    let bytes = new Uint8Array(await answer.arrayBuffer());
    const type = answer.headers.get('content-type') || '';
    let encoding = 'identity';
    if (bytes.length >= COMPRESS_MIN_BYTES && !INCOMPRESSIBLE.test(type)) {
      bytes = await gzip(bytes);
      encoding = 'gzip';
    }
    const responseHeaders = {};
    answer.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders[name] = value;
    });
    const response = {
      status: answer.status,
      statusText: answer.statusText,
      headers: responseHeaders,
      encoding,
      totalBytes: bytes.length,
    };
    if (bytes.length > PANEL_PART_BYTES) {
      response.id = crypto.randomUUID();
      held.set(response.id, {
        path,
        response,
        bytes,
        expires: Date.now() + HELD_MS,
      });
      heldBytes += bytes.length;
    }
    return {
      summary: `${answer.status} ${method} ${path}`,
      data: part(response, bytes, 0),
    };
  },
});
