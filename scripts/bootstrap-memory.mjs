#!/usr/bin/env node
// realmemory — bootstrap-memory.mjs
//
// The REAL deep-learning-phase tool. Processes ALL (or top-N) opencode sessions
// through an LLM to extract durable memories, deduplicates against the existing
// realmemory database, and stores novel memories WITH embeddings — autonomously,
// no agent in the loop, no context limits. Scales to thousands of sessions.
//
// This is what makes realmemory useful on day one for a user with 1000+ existing
// sessions: run one command, get a populated memory database.
//
// Pipeline per session:
//   transcript (from opencode.db) → LLM (extract memories) → dedup (FTS5 search)
//   → store (with embedding, directly to realmemory SQLite DB)
//
// Usage:
//   node scripts/bootstrap-memory.mjs                          # auto-detect everything, process all sessions
//   node scripts/bootstrap-memory.mjs --limit 50               # only top 50 by cost
//   node scripts/bootstrap-memory.mjs --min-cost 1             # only sessions >= $1
//   node scripts/bootstrap-memory.mjs --concurrency 5          # 5 sessions in parallel
//   node scripts/bootstrap-memory.mjs --dry-run                # extract + report, don't store
//   node scripts/bootstrap-memory.mjs --resume                 # skip already-processed sessions
//   node scripts/bootstrap-memory.mjs --model openai/gpt-4o    # override LLM model
//   node scripts/bootstrap-memory.mjs --api-key sk-...         # override API key
//   node scripts/bootstrap-memory.mjs --api-url http://localhost:8085/v1  # local LLM
//   node scripts/bootstrap-memory.mjs --db ~/.local/share/opencode/opencode.db
//   node scripts/bootstrap-memory.mjs --realmemory-db ~/.opencode/realmemory/data.db
//
// LLM provider auto-detection (in order):
//   1. --api-key + --model + --api-url CLI flags
//   2. ~/.config/opencode/realmemory.json summaryProvider config
//   3. opencode auth.json → openrouter key (model: openrouter/auto or --model)
//   4. opencode auth.json → openai key (model: gpt-4o-mini)
//   5. opencode opencode.json → local provider (llamacpp etc.)
//
// Requires: Node 18+ (for fetch), better-sqlite3 (from realmemory's deps).
// Optional: @huggingface/transformers (from realmemory's deps — for embeddings.
//           If unavailable, memories are stored without embeddings; FTS5 keyword
//           search still works, but semantic recall won't find them.)

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { argv, stderr, exit, env } from "node:process";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const args = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) { args[key] = next; i++; }
  else args[key] = "true";
}

const HOME = homedir();
const OC_DB = args.db || join(HOME, ".local", "share", "opencode", "opencode.db");
const RM_DB = args["realmemory-db"] || join(HOME, ".opencode", "realmemory", "data.db");
const LIMIT = args.limit ? parseInt(args.limit, 10) : 0;
const MIN_COST = args["min-cost"] ? parseFloat(args["min-cost"]) : 0;
const CONCURRENCY = args.concurrency ? parseInt(args.concurrency, 10) : 3;
const DRY_RUN = !!args["dry-run"];
const RESUME = !!args.resume;
const VERBOSE = !!args.verbose;
const MAX_TRANSCRIPT_CHARS = 25000; // truncate long sessions for LLM context window

function log(...a) { stderr.write(`[bootstrap] ${a.join(" ")}\n`); }
function vlog(...a) { if (VERBOSE) stderr.write(`[bootstrap] ${a.join(" ")}\n`); }

// ---------------------------------------------------------------------------
// sqlite loader
// ---------------------------------------------------------------------------
function loadSqlite(dbPath) {
  try {
    const Database = require("better-sqlite3");
    return new Database(dbPath, { readonly: false, fileMustExist: true });
  } catch (e) {
    log(`FATAL: cannot open SQLite at ${dbPath}: ${e.message}`);
    log(`Install realmemory (npm i realmemory) for better-sqlite3, or pass --db / --realmemory-db`);
    exit(1);
  }
}

