/** The standalone tool catalog for voice, loaded the first time voice needs it. */

let pending = null;

export function loadToolCatalog() {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
  ]).then(
    ([
      { composeCatalog, coreTools, toolsForSurface },
      { createToolServices },
    ]) =>
      composeCatalog({
        tools: toolsForSurface(coreTools, 'voice'),
        services: createToolServices({
          fetchImpl: (...args) => globalThis.fetch(...args),
          appUrl: globalThis.location.origin,
        }),
      }),
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
