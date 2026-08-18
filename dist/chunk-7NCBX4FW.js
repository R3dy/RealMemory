import {
  MemoryStore,
  loadConfig
} from "./chunk-K6MQZMEO.js";

// src/mcp-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// src/browser/server.ts
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join, normalize, extname } from "path";
import { readFileSync, existsSync } from "fs";
var DEFAULT_GRAPH_LIMIT = 500;
var MAX_GRAPH_LIMIT = 2e3;
var MEMORY_TYPES = /* @__PURE__ */ new Set([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note"
]);
function getUiDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Built package: dist/browser/static/ui/ (server bundled into dist/bin.js).
    join(here, "browser", "static", "ui"),
    // Dev: src/browser/server.ts -> src/browser/static/ui/.
    join(here, "static", "ui"),
    // Dev fallback: relative to cwd.
    join(process.cwd(), "src", "browser", "static", "ui")
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  throw new Error(
    "realmemory: built UI not found. Run `npm run build:ui` (or `npm run build`) to build the React UI into src/browser/static/ui/."
  );
}
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}
var MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8"
};
function mimeFor(filename) {
  return MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
function startBrowserServer(store, opts) {
  const uiDir = getUiDir();
  const ownLifecycle = opts.ownLifecycle ?? true;
  const server = createServer((req, res) => {
    handleRequest(req, res, store, uiDir).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    });
  });
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `[realmemory] browser port ${opts.port} in use; skipping auto-start (use --no-browser to silence)`
      );
      return;
    }
    console.error(`[realmemory] browser server error on port ${opts.port}:`, err);
  });
  server.listen(opts.port, "127.0.0.1", () => {
    console.error(`[realmemory] UI server listening on http://127.0.0.1:${opts.port}`);
  });
  if (ownLifecycle) {
    const shutdown = () => {
      server.close();
      void store.close();
      console.error("[realmemory] UI server stopped");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
  return server;
}
async function handleRequest(req, res, store, uiDir) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Content-Length": 0 });
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  if (pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/version") {
    sendJson(res, 200, { version: "0.14.0" });
    return;
  }
  if (pathname === "/api/stats") {
    const stats = await store.getStats();
    sendJson(res, 200, stats);
    return;
  }
  if (pathname === "/api/domains") {
    await handleDomains(res, store);
    return;
  }
  if (pathname === "/api/graph") {
    await handleGraph(url, res, store);
    return;
  }
  if (pathname === "/api/metrics") {
    const name = url.searchParams.get("name") ?? void 0;
    const since = url.searchParams.get("since") ?? void 0;
    const summary = await store.getMetricSummary(name, since);
    sendJson(res, 200, summary);
    return;
  }
  const memoryMatch = pathname.match(/^\/api\/memory\/(.+)$/);
  if (memoryMatch) {
    await handleMemory(memoryMatch[1], res, store);
    return;
  }
  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }
  const normalizedPath = normalize(pathname);
  if (normalizedPath.includes("..")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  const uiRootFiles = [
    "/logo.svg",
    "/boot-reactor.svg",
    "/grid-hex.svg",
    "/nebula-bg.png",
    "/favicon.ico"
  ];
  if (uiRootFiles.includes(normalizedPath)) {
    const filePath = join(uiDir, normalizedPath === "/favicon.ico" ? "logo.svg" : normalizedPath.slice(1));
    if (existsSync(filePath)) {
      serveStaticFile(res, filePath);
      return;
    }
  }
  if (normalizedPath.startsWith("/assets/")) {
    const filePath = join(uiDir, normalizedPath.slice(1));
    if (existsSync(filePath)) {
      serveStaticFile(res, filePath);
      return;
    }
  }
  if (normalizedPath === "/") {
    serveStaticFile(res, join(uiDir, "index.html"));
    return;
  }
  serveStaticFile(res, join(uiDir, "index.html"));
}
async function handleGraph(url, res, store) {
  const params = url.searchParams;
  let limit = DEFAULT_GRAPH_LIMIT;
  const limitParam = params.get("limit");
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      sendJson(res, 400, { error: "limit must be a non-negative integer" });
      return;
    }
    if (parsed > MAX_GRAPH_LIMIT) {
      sendJson(res, 400, { error: `limit must be <= ${MAX_GRAPH_LIMIT}` });
      return;
    }
    limit = parsed;
  }
  const scopeRaw = params.get("scope") ?? "all";
  if (scopeRaw !== "all" && scopeRaw !== "project" && scopeRaw !== "global") {
    sendJson(res, 400, { error: "scope must be all | project | global" });
    return;
  }
  const scope = scopeRaw;
  const typesRaw = params.get("type");
  const types = typesRaw ? typesRaw.split(",").filter((t) => MEMORY_TYPES.has(t)) : void 0;
  if (typesRaw && types && types.length === 0) {
    sendJson(res, 200, { nodes: [], edges: [] });
    return;
  }
  const tagsRaw = params.get("tags");
  const tags = tagsRaw ? tagsRaw.split(",").filter((t) => t.length > 0) : void 0;
  const domain = params.get("domain") ?? void 0;
  const category = params.get("category") ?? void 0;
  let minWeight;
  const minWeightRaw = params.get("minWeight");
  if (minWeightRaw !== null) {
    minWeight = Number.parseFloat(minWeightRaw);
    if (Number.isNaN(minWeight)) {
      sendJson(res, 400, { error: "minWeight must be a number" });
      return;
    }
  }
  const createdAfter = params.get("createdAfter") ?? void 0;
  const createdBefore = params.get("createdBefore") ?? void 0;
  const q = params.get("q");
  let nodes;
  if (q && q.trim().length > 0) {
    nodes = await store.searchText(q, limit);
    nodes = applyStructuralFilters(nodes, { scope, types, tags, minWeight, createdAfter, createdBefore, domain, category });
    if (nodes.length > limit) nodes = nodes.slice(0, limit);
  } else {
    const result = await store.search({
      scope,
      types,
      tags,
      domain,
      category,
      minWeight,
      createdAfter,
      createdBefore,
      limit,
      offset: 0,
      sortBy: "weight",
      sortOrder: "desc"
    });
    nodes = result.memories;
  }
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const relationships = await store.getRelationshipsForNodes(nodeIds);
  const edges = relationships.filter((r) => nodeIdSet.has(r.sourceId) && nodeIdSet.has(r.targetId)).map((r) => ({
    id: r.id,
    source: r.sourceId,
    target: r.targetId,
    type: r.type,
    createdAt: r.createdAt
  }));
  sendJson(res, 200, { nodes, edges });
}
function applyStructuralFilters(nodes, f) {
  return nodes.filter((n) => {
    if (f.scope === "global" && n.scope !== "global") return false;
    if (f.scope === "project" && n.scope !== "project") return false;
    if (f.types && f.types.length > 0 && !f.types.includes(n.type)) return false;
    if (f.tags && f.tags.length > 0) {
      if (!f.tags.some((t) => n.tags.includes(t))) return false;
    }
    if (f.domain && n.domain !== f.domain) return false;
    if (f.category && n.category !== f.category) return false;
    if (f.minWeight !== void 0 && n.weight < f.minWeight) return false;
    if (f.createdAfter && n.createdAt < f.createdAfter) return false;
    if (f.createdBefore && n.createdAt > f.createdBefore) return false;
    return true;
  });
}
async function handleDomains(res, store) {
  const result = await store.search({
    scope: "all",
    limit: 2e3,
    offset: 0,
    sortBy: "weight",
    sortOrder: "desc"
  });
  const domainMap = /* @__PURE__ */ new Map();
  for (const m of result.memories) {
    const d = m.domain ?? "uncategorized";
    if (!domainMap.has(d)) domainMap.set(d, { count: 0, types: {}, categories: {} });
    const entry = domainMap.get(d);
    entry.count++;
    entry.types[m.type] = (entry.types[m.type] ?? 0) + 1;
    const cat = m.category ?? "uncategorized";
    entry.categories[cat] = (entry.categories[cat] ?? 0) + 1;
  }
  const domains = Array.from(domainMap.entries()).map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.count - a.count);
  sendJson(res, 200, { domains, total: result.memories.length });
}
async function handleMemory(id, res, store) {
  try {
    const result = await store.get(id, true);
    sendJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found") || message.includes("MemoryNotFoundError")) {
      sendJson(res, 404, { error: `Memory not found: ${id}` });
      return;
    }
    sendJson(res, 500, { error: message });
  }
}
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json)
  });
  res.end(json);
}
function serveStaticFile(res, filePath) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": "public, max-age=86400",
      "Content-Length": content.length
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

