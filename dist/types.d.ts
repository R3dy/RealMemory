/**
 * The type of memory — determines how it's categorized and indexed.
 */
type MemoryType = "user_preference" | "task_pattern" | "codebase_fact" | "lesson_learned" | "session_summary" | "contextual_note";
/**
 * The kind of relationship between two memories — used to build the memory graph.
 */
type RelationshipType = "reinforces" | "contradicts" | "extends" | "exception_to" | "derived_from";
/**
 * The scope a memory belongs to — project-local or global across projects.
 */
type MemoryScope = "project" | "global";
/**
 * A sub-classification within a memory type — lets the agent and UI group
 * memories by the *nature* of the knowledge, not just its domain.
 *
 * For lesson_learned:
 *   - "gotcha": a silent failure, a trap, a thing that looks right but isn't
 *   - "cost": a billing / resource leak lesson
 *   - "safety": a destructive-action / data-loss guardrail
 *   - "integration": a cross-system mismatch (key/format/protocol)
 *   - "process": a workflow / tracking / methodology lesson
 *   - "tooling": a tool/version/plugin quirk
 *   - "performance": a perf / timeout / scaling lesson
 *
 * For other types, category is optional and free-form.
 */
type MemoryCategory = "gotcha" | "cost" | "safety" | "integration" | "process" | "tooling" | "performance" | string;
/**
 * Structured origin tracking — where this memory came from.
 * Populated automatically when possible (project context, session id)
 * and retroactively by migration for older memories.
 */
interface MemorySource {
    /** Which project this memory originated from (e.g. "realhax", "realvol"). */
    project?: string;
    /** The session that created or captured this memory, if known. */
    session?: string;
    /** A reference: GitHub issue/PR number, file:line, ADR id, etc. */
    ref?: string;
    /** What kind of reference: "issue", "pr", "adr", "file", "commit", "url". */
    refType?: "issue" | "pr" | "adr" | "file" | "commit" | "url";
}
/**
 * Structured metadata for memory content. Fields are optional and
 * type-dependent — the UI renders whichever are present as labeled sections
 * instead of a wall of free text.
 *
 * For lesson_learned memories, the Assumed/Reality/Lesson structure is
 * parsed into discrete fields so the UI can render them as a structured
 * card and the agent can query them individually.
 */
interface MemoryMetadata {
    /** What was assumed before the lesson was learned. */
    assumed?: string;
    /** What actually happened / the ground truth. */
    reality?: string;
    /** The actionable takeaway. */
    lesson?: string;
    /** History of re-hits / reinforcements with date + context. */
    reinforced?: Array<{
        date: string;
        context: string;
    }>;
    /** When the lesson was first learned (ISO date). */
    learnedDate?: string;
    /** Which project context the lesson was learned in. */
    learnedProject?: string;
    /** Where in the codebase this fact lives (file:line, module, route). */
    location?: string;
    /** Supporting evidence (grep output, test result, etc.). */
    evidence?: string;
    /** What was accomplished in the session. */
    outcomes?: string[];
    /** How long the session lasted (human-readable). */
    duration?: string;
    [key: string]: unknown;
}
/**
 * The core Memory record — a single unit of persistent agent memory.
 */
interface Memory {
    id: string;
    content: string;
    type: MemoryType;
    scope: MemoryScope;
    /** Primary technology/topic domain (e.g. "aws", "testing", "opencode"). */
    domain?: string;
    /** Sub-classification within the type (e.g. "gotcha", "cost", "safety"). */
    category?: string;
    /** Structured origin tracking — where this memory came from. */
    source?: MemorySource;
    tags: string[];
    weight: number;
    confidence: number;
    /** ISO 8601 timestamp. */
    createdAt: string;
    /** ISO 8601 timestamp. */
    updatedAt: string;
    accessCount: number;
    reinforcementCount: number;
    /** Structured metadata — type-dependent fields the UI renders as sections. */
    metadata: MemoryMetadata;
    embedding?: number[];
    status: "active" | "archived";
}
/**
 * A directed relationship between two memories.
 */
interface Relationship {
    id: string;
    sourceId: string;
    targetId: string;
    type: RelationshipType;
    /** ISO 8601 timestamp. */
    createdAt: string;
}
/**
 * Input shape for creating a relationship when storing a memory.
 */
interface RelationshipInput {
    targetId: string;
    type: RelationshipType;
}
/**
 * Input for storing a new memory.
 */
