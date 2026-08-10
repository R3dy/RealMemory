/**
 * Schema definition and migration runner for the realmemory SQLite database.
 */

import type { DbConnection } from "./connection";

/**
 * Schema version 1 — the initial schema.
 *
 * Tables:
 *  - schema_version: tracks applied migrations
 *  - memories:        core memory records
 *  - relationships:   directed edges between memories
 *  - memories_fts:    FTS5 full-text index on memories(content, tags)
 *
 * Triggers keep the FTS index in sync with the memories table.
 */
export const SCHEMA_V1 = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Memories table
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  tags TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  reinforcement_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  embedding BLOB,
  status TEXT NOT NULL DEFAULT 'active',
  project_id TEXT
);

-- Relationships table
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES memories(id),
  FOREIGN KEY (target_id) REFERENCES memories(id),
  UNIQUE(source_id, target_id, type)
);

-- FTS5 full-text search on memory content and tags
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_weight ON memories(weight);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
`;

/**
 * Schema version 2 — adds the `meta` key-value table.
 *
 * The meta table stores small durable key/value settings used by the store,
 * e.g. `decay:lastRun` (the ISO timestamp of the most recent decay pass),
 * so that rate-limiting survives process restarts against the same DB file.
 */
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Migrations map: version -> SQL to apply.
 * Each migration runs only if its version is not already in schema_version.
 */
const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
};

/**
 * Run all pending migrations. Each migration is applied in version order and
 * recorded in the schema_version table. Migrations are idempotent (all
 * statements use IF NOT EXISTS), so re-running on an already-migrated DB is
 * a no-op that still records the version row.
 */
export function runMigrations(db: DbConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const applied = new Set<number>();
  const rows = db
    .prepare("SELECT version FROM schema_version")
    .all() as { version: number }[];
  for (const row of rows) {
    applied.add(row.version);
  }

  const versions = Object.keys(MIGRATIONS)
    .map((v) => Number(v))
    .sort((a, b) => a - b);

  for (const v of versions) {
    if (!applied.has(v)) {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v);
    }
  }
}
