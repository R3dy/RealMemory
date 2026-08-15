import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Server as NodeHttpServer } from "node:http";
import { MemoryStore } from "./store";
import { loadConfig } from "./config";
import { startBrowserServer } from "./browser/server";
import type { MemoryStoreConfig, RelationshipType } from "./types";

/**
 * Convert a Zod schema into the JSON Schema object MCP's Tool.inputSchema
 * requires. Zod v4 ships a built-in `z.toJSONSchema`; we strip the `$schema`
 * header key so the payload matches the MCP spec's narrow object shape.
 */
function zodToInputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  // Defensive: if zod produced anything other than an object schema, coerce.
  if (json.type !== "object" || !json.properties) {
    return {
      type: "object" as const,
      properties: {},
      required: [],
    };
  }
  delete json.$schema;
  return json as Tool["inputSchema"];
}

// ---------------------------------------------------------------------------
// Tool input schemas (Zod)
// ---------------------------------------------------------------------------

const memoryTypeSchema = z.enum([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note",
]);

const relationshipTypeSchema = z.enum([
  "reinforces",
  "contradicts",
  "extends",
  "exception_to",
  "derived_from",
]);

const storeMemorySchema = z.object({
  content: z.string().describe("The memory content"),
  type: memoryTypeSchema,
  tags: z.array(z.string()).optional().default([]),
  scope: z.enum(["project", "global"]).optional().default("project"),
  domain: z.string().optional().describe("Primary technology/topic domain (e.g. 'aws', 'testing', 'opencode')"),
  category: z.string().optional().describe("Sub-classification within type (e.g. 'gotcha', 'cost', 'safety', 'process', 'tooling')"),
  source: z.object({
    project: z.string().optional(),
    session: z.string().optional(),
    ref: z.string().optional(),
    refType: z.enum(["issue", "pr", "adr", "file", "commit", "url"]).optional(),
  }).optional().describe("Origin tracking — where this memory came from"),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  relationships: z
    .array(
      z.object({
        targetId: z.string(),
        type: relationshipTypeSchema,
      }),
    )
    .optional()
    .default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

const recallSchema = z.object({
  query: z.string().describe("Natural-language query — what you want to recall"),
  scope: z.enum(["project", "global", "all"]).optional().default("all"),
  limit: z.number().optional().default(5),
  threshold: z.number().min(0).max(1).optional().default(0.3),
  types: z.array(memoryTypeSchema).optional(),
  tags: z.array(z.string()).optional(),
  domain: z.string().optional().describe("Filter by domain (e.g. 'aws', 'testing')"),
  traverse: z.boolean().optional().default(true),
});

const searchSchema = z.object({
  scope: z.enum(["project", "global", "all"]).optional().default("all"),
  types: z.array(memoryTypeSchema).optional(),
  tags: z.array(z.string()).optional(),
  domain: z.string().optional().describe("Filter by domain"),
  category: z.string().optional().describe("Filter by category"),
  minWeight: z.number().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
  sortBy: z.enum(["weight", "created", "updated", "confidence"]).optional().default("weight"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
});

const relateSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  type: relationshipTypeSchema,
});

const updateMemorySchema = z.object({
  id: z.string(),
  content: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  domain: z.string().optional().describe("Update the domain classification"),
  category: z.string().optional().describe("Update the category"),
  source: z.object({
    project: z.string().optional(),
    session: z.string().optional(),
    ref: z.string().optional(),
    refType: z.enum(["issue", "pr", "adr", "file", "commit", "url"]).optional(),
  }).optional().describe("Update the source"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reinforce: z.boolean().optional().default(false),
});

const forgetSchema = z.object({
  id: z.string(),
  hard: z.boolean().optional().default(false),
  cascadeRelationships: z.boolean().optional().default(true),
});

const listMemoriesSchema = z.object({
  scope: z.enum(["project", "global", "all"]).optional().default("all"),
  type: memoryTypeSchema.optional(),
  tag: z.string().optional(),
  domain: z.string().optional().describe("Filter by domain"),
  category: z.string().optional().describe("Filter by category"),
  minWeight: z.number().optional(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
});

const getMemorySchema = z.object({
  id: z.string(),
  includeRelationships: z.boolean().optional().default(true),
});

const getMetricsSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Filter by metric name (e.g. 'recall_hit'). If omitted, returns all metrics."),
  since: z
    .string()
    .optional()
    .describe("Only include metrics recorded at or after this ISO timestamp."),
});

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

/** A single MCP tool descriptor: name, description, JSON-Schema input, and handler. */
export interface McpToolHandler {
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
export function createMcpTools(store: MemoryStore): McpToolHandler[] {
  return [
    {
      name: "store_memory",
      description:
        "Store a new memory. Use when you learn a preference, fact, decision, or lesson worth recalling in future sessions.",
      inputSchema: zodToInputSchema(storeMemorySchema),
      handler: async (args) => store.store(storeMemorySchema.parse(args)),
    },
    {
      name: "recall",
      description:
        "Semantic search for relevant memories. Use at the start of a task to surface prior context, or when you suspect past work is relevant.",
      inputSchema: zodToInputSchema(recallSchema),
      handler: async (args) => store.recall(recallSchema.parse(args)),
    },
    {
      name: "search",
      description:
        "Structured search with filters (scope/type/tags/weight/date). Use when you need a deterministic filtered query, not semantic relevance.",
      inputSchema: zodToInputSchema(searchSchema),
      handler: async (args) => store.search(searchSchema.parse(args)),
    },
    {
      name: "relate",
      description:
        "Create a typed relationship between two memories (reinforces/contradicts/extends/etc). Use when two memories are structurally connected.",
      inputSchema: zodToInputSchema(relateSchema),
      handler: async (args) => {
        const p = relateSchema.parse(args);
        return store.relate(p.sourceId, p.targetId, p.type as RelationshipType);
      },
    },
    {
      name: "update_memory",
      description:
        "Update an existing memory (content, tags, confidence, metadata, reinforce). Use reinforce:true instead of re-storing when you see a near-duplicate.",
      inputSchema: zodToInputSchema(updateMemorySchema),
      handler: async (args) => {
        const p = updateMemorySchema.parse(args);
        return store.update(p.id, p);
      },
    },
    {
      name: "forget",
      description:
        "Archive or hard-delete a memory. Use when a memory is wrong, stale, or should no longer surface.",
      inputSchema: zodToInputSchema(forgetSchema),
      handler: async (args) => {
        const p = forgetSchema.parse(args);
        return store.forget(p.id, p.hard);
      },
    },
    {
      name: "list_memories",
      description:
        "Browse memories with pagination and filters. Use for a broad overview, not relevance matching.",
      inputSchema: zodToInputSchema(listMemoriesSchema),
      handler: async (args) => store.list(listMemoriesSchema.parse(args)),
    },
    {
      name: "get_memory",
      description:
        "Get a single memory by ID (with relationships). Use when you have a specific ID and want the full record.",
      inputSchema: zodToInputSchema(getMemorySchema),
      handler: async (args) => {
        const p = getMemorySchema.parse(args);
        return store.get(p.id, p.includeRelationships);
      },
    },
    {
      name: "get_metrics",
      description:
        "Query brain-loop metrics (recall_hit_rate, correction_retention, duplicate_rate, memory_bloat_ratio, preference_compliance). Returns per-metric aggregates: count, sum, avg, latest, latest_at.",
      inputSchema: zodToInputSchema(getMetricsSchema),
      handler: async (args) => {
        const p = getMetricsSchema.parse(args);
        return store.getMetricSummary(p.name, p.since);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

const SERVER_NAME = "realmemory";
const SERVER_VERSION = "0.11.0";

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
export interface StartMcpServerOptions {
  ownLifecycle?: boolean;
}

export async function startMcpServer(
  config?: MemoryStoreConfig,
  opts?: StartMcpServerOptions,
): Promise<void> {
  const mergedConfig = config ?? loadConfig();
  const ownLifecycle = opts?.ownLifecycle ?? false;

  const store = new MemoryStore(mergedConfig);
  await store.init();

  const tools = createMcpTools(store);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // tools/list → static catalogue.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })) satisfies Tool[],
  }));

  // tools/call → route to the matching handler.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Error: unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler(args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // New in v0.3.0 (ADR-007): auto-start the read-only graph browser as a
  // side channel in THIS process, sharing the single MemoryStore instance.
  // stdio stays reserved for the MCP JSON-RPC transport (the browser logs to
  // stderr only); HTTP on TCP 127.0.0.1:9333 never touches stdio. Default-on,
  // defeatable via `autoStartBrowser: false` config or `--no-browser`.
  // Best-effort: any failure (port collision, missing asset) logs once to
  // stderr and continues — a UI-side concern must never fail the MCP server.
  // The port is the existing default (bin.ts parseArgs, ADR-006); a
  // `browserPort` config knob is a later increment (issue-12 PARKING_LOT).
  let browserServer: NodeHttpServer | undefined;
  if (mergedConfig.autoStartBrowser !== false) {
    try {
      browserServer = startBrowserServer(store, {
        port: 9333,
        ownLifecycle: false, // the MCP server owns the lifecycle and the shared store
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[realmemory] browser side channel failed to start:", err);
    }
  }

  // The MCP server is the sole closer of both servers and the store — but
  // ONLY when this function owns the process lifecycle (bin.ts CLI entry).
  // Registering a SIGINT/SIGTERM listener removes Node's default termination,
  // and the StdioServerTransport's stdin reader keeps the event loop alive —
  // without an explicit exit the process would hang holding the SQLite WAL
  // handle (ADR-007: "a UI-side concern must never crash the MCP server").
  // process.exit(0) closes that loophole deterministically. Library/test
  // callers (ownLifecycle: false) never install process handlers — the host
  // owns cleanup, and a vitest worker must not be process.exit'd under it.
  if (ownLifecycle) {
    const shutdown = async (): Promise<void> => {
      try {
        browserServer?.close();
      } catch {
        // best-effort
      }
      try {
        await store.close();
      } catch {
        // best-effort
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }
}
