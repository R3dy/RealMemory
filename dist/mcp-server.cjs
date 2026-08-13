"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/mcp-server.ts
var mcp_server_exports = {};
__export(mcp_server_exports, {
  createMcpTools: () => createMcpTools,
  startMcpServer: () => startMcpServer
});
module.exports = __toCommonJS(mcp_server_exports);
var import_server = require("@modelcontextprotocol/sdk/server/index.js");
var import_stdio = require("@modelcontextprotocol/sdk/server/stdio.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var import_zod = require("zod");

// src/store.ts
var import_node_fs2 = require("fs");
var import_node_path2 = require("path");
var import_node_os2 = require("os");

// src/errors.ts
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
var MIGRATIONS = {
  1: SCHEMA_V1,
  2: SCHEMA_V2,
  3: SCHEMA_V3,
  4: SCHEMA_V4
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
var import_node_fs = require("fs");
var import_node_path = require("path");
var import_node_os = require("os");
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
  const globalPath = (0, import_node_path.join)((0, import_node_os.homedir)(), ".config", "opencode", "realmemory.json");
  if ((0, import_node_fs.existsSync)(globalPath)) {
    try {
      config = { ...config, ...readJsonFile(globalPath) };
    } catch {
    }
  }
  const projectPath = (0, import_node_path.join)(
    projectDir || process.cwd(),
    ".realmemory",
    "config.json"
  );
  if ((0, import_node_fs.existsSync)(projectPath)) {
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
}
function readJsonFile(path) {
  const content = (0, import_node_fs.readFileSync)(path, "utf-8");
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
    const { dirname: dirname3, join: join4 } = await import("path");
    const { resolve: resolve2 } = await import("path");
    const { homedir: homedir3 } = await import("os");
    const raw = config.storagePath.startsWith("~") ? join4(homedir3(), config.storagePath.slice(1)) : resolve2(config.storagePath);
    env.cacheDir = dirname3(raw);
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

// src/similarity.ts
function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function embeddingFromBuffer(buf) {
  if (!buf || buf.byteLength === 0) return null;
  if (buf.byteLength % 4 !== 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function embeddingToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// src/store.ts
var DEFAULT_STORAGE_PATH = (0, import_node_path2.resolve)(
  (0, import_node_os2.homedir)(),
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
  "contextual_note"
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
    const storagePath = rawPath.startsWith("~") ? (0, import_node_path2.join)((0, import_node_os2.homedir)(), rawPath.slice(1)) : (0, import_node_path2.resolve)(rawPath);
    const dir = (0, import_node_path2.dirname)(storagePath);
    (0, import_node_fs2.mkdirSync)(dir, { recursive: true });
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

// src/browser/server.ts
var import_node_http = require("http");
var import_node_url = require("url");
var import_node_path3 = require("path");
var import_node_fs3 = require("fs");

// src/browser/assets.ts
var INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>realmemory \u2014 knowledge graph</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-elev2: #1c2330;
    --border: #30363d;
    --border-dim: #21262d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --text-bright: #f0f6fc;
    --accent: #58a6ff;
    --accent-dim: #1f6feb;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
    --orange: #db6d28;
    --gray: #7d8590;
    --teal: #39c5cf;
    --pink: #f778ba;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px; height: 100vh; overflow: hidden;
  }

  /* ===== Top Bar ===== */
  header {
    height: 48px; display: flex; align-items: center; gap: 16px;
    padding: 0 16px; border-bottom: 1px solid var(--border);
    background: var(--bg-elev); z-index: 10;
  }
  header .logo {
    display: flex; align-items: center; gap: 8px;
    font-size: 15px; font-weight: 600; color: var(--accent);
    white-space: nowrap;
  }
  header .logo .icon { width: 18px; height: 18px; fill: var(--accent); }
  header .search-wrap {
    flex: 1; max-width: 500px; position: relative;
  }
  header .search-wrap input {
    width: 100%; padding: 6px 12px 6px 32px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 13px;
    transition: border-color .15s;
  }
  header .search-wrap input:focus { outline: none; border-color: var(--accent); }
  header .search-wrap .search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--text-dim); font-size: 14px;
  }
  header .stats {
    display: none; gap: 12px; font-size: 12px; color: var(--text-dim);
  }
  header .stats .stat { display: flex; align-items: center; gap: 4px; }
  header .stats .stat .num { color: var(--text-bright); font-weight: 600; }
  header .view-toggle {
    display: none; border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
  }
  header .view-toggle button {
    padding: 5px 12px; background: var(--bg); border: none; color: var(--text-dim);
    cursor: pointer; font-size: 12px; transition: all .15s;
  }
  header .view-toggle button.active { background: var(--accent-dim); color: #fff; }
  header .view-toggle button:hover:not(.active) { background: var(--bg-elev2); }

  /* ===== Main Layout (mobile-first: base = mobile flex column) ===== */
  #app {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 48px);
  }

  /* ===== Left Sidebar (Domains + Filters) ===== */
  aside#sidebar {
    border-right: 1px solid var(--border);
    background: var(--bg-elev);
    overflow-y: auto; min-height: 0;
    display: flex; flex-direction: column;
  }
  .sidebar-section { border-bottom: 1px solid var(--border-dim); }
  .sidebar-section h2 {
    padding: 8px 12px 6px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .5px; color: var(--text-dim);
    display: flex; justify-content: space-between; align-items: center;
  }
  .sidebar-section h2 .count { font-size: 10px; color: var(--gray); }

  /* Domain tree */
  .domain-tree { padding: 0 0 8px; }
  .domain-item {
    padding: 4px 12px 4px 16px; cursor: pointer; display: flex;
    align-items: center; gap: 8px; font-size: 12px; transition: background .1s;
    border-left: 3px solid transparent;
  }
  .domain-item:hover { background: var(--bg-elev2); }
  .domain-item.active {
    background: var(--bg-elev2); border-left-color: var(--accent);
  }
  .domain-item .dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .domain-item .name { flex: 1; color: var(--text); }
  .domain-item .badge {
    font-size: 10px; color: var(--text-dim); background: var(--bg);
    border-radius: 8px; padding: 1px 6px; min-width: 18px; text-align: center;
  }
  .domain-item.uncategorized .name { color: var(--text-dim); font-style: italic; }

  /* Filters */
  .filter-group { padding: 6px 12px 10px; }
  .filter-group label {
    display: flex; align-items: center; gap: 6px; padding: 3px 0;
    cursor: pointer; font-size: 12px; color: var(--text);
  }
  .filter-group label:hover { color: var(--text-bright); }
  .filter-group input[type="checkbox"] { accent-color: var(--accent); width: 14px; height: 14px; }
  .filter-group input[type="text"], .filter-group input[type="date"], .filter-group select {
    width: 100%; padding: 4px 8px; background: var(--bg);
    border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-size: 12px;
  }
  .filter-group input[type="range"] { width: 100%; accent-color: var(--accent); }
  .filter-group .row { display: flex; gap: 6px; }
  .filter-group .row > * { flex: 1; }
  .filter-group .category-pills {
    display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;
  }
  .filter-group .pill {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--bg);
    color: var(--text-dim); cursor: pointer; transition: all .1s;
  }
  .filter-group .pill:hover { border-color: var(--accent); color: var(--text); }
  .filter-group .pill.active { background: var(--accent-dim); color: #fff; border-color: var(--accent-dim); }

  /* ===== Center Pane (Graph / List) ===== */
  main#center {
    position: relative; background: var(--bg); overflow: hidden; min-height: 0;
    flex: 1;
  }
  #network { width: 100%; height: 100%; }
  #list-view {
    display: none; width: 100%; height: 100%; overflow-y: auto;
  }
  #list-view.show { display: block; }
  #list-view table { width: 100%; border-collapse: collapse; }
  #list-view th {
    position: sticky; top: 0; background: var(--bg-elev);
    border-bottom: 1px solid var(--border); padding: 6px 10px;
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: .5px; color: var(--text-dim); font-weight: 600;
    cursor: pointer; user-select: none;
  }
  #list-view th:hover { color: var(--text-bright); }
  #list-view td {
    padding: 6px 10px; border-bottom: 1px solid var(--border-dim);
    font-size: 12px; max-width: 400px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  #list-view tr { cursor: pointer; transition: background .1s; }
  #list-view tr:hover { background: var(--bg-elev); }
  #list-view tr.selected { background: var(--bg-elev2); }
  #list-view .type-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  #list-view .weight-bar {
    width: 40px; height: 4px; background: var(--border); border-radius: 2px;
    display: inline-block; overflow: hidden;
  }
  #list-view .weight-bar .fill { height: 100%; border-radius: 2px; }

  #empty-msg {
    position: absolute; inset: 0; display: none; align-items: center;
    justify-content: center; color: var(--text-dim); font-size: 14px;
    pointer-events: none;
  }
  #empty-msg.show { display: flex; }

  /* Graph overlay controls */
  .graph-controls {
    position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; z-index: 5;
  }
  .graph-controls button {
    width: 28px; height: 28px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--bg-elev); color: var(--text-dim); cursor: pointer;
    font-size: 14px; display: flex; align-items: center; justify-content: center;
    transition: all .15s;
  }
  .graph-controls button:hover { background: var(--bg-elev2); color: var(--text); }

  /* ===== Right Detail Panel ===== */
  aside#detail {
    border-left: 1px solid var(--border);
    background: var(--bg-elev); overflow-y: auto; min-height: 0;
  }
  aside#detail .placeholder {
    color: var(--text-dim); font-size: 13px; text-align: center;
    margin-top: 60px; padding: 0 20px;
  }
  aside#detail .placeholder .icon { font-size: 32px; opacity: .3; margin-bottom: 8px; }
  aside#detail .detail-header {
    padding: 10px 14px; border-bottom: 1px solid var(--border-dim);
    display: flex; align-items: center; gap: 8px;
  }
  aside#detail .detail-header .type-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  aside#detail .detail-header .type-label { font-size: 12px; color: var(--text-dim); }
  aside#detail .detail-header .scope-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
  }
  aside#detail .detail-body { padding: 12px 14px; }
  aside#detail .field { margin-bottom: 14px; }
  aside#detail .field .k {
    font-size: 10px; color: var(--text-dim); text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 4px; font-weight: 600;
  }
  aside#detail .field .v { font-size: 12px; word-break: break-word; color: var(--text); }
  aside#detail .content-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; font-size: 12px; line-height: 1.6;
    white-space: pre-wrap; color: var(--text-bright);
  }
  aside#detail .badges { display: flex; flex-wrap: wrap; gap: 4px; }
  aside#detail .badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--border); font-family: monospace;
  }
  aside#detail .badge.domain { background: var(--bg); }
  aside#detail .badge.category { background: var(--bg); color: var(--accent); }
  aside#detail .badge.tag { color: var(--text-dim); }
  aside#detail .stats-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  aside#detail .stat-card {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 8px; text-align: center;
  }
  aside#detail .stat-card .num { font-size: 16px; font-weight: 600; color: var(--text-bright); }
  aside#detail .stat-card .label { font-size: 10px; color: var(--text-dim); }
  aside#detail .weight-bar {
    width: 100%; height: 6px; background: var(--border); border-radius: 3px;
    overflow: hidden; margin-top: 4px;
  }
  aside#detail .weight-bar .fill { height: 100%; border-radius: 3px; transition: width .3s; }
  aside#detail .source-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-family: monospace; font-size: 11px;
  }
  aside#detail .source-box .src-line { color: var(--text-dim); }
  aside#detail .source-box .src-line .val { color: var(--accent); }
  aside#detail .metadata-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-family: monospace; font-size: 11px;
    white-space: pre-wrap; color: var(--text-dim);
  }
  aside#detail .rel-list { }
  aside#detail .rel-item {
    padding: 6px 0; border-bottom: 1px solid var(--border-dim);
    font-size: 11px; display: flex; align-items: center; gap: 6px;
  }
  aside#detail .rel-item:last-child { border-bottom: none; }
  aside#detail .rel-item .rel-type {
    font-size: 10px; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;
  }
  aside#detail .rel-item .rel-preview { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  aside#detail .rel-link { cursor: pointer; color: var(--accent); }
  aside#detail .rel-link:hover { text-decoration: underline; }

  /* ===== Footer ===== */
  footer {
    height: 28px; display: none; align-items: center; gap: 12px;
    padding: 0 16px; border-top: 1px solid var(--border);
    background: var(--bg-elev); font-size: 10px; overflow-x: auto;
  }
  footer .legend-item { display: flex; align-items: center; gap: 3px; color: var(--text-dim); white-space: nowrap; }
  footer .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  footer .line { width: 14px; height: 2px; display: inline-block; }
  footer .sep { width: 1px; height: 12px; background: var(--border); }

  /* Scrollbar styling */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--gray); }

  /* Loading spinner */
  .spinner {
    border: 2px solid var(--border); border-top: 2px solid var(--accent);
    border-radius: 50%; width: 20px; height: 20px;
    animation: spin 1s linear infinite; margin: 20px auto;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ===== Mobile Components (base = mobile, enhance up via min-width queries) ===== */

  /* Hamburger button \u2014 shown on mobile/tablet, hidden on desktop */
  .hamburger {
    display: flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; background: none; border: none;
    color: var(--text); font-size: 20px; cursor: pointer;
    border-radius: 6px; transition: background .15s;
  }
  .hamburger:hover { background: var(--bg-elev2); }

  /* Bottom tab bar \u2014 flex child of #app, NOT position:fixed (O4) */
  .bottom-tabs {
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    display: flex; border-top: 1px solid var(--border);
    background: var(--bg-elev); flex: 0 0 auto;
  }
  .bottom-tabs button {
    flex: 1; background: none; border: none; color: var(--text-dim);
    font-size: 11px; font-weight: 500; cursor: pointer; display: flex;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; transition: color .15s;
  }
  .bottom-tabs button.active { color: var(--accent); }

  /* Drawer \u2014 mobile sidebar slides in from left (off-canvas) */
  .drawer {
    position: fixed; top: 48px; bottom: 0; left: 0;
    width: 280px; max-width: 85vw;
    transform: translateX(-100%);
    transition: transform 200ms; z-index: 20;
    box-shadow: 2px 0 12px rgba(0,0,0,0.4);
  }
  .drawer.open { transform: translateX(0); }

  /* Bottom sheet \u2014 mobile detail slides up from bottom (off-canvas) */
  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0;
    max-height: 70vh;
    transform: translateY(100%);
    transition: transform 200ms; border-radius: 12px 12px 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    z-index: 20; box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
  }
  .sheet.open { transform: translateY(0); }
  .sheet-close {
    position: absolute; top: 8px; right: 8px;
    width: 32px; height: 32px; border-radius: 50%; border: none;
    background: var(--bg); color: var(--text-dim); cursor: pointer;
    font-size: 16px; display: flex; align-items: center; justify-content: center;
    z-index: 21;
  }
  .sheet-close:hover { background: var(--bg-elev2); color: var(--text); }

  /* Scrim \u2014 semi-transparent backdrop for drawer/sheet */
  .scrim {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 10; opacity: 0; pointer-events: none;
    transition: opacity 200ms;
  }
  .scrim.visible { opacity: 1; pointer-events: auto; }

  /* ===== Touch targets (mobile/tablet only \u2014 gated inside max-width:1023px) (O5) ===== */
  @media (max-width: 1023px) {
    .domain-item, .filter-group label, .pill, .graph-controls button,
    .bottom-tabs button, .hamburger, .sheet-close {
      min-height: 44px; min-width: 44px;
    }
  }

  /* ===== Tablet (>=640px) \u2014 hide bottom tabs, show inline search ===== */
  @media (min-width: 640px) {
    .bottom-tabs { display: none; }
    #app { height: calc(100vh - 48px); }
  }

  /* ===== Desktop (>=1024px) \u2014 restore EXACT current 3-column grid (regression-free) ===== */
  @media (min-width: 1024px) {
    #app {
      display: grid;
      grid-template-columns: 280px 1fr 360px;
      grid-template-rows: 1fr;
      height: calc(100vh - 48px - 28px);
    }
    .hamburger { display: none; }
    header .stats { display: flex; }
    header .view-toggle { display: flex; }
    footer { display: flex; }
    .bottom-tabs { display: none; }
    .drawer {
      position: static; transform: none;
      box-shadow: none; z-index: auto; max-width: none;
    }
    .sheet {
      position: static; transform: none;
      box-shadow: none; border-radius: 0;
      padding-bottom: 0; z-index: auto; max-height: none;
    }
    .sheet-close { display: none; }
    .scrim { display: none; }
  }
