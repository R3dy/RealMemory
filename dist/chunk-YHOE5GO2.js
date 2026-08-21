import {
  cosineSimilarity,
  embeddingFromBuffer,
  embeddingToBuffer
} from "./chunk-B5S5KXU7.js";

// src/errors.ts
var NotImplementedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "NotImplementedError";
  }
};
var MemoryStoreError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryStoreError";
  }
};
var MemoryNotFoundError = class extends MemoryStoreError {
  constructor(id) {
    super(`Memory not found: ${id}`);
    this.name = "MemoryNotFoundError";
  }
};
var InvalidTypeError = class extends MemoryStoreError {
  constructor(type) {
    super(`Invalid memory type: ${type}`);
    this.name = "InvalidTypeError";
  }
};
var InvalidConfidenceError = class extends MemoryStoreError {
  constructor(value) {
    super(`Invalid confidence value: ${value}. Must be in [0, 1]`);
    this.name = "InvalidConfidenceError";
  }
};
var DuplicateRelationshipError = class extends MemoryStoreError {
  constructor(sourceId, targetId, type) {
    super(
      `Duplicate relationship: ${sourceId} -> ${targetId} (${type}) already exists`
    );
    this.name = "DuplicateRelationshipError";
  }
};
var SelfRelationshipError = class extends MemoryStoreError {
  constructor(id) {
    super(`Cannot create relationship from a memory to itself: ${id}`);
    this.name = "SelfRelationshipError";
  }
};

// src/scrub.ts
var SECRET_PATTERNS = [
  // AWS access keys.
  /AKIA[0-9A-Z]{16}/g,
  // AWS secret keys (40-char base64 after an aws_secret_access_key assignment).
  /aws_secret_access_key["\s:=]+["']?[A-Za-z0-9/+=]{40}/gi,
  // GitHub personal access tokens.
  /ghp_[a-zA-Z0-9]{36}/g,
  // GitHub OAuth tokens.
  /gho_[a-zA-Z0-9]{36}/g,
  // GitHub app tokens.
  /ghs_[a-zA-Z0-9]{36}/g,
  // GitHub refresh tokens.
  /ghr_[a-zA-Z0-9]{76}/g,
  // OpenAI API keys.
  /sk-[a-zA-Z0-9]{48}/g,
  // Slack tokens (bot, user, app, oauth, legacy).
  /xox[bpoa]-[a-zA-Z0-9-]+/g,
  // Bearer tokens.
  /Bearer\s+[a-zA-Z0-9_\-.=]+/g,
  // Private keys (PEM format, any key type).
  /-----BEGIN\s+[A-Z\s]+PRIVATE\s+KEY-----[\s\S]*?-----END\s+[A-Z\s]+PRIVATE\s+KEY-----/g,
  // Generic password assignments (quoted or bare value, >= 4 chars).
  /(password|passwd|pwd)["\s:=]+["']?[^\s"']{4,}/gi,
  // Generic API key / token / secret assignments (quoted or bare value >= 20 chars).
  /(api_key|apikey|api-key|access_token|access-token|secret_key|secret-key)["\s:=]+["']?[a-zA-Z0-9_\-]{20,}/gi
];
function scrubSecrets(content) {
  let scrubbed = content;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, "[REDACTED]");
  }
  return scrubbed;
}

