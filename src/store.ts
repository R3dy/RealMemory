import { mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import type {
  Memory,
  StoreInput,
  RecallQuery,
  RecallResult,
  SearchQuery,
  SearchResult,
  UpdatePatch,
  ListQuery,
  ListResult,
  ForgetResult,
  Relationship,
  RelationshipType,
  RelationshipEdge,
  MemoryWithRelations,
  MemoryStoreConfig,
  MemoryType,
  MemoryScope,
} from "./types";
import { MemoryStoreError, MemoryNotFoundError, InvalidTypeError, InvalidConfidenceError, DuplicateRelationshipError, SelfRelationshipError } from "./errors";
import type { DbConnection } from "./db/connection";
import { openDatabase } from "./db/dialect";
import { runMigrations } from "./db/schema";
import { generateUlid } from "./db/ulid";
import { scrubSecrets } from "./scrub";
import { computeWeight } from "./weighting";
import { loadConfig, validateConfig } from "./config";
import { createEmbeddingProvider } from "./embeddings";
import type { EmbeddingProvider } from "./embeddings";
import { cosineSimilarity, embeddingFromBuffer, embeddingToBuffer } from "./similarity";

const DEFAULT_STORAGE_PATH = resolve(
  homedir(),
  ".opencode",
  "realmemory",
  "data.db",
);

const VALID_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note",
]);

const DEFAULT_LIMIT = 50;

/**
 * Keyword-mode dedup gate: an FTS5 candidate must hold at least this fraction
 * of the best (maximum) bm25 score in the result set to be considered a
 * near-duplicate (best match → 1.0). Combined with `DUPLICATE_TOKEN_OVERLAP`
 * below, this only fires for exact/near-exact text, never for partial keyword
 * hits. Keyword dedup is a fallback for stores without an embedding provider
 * and guards against accidental re-stores of the same content — it does not
 * catch semantic paraphrases.
 */
const DUPLICATE_KEYWORD_RELEVANCE = 0.9;
/**
 * Keyword-mode dedup gate: a candidate is treated as a near-duplicate only
 * when its token set overlaps the incoming content by at least this fraction
 * (overlap coefficient = shared tokens / larger token count; 1.0 = identical
 * token set). A low overlap means the FTS hit is a partial keyword match, so
 * we store a new memory instead of reinforcing an unrelated one.
 */
const DUPLICATE_TOKEN_OVERLAP = 0.95;

/** Tokenize text into lowercase alphanumeric tokens (casing/punctuation ignored). */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 0);
}

/**
 * Overlap coefficient between two texts: shared token count / larger token
 * count. Returns 0 when either text has no tokens; 1.0 when both token sets
 * are identical.
 */
function tokenOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  let shared = 0;
  for (const t of ta) {
    if (setB.has(t)) shared++;
  }
  return shared / Math.max(ta.length, tb.length);
}

/**
 * Build a safe FTS5 MATCH query string from free text. Splits on whitespace,
 * strips FTS5 special characters (double quotes, asterisks), and joins tokens
 * with OR for broad recall. Returns "" when no usable tokens remain.
 */