</style>
</head>
<body>
<header>
  <button class="hamburger" id="hamburger" title="Menu">&#9776;</button>
  <div class="logo">
    <svg class="icon" viewBox="0 0 16 16"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM5.5 11.5l-3-3 1.4-1.4 1.6 1.6 4-4 1.4 1.4-5.4 5.4z"/></svg>
    realmemory
  </div>
  <div class="search-wrap">
    <span class="search-icon">&#128269;</span>
    <input type="text" id="q" placeholder="Search memories...">
  </div>
  <div class="stats" id="stats-bar">
    <span class="stat"><span class="num" id="stat-memories">0</span> memories</span>
    <span class="stat"><span class="num" id="stat-domains">0</span> domains</span>
    <span class="stat"><span class="num" id="stat-edges">0</span> edges</span>
  </div>
  <div class="view-toggle">
    <button id="view-graph" class="active" title="Graph view">Graph</button>
    <button id="view-list" title="List view">List</button>
  </div>
</header>
<div id="app">
  <aside id="sidebar" class="drawer">
    <div class="sidebar-section">
      <h2>Domains <span class="count" id="domain-count"></span></h2>
      <div class="domain-tree" id="domain-tree">
        <div class="spinner"></div>
      </div>
    </div>
    <div class="sidebar-section">
      <h2>Type</h2>
      <div class="filter-group">
        <label><input type="checkbox" value="user_preference" checked> <span style="color:#58a6ff">user_preference</span></label>
        <label><input type="checkbox" value="task_pattern" checked> <span style="color:#3fb950">task_pattern</span></label>
        <label><input type="checkbox" value="codebase_fact" checked> <span style="color:#d29922">codebase_fact</span></label>
        <label><input type="checkbox" value="lesson_learned" checked> <span style="color:#f85149">lesson_learned</span></label>
        <label><input type="checkbox" value="session_summary" checked> <span style="color:#bc8cff">session_summary</span></label>
        <label><input type="checkbox" value="contextual_note" checked> <span style="color:#7d8590">contextual_note</span></label>
      </div>
    </div>
    <div class="sidebar-section">
      <h2>Category</h2>
      <div class="filter-group">
        <div class="category-pills" id="category-pills"></div>
      </div>
    </div>
    <div class="sidebar-section">
      <h2>Filters</h2>
      <div class="filter-group">
        <label>Scope
          <select id="scope" style="margin-top:2px">
            <option value="all">all</option>
            <option value="project">project</option>
            <option value="global">global</option>
          </select>
        </label>
      </div>
      <div class="filter-group">
        <label>Tags (comma-sep)</label>
        <input type="text" id="tags" placeholder="aws, testing" style="margin-top:2px">
      </div>
      <div class="filter-group">
        <label>Min weight: <span id="weight-val" style="color:var(--accent)">0.00</span></label>
        <input type="range" id="minWeight" min="0" max="1" step="0.01" value="0">
      </div>
      <div class="filter-group">
        <label>Created</label>
        <div class="row" style="margin-top:2px">
          <input type="date" id="createdAfter">
          <input type="date" id="createdBefore">
        </div>
      </div>
    </div>
  </aside>

  <main id="center">
    <div id="network"></div>
    <div id="list-view"><table><thead><tr>
      <th data-sort="type">Type</th>
      <th data-sort="domain">Domain</th>
      <th data-sort="category">Category</th>
      <th data-sort="weight">Weight</th>
      <th data-sort="content">Content</th>
      <th data-sort="tags">Tags</th>
      <th data-sort="createdAt">Created</th>
      <th data-sort="updatedAt">Updated</th>
    </tr></thead><tbody id="list-body"></tbody></table></div>
    <div id="empty-msg">No memories match the current filters.</div>
    <div class="graph-controls">
      <button id="btn-fit" title="Zoom to fit">&#128269;</button>
      <button id="btn-refresh" title="Refresh">&#8635;</button>
    </div>
  </main>

  <aside id="detail" class="sheet">
    <button class="sheet-close" id="sheet-close" title="Close">&#10005;</button>
    <div id="detail-content">
      <div class="placeholder">
        <div class="icon">&#128218;</div>
        Select a memory to inspect its details.
      </div>
    </div>
  </aside>
  <div class="bottom-tabs">
    <button class="tab active" data-tab="graph">Graph</button>
    <button class="tab" data-tab="list">List</button>
    <button class="tab" data-tab="detail">Detail</button>
  </div>