interface StoreInput {
    content: string;
    type: MemoryType;
    tags?: string[];
    scope?: MemoryScope;
    /** Primary technology/topic domain (e.g. "aws", "testing"). */
    domain?: string;
    /** Sub-classification within the type. */
    category?: string;
    /** Structured origin — where this memory came from. */
    source?: MemorySource;
    confidence?: number;
    relationships?: RelationshipInput[];
    metadata?: MemoryMetadata;
    /**
     * When true, content exceeding `concisenessCap` (default 280 chars) is
     * truncated. Set by auto-capture paths (tool.execute.after, evaluateDelta,
     * session.idle summarization). Explicit MCP store_memory does NOT set this —
     * user content is preserved in full. Defaults to false (no truncation).
     */
    concise?: boolean;
}
/**
 * Query for recalling memories by semantic similarity and optional filters.
 */
interface RecallQuery {
    query: string;
    scope?: "project" | "global" | "all";
    limit?: number;
    threshold?: number;
    types?: MemoryType[];
    tags?: string[];
    /** Filter by domain (e.g. "aws", "testing"). */
    domain?: string;
    traverse?: boolean;
}
/**
 * A single recalled memory with its relevance score and related memories.
 */
interface RecallResult {
    memory: Memory;
    score: number;
    matchedBy: "semantic" | "keyword" | "tag" | "traversal";
    related: Memory[];
}
/**
 * Structured search query with filtering, sorting, and pagination.
 */
interface SearchQuery {
    scope?: "project" | "global" | "all";
    types?: MemoryType[];
    tags?: string[];
    /** Filter by domain (e.g. "aws", "testing", "opencode"). */
    domain?: string;
    /** Filter by category (e.g. "gotcha", "cost", "safety"). */
    category?: string;
    minWeight?: number;
    /** ISO 8601 timestamp. */
    createdAfter?: string;
    /** ISO 8601 timestamp. */
    createdBefore?: string;
    limit?: number;
    offset?: number;
    sortBy?: "weight" | "created" | "updated" | "confidence";
    sortOrder?: "asc" | "desc";
}
/**
 * A page of search results with total count and pagination info.
 */
interface SearchResult {
    memories: Memory[];
    total: number;
    offset: number;
    limit: number;
}
/**
 * A patch for updating an existing memory. All fields optional.
 */
interface UpdatePatch {
    content?: string;
    confidence?: number;
    tags?: string[];
    /** Update the domain classification. */
    domain?: string;
    /** Update the category. */
    category?: string;
    /** Update the source. */
    source?: MemorySource;
    metadata?: MemoryMetadata;
    reinforce?: boolean;
}
/**
 * Query for listing memories with simple filters and pagination.
 */
interface ListQuery {
    scope?: "project" | "global" | "all";
    type?: MemoryType;
    tag?: string;
    /** Filter by domain. */
    domain?: string;
    /** Filter by category. */
    category?: string;
    minWeight?: number;
    limit?: number;
    offset?: number;
}
/**
 * A page of list results with total count and pagination info.
 */
interface ListResult {
    memories: Memory[];
    total: number;
    offset: number;
    limit: number;
}
/**
 * Result of forgetting (archiving) a memory.
 */
interface ForgetResult {
    id: string;
    archived: boolean;
    relationshipsRemoved: number;
}
/**
 * A relationship edge connecting to a related memory, with direction.
 */
interface RelationshipEdge {
    type: RelationshipType;
    direction: "outgoing" | "incoming";
    memory: Memory;
}
/**
 * A memory along with its relationship edges.
 */
interface MemoryWithRelations {
    memory: Memory;
    relationships: RelationshipEdge[];
}
/**
 * Configuration for the memory store.
 */
