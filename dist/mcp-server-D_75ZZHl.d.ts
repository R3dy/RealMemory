import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MemoryStoreConfig, StoreInput, Memory, MemoryWithRelations, ListQuery, ListResult, ForgetResult, RecallQuery, RecallResult, SearchQuery, SearchResult, RelationshipType, Relationship, MemoryType, UpdatePatch } from './types.js';

/**
 * The core persistent-memory store. Backed by SQLite (with full-text and
 * optional vector-embedding indexes), it owns the full memory lifecycle:
 * store, get, list, search, recall, relate, update, forget, decay, close.
 *
 * Construct with a {@link MemoryStoreConfig} (which skips file-based config
 * loading) or with no argument (which loads config from the standard files
 * merged with defaults). Call {@link MemoryStore.init} before any other
 * method, and {@link MemoryStore.close} when done.
 */
declare class MemoryStore {
    private config;
    private db;
    private embeddingProvider;
    constructor(config?: MemoryStoreConfig);
    private get decayHalfLifeDays();
    private get archiveThreshold();
    private get crossProjectPromotionThreshold();
    /**
     * Open the database, run migrations, and initialize the embedding provider.
     * Must be called exactly once before any other method. A failure to load a
     * local ONNX model degrades gracefully to keyword-only recall rather than
     * throwing.
     */
    init(): Promise<void>;
    /**
     * Store a new memory. Validates type and confidence and scrubs secrets from
     * content, then checks for a near-duplicate active memory in the same scope
     * and type (cosine-similarity in embedding mode, exact/near-exact text in
     * keyword mode). If a near-duplicate active memory exists, reinforces it —
     * bumping `reinforcementCount` and boosting confidence with diminishing
     * returns — and returns the reinforced memory instead of inserting a new
     * row. When the near-duplicate belongs to a DIFFERENT project (a
     * cross-project reinforcement), the reinforcing project is recorded in the
     * memory's `metadata.crossProjectReinforcements`; once enough distinct
     * projects have reinforced a `user_preference`/`task_pattern` memory (see
     * `crossProjectPromotionThreshold`, default 2), it is promoted to global
     * scope so every project can see it. This is a contract change: `store()`
     * no longer guarantees a fresh row per call. Otherwise it computes the
     * initial composite weight, inserts the row, computes and persists its
     * embedding (best-effort, never blocks on failure), and creates any supplied
     * relationships. Returns the canonical Memory record.
     */
    store(input: StoreInput): Promise<Memory>;
    /**
     * Find an existing active memory that holds a near-duplicate of the given
     * content and type. Returns the matching row, or null when no duplicate
     * exists. Used by {@link store} to reinforce an existing memory instead of
     * inserting a second row.
     *
     * Scope handling differs from recall on purpose: for a project-scoped
     * `store()`, near-duplicate candidates include memories owned by ANY project
     * (plus global memories) — not just the current project's own rows. This is
     * what lets a cross-project reinforcement be detected: when project B stores
     * content that project A already holds, the matching row belongs to A, and
     * {@link store} promotes the memory to global scope once enough distinct
     * projects have reinforced it. A global-scoped `store()` still only matches
     * global memories, preserving the project/global boundary. The matching
     * RULES (thresholds below) are unchanged.
     *
     * Two modes mirror the recall engine:
     * - Embedding mode (an embedding provider is configured): embed the content
     *   and score every candidate memory by cosine similarity. A score at or
     *   above `duplicateSimilarityThreshold` (default 0.92) marks a duplicate.
     *   Memories without a stored embedding are skipped. If the embedding
     *   computation itself fails, we fall back to the keyword gate below — the
     *   same best-effort posture the insert path uses.
     * - Keyword mode (no embedding provider): reuse the FTS5 index for
     *   candidates, then require both a high normalized bm25 relevance
     *   (`DUPLICATE_KEYWORD_RELEVANCE`) and a near-exact token-set overlap
     *   (`DUPLICATE_TOKEN_OVERLAP`). This catches exact/near-exact text but not
     *   semantic paraphrases — it guards against accidental re-stores of the
     *   same content when vectors are unavailable.
     */
    private findDuplicate;
    /**
     * Whether a near-duplicate memory should be promoted to global scope after a
     * cross-project reinforcement. Requires a promotable type
     * (`user_preference`/`task_pattern`), a project scope (never re-promotes an
     * already-global memory), and at least `crossProjectPromotionThreshold`
     * distinct projects contributing to the memory — the origin project plus
     * every project recorded in `reinforcingProjects`.
     */
    private shouldPromoteToGlobal;
    /**
     * Promote a project-scoped memory to global scope. Used by the `store()`
     * dedup path once a `user_preference`/`task_pattern` memory has been
     * reinforced by enough distinct projects. A direct SQL UPDATE because
     * {@link UpdatePatch} intentionally cannot change `scope`/`project_id`.
     */
    private promoteToGlobal;
    /**
     * Fetch a single active memory by ID. When `includeRelationships` is true
     * (default), the returned object carries one-hop outgoing and incoming
     * relationship edges. Throws {@link MemoryNotFoundError} if the ID does not
     * exist or has been archived.
     */
    get(id: string, includeRelationships?: boolean): Promise<MemoryWithRelations>;
    /**
     * Browse active memories with simple filters and pagination. Returns a page
     * with the total count, ordered by weight descending.
     */
    list(query: ListQuery): Promise<ListResult>;
    /**
     * Forget a memory. Soft-archive (default) sets `status = 'archived'` and
     * cascades the relationship deletion; a no-op if already archived. Hard
     * delete (`hard = true`) removes the row entirely. Returns the count of
     * relationships removed. Throws {@link MemoryNotFoundError} if the ID does
     * not exist.
     */
    forget(id: string, hard?: boolean): Promise<ForgetResult>;
    /**
     * Recall memories relevant to a natural-language query. Uses semantic
     * (cosine-similarity) recall when an embedding provider is available, and
     * falls back to FTS5 keyword (bm25) recall otherwise. Results are ranked by
     * `relevance × storedWeight`, their `accessCount` is bumped and weight
     * recomputed, and one-hop related memories are attached when `traverse` is
     * true (default). Applies scope/type/tag filters and a relevance threshold.
     */
    recall(query: RecallQuery): Promise<RecallResult[]>;
    /**
     * Build the WHERE clause + params for the structured filters shared by
     * recall paths: status, scope, types, tags. Does NOT include the FTS MATCH.
     * `prefix` is applied to column names (e.g. "m.") to avoid ambiguity when
     * joining memories_fts and memories.
     */
    private buildRecallFilter;
    /**
     * Semantic recall: embed the query, score every matching memory by cosine
     * similarity, fall back to FTS5 keyword matching for memories without an
     * stored embedding.
     */
    private recallSemantic;
    /**
     * Keyword-only recall: FTS5 bm25 scoring with weight-weighted ranking.
     * Used when no embedding provider is configured (or failed to load).
     */
    private recallKeyword;
    /**
     * Shared post-processing: build RecallResult objects, bump access_count +
     * recompute weight, and optionally traverse one-hop relationships.
     */
    private finalizeRecallResults;
    /**
     * Fetch one-hop related memories (both outgoing + incoming edges) for a
     * given memory, excluding IDs already in the `exclude` set, capped at
     * `maxRelated`.
     */
    private fetchRelatedMemories;
    /**
     * Run an FTS5 MATCH against the query text and return the set of memory IDs
     * that match. Used as the keyword fallback signal in semantic recall.
     */
    private ftsMatchIds;
    /**
     * Structured search with filters (scope, types, tags, minWeight, date
     * range), sorting (weight/created/updated/confidence), and pagination.
     * Unlike {@link recall}, search does not embed the query or traverse
     * relationships — it is a deterministic filtered query.
     */
    search(query: SearchQuery): Promise<SearchResult>;
    /**
     * Create a typed, directed relationship between two active memories.
     * Rejects self-relationships and duplicate (source, target, type) triples.
     * `reinforces` boosts the source's confidence (diminishing returns) and
     * bumps its `reinforcementCount`; `contradicts` decays the target's
     * confidence by 10% of its current value. Both recompute the affected
     * memory's weight. The other types are structural only.
     */
    relate(sourceId: string, targetId: string, type: RelationshipType): Promise<Relationship>;
    /**
     * Automatically create relationship edges from a memory to its semantically
     * similar peers. Capped at maxRelatedPerMemory per call. Idempotent (catches
     * DuplicateRelationshipError). Excludes the source memory (INV-007).
     * Returns the number of edges created.
     */
    maybeRelate(memoryId: string, content: string, type: MemoryType): Promise<number>;
    /**
     * Scan active memories for near-duplicate pairs and merge them (reinforce the
     * higher-weight one, archive the lower-weight one). Bounded scan: at most
     * 1000 most-recently-touched active memories. Returns the count of merges.
     * Fire-safe — errors are caught and logged, never thrown (INV-017).
     */
    dedupPass(): Promise<number>;
    /**
     * Patch an existing active memory. Content is scrubbed; tags are replaced
     * (not merged); metadata is merged with existing. `reinforce: true` bumps
     * `reinforcementCount` and boosts confidence (diminishing returns). Any
     * confidence change recomputes the composite weight. Throws
     * {@link MemoryNotFoundError} / {@link InvalidConfidenceError} as appropriate.
     */
    update(id: string, patch: UpdatePatch): Promise<Memory>;
    /**
     * Read a key from the durable `meta` key-value table. Returns `null` when
     * the key has never been set. Used for rate-limiting and persisted settings
     * that must survive process restarts (e.g. `decay:lastRun`).
     */
    getMeta(key: string): Promise<string | null>;
    /**
     * Write a key to the durable `meta` key-value table, replacing any existing
     * value for the same key.
     */
    setMeta(key: string, value: string): Promise<void>;
    /**
     * Recompute every active memory's composite weight and archive any whose
     * weight has dropped below the configured `archiveThreshold`. Call this on a
     * timer in a long-lived app to keep the store from accumulating stale,
     * low-weight memories.
     */
    decay(): Promise<void>;
    /**
     * Rate-limited decay scheduling. If `intervalHours` have elapsed since the
     * timestamp stored under `lastRunKey` (in the durable `meta` table), runs
     * {@link decay} and records the current time back to `lastRunKey`, returning
     * `true`. Otherwise skips and returns `false`. The timestamp lives in SQLite
     * so the rate-limit persists across process restarts that reopen the same DB
     * file — a fresh MemoryStore reads the same row and won't re-trigger decay
     * within the interval. A missing row is treated as "due", so the first call
     * always runs decay.
     */
    maybeDecay(lastRunKey: string, intervalHours: number): Promise<boolean>;
    /**
     * Record a metric observation (brain-loop observability).
     * Stores a single row in the metrics table with a ULID and ISO timestamp.
     * Fire-safe: errors are caught and logged to the store's error log, never
     * thrown (metrics must not break the caller — INV-017).
     */
    recordMetric(name: string, value: number, sessionId?: string): Promise<void>;
    /**
     * Aggregate summary of recorded metrics. Returns per-metric_name aggregates:
     * count, sum, avg, latest, latest_at. Optionally filtered by name and/or
     * since (ISO timestamp).
     */
    getMetricSummary(name?: string, since?: string): Promise<Array<{
        metric_name: string;
        count: number;
        sum: number;
        avg: number;
        latest: number;
        latest_at: string;
    }>>;
    /**
     * Return the single most-recent metrics row (by recorded_at) whose
     * metric_name matches the given prefix (LIKE 'prefix%'). Returns null if no
     * row matches. Additive: no schema change, no existing method signature
     * change. Used by --doctor to read the latest hook_lands outcome value and
     * the latest session_id (both unreachable via getMetricSummary, whose
     * `latest` field is MAX(metric_value) and returns no session_id).
     *
     * (Synthetic-brain Phase 0 — resolves plan comments 2-C1 + 2-C4.)
     */
    getLatestMetricRow(prefix: string): Promise<{
        metric_name: string;
        metric_value: number;
        session_id: string | null;
        recorded_at: string;
    } | null>;
    /**
     * Count active memories in the store. Additive — used by the doctor report
     * to determine if sessions have run (memories present = sessions happened).
     * (Synthetic-brain Phase 0.)
     */
    count(): Promise<number>;
    /**
     * Return recent metrics rows whose metric_name matches the given prefix
     * (LIKE 'prefix%'), ordered by recorded_at desc, limited to `limit` rows.
     * Used by the memory_why MCP tool to surface recent reflex actions.
     * (Synthetic-brain Phase 7.)
     */
    getRecentMetricsByPrefix(prefix: string, limit?: number): Promise<Array<{
        metric_name: string;
        metric_value: number;
        session_id: string | null;
        recorded_at: string;
    }>>;
    /**
     * Bloat ratio: fraction of active memories with weight below
     * archiveThreshold. 0.0 on an empty store.
     */
    getBloatRatio(): Promise<number>;
    /**
     * Read-only aggregate statistics for the graph browser's sidebar readout:
     * total active memories, counts per type, counts per scope, and total
     * relationships. Does not mutate any row.
     */
    getStats(): Promise<{
        totalMemories: number;
        byType: Record<string, number>;
        byScope: {
            project: number;
            global: number;
        };
        totalRelationships: number;
    }>;
    /**
     * Read-only full-text search returning memories ranked by bm25 relevance,
     * WITHOUT bumping `access_count` or recomputing weight (the key difference
     * from {@link recall}, which mutates). Used by the graph browser's text
     * filter so browsing does not distort the decay/recency signals. Returns an
     * empty array for a query with no usable tokens.
     */
    searchText(query: string, limit?: number): Promise<Memory[]>;
    /**
     * Read-only bulk fetch of all relationships whose `source_id` OR `target_id`
     * is in the supplied `nodeIds` set. Used by the graph browser to draw edges
     * between the currently-visible nodes without N per-node `get()` calls. Does
     * not mutate any row. Returns an empty array for an empty input set.
     */
    getRelationshipsForNodes(nodeIds: string[]): Promise<Relationship[]>;
    /** Close the database handle. Safe to call multiple times; no-op if already closed. */
    close(): Promise<void>;
    private requireDb;
}

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

export { MemoryStore as M, type StartMcpServerOptions as S, type McpToolHandler as a, createMcpTools as c, startMcpServer as s };
