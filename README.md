# realmemory

## What it is

realmemory is an OpenCode plugin that gives AI agents real persistent memory — a weighted, indexed database that stores what agents learn across sessions and recalls it automatically when relevant. It replaces the illusion of learning (a `MEMORY.md` the agent re-reads every session) with actual learning: a searchable, weighted, related, automatically-recalled store that grows smarter the more the agent uses it.

## Why

The problem is simple and universal: agents start every session with amnesia. The state of the art for "memory" is a flat markdown file (`MEMORY.md`, `AGENTS.md`) the agent is instructed to read at startup. That's a reading assignment, not memory. It has no search, no weighting, no relationships, no recall-by-relevance — and its context cost grows linearly with every lesson ever recorded, forever.

realmemory gives agents what they're missing:

- **Search** — find the relevant few memories, not re-read all of them.
- **Weighting** — recent, frequently-used, high-confidence memories rank higher; stale ones decay and archive.
- **Relationships** — a typed graph between memories ("this lesson *contradicts* that one", "this preference is an *exception to* that rule"), traversed during recall.
- **Automatic recall** — event hooks inject relevant memories when a session starts or a user message arrives, without the agent asking.
- **Automatic capture** — tool results (config reads, failed commands) are stored as memories automatically.
- **MCP access** — the same memory is reachable from any MCP-compatible client, not just OpenCode.

## Install

### From npm

```json
// opencode.json
{
  "plugin": ["realmemory"]
}
```

### From git

```json
// opencode.json
{
  "plugin": ["realmemory@git+https://github.com/R3dy/RealMemory.git"]
}
```