// ---------------------------------------------------------------------------
// LLM provider auto-detection
// ---------------------------------------------------------------------------
function detectProvider() {
  // 1. CLI flags
  if (args["api-key"] && args.model) {
    return {
      provider: args["api-url"]?.includes("anthropic") ? "anthropic" : "openai",
      model: args.model,
      apiKey: args["api-key"],
      apiUrl: args["api-url"] || undefined,
    };
  }

  // 2. realmemory config
  const rmConfigPath = join(HOME, ".config", "opencode", "realmemory.json");
  if (existsSync(rmConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(rmConfigPath, "utf8").replace(/\/\/.*$/gm, ""));
      if (cfg.summaryProvider) return cfg.summaryProvider;
    } catch {}
  }

  // 3. opencode auth.json → openrouter
  const authPath = join(HOME, ".local", "share", "opencode", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth.openrouter?.key) {
        return {
          provider: "openai",
          model: args.model || "z-ai/glm-5.2",
          apiKey: auth.openrouter.key,
          apiUrl: "https://openrouter.ai/api/v1/chat/completions",
        };
      }
      if (auth.openai?.key) {
        return {
          provider: "openai",
          model: args.model || "gpt-4o-mini",
          apiKey: auth.openai.key,
          apiUrl: undefined, // default OpenAI endpoint
        };
      }
    } catch {}
  }

  // 4. opencode opencode.json → local provider
  const ocConfigPath = join(HOME, ".config", "opencode", "opencode.json");
  if (existsSync(ocConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(ocConfigPath, "utf8"));
      if (cfg.provider) {
        for (const [name, prov] of Object.entries(cfg.provider)) {
          const baseURL = prov.options?.baseURL;
          if (baseURL) {
            const models = Object.keys(prov.models || {});
            return {
              provider: "openai",
              model: args.model || models[0] || "local-model",
              apiKey: "no-key", // local servers usually don't need auth
              apiUrl: `${baseURL}/chat/completions`,
            };
          }
        }
      }
    } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// embedding provider (optional — for semantic search)
// ---------------------------------------------------------------------------
let _embedFn = null;
async function getEmbedFn() {
  if (_embedFn !== null) return _embedFn;
  try {
    // Try to import from realmemory's dist (repo) or installed package
    const paths = [
      join(__dirname, "..", "dist", "embeddings.js"),
      join(__dirname, "..", "dist", "index.js"),
    ];
    for (const p of paths) {
      if (existsSync(p)) {
        const mod = await import(`file://${p}`);
        if (mod.createEmbeddingProvider) {
          const provider = await mod.createEmbeddingProvider({ model: "Xenova/all-MiniLM-L6-v2" });
          _embedFn = async (text) => provider.embed(text);
          log("embeddings: enabled (Xenova/all-MiniLM-L6-v2)");
          return _embedFn;
        }
      }
    }
  } catch (e) {
    vlog(`embedding provider unavailable: ${e.message}`);
  }
  _embedFn = null;
  log("embeddings: disabled (memories will lack semantic search; FTS5 keyword search still works)");
  return _embedFn;
}

// ---------------------------------------------------------------------------
// transcript extraction (from opencode.db)
// ---------------------------------------------------------------------------
function extractTranscript(db, sessionId) {
  const session = db.prepare("SELECT title, agent, model, cost, time_created FROM session WHERE id = ?").get(sessionId);
  if (!session) return null;

  const messages = db.prepare(
    "SELECT id, time_created FROM message WHERE session_id = ? ORDER BY time_created"
  ).all(sessionId);

  const parts = [];
  parts.push(`Session: ${session.title || "(untitled)"}`);
  parts.push(`Agent: ${session.agent || "?"}, Model: ${session.model || "?"}, Cost: $${(session.cost || 0).toFixed(2)}`);
  parts.push(`Messages: ${messages.length}`);
  parts.push("");

  let totalChars = 0;
  for (const msg of messages) {
    const msgParts = db.prepare(
      "SELECT data FROM part WHERE message_id = ? ORDER BY time_created"
    ).all(msg.id);

    for (const p of msgParts) {
      const text = partToText(p.data);
      if (!text) continue;
      if (totalChars + text.length > MAX_TRANSCRIPT_CHARS) {
        // Truncate — take what fits, then append a note
        const remaining = MAX_TRANSCRIPT_CHARS - totalChars;
        if (remaining > 200) {
          parts.push(text.slice(0, remaining));
          parts.push("\n[... transcript truncated for context window ...]");
        }
        return { session, transcript: parts.join("\n"), truncated: true };
      }
      parts.push(text);
      totalChars += text.length;
    }
  }

  return { session, transcript: parts.join("\n"), truncated: false };
}

