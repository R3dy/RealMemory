import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { M as MemoryStore } from './store--7_59FoP.js';
import { MemoryStoreConfig } from './types.js';

/** A single MCP tool descriptor: name, description, JSON-Schema input, and handler. */
interface McpToolHandler {
    name: string;
    description: string;
    inputSchema: Tool["inputSchema"];
    /** Invoke the tool. Returns JSON-serializable content. Throws on error. */
    handler: (args: Record<string, unknown>) => Promise<unknown>;
}
/**
 * Build the array of 9 MCP tool descriptors backed by the given MemoryStore.
 * Each descriptor carries a JSON Schema `inputSchema` and a `handler` that
 * routes the parsed args to the corresponding MemoryStore method.
 */
declare function createMcpTools(store: MemoryStore): McpToolHandler[];
/**
 * Start the realmemory MCP server on stdio. Loads config (or accepts an
 * explicit config), initialises a MemoryStore, registers the 9 tool handlers,
 * and connects via the StdioServerTransport. Resolves once connected.
 *
 * `ownLifecycle` (default `false`) controls whether THIS function installs
 * process-level SIGINT/SIGTERM handlers + `process.exit(0)` on shutdown. A
 * library function must not install process signal handlers or call
 * `process.exit` — that is the host's job. Only the CLI entry (`bin.ts`, which
 * owns the process) passes `ownLifecycle: true`. In-process callers (tests,
 * plugin hosts, programmatic library use) get the default `false` and manage
 * cleanup themselves. Mirrors the browser server's `ownLifecycle` option.
 */
interface StartMcpServerOptions {
    ownLifecycle?: boolean;
}
declare function startMcpServer(config?: MemoryStoreConfig, opts?: StartMcpServerOptions): Promise<void>;

export { type McpToolHandler, type StartMcpServerOptions, createMcpTools, startMcpServer };
