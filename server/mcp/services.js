/**
 * Local composition of tool services: Core's default services, pointed at a
 * running God's Eye View server's `/api` routes.
 */

import { createToolServices } from '../../src/tools/services.js';

export const DEFAULT_API_BASE = 'http://localhost:4173';

/** Resolve the sources' relative `/api/...` requests against `apiBase`. */
export function createApiFetch({
  apiBase = DEFAULT_API_BASE,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const base = new URL(apiBase);
  if (!['http:', 'https:'].includes(base.protocol))
    throw new TypeError(`apiBase must be an http(s) URL: ${apiBase}`);
  return (input, init) =>
    fetchImpl(
      typeof input === 'string' && input.startsWith('/')
        ? new URL(input, base)
        : input,
      init,
    );
}

/** Construct every service Core's tools read, backed by the local server. */
export function createLocalToolServices(options = {}) {
  return createToolServices({
    fetchImpl: createApiFetch(options),
    appUrl: options.apiBase ?? DEFAULT_API_BASE,
  });
}
