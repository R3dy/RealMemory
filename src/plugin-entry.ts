import realmemoryPlugin from "./plugin";

/**
 * OpenCode plugin module entry point.
 *
 * OpenCode's plugin loader reads the default export of the module resolved
 * from `package.json` `exports["./server"]` and expects a `PluginModule`
 * shape: `{ id?: string; server: Plugin }`. This wrapper re-exports the
 * plugin function in that shape without modifying `src/plugin.ts` (whose
 * default export remains the bare `Plugin` function for direct test imports).
 *
 * @see {@link https://github.com/R3dy/RealMemory/docs/adr/ADR-009-plugin-entrypoint-and-distribution.md ADR-009}
 */
const pluginModule = { server: realmemoryPlugin };

export default pluginModule;