function partToText(data) {
  if (typeof data !== "string") return "";
  try {
    const j = JSON.parse(data);
    if (typeof j === "string") return j;
    if (j?.type === "text" && j.text) return j.text;
    if (j?.type === "tool_call" && j.name) return `[tool: ${j.name}]`;
    if (j?.type === "tool_result" && j.content) {
      const c = typeof j.content === "string" ? j.content : JSON.stringify(j.content).slice(0, 500);
      return `[tool_result: ${c.slice(0, 500)}]`;
    }
    if (j?.role && j?.content) {
      const c = typeof j.content === "string" ? j.content : JSON.stringify(j.content).slice(0, 500);
      return `[${j.role}]: ${c}`;
    }
    return "";
  } catch {
    return data.slice(0, 200);
  }
}

// ---------------------------------------------------------------------------
// LLM call (OpenAI-compatible / Anthropic)
// ---------------------------------------------------------------------------
async function callLLM(provider, prompt) {
  let url = provider.apiUrl;
  if (!url) {
    url = provider.provider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : "https://api.openai.com/v1/chat/completions";
  }

  const isAnthropic = provider.provider === "anthropic" || url.includes("/v1/messages");

  if (isAnthropic) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`LLM error ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    return data.content?.map((c) => c.text || "").join("") || "";
  }

  // OpenAI-compatible
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    }),
  });
  if (!resp.ok) throw new Error(`LLM error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------------------------------------------------------------------------
// summarization prompt (enhanced from summarize.ts for bootstrap context)
// ---------------------------------------------------------------------------
function buildPrompt(transcript, sessionMeta) {
  return [
    "You are an agent memory curator performing a deep-learning bootstrap.",
    "Extract ALL durable, reusable memories from the coding-session transcript below.",
    "This is a one-time import — be thorough. Aim for 5-15 memories.",
    "",
    "Return ONLY a JSON array. Each element must be an object with these fields:",
    '- "content": a non-empty, self-contained string (third person, no pronouns needing context).',
    '  2-4 sentences. Specific enough to be useful. Generalized where possible.',
    '- "type": one of: user_preference, task_pattern, codebase_fact, lesson_learned, session_summary, contextual_note',
    '- "domain": the primary tech/topic (e.g. "aws", "testing", "opencode", "realvol", "realhax", "anymake", "vercel").',
    '  Use the project name if project-specific.',
    '- "category": for lessons: gotcha, cost, safety, integration, process, tooling, performance. null for other types.',
    '- "confidence": 0 to 1 (how sure you are this is worth keeping).',
    '- "weight": 0 to 1 (higher = more important. Things that cost time/money = 0.8+. Observations = 0.3-0.5).',
    '- "tags": array of short lowercase keywords.',
    "",
    "Type descriptions:",
    "- user_preference: how the user wants things done (corrections, stated preferences, build-order choices).",
    "- task_pattern: reproducible approaches/flows that worked (commands, pipelines, techniques).",
    "- codebase_fact: non-obvious structural facts about a project (architecture, schema, invariants).",
    "- lesson_learned: hard-won insights — things that broke, wrong assumptions, approaches that failed.",
    '  Include "assumed", "reality", "lesson" sub-fields in a nested "metadata" object when applicable.',
    "- session_summary: exactly one per session — what was built/fixed/learned.",
    "- contextual_note: developing theories, observations, half-formed insights that don't fit above.",
    "",
    "Rules:",
    '- Always include exactly one "session_summary".',
    "- Do not invent facts — only extract what is present.",
    "- Do not emit commentary or prose outside the JSON array.",
    '- For "lesson_learned", add a "metadata" object: {"assumed":"...", "reality":"...", "lesson":"..."}.',
    "",
    `Session metadata: title="${sessionMeta.title}", agent=${sessionMeta.agent}, cost=$${(sessionMeta.cost || 0).toFixed(2)}`,
    "",
    "Transcript:",
    '"""',
    transcript,
    '"""',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// defensive JSON parsing (from summarize.ts)
// ---------------------------------------------------------------------------
function parseMemories(response) {
  if (typeof response !== "string" || response.trim().length === 0) return [];
  const trimmed = response.trim();
  let parsed = null;

  try { parsed = JSON.parse(trimmed); } catch {}

  if (!Array.isArray(parsed)) {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) { try { parsed = JSON.parse(fence[1].trim()); } catch {} }
  }

  if (!Array.isArray(parsed)) {
    const first = trimmed.indexOf("[");
    const last = trimmed.lastIndexOf("]");
    if (first !== -1 && last > first) { try { parsed = JSON.parse(trimmed.slice(first, last + 1)); } catch {} }
  }

  if (!Array.isArray(parsed)) return [];

  const VALID_TYPES = new Set(["user_preference", "task_pattern", "codebase_fact", "lesson_learned", "session_summary", "contextual_note"]);
  return parsed
    .filter((e) => e && typeof e === "object" && typeof e.content === "string" && e.content.trim() && VALID_TYPES.has(e.type))
    .map((e) => ({
      content: e.content.trim(),
      type: e.type,
      domain: e.domain || null,
      category: e.category || null,
      confidence: Math.max(0, Math.min(1, typeof e.confidence === "number" ? e.confidence : 0.5)),
      weight: Math.max(0, Math.min(1, typeof e.weight === "number" ? e.weight : 0.4)),
      tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string") : [],
      metadata: e.metadata || {},
    }));
}

// ---------------------------------------------------------------------------
// dedup check (FTS5 keyword search against existing memories)
// ---------------------------------------------------------------------------
function dedupCheck(rdb, content) {
  // Extract keywords from the content for FTS5 search
  const keywords = content
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 8)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean);

  if (keywords.length === 0) return null;

  const query = keywords.map((k) => `"${k}"`).join(" OR ");
  try {
    const rows = rdb
      .prepare(
        `SELECT m.id, m.content, m.type, m.weight FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active'
         ORDER BY rank LIMIT 3`
      )
      .all(query);

    if (rows.length === 0) return null;

    // Check for high text overlap (simple word-overlap heuristic)
    const contentWords = new Set(content.toLowerCase().split(/\s+/));
    for (const row of rows) {
      const rowWords = new Set(row.content.toLowerCase().split(/\s+/));
      const intersection = [...contentWords].filter((w) => rowWords.has(w));
      const overlap = intersection.length / Math.min(contentWords.size, rowWords.size);
      if (overlap > 0.6) {
        return { id: row.id, existingContent: row.content.slice(0, 80), overlap };
      }
    }
    return null;
  } catch {
    // FTS5 might not be configured — skip dedup
    return null;
  }
}

