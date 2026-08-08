/**
 * The type of memory — determines how it's categorized and indexed.
 */
export type MemoryType =
  | "user_preference"
  | "task_pattern"
  | "codebase_fact"
  | "lesson_learned"
  | "session_summary"
  | "contextual_note";

/**
 * The kind of relationship between two memories — used to build the memory graph.
 */
export type RelationshipType =
  | "reinforces"
  | "contradicts"
  | "extends"
  | "exception_to"
  | "derived_from";

/**
 * The scope a memory belongs to — project-local or global across projects.
 */
export type MemoryScope = "project" | "global";

/**
 * The core Memory record — a single unit of persistent agent memory.
 */
export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  weight: number;
  confidence: number;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
  accessCount: number;
  reinforcementCount: number;
  metadata: Record<string, unknown>;
  embedding?: number[];
  status: "active" | "archived";
}

/**
 * A directed relationship between two memories.
 */
export interface Relationship {
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
export interface RelationshipInput {
  targetId: string;
  type: RelationshipType;
}

/**
 * Input for storing a new memory.
 */
export interface StoreInput {
  content: string;
  type: MemoryType;
  tags?: string[];
  scope?: MemoryScope;
  confidence?: number;
  relationships?: RelationshipInput[];
  metadata?: Record<string, unknown>;
}

/**
 * Query for recalling memories by semantic similarity and optional filters.
 */
export interface RecallQuery {
  query: string;
  scope?: "project" | "global" | "all";
  limit?: number;
  threshold?: number;
  types?: MemoryType[];
  tags?: string[];
  traverse?: boolean;
}

/**
 * A single recalled memory with its relevance score and related memories.
 */
export interface RecallResult {
  memory: Memory;
  score: number;
  matchedBy: "semantic" | "keyword" | "tag" | "traversal";
  related: Memory[];
}

/**
 * Structured search query with filtering, sorting, and pagination.
 */
export interface SearchQuery {
  scope?: "project" | "global" | "all";
  types?: MemoryType[];
  tags?: string[];
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
export interface SearchResult {
  memories: Memory[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * A patch for updating an existing memory. All fields optional.
 */
export interface UpdatePatch {
  content?: string;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  reinforce?: boolean;
}

/**
 * Query for listing memories with simple filters and pagination.
 */
export interface ListQuery {
  scope?: "project" | "global" | "all";
  type?: MemoryType;
  tag?: string;
  minWeight?: number;
  limit?: number;
  offset?: number;
}

/**
 * A page of list results with total count and pagination info.
 */
export interface ListResult {
  memories: Memory[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Result of forgetting (archiving) a memory.
 */
export interface ForgetResult {
  id: string;
  archived: boolean;
  relationshipsRemoved: number;
}

/**
 * A relationship edge connecting to a related memory, with direction.
 */
export interface RelationshipEdge {
  type: RelationshipType;
  direction: "outgoing" | "incoming";
  memory: Memory;
}

/**
 * A memory along with its relationship edges.
 */
export interface MemoryWithRelations {
  memory: Memory;
  relationships: RelationshipEdge[];
}

/**
 * Configuration for the memory store.
 */
export interface MemoryStoreConfig {
  storagePath?: string;
  /** Project identifier used for project-scoped memories. null/undefined = global scope only. */
  projectId?: string | null;
  embeddingModel?: string;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  decayHalfLifeDays?: number;
  recallThreshold?: number;
  maxRecallResults?: number;
  autoCapture?: boolean;
  autoSummarize?: boolean;
  summaryProvider?: SummaryProviderConfig;
  archiveThreshold?: number;
  maxRelatedPerMemory?: number;
}

/**
 * Configuration for the summary provider used by auto-summarization.
 */
export interface SummaryProviderConfig {
  provider: string;
  model: string;
  apiUrl?: string;
  apiKey?: string;
}