interface MemoryStoreConfig {
    storagePath?: string;
    /** Project identifier used for project-scoped memories. null/undefined = global scope only. */
    projectId?: string | null;
    embeddingModel?: string | null;
    embeddingApiUrl?: string;
    embeddingApiKey?: string;
    decayHalfLifeDays?: number;
    /**
     * How often (in hours) automatic decay scheduling runs. A session.created
     * event triggers decay at most once per this interval; the last-run
     * timestamp is stored durably in SQLite so the cadence survives restarts.
     * Defaults to 24.
     */
    decayIntervalHours?: number;
    recallThreshold?: number;
    /**
     * Cosine-similarity threshold used by `store()` to detect a near-duplicate
     * active memory in the same scope and type (embedding mode only). When the
     * incoming content scores at or above this against an existing memory, the
     * existing memory is reinforced instead of inserting a new row. Defaults to
     * 0.92. Lower = more aggressive dedup; higher = fewer merges.
     */
    duplicateSimilarityThreshold?: number;
    /**
     * Minimum number of distinct project scopes that must have reinforced a
     * `user_preference` or `task_pattern` memory (via the `store()` near-
     * duplicate path) before it is automatically promoted from project scope to
     * global scope. Only `user_preference` and `task_pattern` types are ever
     * auto-promoted; project-specific types like `codebase_fact` and
     * `contextual_note` are never promoted regardless of this value. Defaults
     * to 2.
     */
    crossProjectPromotionThreshold?: number;
    maxRecallResults?: number;
    autoCapture?: boolean;
    autoSummarize?: boolean;
    summaryProvider?: SummaryProviderConfig;
    archiveThreshold?: number;
    maxRelatedPerMemory?: number;
    /**
     * When true (default), starting the MCP server auto-starts the read-only
     * graph browser as a side channel at http://127.0.0.1:9333. Set to false
     * (or pass --no-browser to bin.js) to disable.
     */
    autoStartBrowser?: boolean;
    /**
     * Maximum content length (chars) for auto-stored memories (auto-capture,
     * evaluateDelta, auto-summarize). Content exceeding this is truncated.
     * Explicit MCP store_memory calls are NOT capped. Defaults to 280.
     */
    concisenessCap?: number;
    /**
     * When true (default), the brain loop automatically creates relationship
     * edges when a new memory is stored or reinforced. Capped at
     * maxRelatedPerMemory per store. Set to false to disable auto-relate.
     */
    autoRelate?: boolean;
    /**
     * Master switch for the per-turn brain loop (evaluateDelta on session.idle).
     * When false, no delta memories are stored and no delta metrics are recorded.
     * Defaults to true. The existing recall/decay/summarize hooks are NOT
     * affected by this switch (only the delta-evaluation path).
     */
    brainLoop?: boolean;
    /**
     * How often (in hours) the experimental.session.compacting hygiene hook
     * runs a full dedup + decay pass. Defaults to 4.
     */
    compactingIntervalHours?: number;
    /**
     * Synthetic-brain Phase 1: reflex cache + inhibition.
     * When `reflex` is true (default), build ReflexCache at session start and
     * wire `tool.execute.before`. When false, no inhibition (today's behavior).
     * `inhibition` controls the action: "off" (no-op), "warn" (advisory note,
     * default). "rewrite" and "block" are Phase 4 (not valid values here).
     */
    brain?: {
        reflex?: boolean;
        inhibition?: "off" | "warn";
        /**
         * Synthetic-brain Phase 2: prediction error (surprise-driven encoding).
         * When `true` (effective default — the field's absence enables the loop),
         * the plugin runs the predict → compare → encode loop on every tool call.
         * When explicitly `false`, the loop is skipped (Phase 1 warn-only
         * behavior preserved). Gated on `!== false`, mirroring the `reflex` pattern.
         */
        predictionError?: boolean;
        /**
         * Synthetic-brain Phase 3: working-memory window. Default true (!== false gate).
         * When true, the transform hook assembles a budgeted, slotted window from
         * staged slot data. When false, no window is assembled (pendingWarnNote
         * still delivered independently). Note: design doc §5's config block lists
         * workingMemoryTokens but not this boolean — the gate follows the
         * established brain.reflex / brain.predictionError pattern.
         */
        workingMemory?: boolean;
        /**
         * Synthetic-brain Phase 3: total token budget for the working-memory window.
         * Default 800. Validated [200, 4000].
         */
        workingMemoryTokens?: number;
    };
}
/**
 * Configuration for the summary provider used by auto-summarization.
 */
interface SummaryProviderConfig {
    provider: string;
    model: string;
    apiUrl?: string;
    apiKey?: string;
}

export type { ForgetResult, ListQuery, ListResult, Memory, MemoryCategory, MemoryMetadata, MemoryScope, MemorySource, MemoryStoreConfig, MemoryType, MemoryWithRelations, RecallQuery, RecallResult, Relationship, RelationshipEdge, RelationshipInput, RelationshipType, SearchQuery, SearchResult, StoreInput, SummaryProviderConfig, UpdatePatch };
