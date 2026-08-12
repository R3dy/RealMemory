/** Shape of the OpenCode plugin context object passed to the plugin entry point. */
interface OpenCodePluginContext {
    project: {
        path?: string;
        name?: string;
    } | unknown;
    client: {
        app?: {
            log?: (args: {
                body: {
                    service: string;
                    level: string;
                    message: string;
                    extra?: unknown;
                };
            }) => Promise<void>;
        };
    } | unknown;
    $: unknown;
    directory: string;
    worktree: string;
}
/**
 * OpenCode plugin entry point. Initializes a MemoryStore on first use (with
 * config loaded relative to `ctx.directory` and a project ID derived from it),
 * then returns the hook handlers:
 *   - `event` — auto-recall on `session.created` (staged for injection),
 *     auto-summarize on `session.idle`
 *   - `tool.execute.after` — auto-capture learnings (file reads on config/schema
 *     files become `codebase_fact`s; bash errors become `lesson_learned`s);
 *     fire-and-forget so a slow write never blocks the tool loop
 *   - `chat.message` — auto-recall on user messages, formatted results staged
 *     for injection and deduplicated against memories already delivered this
 *     session; fire-and-forget
 *   - `experimental.chat.system.transform` — the delivery mechanism: appends
 *     the staged recall block to the agent's system prompt and clears it, so
 *     the LLM actually sees the recalled memories
 *
 * @returns the hook handler map OpenCode installs the plugin's handlers from.
 */
declare function realmemoryPlugin(ctx: OpenCodePluginContext): Promise<Record<string, unknown>>;

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
declare const pluginModule: {
    id: string;
    server: typeof realmemoryPlugin;
};

export { pluginModule as default };
