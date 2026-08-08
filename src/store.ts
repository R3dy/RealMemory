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
import { NotImplementedError } from "./errors";
import { MemoryStoreError, MemoryNotFoundError, InvalidTypeError, InvalidConfidenceError, DuplicateRelationshipError, SelfRelationshipError } from "./errors";
import type { DbConnection } from "./db/connection";
import { openDatabase } from "./db/dialect";
import { runMigrations } from "./db/schema";
import { generateUlid } from "./db/ulid";
import { scrubSecrets } from "./scrub";
import { computeWeight } from "./weighting";
import { loadConfig, validateConfig } from "./config";

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
    embedding = Array.from(row.embedding as unknown as ArrayLike<number>);
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

export class MemoryStore {
  private config: MemoryStoreConfig;
  private db: DbConnection | null = null;

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
  }

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

    // 3. Identity + timestamps.
    const id = generateUlid();
    const now = new Date().toISOString();

    // 5. Scope + project_id.
    const scope: MemoryScope = input.scope ?? "project";
    const projectId = scope === "global" ? null : this.config.projectId ?? null;

    // 6. Scrub secrets from content.
    const content = scrubSecrets(input.content);

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

  async recall(_query: RecallQuery): Promise<RecallResult[]> {
    throw new NotImplementedError("recall");
  }

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