After editing `opencode.json`, restart OpenCode. The plugin initializes a SQLite database at `~/.opencode/realmemory/data.db` (configurable — see [Configuration](#configuration)) and begins capturing and recalling immediately.

## Quick start

1. **Add to `opencode.json`** — `"plugin": ["realmemory"]` (npm) or the git URL above.
2. **Restart OpenCode** — the plugin loads on startup and initializes its store.
3. **It works** — memories are captured automatically from tool runs (file reads, failed commands) and recalled automatically when a new session starts or a user message matches stored knowledge. No further configuration required.

To store or recall memories explicitly from any MCP client, point an MCP config at the bundled server:

```json
{
  "mcp": {
    "realmemory": {
      "command": "npx",
      "args": ["realmemory-mcp"]
    }
  }
}
```

## How it works

realmemory has four layers:

- **Storage** — a local SQLite database holds every memory as a typed record with content, tags, scope, confidence, weight, timestamps, and an optional vector embedding. Full-text search (FTS5) and the embedding column are indexed alongside the row table.
- **Weighting** — every memory carries a composite weight in `[0, 1]`, computed as `recencyFactor × relevanceFactor × frequencyFactor × confidenceFactor`. Recency decays exponentially (half-life configurable); frequency scales logarithmically with a 0.5 baseline so fresh memories are never zero-weighted; confidence is adjusted up by `reinforces` edges and down by `contradicts` edges. Memories below the archive threshold are auto-archived by `decay()`.
- **Relationships** — a directed graph of typed edges between memories (`reinforces`, `contradicts`, `extends`, `exception_to`, `derived_from`). `reinforces` boosts the source's confidence; `contradicts` decays the target's. Recall traverses one hop in both directions to surface structurally-related context that pure similarity search would miss.
- **Recall** — hybrid. When an embedding provider is configured, the query is embedded and scored by cosine similarity against every matching memory's vector; memories without embeddings fall back to FTS5 keyword matching. When no provider is configured (or it failed to load), recall is keyword-only via FTS5 bm25. Results are ranked by `relevance × storedWeight`, then augmented with related memories.
- **Hooks** — the OpenCode plugin wires recall to `session.created` (auto-recall on startup) and `message.updated` (auto-recall on user messages), and capture to `tool.execute.after` (auto-capture from `read` on config/schema/route files and `bash` on errors).
- **MCP server** — eight tools (`store_memory`, `recall`, `search`, `relate`, `update_memory`, `forget`, `list_memories`, `get_memory`) exposed over stdio, so the memory is accessible from any MCP client — other agents, automation scripts, or other tools in the ecosystem.

## Configuration

realmemory loads config from two files, merged in order (later overrides earlier), then merged with defaults:

1. `~/.config/opencode/realmemory.json` (global)
2. `<project>/.realmemory/config.json` (project — overrides global)

Files may use JSONC (`//` comments are stripped). Missing files and invalid JSON are silently ignored so a broken config never crashes the store.

```jsonc
{
  // Path to the SQLite database. ~ is expanded to the user's home directory.
  // Default: "~/.opencode/realmemory/data.db"
  "storagePath": "~/.opencode/realmemory/data.db",

  // Embedding model. Set to null/empty for keyword-only mode (no vector search).
  // Local ONNX models use the "Xenova/..." or "onnxcommunity/..." namespace.
  // Remote OpenAI-compatible APIs require embeddingApiUrl + embeddingApiKey.
  // Default: "Xenova/all-MiniLM-L6-v2"
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",

  // OpenAI-compatible remote embedding endpoint (optional).
  // When both URL and key are set, the remote provider takes precedence over local ONNX.
  "embeddingApiUrl": null,
  "embeddingApiKey": null,

  // Recency decay half-life, in days. A memory aged halfLifeDays has recencyFactor ≈ 0.368.
  // Default: 30
  "decayHalfLifeDays": 30,

  // Minimum relevance score for a memory to be recalled, in [0, 1].
  // Default: 0.3
  "recallThreshold": 0.3,

  // Maximum number of memories returned by recall().
  // Default: 5
  "maxRecallResults": 5,

  // Auto-capture learnings from tool execution (file reads, bash errors).
  // Default: true
  "autoCapture": true,

  // Auto-summarize idle sessions (requires summaryProvider). Off by default.
  // Default: false
  "autoSummarize": false,

  // Summary provider for auto-summarization (required when autoSummarize is true).
  "summaryProvider": null,

  // Weight below which decay() archives a memory, in [0, 1].
  // Default: 0.05
  "archiveThreshold": 0.05,

  // Max related memories returned per recalled memory (one-hop traversal).
  // Default: 3
  "maxRelatedPerMemory": 3
}
```

## MCP tools

realmemory exposes eight tools over stdio. Each has a clear, typed argument contract — no overloaded `mode` dispatch.

| Tool | Description |
|------|-------------|
| `store_memory` | Store a new memory (content, type, tags, scope, confidence, relationships, metadata). |
| `recall` | Semantic + keyword search for relevant memories, with optional one-hop relationship traversal. |
| `search` | Structured search with filters (scope, types, tags, weight, date range), sorting, and pagination. |
| `relate` | Create a typed relationship between two memories (`reinforces` boosts source confidence; `contradicts` decays target confidence). |
| `update_memory` | Update an existing memory's content, confidence, tags, metadata, or reinforce it (bumps `reinforcementCount` + confidence). |
| `forget` | Archive (soft) or delete (hard) a memory, cascading its relationships. |
| `list_memories` | Browse memories with simple filters and pagination. |
| `get_memory` | Fetch a single memory by ID, with or without its relationship edges. |

## Memory types

Every memory has one of six types, which govern categorization, indexing, and filtering.

| Type | Description | Example |
|------|-------------|---------|
| `user_preference` | A durable preference about how the user wants things done. | "The user prefers tabs over spaces." |
| `task_pattern` | A recurring pattern in how tasks are approached or structured. | "Bug reports are triaged by severity before assignment." |
| `codebase_fact` | A structural fact about the codebase. | "The API layer is in `src/api/`, backed by Postgres." |
| `lesson_learned` | Something learned the hard way — a failure and its fix. | "AWS `create-image` rejects non-ASCII characters in string params." |
| `session_summary` | A summary of what happened in a session. | "Set up staging; shipped stories 8.1–8.3; parked the metrics dashboard." |
| `contextual_note` | A situational note that doesn't fit the other categories. | "The deploy job is currently paused pending the secrets rotation." |

## Relationship types

Memories are connected by directed, typed edges. Two types have confidence side effects; the rest are structural only.

| Type | Description | Side effect |
|------|-------------|-------------|
| `reinforces` | The source memory supports / re-confirms the target. | Boosts the **source**'s confidence (diminishing returns) and bumps its `reinforcementCount`. |
| `contradicts` | The source memory invalidates the target. | Decays the **target**'s confidence by 10% of its current value. |
| `extends` | The source memory adds detail to the target. | None. |
| `exception_to` | The source memory is a special case of the target rule. | None. |
| `derived_from` | The source memory was concluded from the target. | None. |

## Programmatic API

realmemory is a library first. Import it directly when you want full control over the store lifecycle.

```typescript
import { MemoryStore, RecallEngine } from "realmemory";

const store = new MemoryStore({
  storagePath: "./my-memories.db",
  embeddingModel: null, // keyword-only mode — fast, no model download
});
await store.init();

// Store a memory.
const memory = await store.store({
  content: "The user prefers tabs over spaces",
  type: "user_preference",
  scope: "global",
  confidence: 0.9,
  tags: ["formatting"],
});

// Recall by natural-language query.
const engine = new RecallEngine(store);
const results = await engine.recall({ query: "code formatting preferences", limit: 5 });
for (const r of results) {
  console.log(r.score.toFixed(2), r.memory.content);
}

await store.close();
```

See [`examples/`](./examples) for runnable versions of every major use case.

## Graph browser (`--ui`)

realmemory ships a built-in localhost graph browser for inspecting the memory graph that accumulates in your SQLite database. It is **opt-in, localhost-only, and read-only** — it never starts unless you ask for it, it binds to `127.0.0.1` (never the network), and it cannot mutate the store.

```bash
# Start the graph browser on the default port (9333):
npx realmemory-mcp --ui

# Or a custom port:
npx realmemory-mcp --ui=9400
# or:
npx realmemory-mcp --ui --port=9400
```

Then open `http://127.0.0.1:9333` in your browser. You'll see:

- **A force-directed graph** of your memories (nodes colored by type, sized by weight) and their typed relationships (directed edges colored by relationship type).
- **A filter sidebar** — filter by memory type, scope, tags, minimum weight, creation date range, and free-text content search.
- **A detail panel** — click any node to see its full content, metadata, timestamps, and one-hop relationships. Click a neighbor to re-center the graph on it.
- **A legend** mapping colors to memory types and relationship types.

The browser reads from the same SQLite database the MCP server uses (`~/.opencode/realmemory/data.db` by default). It can run alongside the MCP server — SQLite's WAL mode allows concurrent reads. The graph visualization uses [vis-network](https://github.com/visjs/vis-network) (MIT), vendored as a static browser-side asset (never a Node.js runtime dependency — the package's `dependencies` stay at three).

> **Screenshot:** a screenshot of the graph browser UI will be added on the v0.2.0 release.

> **Note:** `--ui` and the MCP stdio server are mutually exclusive per process. Run `realmemory-mcp` (no flag) for the stdio MCP server; run `realmemory-mcp --ui` in a separate terminal when you want the browser. This is the same shape `codebase-memory-mcp` uses.

See [ADR-006](../docs/adr/ADR-006-localhost-graph-browser.md) for the architectural rationale and the four hard constraints (opt-in, localhost-only, read-only, no new runtime dependency).

## Comparison with alternatives

- **`MEMORY.md` / `AGENTS.md`** — a reading assignment, not memory. No search, no weighting, no relationships; context cost grows linearly forever.
- **opencode-mem** — vector search + auto-capture, but no weighting, no relationships, no MCP server, and one overloaded `memory({ mode })` tool.
- **true-mem** — best-in-class 7-feature weighting, but no vector search by default, no relationship graph, no MCP server, and no active query tool.
- **opencode-memini / codex-memory / magic-context** — passive capture/injection cycles with no weighting, no relationships, and no MCP server.
- **codebase-memory-mcp** — indexes *code structure* (functions, calls, imports). realmemory indexes *what the agent learned* — complementary, not a replacement.

realmemory is the only OpenCode plugin that combines (1) a weighted, indexed memory database (SQLite + vector + full-text), (2) a typed relationship graph between memories, (3) automatic recall via event hooks, and (4) an MCP server for tool-accessible memory — all local-first, installable from npm or git.

## Contributing

1. Fork the repo and clone your fork.
2. `npm install` — pulls dev dependencies and the native `better-sqlite3` binding.
3. `npm run build` — builds `dist/` via `tsup` (required for the smoke test, which imports from `dist/`).
4. `npm test` — runs the vitest suite (currently 304 tests).
5. `npm run typecheck` — `tsc --noEmit`.
6. `npm run lint` — `eslint .`.

Open a PR against `main`. Keep TSDoc on every exported symbol — the build checks for missing docs.

## Changelog

### v0.3.0

- The graph memory browser now auto-starts as a localhost-only side channel when the MCP server loads (ADR-007). It is defeatable via `autoStartBrowser: false` config or the `--no-browser` CLI flag, and adds no new runtime dependency.

## License

MIT