// src/weighting.ts
function computeWeight(memory, relevanceScore, config) {
  const recencyFactor = computeRecencyFactor(memory.createdAt, config.decayHalfLifeDays);
  const relevanceFactor = clamp01(relevanceScore);
  const frequencyFactor = computeFrequencyFactor(memory.accessCount, memory.reinforcementCount);
  const confidenceFactor = clamp01(memory.confidence);
  return clamp01(recencyFactor * relevanceFactor * frequencyFactor * confidenceFactor);
}
function computeRecencyFactor(createdAt, halfLifeDays) {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1e3 * 60 * 60 * 24);
  return Math.exp(-ageDays / halfLifeDays);
}
function computeFrequencyFactor(accessCount, reinforcementCount) {
  const maxExpected = 100;
  const ratio = Math.log(1 + accessCount + reinforcementCount) / Math.log(1 + maxExpected);
  return clamp01(0.5 + 0.5 * ratio);
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

// src/config.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
var DEFAULTS = {
  storagePath: "~/.opencode/realmemory/data.db",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  decayHalfLifeDays: 30,
  decayIntervalHours: 24,
  recallThreshold: 0.3,
  duplicateSimilarityThreshold: 0.92,
  crossProjectPromotionThreshold: 2,
  maxRecallResults: 5,
  autoCapture: true,
  autoSummarize: false,
  archiveThreshold: 0.05,
  maxRelatedPerMemory: 3,
  autoStartBrowser: true,
  concisenessCap: 280,
  autoRelate: true,
  brainLoop: true,
  compactingIntervalHours: 4
};
function loadConfig(projectDir) {
  let config = {};
  const globalPath = join(homedir(), ".config", "opencode", "realmemory.json");
  if (existsSync(globalPath)) {
    try {
      config = { ...config, ...readJsonFile(globalPath) };
    } catch {
    }
  }
  const projectPath = join(
    projectDir || process.cwd(),
    ".realmemory",
    "config.json"
  );
  if (existsSync(projectPath)) {
    try {
      config = { ...config, ...readJsonFile(projectPath) };
    } catch {
    }
  }
  return { ...DEFAULTS, ...config };
}
function validateConfig(config) {
  if (config.decayHalfLifeDays !== void 0 && config.decayHalfLifeDays <= 0) {
    throw new Error("decayHalfLifeDays must be > 0");
  }
  if (config.decayIntervalHours !== void 0 && (config.decayIntervalHours <= 0 || Number.isNaN(config.decayIntervalHours))) {
    throw new Error("decayIntervalHours must be > 0");
  }
  if (config.recallThreshold !== void 0 && (config.recallThreshold < 0 || config.recallThreshold > 1)) {
    throw new Error("recallThreshold must be in [0, 1]");
  }
  if (config.duplicateSimilarityThreshold !== void 0 && (config.duplicateSimilarityThreshold < 0 || config.duplicateSimilarityThreshold > 1)) {
    throw new Error("duplicateSimilarityThreshold must be in [0, 1]");
  }
  if (config.crossProjectPromotionThreshold !== void 0 && (!Number.isInteger(config.crossProjectPromotionThreshold) || config.crossProjectPromotionThreshold < 1)) {
    throw new Error("crossProjectPromotionThreshold must be a positive integer");
  }
  if (config.archiveThreshold !== void 0 && (config.archiveThreshold < 0 || config.archiveThreshold > 1)) {
    throw new Error("archiveThreshold must be in [0, 1]");
  }
  if (config.maxRecallResults !== void 0 && config.maxRecallResults < 0) {
    throw new Error("maxRecallResults must be >= 0");
  }
  if (config.autoStartBrowser !== void 0 && typeof config.autoStartBrowser !== "boolean") {
    throw new Error("autoStartBrowser must be a boolean");
  }
  if (config.concisenessCap !== void 0 && (config.concisenessCap <= 0 || !Number.isFinite(config.concisenessCap))) {
    throw new Error("concisenessCap must be > 0");
  }
  if (config.compactingIntervalHours !== void 0 && (config.compactingIntervalHours <= 0 || Number.isNaN(config.compactingIntervalHours))) {
    throw new Error("compactingIntervalHours must be > 0");
  }
  if (config.autoRelate !== void 0 && typeof config.autoRelate !== "boolean") {
    throw new Error("autoRelate must be a boolean");
  }
  if (config.brainLoop !== void 0 && typeof config.brainLoop !== "boolean") {
    throw new Error("brainLoop must be a boolean");
  }
  if (config.brain?.predictionError !== void 0 && typeof config.brain.predictionError !== "boolean") {
    throw new Error("brain.predictionError must be a boolean");
  }
  if (config.brain?.inhibition !== void 0) {
    const valid = ["off", "warn", "rewrite", "block"];
    if (!valid.includes(config.brain.inhibition)) {
      throw new Error(`brain.inhibition must be one of: ${valid.join(", ")}`);
    }
  }
  if (config.brain?.arousalModulation !== void 0 && typeof config.brain.arousalModulation !== "boolean") {
    throw new Error("brain.arousalModulation must be a boolean");
  }
  if (config.brain?.toolDefinitionNotes !== void 0 && typeof config.brain.toolDefinitionNotes !== "boolean") {
    throw new Error("brain.toolDefinitionNotes must be a boolean");
  }
  if (config.brain?.schemaFormation !== void 0 && typeof config.brain.schemaFormation !== "boolean") {
    throw new Error("brain.schemaFormation must be a boolean");
  }
  if (config.brain?.schemaFormationThreshold !== void 0 && (typeof config.brain.schemaFormationThreshold !== "number" || config.brain.schemaFormationThreshold < 0.5 || config.brain.schemaFormationThreshold > 1)) {
    throw new Error("brain.schemaFormationThreshold must be a number in [0.5, 1]");
  }
  if (config.brain?.schemaFormationMinCluster !== void 0 && (!Number.isInteger(config.brain.schemaFormationMinCluster) || config.brain.schemaFormationMinCluster < 2)) {
    throw new Error("brain.schemaFormationMinCluster must be an integer >= 2");
  }
  if (config.brain?.workingMemory !== void 0 && typeof config.brain.workingMemory !== "boolean") {
    throw new Error("brain.workingMemory must be a boolean");
  }
  if (config.brain?.workingMemoryTokens !== void 0) {
    if (typeof config.brain.workingMemoryTokens !== "number" || config.brain.workingMemoryTokens < 200 || config.brain.workingMemoryTokens > 4e3) {
      throw new Error("brain.workingMemoryTokens must be a number in [200, 4000]");
    }
  }
  if (config.brain?.events !== void 0 && typeof config.brain.events !== "boolean") {
    throw new Error("brain.events must be a boolean");
  }
  if (config.brain?.eventRetention !== void 0) {
    if (!Number.isInteger(config.brain.eventRetention) || config.brain.eventRetention < 1e3) {
      throw new Error("brain.eventRetention must be an integer >= 1000");
    }
  }
  if (config.brain?.selfModel !== void 0 && typeof config.brain.selfModel !== "boolean") {
    throw new Error("brain.selfModel must be a boolean");
  }
  if (config.brain?.identityTokens !== void 0) {
    if (typeof config.brain.identityTokens !== "number" || config.brain.identityTokens < 100 || config.brain.identityTokens > 1e3) {
      throw new Error("brain.identityTokens must be a number in [100, 1000]");
    }
  }
  if (config.brain?.traits !== void 0 && typeof config.brain.traits !== "boolean") {
    throw new Error("brain.traits must be a boolean");
  }
  if (config.brain?.traitLearningRate !== void 0) {
    if (typeof config.brain.traitLearningRate !== "number" || config.brain.traitLearningRate < 0 || config.brain.traitLearningRate > 0.05) {
      throw new Error(
        "brain.traitLearningRate must be a number in [0, 0.05]"
      );
    }
  }
}
function readJsonFile(path) {
  const content = readFileSync(path, "utf-8");
  const stripped = content.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

// src/embeddings.ts
async function createEmbeddingProvider(config) {
  if (config.embeddingApiUrl && config.embeddingApiKey) {
    return createRemoteProvider(config);
  }
  if (!config.embeddingModel) {
    return null;
  }
  try {
    return await createLocalProvider(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[realmemory] Failed to load local embedding model "${config.embeddingModel}": ${msg}. Falling back to keyword-only recall.`
    );
    return null;
  }
}
var MINILM_DIMENSIONS = 384;
async function createLocalProvider(config) {
  const { pipeline, env } = await import("@huggingface/transformers");
  if (config.storagePath) {
    const { dirname: dirname2, join: join3 } = await import("path");
    const { resolve: resolve2 } = await import("path");
    const { homedir: homedir3 } = await import("os");
    const raw = config.storagePath.startsWith("~") ? join3(homedir3(), config.storagePath.slice(1)) : resolve2(config.storagePath);
    env.cacheDir = dirname2(raw);
  }
  const model = config.embeddingModel || "Xenova/all-MiniLM-L6-v2";
  const extractor = await pipeline("feature-extraction", model);
  return {
    model,
    dimensions: MINILM_DIMENSIONS,
    async embed(text) {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      const data = output.data;
      return new Float32Array(data);
    }
  };
}
function createRemoteProvider(config) {
  const apiUrl = config.embeddingApiUrl;
  const apiKey = config.embeddingApiKey;
  const model = config.embeddingModel || "text-embedding-3-small";
  let cachedDims = 0;
  const embed = async (text) => {
    const url = apiUrl.endsWith("/") ? `${apiUrl}embeddings` : `${apiUrl}/embeddings`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, input: text })
    });
    if (!response.ok) {
      throw new Error(
        `Embedding API error: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    const vec = data.data[0]?.embedding;
    if (!vec || vec.length === 0) {
      throw new Error("Embedding API returned empty vector");
    }
    if (cachedDims === 0) cachedDims = vec.length;
    return new Float32Array(vec);
  };
  return {
    model,
    get dimensions() {
      return cachedDims;
    },
    embed
  };
}

// src/store.ts
import { mkdirSync } from "fs";
import { dirname, resolve, join as join2 } from "path";
import { homedir as homedir2 } from "os";

// src/db/dialect.ts
async function openDatabase(path) {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db2 = new Database(path);
    return wrapBunDb(db2);
  }
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const db = new BetterSqlite3(path);
  return wrapBetterSqlite3(db);
}
function wrapBunStatement(stmt) {
  return {
    all(...params) {
      return stmt.all(...params);
    },
    get(...params) {
      return stmt.get(...params);
    },
    run(...params) {
      return stmt.run(...params);
    }
  };
}
function wrapBunDb(db) {
  return {
    prepare(sql) {
      return wrapBunStatement(db.prepare(sql));
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    }
  };
}
function wrapBetterSqlite3(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        all(...params) {
          return stmt.all(...params);
        },
        get(...params) {
          return stmt.get(...params);
        },
        run(...params) {
          const res = stmt.run(...params);
          return {
            changes: res.changes,
            lastInsertRowid: typeof res.lastInsertRowid === "bigint" ? Number(res.lastInsertRowid) : res.lastInsertRowid
          };
        }
      };
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    }
  };
}

// src/db/schema.ts
var SCHEMA_V1 = `
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
var SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
var SCHEMA_V3 = `
-- Domain: primary technology/topic (e.g. "aws", "testing", "opencode")
ALTER TABLE memories ADD COLUMN domain TEXT;

-- Source: JSON { project, session, ref, refType } tracking origin
ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT '{}';

-- Category: sub-classification within type (e.g. "gotcha", "cost", "safety")
ALTER TABLE memories ADD COLUMN category TEXT;

-- Indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
`;
var SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  session_id TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_recorded ON metrics(recorded_at);
`;
var SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS brain_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_events_seq  ON brain_events(seq);
CREATE INDEX IF NOT EXISTS idx_brain_events_kind ON brain_events(kind);
`;
var MIGRATIONS = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
  3: SCHEMA_V3,
  4: SCHEMA_V4,
  5: SCHEMA_V5
};
function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const applied = /* @__PURE__ */ new Set();
  const rows = db.prepare("SELECT version FROM schema_version").all();
  for (const row of rows) {
    applied.add(row.version);
  }
  const versions = Object.keys(MIGRATIONS).map((v) => Number(v)).sort((a, b) => a - b);
  for (const v of versions) {
    if (!applied.has(v)) {
      db.exec(MIGRATIONS[v]);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v);
    }
  }
}

// src/db/ulid.ts
var ENCODE = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var TIME_LEN = 10;
var RAND_LEN = 16;
var lastTime = 0;
var lastRand = [];
function generateUlid() {
  const now = Date.now();
  let rand;
  if (now === lastTime) {
    rand = lastRand.slice();
    for (let i = RAND_LEN - 1; i >= 0; i--) {
      if (rand[i] === 31) {
        rand[i] = 0;
      } else {
        rand[i]++;
        break;
      }
    }
  } else {
    rand = new Array(RAND_LEN);
    for (let i = 0; i < RAND_LEN; i++) {
      rand[i] = Math.floor(Math.random() * 32);
    }
  }
  lastTime = now;
  lastRand = rand;
  let id = "";
  let ts = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = ts % 32;
    id = ENCODE[mod] + id;
    ts = Math.floor(ts / 32);
  }
  for (let i = 0; i < RAND_LEN; i++) {
    id += ENCODE[rand[i]];
  }
  return id;
}

// src/store.ts
var DEFAULT_STORAGE_PATH = resolve(
  homedir2(),
  ".opencode",
  "realmemory",
  "data.db"
);
var VALID_TYPES = /* @__PURE__ */ new Set([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note",
  "self_model"
]);
var PROMOTABLE_TYPES = /* @__PURE__ */ new Set([
  "user_preference",
  "task_pattern"
]);
var DEFAULT_LIMIT = 50;
var DUPLICATE_KEYWORD_RELEVANCE = 0.9;
var DUPLICATE_TOKEN_OVERLAP = 0.95;
function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 0);
}
function tokenOverlap(a, b) {
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
function buildFtsQuery(text) {
  const tokens = text.split(/\s+/).map((t) => t.replace(/["*:()\-]/g, "")).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
function parseMetadataJson(metadataJson) {
  try {
    const parsed = JSON.parse(metadataJson);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return {};
}
function parseSourceJson(sourceJson) {
  try {
    const parsed = JSON.parse(sourceJson);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return {};
}
function rowToMemory(row) {
  let tags;
  try {
    tags = JSON.parse(row.tags);
    if (!Array.isArray(tags)) tags = [];
  } catch {
    tags = [];
  }
  const metadata = parseMetadataJson(row.metadata);
  const source = parseSourceJson(row.source);
  let embedding;
  if (row.embedding) {
    const vec = embeddingFromBuffer(row.embedding);
    if (vec) {
      embedding = Array.from(vec);
    }
  }
  return {
    id: row.id,
    content: row.content,
    type: row.type,
    scope: row.scope,
    domain: row.domain ?? void 0,
    category: row.category ?? void 0,
    source,
    tags,
    weight: row.weight,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessCount: row.access_count,
    reinforcementCount: row.reinforcement_count,
    metadata,
    embedding,
    status: row.status
  };
}
function joinRowToEdge(row, memoryId) {
  const direction = row.rel_source === memoryId ? "outgoing" : "incoming";
  return {
    type: row.rel_type,
    direction,
    memory: rowToMemory(row)
  };
}
var MemoryStore = class {
  config;
  db = null;
  embeddingProvider = null;
  constructor(config) {
    const loaded = config ?? loadConfig();
    validateConfig(loaded);
    this.config = {
      decayHalfLifeDays: 30,
      archiveThreshold: 0.05,
      ...loaded
    };
  }
  get decayHalfLifeDays() {
    return this.config.decayHalfLifeDays ?? 30;
  }
  get archiveThreshold() {
    return this.config.archiveThreshold ?? 0.05;
  }
  get crossProjectPromotionThreshold() {
    return this.config.crossProjectPromotionThreshold ?? 2;
  }
  /**
   * Open the database, run migrations, and initialize the embedding provider.
   * Must be called exactly once before any other method. A failure to load a
   * local ONNX model degrades gracefully to keyword-only recall rather than
   * throwing.
   */
  async init() {
    const rawPath = this.config.storagePath ?? DEFAULT_STORAGE_PATH;
    const storagePath = rawPath.startsWith("~") ? join2(homedir2(), rawPath.slice(1)) : resolve(rawPath);
    const dir = dirname(storagePath);
    mkdirSync(dir, { recursive: true });
    const db = await openDatabase(storagePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    runMigrations(db);
    this.db = db;
    this.embeddingProvider = await createEmbeddingProvider(this.config);
  }
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
  async store(input) {
    const db = this.requireDb();
    if (!VALID_TYPES.has(input.type)) {
      throw new InvalidTypeError(input.type);
    }
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      throw new InvalidConfidenceError(confidence);
    }
    const scope = input.scope ?? "project";
    let content = scrubSecrets(input.content);
    const concisenessCap = this.config.concisenessCap ?? 280;
    if (input.concise && content.length > concisenessCap) {
      content = content.slice(0, concisenessCap) + "...";
    }
    const duplicate = await this.findDuplicate(content, input.type, scope);
    if (duplicate) {
      if (duplicate.project_id !== null && duplicate.project_id !== this.config.projectId) {
        const existingMetadata = parseMetadataJson(duplicate.metadata);
        const existing = Array.isArray(existingMetadata.crossProjectReinforcements) ? existingMetadata.crossProjectReinforcements.filter(
          (p) => typeof p === "string"
        ) : [];
        const reinforcingProjects = this.config.projectId ? Array.from(/* @__PURE__ */ new Set([...existing, this.config.projectId])) : [...existing];
        if (this.shouldPromoteToGlobal(duplicate, reinforcingProjects)) {
          this.promoteToGlobal(duplicate.id);
        }
        return this.update(duplicate.id, {
          reinforce: true,
          metadata: { crossProjectReinforcements: reinforcingProjects }
        });
      }
      return this.update(duplicate.id, { reinforce: true });
    }
    const id = generateUlid();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const projectId = scope === "global" ? null : this.config.projectId ?? null;
    const tagsJson = JSON.stringify(input.tags ?? []);
    const metadataJson = JSON.stringify(input.metadata ?? {});
    const sourceJson = JSON.stringify(input.source ?? {});
    const weight = computeWeight(
      { createdAt: now, accessCount: 0, reinforcementCount: 0, confidence },
      1,
      { decayHalfLifeDays: this.decayHalfLifeDays }
    );
    db.prepare(
      `INSERT INTO memories
        (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, project_id, domain, source, category)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
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
      input.domain ?? null,
      sourceJson,
      input.category ?? null
    );
    if (this.embeddingProvider) {
      try {
        const vec = await this.embeddingProvider.embed(content);
        db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(
          embeddingToBuffer(vec),
          id
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[realmemory] Embedding computation failed for ${id}: ${msg}`);
      }
    }
    if (input.relationships && input.relationships.length > 0) {
      for (const rel of input.relationships) {
        const target = db.prepare("SELECT id FROM memories WHERE id = ?").get(rel.targetId);
        if (!target) {
          throw new MemoryStoreError(
            `RELATIONSHIP_NOT_FOUND: target memory ${rel.targetId} does not exist`
          );
        }
        const relId = generateUlid();
        db.prepare(
          `INSERT INTO relationships (id, source_id, target_id, type, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(relId, id, rel.targetId, rel.type, now);
      }
    }
    const stored = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!stored) {
      throw new MemoryStoreError(`Failed to read back stored memory: ${id}`);
    }
    return rowToMemory(stored);
  }
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
  async findDuplicate(content, type, scope) {
    const db = this.requireDb();
    const where = ["status = 'active'", "type = ?"];
    const params = [type];
    const joinWhere = ["m.status = 'active'", "m.type = ?"];
    const joinParams = [type];
    if (scope === "global") {
      where.push("project_id IS NULL");
      joinWhere.push("m.project_id IS NULL");
    }
    const whereSql = where.join(" AND ");
    const joinWhereSql = joinWhere.join(" AND ");
    if (this.embeddingProvider) {
      try {
        const vec = await this.embeddingProvider.embed(content);
        const rows = db.prepare(`SELECT * FROM memories WHERE ${whereSql}`).all(...params);
        const threshold = this.config.duplicateSimilarityThreshold ?? 0.92;
        let best = null;
        let bestSim = -1;
        for (const row of rows) {
          const embedding = embeddingFromBuffer(row.embedding);
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
      }
    }
    const ftsQuery = buildFtsQuery(content);
    if (ftsQuery === "") return null;
    const candidates = db.prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${joinWhereSql}
         ORDER BY bm25(memories_fts) ASC
         LIMIT 20`
    ).all(ftsQuery, ...joinParams);
    if (candidates.length === 0) return null;
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
   * Whether a near-duplicate memory should be promoted to global scope after a
   * cross-project reinforcement. Requires a promotable type
   * (`user_preference`/`task_pattern`), a project scope (never re-promotes an
   * already-global memory), and at least `crossProjectPromotionThreshold`
   * distinct projects contributing to the memory — the origin project plus
   * every project recorded in `reinforcingProjects`.
   */
  shouldPromoteToGlobal(duplicate, reinforcingProjects) {
    if (duplicate.scope === "global") return false;
    if (!PROMOTABLE_TYPES.has(duplicate.type)) return false;
    const distinctProjects = (/* @__PURE__ */ new Set([duplicate.project_id, ...reinforcingProjects])).size;
    return distinctProjects >= this.crossProjectPromotionThreshold;
  }
  /**
   * Promote a project-scoped memory to global scope. Used by the `store()`
   * dedup path once a `user_preference`/`task_pattern` memory has been
   * reinforced by enough distinct projects. A direct SQL UPDATE because
   * {@link UpdatePatch} intentionally cannot change `scope`/`project_id`.
   */
  promoteToGlobal(id) {
    const db = this.requireDb();
    db.prepare(
      "UPDATE memories SET scope = 'global', project_id = NULL, updated_at = ? WHERE id = ?"
    ).run((/* @__PURE__ */ new Date()).toISOString(), id);
    console.log(
      `[realmemory] Promoted memory ${id} to global scope after cross-project reinforcement`
    );
  }
  /**
   * Fetch a single active memory by ID. When `includeRelationships` is true
   * (default), the returned object carries one-hop outgoing and incoming
   * relationship edges. Throws {@link MemoryNotFoundError} if the ID does not
   * exist or has been archived.
   */
  async get(id, includeRelationships = true) {
    const db = this.requireDb();
    const row = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(id);
    if (!row) {
      throw new MemoryNotFoundError(id);
    }
    const memory = rowToMemory(row);
    const relationships = [];
    if (includeRelationships) {
      const outRows = db.prepare(
        `SELECT
             r.id AS rel_id, r.source_id AS rel_source, r.target_id AS rel_target,
             r.type AS rel_type, r.created_at AS rel_created,
             m.id, m.content, m.type, m.scope, m.tags, m.weight, m.confidence,
             m.created_at, m.updated_at, m.access_count, m.reinforcement_count,
             m.metadata, m.embedding, m.status, m.project_id
           FROM relationships r
           JOIN memories m ON m.id = r.target_id
           WHERE r.source_id = ?`
      ).all(id);
      for (const r of outRows) {
        relationships.push(joinRowToEdge(r, id));
      }
      const inRows = db.prepare(
        `SELECT
             r.id AS rel_id, r.source_id AS rel_source, r.target_id AS rel_target,
             r.type AS rel_type, r.created_at AS rel_created,
             m.id, m.content, m.type, m.scope, m.tags, m.weight, m.confidence,
             m.created_at, m.updated_at, m.access_count, m.reinforcement_count,
             m.metadata, m.embedding, m.status, m.project_id
           FROM relationships r
           JOIN memories m ON m.id = r.source_id
           WHERE r.target_id = ?`
      ).all(id);
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
  async list(query) {
    const db = this.requireDb();
    const where = ["status = 'active'"];
    const params = [];
    const scope = query.scope ?? "all";
    if (scope === "project") {
      const pid = this.config.projectId ?? null;
      where.push("project_id IS ?");
      params.push(pid);
    } else if (scope === "global") {
      where.push("project_id IS NULL");
    } else {
      const pid = this.config.projectId ?? null;
      where.push("(project_id IS ? OR project_id IS NULL)");
      params.push(pid);
    }
    if (query.type) {
      where.push("type = ?");
      params.push(query.type);
    }
    if (query.tag) {
      where.push("tags LIKE ?");
      params.push(`%"${query.tag.replace(/[%_]/g, (c) => "\\" + c)}"%`);
    }
    if (query.domain) {
      where.push("domain = ?");
      params.push(query.domain);
    }
    if (query.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (typeof query.minWeight === "number") {
      where.push("weight >= ?");
      params.push(query.minWeight);
    }
    const whereSql = where.join(" AND ");
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereSql}`).get(...params);
    const total = countRow?.c ?? 0;
    const rows = db.prepare(
      `SELECT * FROM memories WHERE ${whereSql} ORDER BY weight DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
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
  async forget(id, hard = false) {
    const db = this.requireDb();
    const row = db.prepare("SELECT id, status FROM memories WHERE id = ?").get(id);
    if (!row) {
      throw new MemoryNotFoundError(id);
    }
    const countRow = db.prepare(
      "SELECT COUNT(*) AS c FROM relationships WHERE source_id = ? OR target_id = ?"
    ).get(id, id);
    const relationshipsRemoved = countRow?.c ?? 0;
    if (row.status === "archived" && !hard) {
      return { id, archived: true, relationshipsRemoved: 0 };
    }
    if (hard) {
      db.prepare("DELETE FROM relationships WHERE source_id = ? OR target_id = ?").run(id, id);
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return { id, archived: false, relationshipsRemoved };
    }
    db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(
      (/* @__PURE__ */ new Date()).toISOString(),
      id
    );
    db.prepare("DELETE FROM relationships WHERE source_id = ? OR target_id = ?").run(id, id);
    return { id, archived: true, relationshipsRemoved };
  }
  /**
   * Archive (soft-delete) every active memory of a given type. Used by
   * `--reset-self --identity` (Phase 10 Gate 1) to forget all self_model
   * dispositions without touching the rest of the store. Returns the count of
   * rows archived. Idempotent — already-archived rows are skipped. Does not
   * cascade relationships (self_model rows rarely have any); a follow-up pass
   * could, but the reset semantics are "forget the self," not "orphan-clean."
   */
  async archiveByType(type) {
    const db = this.requireDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const info = db.prepare(
      "UPDATE memories SET status = 'archived', updated_at = ? WHERE type = ? AND status = 'active'"
    ).run(now, type);
    return info.changes ?? 0;
  }
  /**
   * Recall memories relevant to a natural-language query. Uses semantic
   * (cosine-similarity) recall when an embedding provider is available, and
   * falls back to FTS5 keyword (bm25) recall otherwise. Results are ranked by
   * `relevance × storedWeight`, their `accessCount` is bumped and weight
   * recomputed, and one-hop related memories are attached when `traverse` is
   * true (default). Applies scope/type/tag filters and a relevance threshold.
   */
  async recall(query) {
    const db = this.requireDb();
    const limit = query.limit ?? this.config.maxRecallResults ?? 5;
    const threshold = query.threshold ?? this.config.recallThreshold ?? 0.3;
    const maxRelated = this.config.maxRelatedPerMemory ?? 3;
    const traverse = query.traverse ?? true;
    const { whereSql, params } = this.buildRecallFilter(query);
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereSql}`).get(...params);
    if ((countRow?.c ?? 0) === 0) return [];
    if (this.embeddingProvider) {
      return await this.recallSemantic(query, whereSql, params, limit, threshold, maxRelated, traverse);
    }
    return await this.recallKeyword(query, whereSql, params, limit, threshold, maxRelated, traverse);
  }
  /**
   * Build the WHERE clause + params for the structured filters shared by
   * recall paths: status, scope, types, tags. Does NOT include the FTS MATCH.
   * `prefix` is applied to column names (e.g. "m.") to avoid ambiguity when
   * joining memories_fts and memories.
   */
  buildRecallFilter(query, prefix = "") {
    const where = [`${prefix}status = 'active'`];
    const params = [];
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
    if (query.domain) {
      where.push(`${prefix}domain = ?`);
      params.push(query.domain);
    }
    return { whereSql: where.join(" AND "), params };
  }
  /**
   * Semantic recall: embed the query, score every matching memory by cosine
   * similarity, fall back to FTS5 keyword matching for memories without an
   * stored embedding.
   */
  async recallSemantic(query, whereSql, params, limit, threshold, maxRelated, traverse) {
    const db = this.requireDb();
    const provider = this.embeddingProvider;
    const queryEmbedding = await provider.embed(query.query);
    const rows = db.prepare(`SELECT * FROM memories WHERE ${whereSql}`).all(...params);
    const keywordIds = await this.ftsMatchIds(query.query, whereSql, params);
    const scored = [];
    for (const row of rows) {
      const embedding = embeddingFromBuffer(row.embedding);
      if (embedding) {
        const sim = cosineSimilarity(queryEmbedding, embedding);
        if (sim < threshold) continue;
        scored.push({ row, relevance: sim, matchedBy: "semantic" });
      } else if (keywordIds.has(row.id)) {
        const rel = 0.3;
        if (rel < threshold) continue;
        scored.push({ row, relevance: rel, matchedBy: "keyword" });
      }
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
   * Keyword-only recall: FTS5 bm25 scoring with weight-weighted ranking.
   * Used when no embedding provider is configured (or failed to load).
   */
  async recallKeyword(query, _whereSql, _params, limit, threshold, maxRelated, traverse) {
    const db = this.requireDb();
    const ftsQuery = buildFtsQuery(query.query);
    if (ftsQuery === "") return [];
    const { whereSql: mWhereSql, params: mParams } = this.buildRecallFilter(query, "m.");
    const rows = db.prepare(
      `SELECT m.*, bm25(memories_fts) AS fts_score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${mWhereSql}
         ORDER BY fts_score ASC
         LIMIT 100`
    ).all(ftsQuery, ...mParams);
    if (rows.length === 0) return [];
    const rawScores = rows.map((r) => -r.fts_score);
    const maxRaw = Math.max(...rawScores, 1e-9);
    const scored = [];
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
  async finalizeRecallResults(scored, _queryText, traverse, maxRelated) {
    const db = this.requireDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bumpStmt = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, weight = ?, updated_at = ? WHERE id = ?"
    );
    const results = [];
    const resultIds = /* @__PURE__ */ new Set();
    for (const { row, relevance, matchedBy } of scored) {
      const newWeight = computeWeight(
        {
          createdAt: row.created_at,
          accessCount: row.access_count + 1,
          reinforcementCount: row.reinforcement_count,
          confidence: row.confidence
        },
        1,
        { decayHalfLifeDays: this.decayHalfLifeDays }
      );
      bumpStmt.run(newWeight, now, row.id);
      const memory = rowToMemory({ ...row, access_count: row.access_count + 1, weight: newWeight });
      resultIds.add(memory.id);
      results.push({
        memory,
        score: relevance * row.weight,
        matchedBy,
        related: []
      });
    }
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
  fetchRelatedMemories(memoryId, maxRelated, exclude) {
    const db = this.requireDb();
    const outRows = db.prepare(
      `SELECT m.* FROM relationships r
         JOIN memories m ON m.id = r.target_id AND m.status = 'active'
         WHERE r.source_id = ?`
    ).all(memoryId);
    const inRows = db.prepare(
      `SELECT m.* FROM relationships r
         JOIN memories m ON m.id = r.source_id AND m.status = 'active'
         WHERE r.target_id = ?`
    ).all(memoryId);
    const seen = /* @__PURE__ */ new Set();
    const related = [];
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
  async ftsMatchIds(queryText, whereSql, params) {
    const db = this.requireDb();
    const ftsQuery = buildFtsQuery(queryText);
    if (ftsQuery === "") return /* @__PURE__ */ new Set();
    const rows = db.prepare(
      `SELECT m.id FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${whereSql}`
    ).all(ftsQuery, ...params);
    return new Set(rows.map((r) => r.id));
  }
  /**
   * Structured search with filters (scope, types, tags, minWeight, date
   * range), sorting (weight/created/updated/confidence), and pagination.
   * Unlike {@link recall}, search does not embed the query or traverse
   * relationships — it is a deterministic filtered query.
   */
  async search(query) {
    const db = this.requireDb();
    const where = ["status = 'active'"];
    const params = [];
    const scope = query.scope ?? "all";
    if (scope === "project") {
      const pid = this.config.projectId ?? null;
      where.push("project_id IS ?");
      params.push(pid);
    } else if (scope === "global") {
      where.push("project_id IS NULL");
    } else {
      const pid = this.config.projectId ?? null;
      where.push("(project_id IS ? OR project_id IS NULL)");
      params.push(pid);
    }
    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => "?").join(", ");
      where.push(`type IN (${placeholders})`);
      params.push(...query.types);
    }
    if (query.tags && query.tags.length > 0) {
      const tagClauses = query.tags.map(() => "tags LIKE ?");
      where.push(`(${tagClauses.join(" OR ")})`);
      for (const tag of query.tags) {
        params.push(`%"${tag.replace(/[%_\\]/g, (c) => "\\" + c)}"%`);
      }
    }
    if (query.domain) {
      where.push("domain = ?");
      params.push(query.domain);
    }
    if (query.category) {
      where.push("category = ?");
      params.push(query.category);
    }
    if (typeof query.minWeight === "number") {
      where.push("weight >= ?");
      params.push(query.minWeight);
    }
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
    const sortBy = query.sortBy ?? "weight";
    const sortOrder = query.sortOrder ?? "desc";
    const sortColumn = sortBy === "created" ? "created_at" : sortBy === "updated" ? "updated_at" : sortBy === "confidence" ? "confidence" : "weight";
    const sortDir = sortOrder === "asc" ? "ASC" : "DESC";
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${whereSql}`).get(...params);
    const total = countRow?.c ?? 0;
    const rows = db.prepare(
      `SELECT * FROM memories WHERE ${whereSql} ORDER BY ${sortColumn} ${sortDir} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
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
  async relate(sourceId, targetId, type) {
    const db = this.requireDb();
    const sourceRow = db.prepare("SELECT id FROM memories WHERE id = ? AND status = 'active'").get(sourceId);
    if (!sourceRow) {
      throw new MemoryNotFoundError(sourceId);
    }
    const targetRow = db.prepare("SELECT id FROM memories WHERE id = ? AND status = 'active'").get(targetId);
    if (!targetRow) {
      throw new MemoryNotFoundError(targetId);
    }
    if (sourceId === targetId) {
      throw new SelfRelationshipError(sourceId);
    }
    const existing = db.prepare(
      "SELECT id FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?"
    ).get(sourceId, targetId, type);
    if (existing) {
      throw new DuplicateRelationshipError(sourceId, targetId, type);
    }
    const relId = generateUlid();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.prepare(
      `INSERT INTO relationships (id, source_id, target_id, type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(relId, sourceId, targetId, type, now);
    if (type === "reinforces") {
      const src = db.prepare(
        "SELECT created_at, access_count, reinforcement_count, confidence FROM memories WHERE id = ?"
      ).get(sourceId);
      const newConfidence = src.confidence + 0.1 * (1 - src.confidence);
      const clampedConfidence = Math.max(0, Math.min(1, newConfidence));
      const newReinforcementCount = src.reinforcement_count + 1;
      const newWeight = computeWeight(
        {
          createdAt: src.created_at,
          accessCount: src.access_count,
          reinforcementCount: newReinforcementCount,
          confidence: clampedConfidence
        },
        1,
        { decayHalfLifeDays: this.decayHalfLifeDays }
      );
      db.prepare(
        "UPDATE memories SET reinforcement_count = ?, confidence = ?, weight = ?, updated_at = ? WHERE id = ?"
      ).run(newReinforcementCount, clampedConfidence, newWeight, now, sourceId);
    } else if (type === "contradicts") {
      const tgt = db.prepare(
        "SELECT created_at, access_count, reinforcement_count, confidence FROM memories WHERE id = ?"
      ).get(targetId);
      const newConfidence = tgt.confidence - 0.1 * tgt.confidence;
      const clampedConfidence = Math.max(0, Math.min(1, newConfidence));
      const newWeight = computeWeight(
        {
          createdAt: tgt.created_at,
          accessCount: tgt.access_count,
          reinforcementCount: tgt.reinforcement_count,
          confidence: clampedConfidence
        },
        1,
        { decayHalfLifeDays: this.decayHalfLifeDays }
      );
      db.prepare(
        "UPDATE memories SET confidence = ?, weight = ?, updated_at = ? WHERE id = ?"
      ).run(clampedConfidence, newWeight, now, targetId);
    }
    return {
      id: relId,
      sourceId,
      targetId,
      type,
      createdAt: now
    };
  }
  /**
   * Automatically create relationship edges from a memory to its semantically
   * similar peers. Capped at maxRelatedPerMemory per call. Idempotent (catches
   * DuplicateRelationshipError). Excludes the source memory (INV-007).
   * Returns the number of edges created.
   */
  async maybeRelate(memoryId, content, type) {
    const maxEdges = this.config.maxRelatedPerMemory ?? 3;
    let edgesCreated = 0;
    try {
      const results = await this.recall({
        query: content,
        scope: "all",
        limit: maxEdges + 1,
        // +1 in case the source is in results (we exclude it)
        threshold: this.config.recallThreshold ?? 0.3,
        traverse: false
      });
      for (const result of results) {
        if (edgesCreated >= maxEdges) break;
        const candidate = result.memory;
        if (candidate.id === memoryId) continue;
        if (candidate.status === "archived") continue;
        let edgeType = "extends";
        if (type === "lesson_learned" && (candidate.type === "user_preference" || candidate.type === "task_pattern")) {
          edgeType = "derived_from";
        } else if (type === candidate.type) {
          edgeType = "reinforces";
        }
        try {
          await this.relate(memoryId, candidate.id, edgeType);
          edgesCreated++;
        } catch (error) {
          if (error instanceof DuplicateRelationshipError || error instanceof MemoryNotFoundError) {
            continue;
          }
          throw error;
        }
      }
    } catch {
    }
    return edgesCreated;
  }
  /**
   * Scan active memories for near-duplicate pairs and merge them (reinforce the
   * higher-weight one, archive the lower-weight one). Bounded scan: at most
   * 1000 most-recently-touched active memories. Returns the count of merges.
   * Fire-safe — errors are caught and logged, never thrown (INV-017).
   */
  async dedupPass() {
    if (!this.db) return 0;
    let merges = 0;
    try {
      const rows = this.db.prepare(
        "SELECT id, content, type, weight, tags FROM memories WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1000"
      ).all();
      const byType = /* @__PURE__ */ new Map();
      for (const row of rows) {
        if (!byType.has(row.type)) byType.set(row.type, []);
        byType.get(row.type).push({ id: row.id, content: row.content, weight: row.weight });
      }
      const merged = /* @__PURE__ */ new Set();
      for (const [, group] of byType) {
        for (let i = 0; i < group.length; i++) {
          if (merged.has(group[i].id)) continue;
          for (let j = i + 1; j < group.length; j++) {
            if (merged.has(group[j].id)) continue;
            const a = group[i].content.trim().toLowerCase().slice(0, 500);
            const b = group[j].content.trim().toLowerCase().slice(0, 500);
            if (a === b || a.length > 20 && b.length > 20 && (a.includes(b) || b.includes(a))) {
              const higher = group[i].weight >= group[j].weight ? group[i] : group[j];
              const lower = group[i].weight >= group[j].weight ? group[j] : group[i];
              try {
                this.db.prepare("UPDATE memories SET reinforcement_count = reinforcement_count + 1, updated_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), higher.id);
                this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), lower.id);
                merged.add(lower.id);
                merges++;
              } catch {
              }
              break;
            }
          }
        }
      }
    } catch {
    }
    return merges;
  }
  /**
   * Synthetic-brain Phase 6: return active episodic memories (types
   * `lesson_learned`, `contextual_note`) with their embeddings, for the
   * consolidation pass (`consolidate.ts`). Bounded scan: at most 1000
   * most-recently-touched. Memories with an existing `derived_from` edge
   * to a `task_pattern` are excluded (idempotency — they've already been
   * consolidated). Fire-safe — returns empty array on error.
   */
  async getConsolidationCandidates() {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(
        "SELECT id, content, type, scope, weight, confidence, tags, domain, embedding, updated_at FROM memories WHERE status = 'active' AND type IN ('lesson_learned', 'contextual_note') ORDER BY updated_at DESC LIMIT 1000"
      ).all();
      const consolidated = /* @__PURE__ */ new Set();
      const consolidateStmt = this.db.prepare(
        "SELECT r.source_id FROM relationships r JOIN memories m ON m.id = r.target_id WHERE r.type = 'derived_from' AND m.type = 'task_pattern' AND r.source_id = ? LIMIT 1"
      );
      for (const row of rows) {
        const existing = consolidateStmt.get(row.id);
        if (existing) consolidated.add(row.id);
      }
      return rows.filter((r) => !consolidated.has(r.id)).map((r) => ({
        id: r.id,
        content: r.content,
        type: r.type,
        scope: r.scope,
        weight: r.weight,
        confidence: r.confidence,
        tags: JSON.parse(r.tags),
        domain: r.domain,
        embedding: embeddingFromBuffer(r.embedding)
      }));
    } catch {
      return [];
    }
  }
  /**
   * Patch an existing active memory. Content is scrubbed; tags are replaced
   * (not merged); metadata is merged with existing. `reinforce: true` bumps
   * `reinforcementCount` and boosts confidence (diminishing returns). Any
   * confidence change recomputes the composite weight. Throws
   * {@link MemoryNotFoundError} / {@link InvalidConfidenceError} as appropriate.
   */
  async update(id, patch) {
    const db = this.requireDb();
    const row = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(id);
    if (!row) {
      throw new MemoryNotFoundError(id);
    }
    if (typeof patch.confidence === "number" && (Number.isNaN(patch.confidence) || patch.confidence < 0 || patch.confidence > 1)) {
      throw new InvalidConfidenceError(patch.confidence);
    }
    const sets = [];
    const params = [];
    if (typeof patch.content === "string") {
      const content = scrubSecrets(patch.content);
      sets.push("content = ?");
      params.push(content);
    }
    let newConfidence;
    if (typeof patch.confidence === "number") {
      newConfidence = patch.confidence;
    }
    if (Array.isArray(patch.tags)) {
      sets.push("tags = ?");
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.metadata && typeof patch.metadata === "object") {
      let existingMetadata = {};
      try {
        const parsed = JSON.parse(row.metadata);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existingMetadata = parsed;
        }
      } catch {
        existingMetadata = {};
      }
      const mergedMetadata = {
        ...existingMetadata,
        ...patch.metadata
      };
      sets.push("metadata = ?");
      params.push(JSON.stringify(mergedMetadata));
    }
    if (typeof patch.domain === "string") {
      sets.push("domain = ?");
      params.push(patch.domain);
    }
    if (typeof patch.category === "string") {
      sets.push("category = ?");
      params.push(patch.category);
    }
    if (patch.source && typeof patch.source === "object") {
      const existingSource = parseSourceJson(row.source);
      const mergedSource = { ...existingSource, ...patch.source };
      sets.push("source = ?");
      params.push(JSON.stringify(mergedSource));
    }
    let reinforcementIncrement = 0;
    if (patch.reinforce === true) {
      reinforcementIncrement = 1;
      const base = typeof newConfidence === "number" ? newConfidence : row.confidence;
      newConfidence = base + 0.1 * (1 - base);
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
    if (patch.reinforce === true || typeof newConfidence === "number") {
      const projectedMemory = {
        createdAt: row.created_at,
        accessCount: row.access_count,
        reinforcementCount: row.reinforcement_count + reinforcementIncrement,
        confidence: typeof newConfidence === "number" ? newConfidence : row.confidence
      };
      const newWeight = computeWeight(projectedMemory, 1, {
        decayHalfLifeDays: this.decayHalfLifeDays
      });
      sets.push("weight = ?");
      params.push(newWeight);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    sets.push("updated_at = ?");
    params.push(now);
    params.push(id);
    db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const updated = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
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
  async getMeta(key) {
    const db = this.requireDb();
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }
  /**
   * Write a key to the durable `meta` key-value table, replacing any existing
   * value for the same key.
   */
  async setMeta(key, value) {
    const db = this.requireDb();
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    ).run(key, value);
  }
  /**
   * Recompute every active memory's composite weight and archive any whose
   * weight has dropped below the configured `archiveThreshold`. Call this on a
   * timer in a long-lived app to keep the store from accumulating stale,
   * low-weight memories.
   */
  async decay() {
    const db = this.requireDb();
    const rows = db.prepare(
      `SELECT id, created_at, access_count, reinforcement_count, confidence
         FROM memories WHERE status = 'active'`
    ).all();
    const archiveThreshold = this.archiveThreshold;
    const halfLifeDays = this.decayHalfLifeDays;
    const archiveStmt = db.prepare(
      `UPDATE memories SET status = 'archived', weight = ? WHERE id = ?`
    );
    const updateStmt = db.prepare(`UPDATE memories SET weight = ? WHERE id = ?`);
    for (const row of rows) {
      const weight = computeWeight(
        {
          createdAt: row.created_at,
          accessCount: row.access_count,
          reinforcementCount: row.reinforcement_count,
          confidence: row.confidence
        },
        1,
        { decayHalfLifeDays: halfLifeDays }
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
  async maybeDecay(lastRunKey, intervalHours) {
    const now = Date.now();
    const lastRunRaw = await this.getMeta(lastRunKey);
    if (lastRunRaw !== null) {
      const lastRun = new Date(lastRunRaw).getTime();
      if (!Number.isNaN(lastRun) && now - lastRun < intervalHours * 60 * 60 * 1e3) {
        return false;
      }
    }
    await this.decay();
    await this.setMeta(lastRunKey, new Date(now).toISOString());
    return true;
  }
  /**
   * Record a metric observation (brain-loop observability).
   * Stores a single row in the metrics table with a ULID and ISO timestamp.
   * Fire-safe: errors are caught and logged to the store's error log, never
   * thrown (metrics must not break the caller — INV-017).
   */
  async recordMetric(name, value, sessionId) {
    if (!this.db) return;
    try {
      const id = generateUlid();
      const recordedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.db.prepare(
        "INSERT INTO metrics (id, metric_name, metric_value, session_id, recorded_at) VALUES (?, ?, ?, ?, ?)"
      ).run(id, name, value, sessionId ?? null, recordedAt);
    } catch {
    }
  }
  /**
   * Aggregate summary of recorded metrics. Returns per-metric_name aggregates:
   * count, sum, avg, latest, latest_at. Optionally filtered by name and/or
   * since (ISO timestamp).
   */
  async getMetricSummary(name, since) {
    if (!this.db) return [];
    let sql = "SELECT metric_name, COUNT(*) as count, SUM(metric_value) as sum, AVG(metric_value) as avg, MAX(metric_value) as latest FROM metrics";
    const conditions = [];
    const params = [];
    if (name) {
      conditions.push("metric_name = ?");
      params.push(name);
    }
    if (since) {
      conditions.push("recorded_at >= ?");
      params.push(since);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " GROUP BY metric_name";
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => {
      const latestRow = this.db.prepare(
        "SELECT recorded_at FROM metrics WHERE metric_name = ? ORDER BY recorded_at DESC LIMIT 1"
      ).get(row.metric_name);
      return {
        metric_name: row.metric_name,
        count: row.count,
        sum: row.sum,
        avg: row.avg,
        latest: row.latest,
        latest_at: latestRow?.recorded_at ?? ""
      };
    });
  }
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
  async getLatestMetricRow(prefix) {
    if (!this.db) return null;
    const row = this.db.prepare(
      "SELECT metric_name, metric_value, session_id, recorded_at FROM metrics WHERE metric_name LIKE ? ORDER BY recorded_at DESC LIMIT 1"
    ).get(`${prefix}%`);
    return row ?? null;
  }
  /**
   * Count active memories in the store. Additive — used by the doctor report
   * to determine if sessions have run (memories present = sessions happened).
   * (Synthetic-brain Phase 0.)
   */
  async count() {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get();
    return row.c;
  }
  /**
   * Return recent metrics rows whose metric_name matches the given prefix
   * (LIKE 'prefix%'), ordered by recorded_at desc, limited to `limit` rows.
   * Used by the memory_why MCP tool to surface recent reflex actions.
   * (Synthetic-brain Phase 7.)
   */
  async getRecentMetricsByPrefix(prefix, limit = 20) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      "SELECT metric_name, metric_value, session_id, recorded_at FROM metrics WHERE metric_name LIKE ? ORDER BY recorded_at DESC LIMIT ?"
    ).all(`${prefix}%`, limit);
    return rows;
  }
  /**
   * Insert a batch of brain events into the `brain_events` table (schema v5).
   * Each event carries its own `emittedAt` timestamp (from the ring buffer)
   * plus an optional `sessionId`. `payload` is JSON-stringified. Returns the
   * number of rows inserted.
   *
   * This is the write side of the synthetic-self Phase 8 event spine. The
   * plugin process emits into an in-RAM ring (zero I/O), then `flush()` calls
   * this in a single batched INSERT from the deliberative path. The UI server
   * process reads the same table concurrently (WAL mode) over SSE.
   *
   * (Synthetic-self Phase 8.)
   */
  async insertBrainEvents(events) {
    if (!this.db || events.length === 0) return 0;
    try {
      const stmt = this.db.prepare(
        "INSERT INTO brain_events (session_id, kind, payload, recorded_at) VALUES (?, ?, ?, ?)"
      );
      let inserted = 0;
      for (const e of events) {
        stmt.run(
          e.sessionId ?? null,
          e.kind,
          JSON.stringify(e.payload),
          e.emittedAt
        );
        inserted++;
      }
      return inserted;
    } catch {
      return 0;
    }
  }
  /**
   * Cap the `brain_events` table: delete rows below `max(seq) - retention`.
   * Called by `flush()` after each batched INSERT. Telemetry tape, not
   * memory — bounded by design.
   *
   * (Synthetic-self Phase 8.)
   */
  async capBrainEvents(retention) {
    if (!this.db || retention <= 0) return 0;
    try {
      const maxRow = this.db.prepare("SELECT MAX(seq) as m FROM brain_events").get();
      const maxSeq = maxRow?.m ?? 0;
      if (maxSeq <= retention) return 0;
      const cutoff = maxSeq - retention;
      const info = this.db.prepare("DELETE FROM brain_events WHERE seq < ?").run(cutoff);
      return info.changes ?? 0;
    } catch {
      return 0;
    }
  }
  /**
   * Read brain events with `seq > afterSeq`, ascending, limited. Used by the
   * UI server's `GET /api/stream` SSE endpoint to tail the event tape.
   *
   * (Synthetic-self Phase 8.)
   */
  async getBrainEvents(afterSeq, limit = 100) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      "SELECT seq, session_id, kind, payload, recorded_at FROM brain_events WHERE seq > ? ORDER BY seq ASC LIMIT ?"
    ).all(afterSeq, limit);
    return rows;
  }
  /**
   * Reconstruct a brain-state snapshot from the event tape for the UI's
   * `GET /api/brain/state` page-load endpoint. No shared RAM required —
   * everything here is derived from `brain_events` + `memories`:
   *   - `lastEventAt`: recorded_at of the most recent brain_event (or null)
   *   - `liveVsStale`: "live" if last event < 30s ago, "stale" if > 5min, else "idle"
   *   - `reflexRuleCount`: count of active `lesson_learned` memories above the
   *     reflex weight floor (0.3) — the rules the reflex cache would load
   *   - `lastArousal`: payload.arousal of the most recent `arousal.change` (or null)
   *   - `lastWmAssembled`: payload of the most recent `wm.assembled` (or null)
   *   - `eventCount`: total rows in `brain_events`
   *
   * (Synthetic-self Phase 8.)
   */
  async getBrainStateSnapshot() {
    if (!this.db) {
      return {
        lastEventAt: null,
        liveVsStale: "empty",
        reflexRuleCount: 0,
        lastArousal: null,
        lastWmAssembled: null,
        eventCount: 0
      };
    }
    const lastRow = this.db.prepare(
      "SELECT recorded_at FROM brain_events ORDER BY seq DESC LIMIT 1"
    ).get();
    const countRow = this.db.prepare("SELECT COUNT(*) as c FROM brain_events").get();
    const eventCount = countRow?.c ?? 0;
    let liveVsStale = "empty";
    let lastEventAt = null;
    if (lastRow?.recorded_at) {
      lastEventAt = lastRow.recorded_at;
      const ms = Date.now() - Date.parse(lastRow.recorded_at);
      if (!Number.isNaN(ms)) {
        if (ms < 3e4) liveVsStale = "live";
        else if (ms > 5 * 6e4) liveVsStale = "stale";
        else liveVsStale = "idle";
      }
    }
    const ruleRow = this.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND type = 'lesson_learned' AND weight >= 0.3"
    ).get();
    let lastArousal = null;
    const arousalRow = this.db.prepare(
      "SELECT payload FROM brain_events WHERE kind = 'arousal.change' ORDER BY seq DESC LIMIT 1"
    ).get();
    if (arousalRow?.payload) {
      try {
        const p = JSON.parse(arousalRow.payload);
        if (typeof p.arousal === "number") lastArousal = p.arousal;
      } catch {
      }
    }
    let lastWmAssembled = null;
    const wmRow = this.db.prepare(
      "SELECT payload FROM brain_events WHERE kind = 'wm.assembled' ORDER BY seq DESC LIMIT 1"
    ).get();
    if (wmRow?.payload) {
      try {
        lastWmAssembled = JSON.parse(wmRow.payload);
      } catch {
      }
    }
    return {
      lastEventAt,
      liveVsStale,
      reflexRuleCount: ruleRow?.c ?? 0,
      lastArousal,
      lastWmAssembled,
      eventCount
    };
  }
  /**
   * Bloat ratio: fraction of active memories with weight below
   * archiveThreshold. 0.0 on an empty store.
   */
  async getBloatRatio() {
    if (!this.db) return 0;
    const threshold = this.config.archiveThreshold ?? 0.05;
    const total = this.db.prepare("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get();
    if (total.c === 0) return 0;
    const bloat = this.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND weight < ?"
    ).get(threshold);
    return bloat.c / total.c;
  }
  /**
   * Read-only aggregate statistics for the graph browser's sidebar readout:
   * total active memories, counts per type, counts per scope, and total
   * relationships. Does not mutate any row.
   */
  async getStats() {
    const db = this.requireDb();
    const totalMemories = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE status = 'active'").get().c;
    const typeRows = db.prepare(
      "SELECT type, COUNT(*) AS c FROM memories WHERE status = 'active' GROUP BY type"
    ).all();
    const byType = {};
    for (const r of typeRows) byType[r.type] = r.c;
    const projectCount = db.prepare(
      "SELECT COUNT(*) AS c FROM memories WHERE status = 'active' AND project_id IS NOT NULL"
    ).get().c;
    const globalCount = db.prepare(
      "SELECT COUNT(*) AS c FROM memories WHERE status = 'active' AND project_id IS NULL"
    ).get().c;
    const totalRelationships = db.prepare("SELECT COUNT(*) AS c FROM relationships").get().c;
    return {
      totalMemories,
      byType,
      byScope: { project: projectCount, global: globalCount },
      totalRelationships
    };
  }
  /**
   * Read-only full-text search returning memories ranked by bm25 relevance,
   * WITHOUT bumping `access_count` or recomputing weight (the key difference
   * from {@link recall}, which mutates). Used by the graph browser's text
   * filter so browsing does not distort the decay/recency signals. Returns an
   * empty array for a query with no usable tokens.
   */
  async searchText(query, limit) {
    const db = this.requireDb();
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === "") return [];
    const cap = limit ?? 100;
    const rows = db.prepare(
      `SELECT m.* FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active'
         ORDER BY bm25(memories_fts) ASC
         LIMIT ?`
    ).all(ftsQuery, cap);
    return rows.map(rowToMemory);
  }
  /**
   * Read-only bulk fetch of all relationships whose `source_id` OR `target_id`
   * is in the supplied `nodeIds` set. Used by the graph browser to draw edges
   * between the currently-visible nodes without N per-node `get()` calls. Does
   * not mutate any row. Returns an empty array for an empty input set.
   */
  async getRelationshipsForNodes(nodeIds) {
    const db = this.requireDb();
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, source_id, target_id, type, created_at FROM relationships
         WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
    ).all(...nodeIds, ...nodeIds);
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      targetId: r.target_id,
      type: r.type,
      createdAt: r.created_at
    }));
  }
  /** Close the database handle. Safe to call multiple times; no-op if already closed. */
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
  requireDb() {
    if (!this.db) {
      throw new MemoryStoreError("MemoryStore is not initialized. Call init() first.");
    }
    return this.db;
  }
};

export {
  NotImplementedError,
  MemoryStoreError,
  MemoryNotFoundError,
  InvalidTypeError,
  InvalidConfidenceError,
  DuplicateRelationshipError,
  SelfRelationshipError,
  generateUlid,
  scrubSecrets,
  computeWeight,
  computeRecencyFactor,
  computeFrequencyFactor,
  loadConfig,
  validateConfig,
  createEmbeddingProvider,
  MemoryStore
};
