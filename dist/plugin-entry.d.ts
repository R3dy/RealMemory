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
 * OpenCode's plugin loader reads the default export of the module resolved
 * from `package.json` `exports["./server"]` and expects a `PluginModule`
 * shape: `{ id?: string; server: Plugin }`. This wrapper re-exports the
 * plugin function in that shape without modifying `src/plugin.ts` (whose
 * default export remains the bare `Plugin` function for direct test imports).
 *
 * @see {@link https://github.com/R3dy/RealMemory/docs/adr/ADR-009-plugin-entrypoint-and-distribution.md ADR-009}
 */
declare const pluginModule: {
    server: typeof realmemoryPlugin;
};

export { pluginModule as default };
