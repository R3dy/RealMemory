import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { MemoryStore } from "../store";
import type { Memory, Relationship, MemoryType } from "../types";
import { INDEX_HTML } from "./assets";

/**
 * A directed edge in the graph payload, with `source`/`target` naming that
 * matches what vis-network's `DataSet` edges consume.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  createdAt: string;
}

export interface BrowserServerOptions {
  port: number;
  /**
   * When true (default), the browser server owns its process lifecycle: it
   * installs SIGINT/SIGTERM handlers that close the HTTP server and the store,
   * then call process.exit(0) for deterministic termination. Use this for the
   * standalone --ui mode (bin.ts --ui branch).
   *
   * When false, the caller owns the lifecycle and the shared store: no signal
   * handlers are registered, store.close() is NOT called on shutdown, and
   * process.exit() is NOT called. Use this for the side-channel mode inside
   * startMcpServer, where the MCP server closes both the stdio server and the
   * browser HTTP server and closes the store exactly once.
   */
  ownLifecycle?: boolean;
}

const DEFAULT_GRAPH_LIMIT = 500;
const MAX_GRAPH_LIMIT = 2000;

const MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note",
]);

/**
 * Resolve the vendored vis-network bundle. Works in both `src/` (dev, run via
 * tsx) and `dist/` (built) layouts by looking relative to this module's
 * location. Vendored — never an npm `dependency`.
 */
function loadVisNetworkJs(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Built package: dist/browser/static/ (server bundled into dist/bin.js).
    join(here, "browser", "static", "vis-network.min.js"),
    // Dev: src/browser/server.ts -> src/browser/static/.
    join(here, "static", "vis-network.min.js"),
    // Dev fallback: relative to cwd.
    join(process.cwd(), "src", "browser", "static", "vis-network.min.js"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "realmemory: vendored vis-network.min.js not found. Run `npm run build` or ensure src/browser/static/vis-network.min.js exists.",
  );
}

/**
 * Start the localhost-only, read-only HTTP graph browser server. Binds to
 * 127.0.0.1 exclusively (never 0.0.0.0). Only `GET` is handled; all other
 * methods return `405`. All endpoints are read-only — no mutation of the
 * store. Returns the underlying `http.Server` (useful for tests).
 *
 * stdout is reserved for the MCP JSON-RPC stdio transport when this server is
 * run as a side channel inside the MCP server process, so all diagnostics go
 * to stderr (console.error) unconditionally. `ownLifecycle` (default `true`)
 * controls whether the server installs SIGINT/SIGTERM handlers that close the
 * HTTP server and the store, then call process.exit(0). Pass
 * `ownLifecycle: false` when the caller owns the lifecycle and the shared
 * store.
 */