function buildFtsQuery(text: string): string {
  const tokens = text
    .split(/\s+/)
    .map((t) => t.replace(/["*:()\-]/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** Row shape as stored in the memories table (snake_case, JSON-encoded fields). */
interface MemoryRow {
  id: string;
  content: string;
  type: string;
  scope: string;
  tags: string;
  weight: number;
  confidence: number;
  created_at: string;
  updated_at: string;
  access_count: number;
  reinforcement_count: number;
  metadata: string;
  embedding: Uint8Array | null;
  status: string;
  project_id: string | null;
}

/** Joined row from a relationships+memories query with aliased rel_* columns. */
interface JoinRow extends MemoryRow {
  rel_id: string;
  rel_source: string;
  rel_target: string;
  rel_type: string;
  rel_created: string;
}

/** Convert a raw DB row (snake_case, JSON strings) into a public Memory object. */
function rowToMemory(row: MemoryRow): Memory {
  let tags: string[];
  try {
    tags = JSON.parse(row.tags) as string[];
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      metadata = {};
    }
  } catch {
    metadata = {};
  }

  let embedding: number[] | undefined;
  if (row.embedding) {
    const vec = embeddingFromBuffer(row.embedding as unknown as Uint8Array);
    if (vec) {
      embedding = Array.from(vec);
    }
  }

  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    scope: row.scope as MemoryScope,
    tags,
    weight: row.weight,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessCount: row.access_count,
    reinforcementCount: row.reinforcement_count,
    metadata,
    embedding,
    status: row.status as "active" | "archived",
  };
}

/** Convert an aliased join row (relationships + memories) to a RelationshipEdge. */
function joinRowToEdge(row: JoinRow, memoryId: string): RelationshipEdge {
  const direction = row.rel_source === memoryId ? "outgoing" : "incoming";
  return {
    type: row.rel_type as RelationshipType,
    direction,
    memory: rowToMemory(row),
  };
}

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
export class MemoryStore {
  private config: MemoryStoreConfig;
  private db: DbConnection | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;

  constructor(config?: MemoryStoreConfig) {
    // If no config provided, load from config files merged with defaults.
    const loaded = config ?? loadConfig();
    validateConfig(loaded);
    this.config = {
      decayHalfLifeDays: 30,
      archiveThreshold: 0.05,
      ...loaded,
    };
  }

  private get decayHalfLifeDays(): number {
    return this.config.decayHalfLifeDays ?? 30;
  }

  private get archiveThreshold(): number {
    return this.config.archiveThreshold ?? 0.05;
  }

  /**
   * Open the database, run migrations, and initialize the embedding provider.
   * Must be called exactly once before any other method. A failure to load a
   * local ONNX model degrades gracefully to keyword-only recall rather than
   * throwing.
   */
  async init(): Promise<void> {
    const rawPath = this.config.storagePath ?? DEFAULT_STORAGE_PATH;
    // Expand a leading ~ to the user's home directory.
    const storagePath = rawPath.startsWith("~")
      ? join(homedir(), rawPath.slice(1))
      : resolve(rawPath);
    const dir = dirname(storagePath);
    mkdirSync(dir, { recursive: true });

    const db = await openDatabase(storagePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
    this.db = db;

    // Initialize the embedding provider. A failure to load a local model
    // (network error, missing ONNX runtime, etc.) returns null and we fall
    // back to keyword-only recall rather than crashing init.
    this.embeddingProvider = await createEmbeddingProvider(this.config);
  }

  /**
   * Store a new memory. Validates type and confidence and scrubs secrets from
   * content, then checks for a near-duplicate active memory in the same scope
   * and type (cosine-similarity in embedding mode, exact/near-exact text in
   * keyword mode). If a near-duplicate active memory exists, reinforces it —
   * bumping `reinforcementCount` and boosting confidence with diminishing
   * returns — and returns the reinforced memory instead of inserting a new
   * row. This is a contract change: `store()` no longer guarantees a fresh
   * row per call. Otherwise it computes the initial composite weight, inserts
   * the row, computes and persists its embedding (best-effort, never blocks
   * on failure), and creates any supplied relationships. Returns the
   * canonical Memory record.
   */
  async store(input: StoreInput): Promise<Memory> {
    const db = this.requireDb();

    // 1. Validate type.
    if (!VALID_TYPES.has(input.type)) {
      throw new InvalidTypeError(input.type);
    }

    // 2. Validate confidence.
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      throw new InvalidConfidenceError(confidence);
    }

    // 3. Scope + scrubbed content, shared by the dedup check and the insert.
    const scope: MemoryScope = input.scope ?? "project";
    const content = scrubSecrets(input.content);

    // 4. Near-duplicate check: when an active memory in the same scope and
    //    type already holds identical/near-identical content, reinforce the
    //    existing memory instead of inserting a second row. Relationships
    //    passed in the input are intentionally not created on this path — no
    //    new row exists to attach them to.
    const duplicate = await this.findDuplicate(content, input.type, scope);
    if (duplicate) {
      return this.update(duplicate.id, { reinforce: true });
    }

    // 5. Identity + timestamps.
    const id = generateUlid();
    const now = new Date().toISOString();

    // 6. project_id (scope resolved above).
    const projectId = scope === "global" ? null : this.config.projectId ?? null;

    // 7. Serialize tags + metadata.
    const tagsJson = JSON.stringify(input.tags ?? []);
    const metadataJson = JSON.stringify(input.metadata ?? {});

    // 8. Initial composite weight (relevance = 1.0 at store time; no query context yet).
    const weight = computeWeight(
      { createdAt: now, accessCount: 0, reinforcementCount: 0, confidence },
      1.0,
      { decayHalfLifeDays: this.decayHalfLifeDays },
    );

    // 9. INSERT.
    db.prepare(
      `INSERT INTO memories
        (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, project_id)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      id,
      content,
      input.type,
      scope,
      tagsJson,
      weight,
      confidence,
      now,
      now,
      0,
      0,
      metadataJson,
      projectId,
    );

    // 9b. Embedding (async, best-effort — never block store on failure).
    if (this.embeddingProvider) {
      try {
        const vec = await this.embeddingProvider.embed(content);
        db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(
          embeddingToBuffer(vec),
          id,
        );
      } catch (err) {
        // A single embedding failure shouldn't break the store call; the
        // memory is already persisted and will be matched by keyword fallback.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[realmemory] Embedding computation failed for ${id}: ${msg}`);
      }
    }

    // 10. Relationships.
    if (input.relationships && input.relationships.length > 0) {
      for (const rel of input.relationships) {
        const target = db
          .prepare("SELECT id FROM memories WHERE id = ?")
          .get(rel.targetId) as { id: string } | undefined;
        if (!target) {
          throw new MemoryStoreError(
            `RELATIONSHIP_NOT_FOUND: target memory ${rel.targetId} does not exist`,
          );
        }
        const relId = generateUlid();
        db.prepare(
          `INSERT INTO relationships (id, source_id, target_id, type, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(relId, id, rel.targetId, rel.type, now);
      }
    }

    // 11. Return the stored Memory (re-read to get canonical representation).
    const stored = db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    if (!stored) {
      throw new MemoryStoreError(`Failed to read back stored memory: ${id}`);
    }
    return rowToMemory(stored);
  }

  /**
   * Find an existing active memory in the same scope and type that holds a
   * near-duplicate of the given content. Returns the matching row, or null
   * when no duplicate exists. Used by {@link store} to reinforce an existing
   * memory instead of inserting a second row.
   *
   * Two modes mirror the recall engine:
   * - Embedding mode (an embedding provider is configured): embed the content
   *   and score every same-scope/same-type active memory by cosine
   *   similarity. A score at or above `duplicateSimilarityThreshold` (default
   *   0.92) marks a duplicate. Memories without a stored embedding are
   *   skipped. If the embedding computation itself fails, we fall back to the
   *   keyword gate below — the same best-effort posture the insert path uses.
   * - Keyword mode (no embedding provider): reuse the FTS5 index for
   *   candidates, then require both a high normalized bm25 relevance
   *   (`DUPLICATE_KEYWORD_RELEVANCE`) and a near-exact token-set overlap
   *   (`DUPLICATE_TOKEN_OVERLAP`). This catches exact/near-exact text but not
   *   semantic paraphrases — it guards against accidental re-stores of the
   *   same content when vectors are unavailable.
   */
  private async findDuplicate(
    content: string,
    type: MemoryType,
    scope: MemoryScope,
  ): Promise<MemoryRow | null> {
    const db = this.requireDb();
    // Same scope + same type as the incoming memory. The plain filter serves
    // the direct SELECT; the "m."-prefixed one disambiguates the FTS join.
    // `query` is unused by buildRecallFilter — only scope/types/tags are read.
    const recallFilter: RecallQuery = { query: content, scope, types: [type] };
    const plainFilter = this.buildRecallFilter(recallFilter);
    const joinFilter = this.buildRecallFilter(recallFilter, "m.");

    // Embedding mode: cosine similarity against every same-scope/type active
    // memory.
    if (this.embeddingProvider) {
      try {
        const vec = await this.embeddingProvider.embed(content);
        const rows = db
          .prepare(`SELECT * FROM memories WHERE ${plainFilter.whereSql}`)
          .all(...plainFilter.params) as unknown as MemoryRow[];
        const threshold = this.config.duplicateSimilarityThreshold ?? 0.92;
        let best: MemoryRow | null = null;
        let bestSim = -1;
        for (const row of rows) {
          const embedding = embeddingFromBuffer(row.embedding as unknown as Uint8Array);
          if (!embedding) continue;
          const sim = cosineSimilarity(vec, embedding);
          if (sim > bestSim) {
            bestSim = sim;
            best = row;
          }
        }
        if (best && bestSim >= threshold) return best;
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[realmemory] Duplicate check (embedding) failed: ${msg}`);
        // Best-effort: continue to the keyword gate below.
      }
    }

    // Keyword mode: FTS5 candidates + near-exact text overlap.
    const ftsQuery = buildFtsQuery(content);
    if (ftsQuery === "") return null;
    const candidates = db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS fts_score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${joinFilter.whereSql}
         ORDER BY bm25(memories_fts) ASC
         LIMIT 20`,
      )
      .all(ftsQuery, ...joinFilter.params) as unknown as Array<MemoryRow & { fts_score: number }>;
    if (candidates.length === 0) return null;

    // Normalize bm25 the same way recall does (best match → 1.0), then require
    // both a high relative score and a near-identical token set so a partial
    // keyword hit never collapses an unrelated memory into a reinforcement.
    const rawScores = candidates.map((r) => -r.fts_score);
    const maxRaw = Math.max(...rawScores, 1e-9);
    for (let i = 0; i < candidates.length; i++) {
      const relevance = rawScores[i] / maxRaw;
      if (relevance < DUPLICATE_KEYWORD_RELEVANCE) continue;
      if (tokenOverlap(content, candidates[i].content) < DUPLICATE_TOKEN_OVERLAP) continue;
      return candidates[i];
    }
    return null;
  }

  /**
   * Fetch a single active memory by ID. When `includeRelationships` is true
   * (default), the returned object carries one-hop outgoing and incoming
   * relationship edges. Throws {@link MemoryNotFoundError} if the ID does not
   * exist or has been archived.
   */
  async get(id: string, includeRelationships = true): Promise<MemoryWithRelations> {
    const db = this.requireDb();

    // 1. Fetch the memory (only active).
    const row = db
      .prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'")
      .get(id) as MemoryRow | undefined;
    if (!row) {
      throw new MemoryNotFoundError(id);
    }

    const memory = rowToMemory(row);

    // 4. Relationships.
    const relationships: RelationshipEdge[] = [];
    if (includeRelationships) {
      // Outgoing edges: this memory is the source.
      const outRows = db
        .prepare(
          `SELECT
             r.id AS rel_id, r.source_id AS rel_source, r.target_id AS rel_target,
             r.type AS rel_type, r.created_at AS rel_created,
             m.id, m.content, m.type, m.scope, m.tags, m.weight, m.confidence,
             m.created_at, m.updated_at, m.access_count, m.reinforcement_count,
             m.metadata, m.embedding, m.status, m.project_id
           FROM relationships r
           JOIN memories m ON m.id = r.target_id
           WHERE r.source_id = ?`,
        )
        .all(id) as unknown as JoinRow[];
      for (const r of outRows) {
        relationships.push(joinRowToEdge(r, id));
      }
      // Incoming edges: this memory is the target.
      const inRows = db
        .prepare(
          `SELECT
             r.id AS rel_id, r.source_id AS rel_source, r.target_id AS rel_target,
             r.type AS rel_type, r.created_at AS rel_created,
             m.id, m.content, m.type, m.scope, m.tags, m.weight, m.confidence,
             m.created_at, m.updated_at, m.access_count, m.reinforcement_count,
             m.metadata, m.embedding, m.status, m.project_id
           FROM relationships r
           JOIN memories m ON m.id = r.source_id
           WHERE r.target_id = ?`,
        )
        .all(id) as unknown as JoinRow[];
      for (const r of inRows) {
        relationships.push(joinRowToEdge(r, id));
      }
    }

    return { memory, relationships };
  }

  /**
   * Browse active memories with simple filters and pagination. Returns a page
   * with the total count, ordered by weight descending.
   */
  async list(query: ListQuery): Promise<ListResult> {
    const db = this.requireDb();

    const where: string[] = ["status = 'active'"];
    const params: unknown[] = [];

    // Scope filter.
    const scope = query.scope ?? "all";
    if (scope === "project") {
      const pid = this.config.projectId ?? null;
      where.push("project_id IS ?");
      params.push(pid);
    } else if (scope === "global") {
      where.push("project_id IS NULL");
    } else {
      // scope === "all" → current project + global (NOT other projects).
      const pid = this.config.projectId ?? null;
      where.push("(project_id IS ? OR project_id IS NULL)");
      params.push(pid);
    }

    // Type filter.
    if (query.type) {
      where.push("type = ?");
      params.push(query.type);
    }

    // Tag filter (JSON contains).
    if (query.tag) {
      where.push("tags LIKE ?");
      params.push(`%"${query.tag.replace(/[%_]/g, (c) => "\\" + c)}"%`);
    }

    // minWeight filter.
    if (typeof query.minWeight === "number") {
      where.push("weight >= ?");
      params.push(query.minWeight);
    }

    const whereSql = where.join(" AND ");
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    // Total count.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereSql}`)
      .get(...params) as { c: number } | undefined;
    const total = countRow?.c ?? 0;

    // Page.
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE ${whereSql} ORDER BY weight DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as MemoryRow[];

    const memories = rows.map(rowToMemory);

    return { memories, total, offset, limit };
  }

  /**
   * Forget a memory. Soft-archive (default) sets `status = 'archived'` and
   * cascades the relationship deletion; a no-op if already archived. Hard
   * delete (`hard = true`) removes the row entirely. Returns the count of
   * relationships removed. Throws {@link MemoryNotFoundError} if the ID does
   * not exist.
   */
  async forget(id: string, hard = false): Promise<ForgetResult> {
    const db = this.requireDb();

    // 1. Check the memory exists.
    const row = db
      .prepare("SELECT id, status FROM memories WHERE id = ?")
      .get(id) as { id: string; status: string } | undefined;
    if (!row) {
      throw new MemoryNotFoundError(id);
    }

    // 2. Count relationships.
    const countRow = db
      .prepare(
        "SELECT COUNT(*) AS c FROM relationships WHERE source_id = ? OR target_id = ?",
      )
      .get(id, id) as { c: number } | undefined;
    const relationshipsRemoved = countRow?.c ?? 0;

    // 5. Already archived + soft = no-op.
    if (row.status === "archived" && !hard) {
      return { id, archived: true, relationshipsRemoved: 0 };
    }

    if (hard) {
      // 3. Hard delete.
      db.prepare("DELETE FROM relationships WHERE source_id = ? OR target_id = ?").run(id, id);
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return { id, archived: false, relationshipsRemoved };
    }

    // 4. Soft archive + cascade relationships (default true).
    db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    db.prepare("DELETE FROM relationships WHERE source_id = ? OR target_id = ?").run(id, id);
    return { id, archived: true, relationshipsRemoved };
  }

  /**
   * Recall memories relevant to a natural-language query. Uses semantic
   * (cosine-similarity) recall when an embedding provider is available, and
   * falls back to FTS5 keyword (bm25) recall otherwise. Results are ranked by
   * `relevance × storedWeight`, their `accessCount` is bumped and weight
   * recomputed, and one-hop related memories are attached when `traverse` is
   * true (default). Applies scope/type/tag filters and a relevance threshold.
   */
  async recall(query: RecallQuery): Promise<RecallResult[]> {
    const db = this.requireDb();

    const limit = query.limit ?? this.config.maxRecallResults ?? 5;
    const threshold = query.threshold ?? this.config.recallThreshold ?? 0.3;
    const maxRelated = this.config.maxRelatedPerMemory ?? 3;
    const traverse = query.traverse ?? true;

    // Build the structured filter (scope, types, tags) shared by both paths.
    const { whereSql, params } = this.buildRecallFilter(query);

    // Empty DB fast path.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereSql}`)
      .get(...params) as { c: number } | undefined;
    if ((countRow?.c ?? 0) === 0) return [];

    // ----- Path 1: semantic recall (embedding provider available) -----
    if (this.embeddingProvider) {
      return await this.recallSemantic(query, whereSql, params, limit, threshold, maxRelated, traverse);
    }

    // ----- Path 2: keyword-only recall (FTS5) -----
    return await this.recallKeyword(query, whereSql, params, limit, threshold, maxRelated, traverse);
  }

  /**
   * Build the WHERE clause + params for the structured filters shared by
   * recall paths: status, scope, types, tags. Does NOT include the FTS MATCH.
   * `prefix` is applied to column names (e.g. "m.") to avoid ambiguity when
   * joining memories_fts and memories.
   */
  private buildRecallFilter(query: RecallQuery, prefix = ""): { whereSql: string; params: unknown[] } {
    const where: string[] = [`${prefix}status = 'active'`];
    const params: unknown[] = [];

    const scope = query.scope ?? "all";
    if (scope === "project") {
      const pid = this.config.projectId ?? null;
      where.push(`${prefix}project_id IS ?`);
      params.push(pid);
    } else if (scope === "global") {
      where.push(`${prefix}project_id IS NULL`);
    } else {
      const pid = this.config.projectId ?? null;
      where.push(`(${prefix}project_id IS ? OR ${prefix}project_id IS NULL)`);
      params.push(pid);
    }

    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => "?").join(", ");
      where.push(`${prefix}type IN (${placeholders})`);
      params.push(...query.types);
    }

    if (query.tags && query.tags.length > 0) {
      const tagClauses = query.tags.map(() => `${prefix}tags LIKE ?`);
      where.push(`(${tagClauses.join(" OR ")})`);
      for (const tag of query.tags) {
        params.push(`%"${tag.replace(/[%_\\]/g, (c) => "\\" + c)}"%`);
      }
    }

    return { whereSql: where.join(" AND "), params };
  }

  /**
   * Semantic recall: embed the query, score every matching memory by cosine
   * similarity, fall back to FTS5 keyword matching for memories without an
   * stored embedding.
   */
  private async recallSemantic(
    query: RecallQuery,
    whereSql: string,
    params: unknown[],
    limit: number,
    threshold: number,
    maxRelated: number,
    traverse: boolean,
  ): Promise<RecallResult[]> {
    const db = this.requireDb();
    const provider = this.embeddingProvider!;
    const queryEmbedding = await provider.embed(query.query);

    // Fetch all memories matching the structured filters.
    const rows = db
      .prepare(`SELECT * FROM memories WHERE ${whereSql}`)
      .all(...params) as unknown as MemoryRow[];

    // Separately run FTS5 to discover keyword matches (for memories without
    // embeddings, and as a relevance signal boost).
    const keywordIds = await this.ftsMatchIds(query.query, whereSql, params);

    interface Scored {
      row: MemoryRow;
      relevance: number;
      matchedBy: "semantic" | "keyword";
    }
    const scored: Scored[] = [];

    for (const row of rows) {
      const embedding = embeddingFromBuffer(row.embedding as unknown as Uint8Array);
      if (embedding) {
        const sim = cosineSimilarity(queryEmbedding, embedding);
        if (sim < threshold) continue;
        scored.push({ row, relevance: sim, matchedBy: "semantic" });
      } else if (keywordIds.has(row.id)) {
        // No embedding but keyword-matched — baseline relevance below the
        // semantic threshold so semantic hits always rank higher.
        const rel = 0.3;
        if (rel < threshold) continue;
        scored.push({ row, relevance: rel, matchedBy: "keyword" });
      }
    }

    // Rank by finalScore = relevance * storedWeight (equivalent to
    // computeWeight(memory, relevance, config) since storedWeight uses
    // relevance=1.0).
    scored.sort((a, b) => {
      const fa = a.relevance * a.row.weight;
      const fb = b.relevance * b.row.weight;
      return fb - fa;
    });

    const top = scored.slice(0, limit);
    if (top.length === 0) return [];

    return this.finalizeRecallResults(top, query.query, traverse, maxRelated);
  }

  /**
   * Keyword-only recall: FTS5 bm25 scoring with weight-weighted ranking.
   * Used when no embedding provider is configured (or failed to load).
   */
  private async recallKeyword(
    query: RecallQuery,
    _whereSql: string,
    _params: unknown[],
    limit: number,
    threshold: number,
    maxRelated: number,
    traverse: boolean,
  ): Promise<RecallResult[]> {
    const db = this.requireDb();
    const ftsQuery = buildFtsQuery(query.query);
    if (ftsQuery === "") return [];

    // Rebuild the structured filter with the `m.` prefix to avoid ambiguity
    // between memories_fts.tags and memories.tags.
    const { whereSql: mWhereSql, params: mParams } = this.buildRecallFilter(query, "m.");

    // We need to join memories_fts with memories to apply the structured
    // filters AND get the bm25 score. FTS5's bm25() returns negative values
    // (more negative = better match), so we negate for "higher = better".
    const rows = db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS fts_score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${mWhereSql}
         ORDER BY fts_score ASC
         LIMIT 100`,
      )
      .all(ftsQuery, ...mParams) as unknown as Array<MemoryRow & { fts_score: number }>;

    if (rows.length === 0) return [];

    // Normalize bm25 to a 0..1 relevance score (best match → 1.0).
    const rawScores = rows.map((r) => -r.fts_score);
    const maxRaw = Math.max(...rawScores, 1e-9);

    interface Scored {
      row: MemoryRow & { fts_score: number };
      relevance: number;
      matchedBy: "keyword";
    }
    const scored: Scored[] = [];
    for (let i = 0; i < rows.length; i++) {
      const relevance = rawScores[i] / maxRaw;
      if (relevance < threshold) continue;
      scored.push({ row: rows[i], relevance, matchedBy: "keyword" });
    }

    scored.sort((a, b) => {
      const fa = a.relevance * a.row.weight;
      const fb = b.relevance * b.row.weight;
      return fb - fa;
    });

    const top = scored.slice(0, limit);
    if (top.length === 0) return [];

    return this.finalizeRecallResults(top, query.query, traverse, maxRelated);
  }

  /**
   * Shared post-processing: build RecallResult objects, bump access_count +
   * recompute weight, and optionally traverse one-hop relationships.
   */
  private async finalizeRecallResults(
    scored: Array<{ row: MemoryRow; relevance: number; matchedBy: "semantic" | "keyword" }>,
    _queryText: string,
    traverse: boolean,
    maxRelated: number,
  ): Promise<RecallResult[]> {
    const db = this.requireDb();
    const now = new Date().toISOString();
    const bumpStmt = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, weight = ?, updated_at = ? WHERE id = ?",
    );

    const results: RecallResult[] = [];
    const resultIds = new Set<string>();

    for (const { row, relevance, matchedBy } of scored) {
      // Recompute weight with the bumped access_count (relevance factor = 1.0
      // to preserve the stored "intrinsic" weight semantics).
      const newWeight = computeWeight(
        {
          createdAt: row.created_at,
          accessCount: row.access_count + 1,
          reinforcementCount: row.reinforcement_count,
          confidence: row.confidence,
        },
        1.0,
        { decayHalfLifeDays: this.decayHalfLifeDays },
      );
      bumpStmt.run(newWeight, now, row.id);

      const memory = rowToMemory({ ...row, access_count: row.access_count + 1, weight: newWeight });
      resultIds.add(memory.id);
      results.push({
        memory,
        score: relevance * row.weight,
        matchedBy,
        related: [],
      });
    }

    // Relationship traversal (one-hop, both directions).
    if (traverse && results.length > 0) {
      for (const result of results) {
        const related = this.fetchRelatedMemories(result.memory.id, maxRelated, resultIds);
        result.related = related;
        for (const r of related) resultIds.add(r.id);
      }
    }

    return results;
  }

  /**
   * Fetch one-hop related memories (both outgoing + incoming edges) for a
   * given memory, excluding IDs already in the `exclude` set, capped at
   * `maxRelated`.
   */
  private fetchRelatedMemories(memoryId: string, maxRelated: number, exclude: Set<string>): Memory[] {
    const db = this.requireDb();
    const outRows = db
      .prepare(
        `SELECT m.* FROM relationships r
         JOIN memories m ON m.id = r.target_id AND m.status = 'active'
         WHERE r.source_id = ?`,
      )
      .all(memoryId) as unknown as MemoryRow[];
    const inRows = db
      .prepare(
        `SELECT m.* FROM relationships r
         JOIN memories m ON m.id = r.source_id AND m.status = 'active'
         WHERE r.target_id = ?`,
      )
      .all(memoryId) as unknown as MemoryRow[];

    const seen = new Set<string>();
    const related: Memory[] = [];
    for (const row of [...outRows, ...inRows]) {
      if (exclude.has(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      related.push(rowToMemory(row));
      if (related.length >= maxRelated) break;
    }
    return related;
  }

  /**
   * Run an FTS5 MATCH against the query text and return the set of memory IDs
   * that match. Used as the keyword fallback signal in semantic recall.
   */
  private async ftsMatchIds(queryText: string, whereSql: string, params: unknown[]): Promise<Set<string>> {
    const db = this.requireDb();
    const ftsQuery = buildFtsQuery(queryText);
    if (ftsQuery === "") return new Set();
    const rows = db
      .prepare(
        `SELECT m.id FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${whereSql}`,
      )
      .all(ftsQuery, ...params) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Structured search with filters (scope, types, tags, minWeight, date
   * range), sorting (weight/created/updated/confidence), and pagination.
   * Unlike {@link recall}, search does not embed the query or traverse
   * relationships — it is a deterministic filtered query.
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const db = this.requireDb();

    const where: string[] = ["status = 'active'"];
    const params: unknown[] = [];

    // Scope filter.
    const scope = query.scope ?? "all";
    if (scope === "project") {
      const pid = this.config.projectId ?? null;
      where.push("project_id IS ?");
      params.push(pid);
    } else if (scope === "global") {
      where.push("project_id IS NULL");
    } else {
      // scope === "all" → current project + global (NOT other projects).
      const pid = this.config.projectId ?? null;
      where.push("(project_id IS ? OR project_id IS NULL)");
      params.push(pid);
    }

    // Types filter (multiple).
    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => "?").join(", ");
      where.push(`type IN (${placeholders})`);
      params.push(...query.types);
    }

    // Tags filter (OR semantics — match any of the provided tags).
    if (query.tags && query.tags.length > 0) {
      const tagClauses = query.tags.map(() => "tags LIKE ?");
      where.push(`(${tagClauses.join(" OR ")})`);
      for (const tag of query.tags) {
        params.push(`%"${tag.replace(/[%_\\]/g, (c) => "\\" + c)}"%`);
      }
    }

    // minWeight filter.
    if (typeof query.minWeight === "number") {
      where.push("weight >= ?");
      params.push(query.minWeight);
    }

    // createdAfter / createdBefore.
    if (query.createdAfter) {
      where.push("created_at >= ?");
      params.push(query.createdAfter);
    }
    if (query.createdBefore) {
      where.push("created_at <= ?");
      params.push(query.createdBefore);
    }

    const whereSql = where.join(" AND ");
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    // Sorting.
    const sortBy = query.sortBy ?? "weight";
    const sortOrder = query.sortOrder ?? "desc";
    const sortColumn =
      sortBy === "created"
        ? "created_at"
        : sortBy === "updated"
          ? "updated_at"
          : sortBy === "confidence"
            ? "confidence"
            : "weight";
    const sortDir = sortOrder === "asc" ? "ASC" : "DESC";

    // Total count.
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereSql}`)
      .get(...params) as { c: number } | undefined;
    const total = countRow?.c ?? 0;

    // Page.
    const rows = db
      .prepare(
        `SELECT * FROM memories WHERE ${whereSql} ORDER BY ${sortColumn} ${sortDir} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as MemoryRow[];

    const memories = rows.map(rowToMemory);

    return { memories, total, offset, limit };
  }

  /**
   * Create a typed, directed relationship between two active memories.
   * Rejects self-relationships and duplicate (source, target, type) triples.
   * `reinforces` boosts the source's confidence (diminishing returns) and
   * bumps its `reinforcementCount`; `contradicts` decays the target's
   * confidence by 10% of its current value. Both recompute the affected
   * memory's weight. The other types are structural only.
   */
  async relate(
    sourceId: string,
    targetId: string,
    type: RelationshipType,
  ): Promise<Relationship> {
    const db = this.requireDb();

    // 1. Validate source exists and is active.
    const sourceRow = db
      .prepare("SELECT id FROM memories WHERE id = ? AND status = 'active'")
      .get(sourceId) as { id: string } | undefined;
    if (!sourceRow) {
      throw new MemoryNotFoundError(sourceId);
    }

    // 2. Validate target exists and is active.
    const targetRow = db
      .prepare("SELECT id FROM memories WHERE id = ? AND status = 'active'")
      .get(targetId) as { id: string } | undefined;
    if (!targetRow) {
      throw new MemoryNotFoundError(targetId);
    }

    // 3. Reject self-relationships.
    if (sourceId === targetId) {
      throw new SelfRelationshipError(sourceId);
    }

    // 4. Reject duplicates (same source, target, type).
    const existing = db
      .prepare(
        "SELECT id FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?",
      )
      .get(sourceId, targetId, type) as { id: string } | undefined;
    if (existing) {
      throw new DuplicateRelationshipError(sourceId, targetId, type);
    }

    // 5. Insert the relationship edge.
    const relId = generateUlid();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO relationships (id, source_id, target_id, type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(relId, sourceId, targetId, type, now);

    // 6. Apply confidence side effects based on relationship type.
    if (type === "reinforces") {
      // Boost the SOURCE memory's confidence (diminishing returns) + bump
      // reinforcement_count, then recompute its weight.
      const src = db
        .prepare(
          "SELECT created_at, access_count, reinforcement_count, confidence FROM memories WHERE id = ?",
        )
        .get(sourceId) as {
          created_at: string;
          access_count: number;
          reinforcement_count: number;
          confidence: number;
        };
      const newConfidence = src.confidence + 0.1 * (1 - src.confidence);
      const clampedConfidence = Math.max(0, Math.min(1, newConfidence));
      const newReinforcementCount = src.reinforcement_count + 1;
      const newWeight = computeWeight(
        {
          createdAt: src.created_at,
          accessCount: src.access_count,
          reinforcementCount: newReinforcementCount,
          confidence: clampedConfidence,
        },
        1.0,
        { decayHalfLifeDays: this.decayHalfLifeDays },
      );
      db.prepare(
        "UPDATE memories SET reinforcement_count = ?, confidence = ?, weight = ?, updated_at = ? WHERE id = ?",
      ).run(newReinforcementCount, clampedConfidence, newWeight, now, sourceId);
    } else if (type === "contradicts") {
      // Decay the TARGET memory's confidence by 10% of its current value, then
      // recompute its weight. The SOURCE is unaffected.
      const tgt = db
        .prepare(
          "SELECT created_at, access_count, reinforcement_count, confidence FROM memories WHERE id = ?",
        )
        .get(targetId) as {
          created_at: string;
          access_count: number;
          reinforcement_count: number;
          confidence: number;
        };
      const newConfidence = tgt.confidence - 0.1 * tgt.confidence;
      const clampedConfidence = Math.max(0, Math.min(1, newConfidence));
      const newWeight = computeWeight(
        {
          createdAt: tgt.created_at,
          accessCount: tgt.access_count,
          reinforcementCount: tgt.reinforcement_count,
          confidence: clampedConfidence,
        },
        1.0,
        { decayHalfLifeDays: this.decayHalfLifeDays },
      );
      db.prepare(
        "UPDATE memories SET confidence = ?, weight = ?, updated_at = ? WHERE id = ?",
      ).run(clampedConfidence, newWeight, now, targetId);
    }
    // "extends", "exception_to", "derived_from" — no confidence side effects.

    // 7. Return the Relationship object.
    return {
      id: relId,
      sourceId,
      targetId,
      type,
      createdAt: now,
    };
  }

  /**
   * Patch an existing active memory. Content is scrubbed; tags are replaced
   * (not merged); metadata is merged with existing. `reinforce: true` bumps
   * `reinforcementCount` and boosts confidence (diminishing returns). Any
   * confidence change recomputes the composite weight. Throws
   * {@link MemoryNotFoundError} / {@link InvalidConfidenceError} as appropriate.
   */
  async update(id: string, patch: UpdatePatch): Promise<Memory> {
    const db = this.requireDb();

    // 1. Load the existing active memory.
    const row = db
      .prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'")
      .get(id) as MemoryRow | undefined;
    if (!row) {
      throw new MemoryNotFoundError(id);
    }

    // 2. Validate confidence if provided.
    if (
      typeof patch.confidence === "number" &&
      (Number.isNaN(patch.confidence) ||
        patch.confidence < 0 ||
        patch.confidence > 1)
    ) {
      throw new InvalidConfidenceError(patch.confidence);
    }

    // 3. Build the set clauses.
    const sets: string[] = [];
    const params: unknown[] = [];

    // content (scrubbed).
    if (typeof patch.content === "string") {
      const content = scrubSecrets(patch.content);
      sets.push("content = ?");
      params.push(content);
    }

    // confidence (explicit patch value; may be overridden by reinforce below).
    let newConfidence: number | undefined;
    if (typeof patch.confidence === "number") {
      newConfidence = patch.confidence;
    }

    // tags (replace, not merge).
    if (Array.isArray(patch.tags)) {
      sets.push("tags = ?");
      params.push(JSON.stringify(patch.tags));
    }

    // metadata (merge with existing).
    if (patch.metadata && typeof patch.metadata === "object") {
      let existingMetadata: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existingMetadata = parsed as Record<string, unknown>;
        }
      } catch {
        existingMetadata = {};
      }
      const mergedMetadata: Record<string, unknown> = {
        ...existingMetadata,
        ...patch.metadata,
      };
      sets.push("metadata = ?");
      params.push(JSON.stringify(mergedMetadata));
    }

    // 4. Reinforce: bump reinforcement_count + boost confidence (diminishing returns).
    let reinforcementIncrement = 0;
    if (patch.reinforce === true) {
      reinforcementIncrement = 1;
      const base = typeof newConfidence === "number" ? newConfidence : row.confidence;
      newConfidence = base + 0.1 * (1 - base);
      // Clamp to [0, 1] to guard against floating-point drift at the extremes.
      if (newConfidence > 1) newConfidence = 1;
      if (newConfidence < 0) newConfidence = 0;
    }

    if (typeof newConfidence === "number") {
      sets.push("confidence = ?");
      params.push(newConfidence);
    }

    if (reinforcementIncrement > 0) {
      sets.push("reinforcement_count = reinforcement_count + ?");
      params.push(reinforcementIncrement);
    }

    // 4b. Recompute weight when reinforcing (or when confidence changed).
    if (patch.reinforce === true || typeof newConfidence === "number") {
      const projectedMemory = {
        createdAt: row.created_at,
        accessCount: row.access_count,
        reinforcementCount: row.reinforcement_count + reinforcementIncrement,
        confidence: typeof newConfidence === "number" ? newConfidence : row.confidence,
      };
      const newWeight = computeWeight(projectedMemory, 1.0, {
        decayHalfLifeDays: this.decayHalfLifeDays,
      });
      sets.push("weight = ?");
      params.push(newWeight);
    }

    // 5. Always update updated_at.
    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    params.push(now);

    // 6. Execute the UPDATE.
    params.push(id);
    db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    // 7. Re-read and return.
    const updated = db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    if (!updated) {
      throw new MemoryStoreError(`Failed to read back updated memory: ${id}`);
    }
    return rowToMemory(updated);
  }

  /**
   * Read a key from the durable `meta` key-value table. Returns `null` when
   * the key has never been set. Used for rate-limiting and persisted settings
   * that must survive process restarts (e.g. `decay:lastRun`).
   */
  async getMeta(key: string): Promise<string | null> {
    const db = this.requireDb();
    const row = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? (row.value as string) : null;
  }

  /**
   * Write a key to the durable `meta` key-value table, replacing any existing
   * value for the same key.
   */
  async setMeta(key: string, value: string): Promise<void> {
    const db = this.requireDb();
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    ).run(key, value);
  }

  /**
   * Recompute every active memory's composite weight and archive any whose
   * weight has dropped below the configured `archiveThreshold`. Call this on a
   * timer in a long-lived app to keep the store from accumulating stale,
   * low-weight memories.
   */
  async decay(): Promise<void> {
    const db = this.requireDb();

    const rows = db
      .prepare(
        `SELECT id, created_at, access_count, reinforcement_count, confidence
         FROM memories WHERE status = 'active'`,
      )
      .all() as Array<{
        id: string;
        created_at: string;
        access_count: number;
        reinforcement_count: number;
        confidence: number;
      }>;

    const archiveThreshold = this.archiveThreshold;
    const halfLifeDays = this.decayHalfLifeDays;
    const archiveStmt = db.prepare(
      `UPDATE memories SET status = 'archived', weight = ? WHERE id = ?`,
    );
    const updateStmt = db.prepare(`UPDATE memories SET weight = ? WHERE id = ?`);

    for (const row of rows) {
      const weight = computeWeight(
        {
          createdAt: row.created_at,
          accessCount: row.access_count,
          reinforcementCount: row.reinforcement_count,
          confidence: row.confidence,
        },
        1.0,
        { decayHalfLifeDays: halfLifeDays },
      );
      if (weight < archiveThreshold) {
        archiveStmt.run(weight, row.id);
      } else {
        updateStmt.run(weight, row.id);
      }
    }
  }

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
  async maybeDecay(lastRunKey: string, intervalHours: number): Promise<boolean> {
    const now = Date.now();
    const lastRunRaw = await this.getMeta(lastRunKey);
    if (lastRunRaw !== null) {
      const lastRun = new Date(lastRunRaw).getTime();
      if (
        !Number.isNaN(lastRun) &&
        now - lastRun < intervalHours * 60 * 60 * 1000
      ) {
        // Still within the interval — skip.
        return false;
      }
    }

    // Interval elapsed (or never run) — decay now and record the timestamp.
    await this.decay();
    await this.setMeta(lastRunKey, new Date(now).toISOString());
    return true;
  }

  /**
   * Read-only aggregate statistics for the graph browser's sidebar readout:
   * total active memories, counts per type, counts per scope, and total
   * relationships. Does not mutate any row.
   */
  async getStats(): Promise<{
    totalMemories: number;
    byType: Record<string, number>;
    byScope: { project: number; global: number };
    totalRelationships: number;
  }> {
    const db = this.requireDb();
    const totalMemories = (
      db
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE status = 'active'")
        .get() as { c: number }
    ).c;
    const typeRows = db
      .prepare(
        "SELECT type, COUNT(*) AS c FROM memories WHERE status = 'active' GROUP BY type",
      )
      .all() as Array<{ type: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const r of typeRows) byType[r.type] = r.c;
    const projectCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE status = 'active' AND project_id IS NOT NULL",
        )
        .get() as { c: number }
    ).c;
    const globalCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE status = 'active' AND project_id IS NULL",
        )
        .get() as { c: number }
    ).c;
    const totalRelationships = (
      db.prepare("SELECT COUNT(*) AS c FROM relationships").get() as { c: number }
    ).c;
    return {
      totalMemories,
      byType,
      byScope: { project: projectCount, global: globalCount },
      totalRelationships,
    };
  }

  /**
   * Read-only full-text search returning memories ranked by bm25 relevance,
   * WITHOUT bumping `access_count` or recomputing weight (the key difference
   * from {@link recall}, which mutates). Used by the graph browser's text
   * filter so browsing does not distort the decay/recency signals. Returns an
   * empty array for a query with no usable tokens.
   */
  async searchText(query: string, limit?: number): Promise<Memory[]> {
    const db = this.requireDb();
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === "") return [];
    const cap = limit ?? 100;
    const rows = db
      .prepare(
        `SELECT m.* FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active'
         ORDER BY bm25(memories_fts) ASC
         LIMIT ?`,
      )
      .all(ftsQuery, cap) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Read-only bulk fetch of all relationships whose `source_id` OR `target_id`
   * is in the supplied `nodeIds` set. Used by the graph browser to draw edges
   * between the currently-visible nodes without N per-node `get()` calls. Does
   * not mutate any row. Returns an empty array for an empty input set.
   */
  async getRelationshipsForNodes(nodeIds: string[]): Promise<Relationship[]> {
    const db = this.requireDb();
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, source_id, target_id, type, created_at FROM relationships
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      )
      .all(...nodeIds, ...nodeIds) as Array<{
      id: string;
      source_id: string;
      target_id: string;
      type: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type as RelationshipType,
      createdAt: r.created_at,
    }));
  }

  /** Close the database handle. Safe to call multiple times; no-op if already closed. */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private requireDb(): DbConnection {
    if (!this.db) {
      throw new MemoryStoreError("MemoryStore is not initialized. Call init() first.");
    }
    return this.db;
  }
}