</div>
<div class="scrim" id="scrim"></div>
<footer id="legend">
  <span class="legend-item"><span class="dot" style="background:#58a6ff"></span> user_preference</span>
  <span class="legend-item"><span class="dot" style="background:#3fb950"></span> task_pattern</span>
  <span class="legend-item"><span class="dot" style="background:#d29922"></span> codebase_fact</span>
  <span class="legend-item"><span class="dot" style="background:#f85149"></span> lesson_learned</span>
  <span class="legend-item"><span class="dot" style="background:#bc8cff"></span> session_summary</span>
  <span class="legend-item"><span class="dot" style="background:#7d8590"></span> contextual_note</span>
  <span class="sep"></span>
  <span class="legend-item"><span class="line" style="background:#3fb950"></span> reinforces</span>
  <span class="legend-item"><span class="line" style="background:#f85149"></span> contradicts</span>
  <span class="legend-item"><span class="line" style="background:#58a6ff"></span> extends</span>
  <span class="legend-item"><span class="line" style="background:#d29922"></span> exception_to</span>
  <span class="legend-item"><span class="line" style="background:#bc8cff"></span> derived_from</span>
</footer>
<script src="/static/vis-network.min.js"></script>
<script>
// ===== Color maps =====
const TYPE_COLORS = {
  user_preference: '#58a6ff', task_pattern: '#3fb950', codebase_fact: '#d29922',
  lesson_learned: '#f85149', session_summary: '#bc8cff', contextual_note: '#7d8590'
};
const EDGE_COLORS = {
  reinforces: '#3fb950', contradicts: '#f85149', extends: '#58a6ff',
  exception_to: '#d29922', derived_from: '#bc8cff'
};
const DOMAIN_COLORS = {
  aws: '#ff9900', terraform: '#6c4ee5', opencode: '#ff6b35', testing: '#3fb950',
  vercel: '#6b7280', guacamole: '#8b5cf6', supabase: '#3ecf8e', docker: '#2496ed',
  ansible: '#ee0000', anymake: '#ffb800', python: '#3776ab', realhax: '#f85149',
  realvol: '#58a6ff', realcode: '#39c5cf', basecamp: '#f778ba',
  realmemory: '#d29922', uncategorized: '#7d8590'
};
const CATEGORY_COLORS = {
  gotcha: '#f85149', cost: '#ff9900', safety: '#d29922', integration: '#bc8cff',
  process: '#58a6ff', tooling: '#39c5cf', performance: '#3fb950'
};
function domainColor(d) { return DOMAIN_COLORS[d] || DOMAIN_COLORS.uncategorized; }
function categoryColor(c) { return CATEGORY_COLORS[c] || '#7d8590'; }

