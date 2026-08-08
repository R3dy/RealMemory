import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { MemoryStoreError, MemoryNotFoundError, InvalidTypeError, InvalidConfidenceError } from "./errors";
import type { DbConnection } from "./db/connection";
import { openDatabase } from "./db/dialect";
import { runMigrations } from "./db/schema";
import { generateUlid } from "./db/ulid";
import { scrubSecrets } from "./scrub";

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
    this.config = config ?? {};
  }

  async init(): Promise<void> {
    const storagePath = resolve(
      this.config.storagePath ?? DEFAULT_STORAGE_PATH,
    );
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

    // 8. Initial weight = confidence.
    const weight = confidence;

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
    }
    // "all" → no scope filter.

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

  async search(_query: SearchQuery): Promise<SearchResult> {
    throw new NotImplementedError("search");
  }

  async relate(
    _sourceId: string,
    _targetId: string,
    _type: RelationshipType,
  ): Promise<Relationship> {
    throw new NotImplementedError("relate");
  }

  async update(_id: string, _patch: UpdatePatch): Promise<Memory> {
    throw new NotImplementedError("update");
  }

  async decay(): Promise<void> {
    throw new NotImplementedError("decay");
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
