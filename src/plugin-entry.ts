import realmemoryPlugin from "./plugin";

/**
 * OpenCode plugin module entry point.
 *
 * OpenCode's plugin loader (PluginLoader in packages/opencode/src/plugin)
 * resolves the `exports["./server"]` subpath from package.json, imports the
 * module, and reads the default export as a `PluginModule`:
 *
 *   { id: string; server: Plugin; tui?: never }
 *
 * CRITICAL: for file/path plugins (loaded via a local directory path in
 * opencode.json `plugin` array, not via npm package name), the loader
 * REQUIRES `id` to be present in the default export — there is no fallback
 * to `package.json` `name` for file plugins (unlike npm plugins). Missing
 * `id` produces: `Path plugin file:///... must export id`.
 *
 * @see {@link https://github.com/sst/opencode/blob/dev/packages/opencode/src/plugin/shared.ts OpenCode plugin loader source}
 * @see {@link docs/adr/ADR-009-plugin-entrypoint-and-distribution.md ADR-009}
 */
const pluginModule = {
  id: "realmemory",
  server: realmemoryPlugin,
};

export default pluginModule;