// ===== State =====
let network = null;
let allNodes = new vis.DataSet();
let allEdges = new vis.DataSet();
let currentView = 'graph';
let activeDomain = null;
let activeCategory = null;
let listSort = { col: 'weight', dir: 'desc' };
let selectedMemoryId = null;
let activeTab = 'graph';
let currentTier = 'desktop';

// ===== Query building =====
function buildQuery() {
  const params = new URLSearchParams();
  const q = document.getElementById('q').value.trim();
  if (q) params.set('q', q);
  const types = [];
  document.querySelectorAll('#sidebar input[type=checkbox]:checked').forEach(c => types.push(c.value));
  if (types.length < 6 && types.length > 0) params.set('type', types.join(','));
  else if (types.length === 0) params.set('type', '__none__');
  const scope = document.getElementById('scope').value;
  if (scope !== 'all') params.set('scope', scope);
  const tags = document.getElementById('tags').value.trim();
  if (tags) params.set('tags', tags);
  if (activeDomain) params.set('domain', activeDomain);
  if (activeCategory) params.set('category', activeCategory);
  const mw = document.getElementById('minWeight').value;
  if (parseFloat(mw) > 0) params.set('minWeight', mw);
  const ca = document.getElementById('createdAfter').value;
  if (ca) params.set('createdAfter', ca);
  const cb = document.getElementById('createdBefore').value;
  if (cb) params.set('createdBefore', cb);
  return params;
}

// ===== Fetch graph data =====
async function fetchGraph() {
  const params = buildQuery();
  const resp = await fetch('/api/graph?' + params.toString());
  const data = await resp.json();
  const nodes = (data.nodes || []).map(m => {
    const dc = domainColor(m.domain);
    const tc = TYPE_COLORS[m.type] || '#7d8590';
    const label = (m.content.slice(0, 35) + (m.content.length > 35 ? '...' : '')).replace(/\\n/g, ' ');
    return {
      id: m.id, label: label,
      title: m.content.slice(0, 200),
      color: { background: tc, border: dc, highlight: { background: tc, border: dc } },
      borderWidth: m.domain ? 3 : 1,
      size: 10 + m.weight * 25,
      font: { color: '#c9d1d9', size: 10, face: 'sans-serif' },
      shape: 'dot',
      _data: m
    };
  });
  const edges = (data.edges || []).map(e => ({
    id: e.id, from: e.source, to: e.target,
    color: { color: EDGE_COLORS[e.type] || '#7d8590', opacity: 0.6 },
    arrows: 'to', title: e.type, width: 2
  }));
  allNodes.clear(); allNodes.update(nodes);
  allEdges.clear(); allEdges.update(edges);
  document.getElementById('empty-msg').classList.toggle('show', nodes.length === 0);
  if (!network) {
    network = new vis.Network(document.getElementById('network'), { nodes: allNodes, edges: allEdges }, {
      layout: { improvedLayout: nodes.length <= 100, randomSeed: 42 },
      physics: {
        barnesHut: { gravitationalConstant: -3000, centralGravity: 0.3, springLength: 120, springConstant: 0.05, damping: 0.4 },
        stabilization: { iterations: 150 }
      },
      interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false, zoomView: true, dragView: true, multiselect: false },
      manipulation: { enabled: false }
    });
    network.on('click', function(params) {
      if (params.nodes.length > 0) {
        showDetail(params.nodes[0]);
        openDetailSheet();
      } else showPlaceholder();
    });
    network.on('doubleClick', function(params) {
      if (params.nodes.length > 0) network.focus(params.nodes[0], { scale: 1.5, animation: { duration: 400 } });
    });
    network.once('stabilizationIterationsDone', function() { network.fit(); });
  } else {
    network.setData({ nodes: allNodes, edges: allEdges });
    network.once('stabilizationIterationsDone', function() { network.fit(); });
  }
  updateListBody(data.nodes || []);
}

