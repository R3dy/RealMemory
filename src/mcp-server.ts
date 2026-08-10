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
  traverse: z.boolean().optional().default(true),
});

const searchSchema = z.object({
  scope: z.enum(["project", "global", "all"]).optional().default("all"),
  types: z.array(memoryTypeSchema).optional(),
  tags: z.array(z.string()).optional(),
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
  minWeight: z.number().optional(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
});

const getMemorySchema = z.object({
  id: z.string(),
  includeRelationships: z.boolean().optional().default(true),
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
 * Build the array of 8 MCP tool descriptors backed by the given MemoryStore.
 * Each descriptor carries a JSON Schema `inputSchema` and a `handler` that
 * routes the parsed args to the corresponding MemoryStore method.
 */
export function createMcpTools(store: MemoryStore): McpToolHandler[] {
  return [
    {
      name: "store_memory",
      description: "Store a new memory",
      inputSchema: zodToInputSchema(storeMemorySchema),
      handler: async (args) => store.store(storeMemorySchema.parse(args)),
    },
    {
      name: "recall",
      description: "Semantic search for relevant memories",
      inputSchema: zodToInputSchema(recallSchema),
      handler: async (args) => store.recall(recallSchema.parse(args)),
    },
    {
      name: "search",
      description: "Structured search with filters",
      inputSchema: zodToInputSchema(searchSchema),
      handler: async (args) => store.search(searchSchema.parse(args)),
    },
    {
      name: "relate",
      description: "Create a typed relationship between two memories",
      inputSchema: zodToInputSchema(relateSchema),
      handler: async (args) => {
        const p = relateSchema.parse(args);
        return store.relate(p.sourceId, p.targetId, p.type as RelationshipType);
      },
    },
    {
      name: "update_memory",
      description: "Update an existing memory",
      inputSchema: zodToInputSchema(updateMemorySchema),
      handler: async (args) => {
        const p = updateMemorySchema.parse(args);
        return store.update(p.id, p);
      },
    },
    {
      name: "forget",
      description: "Archive or delete a memory",
      inputSchema: zodToInputSchema(forgetSchema),
      handler: async (args) => {
        const p = forgetSchema.parse(args);
        return store.forget(p.id, p.hard);
      },
    },
    {
      name: "list_memories",
      description: "Browse memories with pagination",
      inputSchema: zodToInputSchema(listMemoriesSchema),
      handler: async (args) => store.list(listMemoriesSchema.parse(args)),
    },
    {
      name: "get_memory",
      description: "Get a single memory by ID",
      inputSchema: zodToInputSchema(getMemorySchema),
      handler: async (args) => {
        const p = getMemorySchema.parse(args);
        return store.get(p.id, p.includeRelationships);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

const SERVER_NAME = "realmemory";
const SERVER_VERSION = "0.3.0";

/**
 * Start the realmemory MCP server on stdio. Loads config (or accepts an
 * explicit config), initialises a MemoryStore, registers the 8 tool handlers,
 * and connects via the StdioServerTransport. Resolves once connected.
 */
export async function startMcpServer(config?: MemoryStoreConfig): Promise<void> {
  const mergedConfig = config ?? loadConfig();

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

  // The MCP server is now the sole closer of both servers and the store.
  // Registering a SIGINT/SIGTERM listener removes Node's default termination,
  // and the StdioServerTransport's stdin reader keeps the event loop alive —
  // without an explicit exit the process would hang holding the SQLite WAL
  // handle (ADR-007: "a UI-side concern must never crash the MCP server").
  // process.exit(0) closes that loophole deterministically.
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