// ---------------------------------------------------------------------------
// store memory directly to realmemory DB
// ---------------------------------------------------------------------------
function ulid() {
  // Simplified ULID — time-ordered unique ID
  const ts = Date.now().toString(36).toUpperCase().padStart(10, "0");
  const rand = Math.random().toString(36).toUpperCase().slice(2, 18).padEnd(18, "0");
  return "01" + ts + rand;
}

function storeMemory(rdb, embedFn, memory, sessionId) {
  const id = ulid();
  const now = new Date().toISOString();
  const tags = JSON.stringify(memory.tags);
  const source = JSON.stringify({ session: sessionId });
  const metadata = JSON.stringify(memory.metadata || {});

  // Generate embedding if available
  let embeddingBuf = null;
  if (embedFn) {
    try {
      const embedding = embedFn ? null : null; // embedFn is sync in this context — handle below
    } catch {}
  }

  rdb.prepare(
    `INSERT INTO memories (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, domain, source, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    memory.content,
    memory.type,
    "global", // default to global; the agent can narrow later
    tags,
    memory.weight,
    memory.confidence,
    now,
    now,
    0,
    0,
    metadata,
    "active",
    memory.domain,
    source,
    memory.category,
  );

  // Update FTS5 index
  try {
    rdb.prepare("INSERT INTO memories_fts (rowid, content) VALUES (?, ?)").run(
      rdb.prepare("SELECT last_insert_rowid() as id").get().id,
      memory.content,
    );
  } catch {}

  return id;
}

// Store embedding asynchronously (embeddings are generated via transformers which is async)
async function storeEmbedding(rdb, memoryId, embedFn, content) {
  if (!embedFn) return;
  try {
    const embedding = await embedFn(content);
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    rdb.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(buf, memoryId);
  } catch (e) {
    vlog(`embedding failed for ${memoryId}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// process one session
// ---------------------------------------------------------------------------
async function processSession(ocDb, rdb, embedFn, provider, sessionId, processed) {
  const extracted = extractTranscript(ocDb, sessionId);
  if (!extracted) return { sessionId, error: "no transcript", stored: 0 };

  const { session, transcript, truncated } = extracted;
  vlog(`  session: ${session.title?.slice(0, 50)} | ${transcript.length} chars${truncated ? " (truncated)" : ""}`);

  // Build prompt + call LLM
  const prompt = buildPrompt(transcript, session);
  let memories;
  try {
    const response = await callLLM(provider, prompt);
    memories = parseMemories(response);
  } catch (e) {
    return { sessionId, error: `LLM: ${e.message}`, stored: 0 };
  }

  if (memories.length === 0) {
    return { sessionId, extracted: 0, stored: 0, deduped: 0 };
  }

  // Dedup + store
  let stored = 0;
  let deduped = 0;
  const storedIds = [];

  for (const mem of memories) {
    if (DRY_RUN) {
      vlog(`    [dry-run] ${mem.type}: ${mem.content.slice(0, 60)}`);
      stored++;
      continue;
    }

    const dup = dedupCheck(rdb, mem.content);
    if (dup) {
      vlog(`    [dedup] "${mem.content.slice(0, 40)}..." overlaps existing: "${dup.existingContent}..." (${(dup.overlap * 100).toFixed(0)}%)`);
      deduped++;
      continue;
    }

    const id = storeMemory(rdb, null, mem, sessionId);
    storedIds.push({ id, content: mem.content });
    stored++;

    // Generate + store embedding asynchronously (don't block the loop)
    if (embedFn) {
      storeEmbedding(rdb, id, embedFn, mem.content).catch(() => {});
    }
  }

  // Mark session as processed
  if (!DRY_RUN) {
    processed.add(sessionId);
    writeProcessed(processed);
  }

  return { sessionId, title: session.title, extracted: memories.length, stored, deduped, storedIds };
}

// ---------------------------------------------------------------------------
// resume tracking
// ---------------------------------------------------------------------------
const PROCESSED_FILE = join(HOME, ".opencode", "realmemory", ".bootstrap-processed");

function loadProcessed() {
  if (!RESUME) return new Set();
  try {
    return new Set(readFileSync(PROCESSED_FILE, "utf8").split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeProcessed(set) {
  try {
    writeFileSync(PROCESSED_FILE, [...set].join("\n") + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  log("=== realmemory bootstrap ===");
  log(`opencode.db: ${OC_DB}`);
  log(`realmemory.db: ${RM_DB}`);
  log(`concurrency: ${CONCURRENCY}${DRY_RUN ? " (dry-run)" : ""}${RESUME ? " (resume)" : ""}`);

  // 1. Detect LLM provider
  const provider = detectProvider();
  if (!provider) {
    log("FATAL: no LLM provider detected. Pass --api-key + --model, or configure auth.json.");
    log("  Example: node scripts/bootstrap-memory.mjs --api-key sk-... --model gpt-4o-mini");
    exit(1);
  }
  log(`LLM: ${provider.model} @ ${provider.apiUrl || "default endpoint"}`);

  // 2. Load embeddings (optional)
  const embedFn = DRY_RUN ? null : await getEmbedFn();

  // 3. Open databases
  const ocDb = loadSqlite(OC_DB);
  ocDb.pragma("journal_mode = WAL");
  const rdb = loadSqlite(RM_DB);

  // 4. Get sessions to process
  let sql = `
    SELECT s.id, s.title, s.cost, s.time_created,
           (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
    FROM session s WHERE 1=1
  `;
  const params = [];
  if (MIN_COST > 0) { sql += ` AND s.cost >= ?`; params.push(MIN_COST); }
  sql += ` ORDER BY s.cost DESC, msg_count DESC`;
  if (LIMIT > 0) { sql += ` LIMIT ?`; params.push(LIMIT); }

  const sessions = ocDb.prepare(sql).all(...params);
  const total = sessions.length;

  // Filter already-processed
  const processed = loadProcessed();
  const todo = sessions.filter((s) => !processed.has(s.id));
  log(`sessions: ${total} total, ${processed.size} already processed, ${todo.length} to process`);

  if (todo.length === 0) {
    log("nothing to do — all sessions already processed (or 0 sessions matched).");
    ocDb.close();
    rdb.close();
    return;
  }

  // 5. Process in parallel batches
  let totalExtracted = 0;
  let totalStored = 0;
  let totalDeduped = 0;
  let totalErrors = 0;
  let done = 0;

  const queue = [...todo];
  const startTime = Date.now();

  async function worker() {
    while (queue.length > 0) {
      const session = queue.shift();
      if (!session) break;

      done++;
      const pct = ((done / todo.length) * 100).toFixed(1);
      log(`[${done}/${todo.length} ${pct}%] $${(session.cost || 0).toFixed(2)} ${(session.title || "?").slice(0, 40)}`);

      try {
        const result = await processSession(ocDb, rdb, embedFn, provider, session.id, processed);
        totalExtracted += result.extracted || 0;
        totalStored += result.stored || 0;
        totalDeduped += result.deduped || 0;
        if (result.error) {
          totalErrors++;
          log(`  ERROR: ${result.error}`);
        } else {
          log(`  extracted: ${result.extracted || 0} | stored: ${result.stored || 0} | deduped: ${result.deduped || 0}`);
        }
      } catch (e) {
        totalErrors++;
        log(`  FATAL: ${e.message}`);
      }
    }
  }

  // Launch workers
  const workers = Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker());
  await Promise.all(workers);

  // 6. Relationship-building pass
  //
  // After all memories are stored, we build the web. For each batch of new
  // memories, we find candidate existing memories via FTS5 keyword search,
  // then ask the LLM to classify the relationship type (reinforces, extends,
  // contradicts, derived_from, exception_to). This is what makes memories
  // compound — isolated nodes become a connected graph.
  //
  let totalRelated = 0;
  const allStoredIds = []; // collected during processing

  if (!DRY_RUN && totalStored > 0) {
    log("");
    log("=== RELATIONSHIP-BUILDING PASS ===");

    // Gather all memories stored this run (they're the newest in the DB)
    const newMemories = rdb.prepare(
      `SELECT id, content, type, domain, tags FROM memories
       WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`
    ).all(totalStored + 50); // +50 buffer for any concurrent writes

    log(`building relationships for ${newMemories.length} memories...`);

    // For each new memory, find candidates and classify
    const RELATIONSHIP_TYPES = ["reinforces", "extends", "contradicts", "derived_from", "exception_to"];

    for (let i = 0; i < newMemories.length; i++) {
      const mem = newMemories[i];
      vlog(`  [relate ${i + 1}/${newMemories.length}] ${mem.content.slice(0, 50)}...`);

      // Find candidate related memories via FTS5
      const keywords = mem.content
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .slice(0, 6)
        .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
        .filter(Boolean);

      if (keywords.length < 2) continue;

      const ftsQuery = keywords.map((k) => `"${k}"`).join(" OR ");
      let candidates = [];
      try {
        candidates = rdb.prepare(
          `SELECT m.id, m.content, m.type, m.domain FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.id != ? AND m.status = 'active'
           ORDER BY rank LIMIT 5`
        ).all(ftsQuery, mem.id);
      } catch { continue; }

      if (candidates.length === 0) continue;

      // Check which relationships already exist (don't duplicate)
      const existingRels = new Set();
      try {
        const rows = rdb.prepare(
          "SELECT source_id, target_id, type FROM relationships WHERE source_id = ? OR target_id = ?"
        ).all(mem.id, mem.id);
        for (const r of rows) {
          existingRels.add(`${r.source_id}->${r.target_id}:${r.type}`);
        }
      } catch {}

      // Ask the LLM to classify relationships between this memory and its candidates
      const relatePrompt = [
        "You are a memory relationship classifier. Given a source memory and several candidate memories,",
        "identify which (if any) are related and classify the relationship type.",
        "",
        "Relationship types:",
        "- reinforces: the target supports/re-confirms the source (same lesson learned again)",
        "- extends: the target is about the same theme but covers a different surface/aspect",
        "- contradicts: the target contradicts or disagrees with the source",
        "- derived_from: the source is a specific instance or consequence of the target",
        "- exception_to: the target describes an exception or boundary condition to the source",
        "",
        "Return ONLY a JSON array of objects: {\"target_id\": \"...\", \"type\": \"...\", \"reason\": \"...\"}",
        "Only include relationships you are confident about. Skip unrelated pairs.",
        "An empty array [] is a valid response if nothing is related.",
        "",
        `SOURCE MEMORY (id: ${mem.id}):`,
        `  type: ${mem.type}`,
        `  domain: ${mem.domain || "?"}`,
        `  content: ${mem.content}`,
        "",
        "CANDIDATE MEMORIES:",
        ...candidates.map((c, idx) => `  [${idx}] id: ${c.id} | type: ${c.type} | domain: ${c.domain || "?"} | content: ${c.content.slice(0, 200)}`),
        "",
        "Return the JSON array now:",
      ].join("\n");

      let relationships;
      try {
        const resp = await callLLM(provider, relatePrompt);
        // Parse defensively
        let parsed = null;
        try { parsed = JSON.parse(resp.trim()); } catch {}
        if (!Array.isArray(parsed)) {
          const fence = resp.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fence?.[1]) { try { parsed = JSON.parse(fence[1].trim()); } catch {} }
        }
        if (!Array.isArray(parsed)) {
          const first = resp.indexOf("[");
          const last = resp.lastIndexOf("]");
          if (first !== -1 && last > first) { try { parsed = JSON.parse(resp.slice(first, last + 1)); } catch {} }
        }
        relationships = Array.isArray(parsed) ? parsed : [];
      } catch { continue; }

      // Store relationships
      for (const rel of relationships) {
        if (!rel.target_id || !rel.type || !RELATIONSHIP_TYPES.includes(rel.type)) continue;
        if (rel.target_id === mem.id) continue; // no self-relationships

        // Verify target exists
        const targetExists = rdb.prepare("SELECT 1 FROM memories WHERE id = ? AND status = 'active'").get(rel.target_id);
        if (!targetExists) continue;

        // Skip if relationship already exists
        const key = `${mem.id}->${rel.target_id}:${rel.type}`;
        const reverseKey = `${rel.target_id}->${mem.id}:${rel.type}`;
        if (existingRels.has(key) || existingRels.has(reverseKey)) continue;

        // Store it
        const relId = ulid();
        const now = new Date().toISOString();
        try {
          rdb.prepare(
            "INSERT OR IGNORE INTO relationships (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(relId, mem.id, rel.target_id, rel.type, now);
          totalRelated++;
          vlog(`    -> ${rel.type} -> ${rel.target_id} (${(rel.reason || "").slice(0, 50)})`);
        } catch (e) {
          vlog(`    relationship store failed: ${e.message}`);
        }
      }

      // Small delay to avoid rate-limiting on the relate LLM calls
      if (i > 0 && i % 5 === 0) await new Promise((r) => setTimeout(r, 500));
    }

    log(`relationships created: ${totalRelated}`);
  }

  // 7. Report
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("");
  log("=== BOOTSTRAP COMPLETE ===");
  log(`sessions processed: ${done} / ${todo.length}`);
  log(`memories extracted: ${totalExtracted}`);
  log(`memories stored: ${totalStored}${DRY_RUN ? " (dry-run — nothing actually written)" : ""}`);
  log(`memories deduped (skipped): ${totalDeduped}`);
  log(`relationships built: ${totalRelated}`);
  log(`errors: ${totalErrors}`);
  log(`elapsed: ${elapsed}s`);
  log(`embedding: ${embedFn ? "enabled" : "disabled"}`);
  if (!DRY_RUN && !embedFn) {
    log("");
    log("NOTE: memories were stored without embeddings. To enable semantic search,");
    log("restart opencode (the MCP server will generate embeddings on next recall).");
  }

  ocDb.close();
  rdb.close();
}

main().catch((e) => {
  log(`FATAL: ${e.message}`);
  exit(1);
});