// ===== List view =====
function updateListBody(nodes) {
  const tbody = document.getElementById('list-body');
  const sorted = sortNodes(nodes);
  tbody.innerHTML = sorted.map(m => {
    const tc = TYPE_COLORS[m.type] || '#7d8590';
    const dc = domainColor(m.domain);
    const wColor = m.weight > 0.5 ? '#3fb950' : m.weight > 0.25 ? '#d29922' : '#f85149';
    const tags = (m.tags || []).slice(0, 3).join(', ');
    return '<tr data-id="' + esc(m.id) + '">' +
      '<td><span class="type-dot" style="background:' + tc + '"></span>' + esc(m.type) + '</td>' +
      '<td style="color:' + dc + '">' + esc(m.domain || '\u2014') + '</td>' +
      '<td>' + esc(m.category || '\u2014') + '</td>' +
      '<td><span class="weight-bar"><span class="fill" style="width:' + Math.round(m.weight * 100) + '%;background:' + wColor + '"></span></span> ' + m.weight.toFixed(2) + '</td>' +
      '<td>' + esc(m.content.slice(0, 80)) + (m.content.length > 80 ? '...' : '') + '</td>' +
      '<td style="color:var(--text-dim)">' + esc(tags) + '</td>' +
      '<td style="color:var(--text-dim);white-space:nowrap">' + esc(fmtDate(m.createdAt)) + '</td>' +
      '<td style="color:var(--text-dim);white-space:nowrap">' + esc(fmtDate(m.updatedAt)) + '</td>' +
      '</tr>';
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(t => t.classList.remove('selected'));
      tr.classList.add('selected');
      showDetail(tr.dataset.id);
      openDetailSheet();
    });
  });
}