export function startBrowserServer(
  store: MemoryStore,
  opts: BrowserServerOptions,
): Server {
  const visNetworkJs = loadVisNetworkJs();
  const ownLifecycle = opts.ownLifecycle ?? true;

  const server = createServer((req, res) => {
    handleRequest(req, res, store, visNetworkJs).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    });
  });

  // Best-effort port collision (ADR-007): a UI-side concern must never crash
  // the host process. Node delivers listen failures on the Server's "error"
  // event (not the listen callback), so this handler swallows EADDRINUSE with
  // a single stderr line and the server simply never listens. The caller
  // continues without the browser.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(
        `[realmemory] browser port ${opts.port} in use; skipping auto-start (use --no-browser to silence)`,
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[realmemory] browser server error on port ${opts.port}:`, err);
  });

  server.listen(opts.port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.error(`[realmemory] UI server listening on http://127.0.0.1:${opts.port}`);
  });

  if (ownLifecycle) {
    const shutdown = (): void => {
      server.close();
      void store.close();
      // eslint-disable-next-line no-console
      console.error("[realmemory] UI server stopped");
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  visNetworkJs: string,
): Promise<void> {
  // Only GET is allowed — read-only server.
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/") {
    sendHtml(res, 200, INDEX_HTML);
    return;
  }

  if (pathname === "/static/vis-network.min.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(visNetworkJs);
    return;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
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
    const name = url.searchParams.get("name") ?? undefined;
    const since = url.searchParams.get("since") ?? undefined;
    const summary = await store.getMetricSummary(name, since);
    sendJson(res, 200, summary);
    return;
  }

  const memoryMatch = pathname.match(/^\/api\/memory\/(.+)$/);
  if (memoryMatch) {
    await handleMemory(memoryMatch[1], res, store);
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

async function handleGraph(
  url: URL,
  res: ServerResponse,
  store: MemoryStore,
): Promise<void> {
  const params = url.searchParams;

  // Limit with a hard cap.
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

  // Scope filter.
  const scopeRaw = params.get("scope") ?? "all";
  if (scopeRaw !== "all" && scopeRaw !== "project" && scopeRaw !== "global") {
    sendJson(res, 400, { error: "scope must be all | project | global" });
    return;
  }
  const scope = scopeRaw as "all" | "project" | "global";

  // Type filter (comma-separated).
  const typesRaw = params.get("type");
  const types: MemoryType[] | undefined = typesRaw
    ? (typesRaw.split(",").filter((t) => MEMORY_TYPES.has(t as MemoryType)) as MemoryType[])
    : undefined;
  if (typesRaw && types && types.length === 0) {
    // All requested types invalid — return empty.
    sendJson(res, 200, { nodes: [], edges: [] });
    return;
  }

  // Tags filter (comma-separated).
  const tagsRaw = params.get("tags");
  const tags = tagsRaw ? tagsRaw.split(",").filter((t) => t.length > 0) : undefined;

  // Domain filter.
  const domain = params.get("domain") ?? undefined;

  // Category filter.
  const category = params.get("category") ?? undefined;

  // minWeight filter.
  let minWeight: number | undefined;
  const minWeightRaw = params.get("minWeight");
  if (minWeightRaw !== null) {
    minWeight = Number.parseFloat(minWeightRaw);
    if (Number.isNaN(minWeight)) {
      sendJson(res, 400, { error: "minWeight must be a number" });
      return;
    }
  }

  // Date range filters.
  const createdAfter = params.get("createdAfter") ?? undefined;
  const createdBefore = params.get("createdBefore") ?? undefined;

  // Text search.
  const q = params.get("q");

  // Fetch nodes.
  let nodes: Memory[];
  if (q && q.trim().length > 0) {
    // Text search path — read-only FTS5, no access_count bump.
    nodes = await store.searchText(q, limit);
    // Apply additional structured filters on top (scope/types/tags/dates) by
    // post-filtering, since searchText only does FTS5.
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
      sortOrder: "desc",
    });
    nodes = result.memories;
  }

  // Fetch edges between the returned nodes. Query the store for relationships
  // touching any visible node, then keep only edges whose BOTH endpoints are in
  // the visible set (so the canvas never shows dangling edges to off-screen nodes).
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);
  const relationships = await store.getRelationshipsForNodes(nodeIds);
  const edges: GraphEdge[] = relationships
    .filter((r: Relationship) => nodeIdSet.has(r.sourceId) && nodeIdSet.has(r.targetId))
    .map((r: Relationship) => ({
      id: r.id,
      source: r.sourceId,
      target: r.targetId,
      type: r.type,
      createdAt: r.createdAt,
    }));

  sendJson(res, 200, { nodes, edges });
}

interface StructuralFilter {
  scope: "all" | "project" | "global";
  types?: MemoryType[];
  tags?: string[];
  domain?: string;
  category?: string;
  minWeight?: number;
  createdAfter?: string;
  createdBefore?: string;
}

function applyStructuralFilters(nodes: Memory[], f: StructuralFilter): Memory[] {
  return nodes.filter((n) => {
    if (f.scope === "global" && n.scope !== "global") return false;
    if (f.scope === "project" && n.scope !== "project") return false;
    if (f.types && f.types.length > 0 && !f.types.includes(n.type)) return false;
    if (f.tags && f.tags.length > 0) {
      if (!f.tags.some((t) => n.tags.includes(t))) return false;
    }
    if (f.domain && n.domain !== f.domain) return false;
    if (f.category && n.category !== f.category) return false;
    if (f.minWeight !== undefined && n.weight < f.minWeight) return false;
    if (f.createdAfter && n.createdAt < f.createdAfter) return false;
    if (f.createdBefore && n.createdAt > f.createdBefore) return false;
    return true;
  });
}

/**
 * Return domain breakdown stats for the sidebar: count of memories per
 * domain, with type breakdown within each domain.
 */
async function handleDomains(
  res: ServerResponse,
  store: MemoryStore,
): Promise<void> {
  const result = await store.search({
    scope: "all",
    limit: 2000,
    offset: 0,
    sortBy: "weight",
    sortOrder: "desc",
  });
  const domainMap = new Map<string, { count: number; types: Record<string, number>; categories: Record<string, number> }>();
  for (const m of result.memories) {
    const d = m.domain ?? "uncategorized";
    if (!domainMap.has(d)) domainMap.set(d, { count: 0, types: {}, categories: {} });
    const entry = domainMap.get(d)!;
    entry.count++;
    entry.types[m.type] = (entry.types[m.type] ?? 0) + 1;
    const cat = m.category ?? "uncategorized";
    entry.categories[cat] = (entry.categories[cat] ?? 0) + 1;
  }
  const domains = Array.from(domainMap.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.count - a.count);
  sendJson(res, 200, { domains, total: result.memories.length });
}

async function handleMemory(
  id: string,
  res: ServerResponse,
  store: MemoryStore,
): Promise<void> {
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}