// src/mcp-server.ts
function zodToInputSchema(schema) {
  const json = z.toJSONSchema(schema, { io: "input" });
  if (json.type !== "object" || !json.properties) {
    return {
      type: "object",
      properties: {},
      required: []
    };
  }
  delete json.$schema;
  return json;
}
var memoryTypeSchema = z.enum([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note"
]);
var relationshipTypeSchema = z.enum([
  "reinforces",
  "contradicts",
  "extends",
  "exception_to",
  "derived_from"
]);
var storeMemorySchema = z.object({
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
    refType: z.enum(["issue", "pr", "adr", "file", "commit", "url"]).optional()
  }).optional().describe("Origin tracking \u2014 where this memory came from"),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  relationships: z.array(
    z.object({
      targetId: z.string(),
      type: relationshipTypeSchema
    })
  ).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({})
});
var recallSchema = z.object({
  query: z.string().describe("Natural-language query \u2014 what you want to recall"),
  scope: z.enum(["project", "global", "all"]).optional().default("all"),
  limit: z.number().optional().default(5),
  threshold: z.number().min(0).max(1).optional().default(0.3),
  types: z.array(memoryTypeSchema).optional(),
  tags: z.array(z.string()).optional(),
  domain: z.string().optional().describe("Filter by domain (e.g. 'aws', 'testing')"),
  traverse: z.boolean().optional().default(true)
});
var searchSchema = z.object({
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
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc")
});
var relateSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  type: relationshipTypeSchema
});
var updateMemorySchema = z.object({
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
    refType: z.enum(["issue", "pr", "adr", "file", "commit", "url"]).optional()
  }).optional().describe("Update the source"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reinforce: z.boolean().optional().default(false)
});
var forgetSchema = z.object({
  id: z.string(),
  hard: z.boolean().optional().default(false),
  cascadeRelationships: z.boolean().optional().default(true)
});
var listMemoriesSchema = z.object({
  scope: z.enum(["project", "global", "all"]).optional().default("all"),
  type: memoryTypeSchema.optional(),
  tag: z.string().optional(),
  domain: z.string().optional().describe("Filter by domain"),
  category: z.string().optional().describe("Filter by category"),
  minWeight: z.number().optional(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0)
});
var getMemorySchema = z.object({
  id: z.string(),
  includeRelationships: z.boolean().optional().default(true)
});
var getMetricsSchema = z.object({
  name: z.string().optional().describe("Filter by metric name (e.g. 'recall_hit'). If omitted, returns all metrics."),
  since: z.string().optional().describe("Only include metrics recorded at or after this ISO timestamp.")
});
var memoryWhySchema = z.object({
  limit: z.number().optional().default(10).describe("Max number of recent reflex actions to return (default 10).")
});
var memoryRecallSchema = z.object({
  query: z.string().describe("What you want to recall \u2014 natural-language query."),
  limit: z.number().optional().default(5),
  threshold: z.number().min(0).max(1).optional().default(0.3)
});
var memoryNoteSchema = z.object({
  content: z.string().describe("The memory content \u2014 what to remember."),
  type: memoryTypeSchema.optional().default("lesson_learned"),
  tags: z.array(z.string()).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.6)
});
function createMcpTools(store) {
  return [
    {
      name: "store_memory",
      description: "Store a new memory. Use when you learn a preference, fact, decision, or lesson worth recalling in future sessions.",
      inputSchema: zodToInputSchema(storeMemorySchema),
      handler: async (args) => store.store(storeMemorySchema.parse(args))
    },
    {
      name: "recall",
      description: "Semantic search for relevant memories. Use at the start of a task to surface prior context, or when you suspect past work is relevant.",
      inputSchema: zodToInputSchema(recallSchema),
      handler: async (args) => store.recall(recallSchema.parse(args))
    },
    {
      name: "search",
      description: "Structured search with filters (scope/type/tags/weight/date). Use when you need a deterministic filtered query, not semantic relevance.",
      inputSchema: zodToInputSchema(searchSchema),
      handler: async (args) => store.search(searchSchema.parse(args))
    },
    {
      name: "relate",
      description: "Create a typed relationship between two memories (reinforces/contradicts/extends/etc). Use when two memories are structurally connected.",
      inputSchema: zodToInputSchema(relateSchema),
      handler: async (args) => {
        const p = relateSchema.parse(args);
        return store.relate(p.sourceId, p.targetId, p.type);
      }
    },
    {
      name: "update_memory",
      description: "Update an existing memory (content, tags, confidence, metadata, reinforce). Use reinforce:true instead of re-storing when you see a near-duplicate.",
      inputSchema: zodToInputSchema(updateMemorySchema),
      handler: async (args) => {
        const p = updateMemorySchema.parse(args);
        return store.update(p.id, p);
      }
    },
    {
      name: "forget",
      description: "Archive or hard-delete a memory. Use when a memory is wrong, stale, or should no longer surface.",
      inputSchema: zodToInputSchema(forgetSchema),
      handler: async (args) => {
        const p = forgetSchema.parse(args);
        return store.forget(p.id, p.hard);
      }
    },
    {
      name: "list_memories",
      description: "Browse memories with pagination and filters. Use for a broad overview, not relevance matching.",
      inputSchema: zodToInputSchema(listMemoriesSchema),
      handler: async (args) => store.list(listMemoriesSchema.parse(args))
    },
    {
      name: "get_memory",
      description: "Get a single memory by ID (with relationships). Use when you have a specific ID and want the full record.",
      inputSchema: zodToInputSchema(getMemorySchema),
      handler: async (args) => {
        const p = getMemorySchema.parse(args);
        return store.get(p.id, p.includeRelationships);
      }
    },
    {
      name: "get_metrics",
      description: "Query brain-loop metrics (recall_hit_rate, correction_retention, duplicate_rate, memory_bloat_ratio, preference_compliance). Returns per-metric aggregates: count, sum, avg, latest, latest_at.",
      inputSchema: zodToInputSchema(getMetricsSchema),
      handler: async (args) => {
        const p = getMetricsSchema.parse(args);
        return store.getMetricSummary(p.name, p.since);
      }
    },
    // Synthetic-brain Phase 7: native memory tools
    {
      name: "memory_why",
      description: "Introspect on why the memory system recently blocked, rewrote, or warned about a tool call. Returns recent reflex actions (block/rewrite/warn/override) with the source memory IDs, action types, and timestamps. Use this when a tool call was blocked or modified and you want to understand why.",
      inputSchema: zodToInputSchema(memoryWhySchema),
      handler: async (args) => {
        const p = memoryWhySchema.parse(args);
        const prefixes = ["reflex_block:", "reflex_rewrite:", "reflex_fire:", "reflex_override:"];
        const all = [];
        for (const prefix of prefixes) {
          const rows = await store.getRecentMetricsByPrefix(prefix, p.limit);
          all.push(...rows);
        }
        all.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
        return all.slice(0, p.limit).map((r) => {
          const [_, memoryId] = r.metric_name.split(":");
          const action = r.metric_name.split(":")[0].replace("reflex_", "");
          return {
            action,
            memoryId,
            sessionId: r.session_id,
            recordedAt: r.recorded_at
          };
        });
      }
    },
    {
      name: "memory_recall",
      description: "Deliberately search your memory for relevant context. Use when the injected working-memory window wasn't enough and you need to recall something specific from past sessions.",
      inputSchema: zodToInputSchema(memoryRecallSchema),
      handler: async (args) => {
        const p = memoryRecallSchema.parse(args);
        return store.recall({
          query: p.query,
          scope: "all",
          limit: p.limit,
          threshold: p.threshold,
          traverse: true
        });
      }
    },
    {
      name: "memory_note",
      description: 'Explicitly remember something for future sessions. Use when you want to store a lesson, preference, or fact \u2014 "remember this" as a deliberate act.',
      inputSchema: zodToInputSchema(memoryNoteSchema),
      handler: async (args) => {
        const p = memoryNoteSchema.parse(args);
        return store.store({
          content: p.content,
          type: p.type,
          scope: "project",
          confidence: p.confidence,
          tags: p.tags
        });
      }
    }
  ];
}
var SERVER_NAME = "realmemory";
var SERVER_VERSION = "0.13.0";
async function startMcpServer(config, opts) {
  const mergedConfig = config ?? loadConfig();
  const ownLifecycle = opts?.ownLifecycle ?? false;
  const store = new MemoryStore(mergedConfig);
  await store.init();
  const tools = createMcpTools(store);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Error: unknown tool: ${name}` }],
        isError: true
      };
    }
    try {
      const result = await tool.handler(args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true
      };
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  let browserServer;
  if (mergedConfig.autoStartBrowser !== false) {
    try {
      browserServer = startBrowserServer(store, {
        port: 9333,
        ownLifecycle: false
        // the MCP server owns the lifecycle and the shared store
      });
    } catch (err) {
      console.error("[realmemory] browser side channel failed to start:", err);
    }
  }
  if (ownLifecycle) {
    const shutdown = async () => {
      try {
        browserServer?.close();
      } catch {
      }
      try {
        await store.close();
      } catch {
      }
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  }
}

export {
  startBrowserServer,
  createMcpTools,
  startMcpServer
};