function sortNodes(nodes) {
  const dir = listSort.dir === 'asc' ? 1 : -1;
  return [...nodes].sort((a, b) => {
    let av, bv;
    switch (listSort.col) {
      case 'type': av = a.type; bv = b.type; break;
      case 'domain': av = a.domain || ''; bv = b.domain || ''; break;
      case 'category': av = a.category || ''; bv = b.category || ''; break;
      case 'weight': av = a.weight; bv = b.weight; break;
      case 'content': av = a.content; bv = b.content; break;
      case 'tags': av = (a.tags || []).join(','); bv = (b.tags || []).join(','); break;
      case 'createdAt': av = a.createdAt || ''; bv = b.createdAt || ''; break;
      case 'updatedAt': av = a.updatedAt || ''; bv = b.updatedAt || ''; break;
      default: av = a.weight; bv = b.weight;
    }
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

// ===== Detail panel =====
async function showDetail(id) {
  selectedMemoryId = id;
  const resp = await fetch('/api/memory/' + encodeURIComponent(id));
  const data = await resp.json();
  const m = data.memory;
  const tc = TYPE_COLORS[m.type] || '#7d8590';
  const dc = domainColor(m.domain);
  let html = '';

  // Header
  html += '<div class="detail-header">';
  html += '<span class="type-dot" style="background:' + tc + ';border:2px solid ' + dc + '"></span>';
  html += '<span class="type-label">' + esc(m.type) + '</span>';
  html += '<span class="scope-badge">' + esc(m.scope) + '</span>';
  html += '</div>';

  html += '<div class="detail-body">';

  // Content
  html += '<div class="field"><div class="k">Content</div><div class="content-box">' + esc(m.content) + '</div></div>';

  // Domain + Category badges
  html += '<div class="field"><div class="k">Classification</div><div class="badges">';
  if (m.domain) html += '<span class="badge domain" style="border-color:' + dc + ';color:' + dc + '">' + esc(m.domain) + '</span>';
  if (m.category) html += '<span class="badge category">' + esc(m.category) + '</span>';
  html += '</div></div>';

  // Tags
  if (m.tags && m.tags.length) {
    html += '<div class="field"><div class="k">Tags</div><div class="badges">';
    for (const t of m.tags) html += '<span class="badge tag">' + esc(t) + '</span>';
    html += '</div></div>';
  }

  // Stats grid
  const wColor = m.weight > 0.5 ? '#3fb950' : m.weight > 0.25 ? '#d29922' : '#f85149';
  html += '<div class="field"><div class="k">Weight / Confidence</div>';
  html += '<div class="stats-grid">';
  html += '<div class="stat-card"><div class="num">' + m.weight.toFixed(3) + '</div><div class="label">weight</div></div>';
  html += '<div class="stat-card"><div class="num">' + m.confidence.toFixed(2) + '</div><div class="label">confidence</div></div>';
  html += '</div>';
  html += '<div class="weight-bar"><span class="fill" style="width:' + Math.round(m.weight * 100) + '%;background:' + wColor + '"></span></div>';
  html += '</div>';

  // Access / reinforcement
  html += '<div class="field"><div class="k">Access / Reinforcement</div><div class="stats-grid">';
  html += '<div class="stat-card"><div class="num">' + m.accessCount + '</div><div class="label">accessed</div></div>';
  html += '<div class="stat-card"><div class="num">' + m.reinforcementCount + '</div><div class="label">reinforced</div></div>';
  html += '</div></div>';

  // Source
  if (m.source && (m.source.project || m.source.ref || m.source.session)) {
    html += '<div class="field"><div class="k">Source</div><div class="source-box">';
    if (m.source.project) html += '<div class="src-line">project: <span class="val">' + esc(m.source.project) + '</span></div>';
    if (m.source.session) html += '<div class="src-line">session: <span class="val">' + esc(m.source.session) + '</span></div>';
    if (m.source.ref) html += '<div class="src-line">' + esc(m.source.refType || 'ref') + ': <span class="val">' + esc(m.source.ref) + '</span></div>';
    html += '</div></div>';
  }

  // Timestamps
  html += '<div class="field"><div class="k">Timeline</div><div class="v">';
  html += 'Created: ' + esc(m.createdAt) + '<br>Updated: ' + esc(m.updatedAt);
  html += '</div></div>';

  // Structured metadata (if any)
  if (m.metadata && Object.keys(m.metadata).length > 0) {
    const md = m.metadata;
    const hasStructured = md.assumed || md.reality || md.lesson || md.learnedDate || md.learnedProject || md.location || md.evidence || md.outcomes;
    if (hasStructured) {
      html += '<div class="field"><div class="k">Structured Data</div>';
      if (md.assumed) html += '<div style="margin-bottom:6px"><div class="k" style="color:var(--yellow)">Assumed</div><div class="v">' + esc(md.assumed) + '</div></div>';
      if (md.reality) html += '<div style="margin-bottom:6px"><div class="k" style="color:var(--red)">Reality</div><div class="v">' + esc(md.reality) + '</div></div>';
      if (md.lesson) html += '<div style="margin-bottom:6px"><div class="k" style="color:var(--green)">Lesson</div><div class="v">' + esc(md.lesson) + '</div></div>';
      if (md.learnedDate) html += '<div style="margin-bottom:6px"><div class="k">Learned</div><div class="v">' + esc(md.learnedDate) + (md.learnedProject ? ' (' + esc(md.learnedProject) + ')' : '') + '</div></div>';
      if (md.reinforced && md.reinforced.length) {
        html += '<div style="margin-bottom:6px"><div class="k">Reinforcement History</div>';
        for (const r of md.reinforced) html += '<div class="v" style="font-size:11px;color:var(--text-dim)">' + esc(r.date) + ': ' + esc(r.context) + '</div>';
        html += '</div>';
      }
      if (md.location) html += '<div style="margin-bottom:6px"><div class="k">Location</div><div class="v">' + esc(md.location) + '</div></div>';
      if (md.evidence) html += '<div style="margin-bottom:6px"><div class="k">Evidence</div><div class="v">' + esc(md.evidence) + '</div></div>';
      if (md.outcomes && md.outcomes.length) {
        html += '<div style="margin-bottom:6px"><div class="k">Outcomes</div><ul style="padding-left:16px">';
        for (const o of md.outcomes) html += '<li>' + esc(o) + '</li>';
        html += '</ul></div>';
      }
      html += '</div>';
    }
    // Raw metadata fallback
    const extraKeys = Object.keys(md).filter(k => !['assumed','reality','lesson','learnedDate','learnedProject','reinforced','location','evidence','outcomes','duration','crossProjectReinforcements'].includes(k));
    if (extraKeys.length > 0 || (md.crossProjectReinforcements && Array.isArray(md.crossProjectReinforcements) && md.crossProjectReinforcements.length > 0)) {
      html += '<div class="field"><div class="k">Raw Metadata</div><div class="metadata-box">' + esc(JSON.stringify(md, null, 2)) + '</div></div>';
    }
  }

  // Relationships
  const rels = data.relationships || [];
  if (rels.length) {
    html += '<div class="field"><div class="k">Relationships (' + rels.length + ')</div><div class="rel-list">';
    for (const r of rels) {
      const dir = r.direction === 'outgoing' ? '\\u2192' : '\\u2190';
      const ec = EDGE_COLORS[r.type] || '#7d8590';
      const preview = r.memory.content.slice(0, 50);
      html += '<div class="rel-item">';
      html += '<span class="rel-type" style="background:' + ec + '22;color:' + ec + '">' + dir + ' ' + esc(r.type) + '</span>';
      html += '<span class="rel-preview">' + esc(preview) + '</span>';
      html += '<span class="rel-link" data-id="' + esc(r.memory.id) + '">view\\u00bb</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  html += '</div>';
  document.getElementById('detail-content').innerHTML = html;
  document.querySelectorAll('#detail .rel-link').forEach(el => {
    el.addEventListener('click', () => {
      showDetail(el.dataset.id);
      if (network) { network.focus(el.dataset.id, { scale: 1.5, animation: { duration: 400 } }); network.selectNodes([el.dataset.id]); }
    });
  });
}

function showPlaceholder() {
  selectedMemoryId = null;
  document.getElementById('detail-content').innerHTML = '<div class="placeholder"><div class="icon">\\u{1F4D8}</div>Select a memory to inspect its details.</div>';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '\u2014';
  var p = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
       + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ===== Domain sidebar =====
async function fetchDomains() {
  try {
    const resp = await fetch('/api/domains');
    const data = await resp.json();
    const tree = document.getElementById('domain-tree');
    const domains = data.domains || [];
    document.getElementById('domain-count').textContent = domains.length + ' domains';

    let html = '<div class="domain-item' + (!activeDomain ? ' active' : '') + '" data-domain="">';
    html += '<span class="dot" style="background:' + DOMAIN_COLORS.uncategorized + '"></span>';
    html += '<span class="name">All domains</span>';
    html += '<span class="badge">' + data.total + '</span></div>';

    for (const d of domains) {
      const name = d.name === 'null' || !d.name ? 'uncategorized' : d.name;
      const dc = domainColor(name);
      const isActive = activeDomain === name || (activeDomain === 'uncategorized' && name === 'uncategorized');
      html += '<div class="domain-item' + (isActive ? ' active' : '') + (name === 'uncategorized' ? ' uncategorized' : '') + '" data-domain="' + esc(name) + '">';
      html += '<span class="dot" style="background:' + dc + '"></span>';
      html += '<span class="name">' + esc(name) + '</span>';
      html += '<span class="badge">' + d.count + '</span>';
      html += '</div>';
    }
    tree.innerHTML = html;

    tree.querySelectorAll('.domain-item').forEach(el => {
      el.addEventListener('click', () => {
        const d = el.dataset.domain;
        activeDomain = (d === '' || d === activeDomain) ? null : d;
        tree.querySelectorAll('.domain-item').forEach(e => e.classList.remove('active'));
        if (activeDomain) {
          tree.querySelector('[data-domain="' + activeDomain + '"]')?.classList.add('active');
        } else {
          tree.querySelector('[data-domain=""]').classList.add('active');
        }
        fetchGraph();
      });
    });

    // Category pills
    const allCats = new Set();
    for (const d of domains) {
      if (d.categories) Object.keys(d.categories).forEach(c => allCats.add(c));
    }
    const pills = document.getElementById('category-pills');
    pills.innerHTML = Array.from(allCats).sort().map(c => {
      const cc = categoryColor(c);
      const isActive = activeCategory === c;
      return '<span class="pill' + (isActive ? ' active' : '') + '" data-cat="' + esc(c) + '" style="' + (isActive ? '' : 'border-color:' + cc + '33;color:' + cc) + '">' + esc(c) + '</span>';
    }).join('');
    pills.querySelectorAll('.pill').forEach(el => {
      el.addEventListener('click', () => {
        const c = el.dataset.cat;
        activeCategory = (c === activeCategory) ? null : c;
        pills.querySelectorAll('.pill').forEach(e => e.classList.remove('active'));
        if (activeCategory) pills.querySelector('[data-cat="' + activeCategory + '"]')?.classList.add('active');
        fetchGraph();
      });
    });
  } catch(e) {
    console.error('Failed to fetch domains:', e);
  }
}

// ===== Stats bar =====
async function fetchStats() {
  try {
    const resp = await fetch('/api/stats');
    const s = await resp.json();
    document.getElementById('stat-memories').textContent = s.totalMemories || 0;
    document.getElementById('stat-edges').textContent = s.totalRelationships || 0;
    // Count domains from the domains endpoint
    const dr = await fetch('/api/domains');
    const dd = await dr.json();
    document.getElementById('stat-domains').textContent = (dd.domains || []).length;
  } catch(e) {}
}

// ===== Event handlers =====
function debounce(fn, ms) {
  let t; return function() { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

document.getElementById('q').addEventListener('input', debounce(fetchGraph, 300));
document.querySelectorAll('#sidebar input[type=checkbox]').forEach(c => c.addEventListener('change', fetchGraph));
document.getElementById('scope').addEventListener('change', fetchGraph);
document.getElementById('tags').addEventListener('input', debounce(fetchGraph, 300));
document.getElementById('minWeight').addEventListener('input', function() {
  document.getElementById('weight-val').textContent = parseFloat(this.value).toFixed(2);
  debounce(fetchGraph, 200)();
});
document.getElementById('createdAfter').addEventListener('change', fetchGraph);
document.getElementById('createdBefore').addEventListener('change', fetchGraph);
document.getElementById('btn-refresh').addEventListener('click', () => { fetchGraph(); fetchStats(); fetchDomains(); });
document.getElementById('btn-fit').addEventListener('click', () => { if (network) network.fit({ animation: { duration: 500 } }); });

// View toggle
document.getElementById('view-graph').addEventListener('click', () => {
  currentView = 'graph';
  document.getElementById('view-graph').classList.add('active');
  document.getElementById('view-list').classList.remove('active');
  document.getElementById('network').style.display = 'block';
  document.getElementById('list-view').classList.remove('show');
  if (network) network.redraw();
});
document.getElementById('view-list').addEventListener('click', () => {
  currentView = 'list';
  document.getElementById('view-list').classList.add('active');
  document.getElementById('view-graph').classList.remove('active');
  document.getElementById('network').style.display = 'none';
  document.getElementById('list-view').classList.add('show');
});

// List sort
document.querySelectorAll('#list-view th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (listSort.col === col) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
    else { listSort.col = col; listSort.dir = 'desc'; }
    updateListBody(allNodes.get().map(n => n._data).filter(Boolean));
  });
});

// ===== Viewport tier detection (mobile-first responsive) =====
function getViewportTier() {
  if (window.matchMedia('(min-width: 1024px)').matches) return 'desktop';
  if (window.matchMedia('(min-width: 640px)').matches) return 'tablet';
  return 'mobile';
}
function isNetworkVisible() {
  const el = document.getElementById('network');
  return el && el.style.display !== 'none';
}
function clearMobileInlineStyles() {
  const networkEl = document.getElementById('network');
  const listViewEl = document.getElementById('list-view');
  const detailEl = document.getElementById('detail');
  const sheetCloseEl = document.getElementById('sheet-close');
  if (networkEl) networkEl.style.display = '';
  if (listViewEl) { listViewEl.style.display = ''; listViewEl.classList.remove('show'); }
  if (detailEl) {
    detailEl.style.display = '';
    detailEl.style.transform = '';
    detailEl.style.position = '';
    detailEl.style.maxHeight = '';
    detailEl.style.borderRadius = '';
    detailEl.style.boxShadow = '';
    detailEl.style.paddingBottom = '';
    detailEl.style.zIndex = '';
  }
  if (sheetCloseEl) sheetCloseEl.style.display = '';
}
function openDetailSheet() {
  if (getViewportTier() === 'desktop') return;
  const detailEl = document.getElementById('detail');
  detailEl.style.display = 'block';
  detailEl.offsetHeight;
  detailEl.classList.add('open');
  document.getElementById('scrim').classList.add('visible');
}
function closeDetailSheet() {
  if (getViewportTier() === 'desktop') return;
  const detailEl = document.getElementById('detail');
  detailEl.classList.remove('open');
  document.getElementById('scrim').classList.remove('visible');
  setTimeout(() => {
    if (!detailEl.classList.contains('open') && activeTab !== 'detail') {
      detailEl.style.display = 'none';
    }
  }, 200);
}

// ===== Mobile interaction handlers (short-circuit on desktop) =====
document.getElementById('hamburger').addEventListener('click', () => {
  if (getViewportTier() === 'desktop') return;
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('scrim').classList.toggle('visible');
});

document.getElementById('scrim').addEventListener('click', () => {
  if (getViewportTier() === 'desktop') return;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('detail').classList.remove('open');
  document.getElementById('scrim').classList.remove('visible');
  if (activeTab !== 'detail') {
    setTimeout(() => {
      const detailEl = document.getElementById('detail');
      if (!detailEl.classList.contains('open')) detailEl.style.display = 'none';
    }, 200);
  }
});

document.getElementById('sheet-close').addEventListener('click', () => {
  if (getViewportTier() === 'desktop') return;
  closeDetailSheet();
});

document.querySelectorAll('.bottom-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (getViewportTier() === 'desktop') return;
    const tab = btn.dataset.tab;
    activeTab = tab;
    document.querySelectorAll('.bottom-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const networkEl = document.getElementById('network');
    const listViewEl = document.getElementById('list-view');
    const detailEl = document.getElementById('detail');
    const sheetCloseEl = document.getElementById('sheet-close');
    detailEl.style.transform = '';
    detailEl.style.position = '';
    detailEl.style.maxHeight = '';
    detailEl.style.borderRadius = '';
    detailEl.style.boxShadow = '';
    detailEl.style.paddingBottom = '';
    detailEl.style.zIndex = '';
    if (tab === 'graph') {
      networkEl.style.display = 'block';
      listViewEl.style.display = 'none';
      listViewEl.classList.remove('show');
      detailEl.style.display = 'none';
      sheetCloseEl.style.display = '';
      if (network) { network.redraw(); network.fit({ animation: { duration: 300 } }); }
    } else if (tab === 'list') {
      networkEl.style.display = 'none';
      listViewEl.style.display = 'block';
      listViewEl.classList.add('show');
      detailEl.style.display = 'none';
      sheetCloseEl.style.display = '';
    } else if (tab === 'detail') {
      networkEl.style.display = 'none';
      listViewEl.style.display = 'none';
      listViewEl.classList.remove('show');
      detailEl.style.display = 'block';
      detailEl.style.transform = 'none';
      detailEl.style.position = 'relative';
      detailEl.style.maxHeight = 'none';
      detailEl.style.borderRadius = '0';
      detailEl.style.boxShadow = 'none';
      detailEl.style.paddingBottom = '0';
      sheetCloseEl.style.display = 'none';
      if (!selectedMemoryId) {
        document.getElementById('detail-content').innerHTML = '<div class="placeholder"><div class="icon">&#128218;</div>Tap a node to see its detail.</div>';
      }
    }
  });
});

// Debounced resize: recompute tier, redraw+fit network if visible (O3)
const debouncedResize = debounce(() => {
  const newTier = getViewportTier();
  if (newTier !== currentTier) {
    currentTier = newTier;
    if (newTier === 'desktop') {
      clearMobileInlineStyles();
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('detail').classList.remove('open');
      document.getElementById('scrim').classList.remove('visible');
      document.querySelectorAll('.bottom-tabs button').forEach(b => b.classList.remove('active'));
      const graphTab = document.querySelector('.bottom-tabs button[data-tab="graph"]');
      if (graphTab) graphTab.classList.add('active');
      activeTab = 'graph';
    }
  }
  if (network && isNetworkVisible()) {
    network.redraw();
    network.fit({ animation: { duration: 300 } });
  }
}, 200);
window.addEventListener('resize', debouncedResize);

// Debounced orientationchange: redraw+fit network if visible (O3)
const debouncedOrient = debounce(() => {
  if (network && isNetworkVisible()) {
    network.redraw();
    network.fit({ animation: { duration: 300 } });
  }
}, 200);
window.addEventListener('orientationchange', debouncedOrient);

// ===== Init =====
currentTier = getViewportTier();
fetchDomains();
fetchGraph();
fetchStats();
</script>
</body>
</html>
`;

// src/browser/server.ts
var import_meta = {};
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
function loadVisNetworkJs() {
  const here = (0, import_node_path3.dirname)((0, import_node_url.fileURLToPath)(import_meta.url));
  const candidates = [
    // Built package: dist/browser/static/ (server bundled into dist/bin.js).
    (0, import_node_path3.join)(here, "browser", "static", "vis-network.min.js"),
    // Dev: src/browser/server.ts -> src/browser/static/.
    (0, import_node_path3.join)(here, "static", "vis-network.min.js"),
    // Dev fallback: relative to cwd.
    (0, import_node_path3.join)(process.cwd(), "src", "browser", "static", "vis-network.min.js")
  ];
  for (const p of candidates) {
    try {
      return (0, import_node_fs3.readFileSync)(p, "utf-8");
    } catch {
    }
  }
  throw new Error(
    "realmemory: vendored vis-network.min.js not found. Run `npm run build` or ensure src/browser/static/vis-network.min.js exists."
  );
}
function startBrowserServer(store, opts) {
  const visNetworkJs = loadVisNetworkJs();
  const ownLifecycle = opts.ownLifecycle ?? true;
  const server = (0, import_node_http.createServer)((req, res) => {
    handleRequest(req, res, store, visNetworkJs).catch((err) => {
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
async function handleRequest(req, res, store, visNetworkJs) {
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
      "Cache-Control": "public, max-age=86400"
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
  sendJson(res, 404, { error: "Not Found" });
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
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

// src/mcp-server.ts
function zodToInputSchema(schema) {
  const json = import_zod.z.toJSONSchema(schema, { io: "input" });
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
var memoryTypeSchema = import_zod.z.enum([
  "user_preference",
  "task_pattern",
  "codebase_fact",
  "lesson_learned",
  "session_summary",
  "contextual_note"
]);
var relationshipTypeSchema = import_zod.z.enum([
  "reinforces",
  "contradicts",
  "extends",
  "exception_to",
  "derived_from"
]);
var storeMemorySchema = import_zod.z.object({
  content: import_zod.z.string().describe("The memory content"),
  type: memoryTypeSchema,
  tags: import_zod.z.array(import_zod.z.string()).optional().default([]),
  scope: import_zod.z.enum(["project", "global"]).optional().default("project"),
  domain: import_zod.z.string().optional().describe("Primary technology/topic domain (e.g. 'aws', 'testing', 'opencode')"),
  category: import_zod.z.string().optional().describe("Sub-classification within type (e.g. 'gotcha', 'cost', 'safety', 'process', 'tooling')"),
  source: import_zod.z.object({
    project: import_zod.z.string().optional(),
    session: import_zod.z.string().optional(),
    ref: import_zod.z.string().optional(),
    refType: import_zod.z.enum(["issue", "pr", "adr", "file", "commit", "url"]).optional()
  }).optional().describe("Origin tracking \u2014 where this memory came from"),
  confidence: import_zod.z.number().min(0).max(1).optional().default(0.5),
  relationships: import_zod.z.array(
    import_zod.z.object({
      targetId: import_zod.z.string(),
      type: relationshipTypeSchema
    })
  ).optional().default([]),
  metadata: import_zod.z.record(import_zod.z.string(), import_zod.z.unknown()).optional().default({})
});
var recallSchema = import_zod.z.object({
  query: import_zod.z.string().describe("Natural-language query \u2014 what you want to recall"),
  scope: import_zod.z.enum(["project", "global", "all"]).optional().default("all"),
  limit: import_zod.z.number().optional().default(5),
  threshold: import_zod.z.number().min(0).max(1).optional().default(0.3),
  types: import_zod.z.array(memoryTypeSchema).optional(),
  tags: import_zod.z.array(import_zod.z.string()).optional(),
  domain: import_zod.z.string().optional().describe("Filter by domain (e.g. 'aws', 'testing')"),
  traverse: import_zod.z.boolean().optional().default(true)
});
var searchSchema = import_zod.z.object({
  scope: import_zod.z.enum(["project", "global", "all"]).optional().default("all"),
  types: import_zod.z.array(memoryTypeSchema).optional(),
  tags: import_zod.z.array(import_zod.z.string()).optional(),
  domain: import_zod.z.string().optional().describe("Filter by domain"),
  category: import_zod.z.string().optional().describe("Filter by category"),
  minWeight: import_zod.z.number().optional(),
  createdAfter: import_zod.z.string().optional(),
  createdBefore: import_zod.z.string().optional(),
  limit: import_zod.z.number().optional().default(20),
  offset: import_zod.z.number().optional().default(0),
  sortBy: import_zod.z.enum(["weight", "created", "updated", "confidence"]).optional().default("weight"),
  sortOrder: import_zod.z.enum(["asc", "desc"]).optional().default("desc")
});
var relateSchema = import_zod.z.object({
  sourceId: import_zod.z.string(),
  targetId: import_zod.z.string(),
  type: relationshipTypeSchema
});
var updateMemorySchema = import_zod.z.object({
  id: import_zod.z.string(),
  content: import_zod.z.string().optional(),
  confidence: import_zod.z.number().min(0).max(1).optional(),
  tags: import_zod.z.array(import_zod.z.string()).optional(),
  domain: import_zod.z.string().optional().describe("Update the domain classification"),
  category: import_zod.z.string().optional().describe("Update the category"),
  source: import_zod.z.object({
    project: import_zod.z.string().optional(),
    session: import_zod.z.string().optional(),
    ref: import_zod.z.string().optional(),
    refType: import_zod.z.enum(["issue", "pr", "adr", "file", "commit", "url"]).optional()
  }).optional().describe("Update the source"),
  metadata: import_zod.z.record(import_zod.z.string(), import_zod.z.unknown()).optional(),
  reinforce: import_zod.z.boolean().optional().default(false)
});
var forgetSchema = import_zod.z.object({
  id: import_zod.z.string(),
  hard: import_zod.z.boolean().optional().default(false),
  cascadeRelationships: import_zod.z.boolean().optional().default(true)
});
var listMemoriesSchema = import_zod.z.object({
  scope: import_zod.z.enum(["project", "global", "all"]).optional().default("all"),
  type: memoryTypeSchema.optional(),
  tag: import_zod.z.string().optional(),
  domain: import_zod.z.string().optional().describe("Filter by domain"),
  category: import_zod.z.string().optional().describe("Filter by category"),
  minWeight: import_zod.z.number().optional(),
  limit: import_zod.z.number().optional().default(50),
  offset: import_zod.z.number().optional().default(0)
});
var getMemorySchema = import_zod.z.object({
  id: import_zod.z.string(),
  includeRelationships: import_zod.z.boolean().optional().default(true)
});
var getMetricsSchema = import_zod.z.object({
  name: import_zod.z.string().optional().describe("Filter by metric name (e.g. 'recall_hit'). If omitted, returns all metrics."),
  since: import_zod.z.string().optional().describe("Only include metrics recorded at or after this ISO timestamp.")
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
    }
  ];
}
var SERVER_NAME = "realmemory";
var SERVER_VERSION = "0.1.1";
async function startMcpServer(config, opts) {
  const mergedConfig = config ?? loadConfig();
  const ownLifecycle = opts?.ownLifecycle ?? false;
  const store = new MemoryStore(mergedConfig);
  await store.init();
  const tools = createMcpTools(store);
  const server = new import_server.Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(import_types.ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  }));
  server.setRequestHandler(import_types.CallToolRequestSchema, async (request) => {
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
  const transport = new import_stdio.StdioServerTransport();
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createMcpTools,
  startMcpServer
});
