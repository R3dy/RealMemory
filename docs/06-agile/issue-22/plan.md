# Development Plan — Issue #22: Make realmemory act like a human brain

**Author:** Anymake Solution Architect
**Project:** realmemory — `project_type: library`
**Issue:** https://github.com/R3dy/RealMemory/issues/22 — `type: feature`
**Code state analyzed:** main @ `21303fc` (v0.3.0 — post Epic #3 brain loop + issue #13 schema v3 + issue #20 mobile UI)
**Status:** In Review (round 3)
**Location:** `PROJECTS/realmemory/repo/docs/06-agile/issue-22/plan.md`

---

## 1. Problem Statement

Issue #22 asks realmemory to "act like a human brain": capture small recurring
deltas, prefer concise behavior-oriented memories, reinforce tiny patterns when
repeated, let unused micro-memories decay naturally, and add a per-turn
self-improvement loop that evaluates the delta between user intent and assistant
response and stores/updates/reinforces accordingly. The issue specifies an
event/hook mapping, pseudocode for a per-turn `evaluateDelta` loop, 5 minimal
metrics, a 5-step rollout plan, and safety constraints (never store secrets,
concise, project-scope default).

**Most of this is already built.** Epic #3 (PRs #14–#19, merged 2026-08-10)
shipped: dedup + reinforce on `store()` (#6/PR #16), rate-limited `decay()` on
`session.created` (#7/PR #15), `chat.message` → recall staged for injection
(#9+#4/PR #19), `tool.execute.after` → auto-capture (#9+#4/PR #19 — partial:
file-reads + bash-errors only), `experimental.chat.system.transform` → delivery
(#9+#4/PR #19), secrets scrubbing on every write (INV-001), project-scope
default (INV-004).

The actual gap — what #22 builds — is five work items, confirmed as the
issue scope during intake:

1. **Per-turn delta evaluation loop** — after the assistant responds, evaluate
   the delta (correction/repetition/preference signals, tool outcomes, whether
   recalled memory was used) and store/update/reinforce. Includes
   `classifyIntent` + `dynamicLimit(intent)` (recall currently uses raw text,
   fixed `limit: 3`).
2. **Automatic relation creation (`maybeRelate`)** — when a new memory is stored
   or a delta reinforces an existing one, automatically create `relate()` edges
   (extends/reinforces/derived_from). `relate()` is currently a manual MCP tool
   only.
3. **Metrics tracking** — 5 minimal metrics (`recall_hit_rate`,
   `correction_retention`, `duplicate_rate`, `memory_bloat_ratio`,
   `preference_compliance`) in a SQLite meta table, queryable via a new MCP tool
   and browser endpoint.
4. **`experimental.session.compacting` hygiene hook** — run memory hygiene
   (decay, dedup pass, low-weight archive) when OpenCode compacts the session
   context.
5. **Conciseness enforcement** — cap auto-stored memory content length (default
   280 chars) so the store doesn't bloat with verbose auto-captured text.

---

## 2. Root Cause / Motivation

This is a feature, not a bug. The motivation is the success model for a
`library` project type: adoption depends on the memory being *useful* —
capturing the right things, reinforcing the right patterns, and decaying the
wrong ones — without bloating or blocking the agent host. Epic #3 built the
plumbing (auto-recall, auto-capture, dedup, decay, delivery). #22 closes the
loop: the brain now *evaluates* each turn and *relates* new memories to
existing ones automatically, so the graph self-organizes instead of growing
flat. The metrics make the loop observable so we can tune thresholds.

**Why now:** Epic #3 shipped the loop's *inputs* (recall, capture, inject) and
*outputs* (dedup, reinforce, decay) but left the *evaluation* (the per-turn
"was this a correction? a repetition? a preference?") and the *graph
self-organization* (auto-relate) unimplemented. Without them, the store grows
flat and the loop can't self-correct — it captures but doesn't learn from
deltas. #22 is the completion of the brain-loop architecture Epic #3 started.

**Intent-layer freshness:** SYSTEM_MAP last mapped 2026-08-11, HEAD `21303fc`,
refreshed by the Cartographer for #22 planning. DECISIONS.md and INVARIANTS.md
refreshed the same day. The intent layer is fresh — this plan is designed
against the current map.

---

## 3. Current-State Review

From `/home/royce/mission-control/PROJECTS/realmemory/docs/SYSTEM_MAP.md` (2026-08-11 refresh) plus direct reading of the source:

| Touched | Details |
|---------|---------|
| Modules | `src/plugin.ts` (hooks), `src/store.ts` (MemoryStore — store/recall/relate/decay/maybeDecay/getMeta/setMeta), `src/db/schema.ts` (SCHEMA_V3, migrations runner, meta KV table), `src/types.ts` (StoreInput, RecallQuery, MemoryStoreConfig), `src/config.ts` (DEFAULTS, validateConfig), `src/mcp-server.ts` (8 tools), `src/browser/server.ts` (graph browser HTTP) |
| Data model | `memories`, `relationships`, `memories_fts` (FTS5), `meta` (v2 KV), `schema_version` — **#22 adds a new `metrics` table via SCHEMA_V4** (idempotent, same pattern as SCHEMA_V2 meta table) |
| Flows | Plugin brain loop: `session.created` → auto-recall + decay scheduling; `session.idle` → LLM summarization (opt-in) + **#22: evaluateDelta (primary delta-loop trigger — C1 fix, runs BEFORE the LLM summarization)**; `tool.execute.after` → auto-capture (file-reads + bash-errors); `chat.message` (user only) → auto-recall staged for injection; `experimental.chat.system.transform` → delivery. **#22 adds: `session.idle` → evaluateDelta (primary); `chat.message` (assistant) → evaluateDelta (secondary/best-effort — verified NOT to fire in the installed OpenCode host, retained only as future-proofing); `experimental.session.compacting` → hygiene.** |
| Integrations | SQLite (bun:sqlite / better-sqlite3), MCP SDK stdio, `@huggingface/transformers` (best-effort embeddings), `zod` (4th dep — INV-014 currently violated per Drift #6), LLM summary provider (opt-in, `session.idle` only — Drift #5 unaddressed). **#22 adds ZERO new integrations** — metrics use the existing SQLite store; evaluateDelta uses local heuristics (no LLM). |

**Key code anchors (file:line):**

- `src/plugin.ts:452-491` — `chat.message` hook, currently returns early for
  `output.message.role !== "user"` (line 456). The assistant-message branch is
  the insertion point for the delta loop.
- `src/plugin.ts:460-490` — user-message recall path, uses fixed `limit: 3`
  (line **470**). Replaced with `dynamicLimit(intent)`.
- `src/plugin.ts:288-301` — `maybeDecay("decay:lastRun", decayIntervalHours)`
  on `session.created`, detached. The compacting hook reuses this pattern with
  a different meta key.
- `src/plugin.ts:252-376` — `event` handler (handles `session.created` and
  `session.idle`). This is the **PRIMARY insertion point for the delta loop**
  (§4.1 C1 fix — round-2 verification confirmed `session.idle` is the reliable
  turn-completion signal in the installed OpenCode host; the `chat.message`
  assistant branch is demoted to secondary/best-effort).
- `src/plugin.ts:497-510` — `experimental.chat.system.transform`: delivers
  `state.pendingInjection` then sets `state.pendingInjection = null` (line 509).
  **The `lastInjectedMemoryIds` field (C2 fix) is set here, BEFORE the clear at
  line 509**, so the hit-rate metric can read it on the assistant branch.
- `src/plugin.ts:28-37` — `interface PluginState` (current fields: `store`,
  `config`, `injectedMemoryIds: Set<string>`, `pendingInjection: string | null`,
  `initialized`, `initPromise`). **#22 adds: `lastUserText`, `lastUserIntent`,
  `recentUserTexts`, `lastToolCapture`, `lastInjectedMemoryIds`.**
- `src/store.ts:312-457` — `store()`: validates, scrubs secrets (step 3, line
  328), dedup check (step 4, line 335-368), insert. **The conciseness cap is
  applied here** (step 3, after scrubSecrets, gated by a new `concise` flag on
  StoreInput).
- `src/store.ts:1217-1332` — `relate()`: validates, rejects self/duplicate,
  inserts edge, applies confidence side effects. **`maybeRelate` wraps this** —
  recalls similar, calls `relate()`, catches `DuplicateRelationshipError`.
- `src/store.ts:1484-1501` — `getMeta`/`setMeta` (the meta KV pattern #22
  mirrors for `recordMetric`/`getMetricSummary`).
- `src/store.ts:1561-1579` — `maybeDecay(lastRunKey, intervalHours)` — rate-
  limited decay via meta KV. The compacting hook uses a separate
  `decay:compacting` key with `compactingIntervalHours`.
- `src/store.ts:1509-1549` — `decay()` — recomputes weights, archives below
  `archiveThreshold`. The compacting hook calls this directly.
- `src/db/schema.ts:93-98` — SCHEMA_V2 (meta table, idempotent `IF NOT EXISTS`).
  SCHEMA_V4 follows this exact pattern for the `metrics` table.
- `src/db/schema.ts:123` — `CURRENT_SCHEMA_VERSION = 3` — bumped to 4.
- `src/db/schema.ts:129-133` — `MIGRATIONS` map — add `4: SCHEMA_V4`.
- `src/db/schema.ts:141-164` — `runMigrations` — idempotent, records each
  version in `schema_version`. No change needed; adding v4 to the map is enough.
- `src/config.ts:6-37` — `DEFAULTS` — add `concisenessCap: 280`,
  `autoRelate: true`, `brainLoop: true`, `compactingIntervalHours: 4`.
- `src/config.ts:83-127` — `validateConfig` — add range checks for the new
  knobs.
- `src/mcp-server.ts:170-241` — `createMcpTools` (8 tools) — add a 9th,
  `get_metrics`.
- `src/browser/server.ts` — add `GET /api/metrics` route (localhost, read-only
  — same ADR-006/007 posture).

---

## 4. Solution Design

The plan is **Additive**: new hook branches, new MemoryStore methods, a new
schema v4 migration (idempotent), a new ADR-008 (ratifies, doesn't supersede),
a new MCP tool, a new browser route. No existing ADR is superseded. No existing
public API method signature changes (a new optional `concise?: boolean` field
on `StoreInput` is additive — existing callers are unaffected). No new runtime
dependencies (INV-014 already violated by `zod` per Drift #6; #22 must not
compound it).

### 4.1 Per-turn delta evaluation loop

#### 4.1.1 Hook insertion (C1 fix — round-2 verification promoted the event branch to primary)

**Round-2 verification settled the question round 1 only flagged.** Inspecting
the installed OpenCode binary (`~/.opencode/bin/opencode`, 2026-08-09 — the
"version in use" this plan targets): `trigger("chat.message", ...)` appears
**exactly once**, in `SessionPrompt.createUserMessage`, with
`{message: <the newly created role:"user"> message, parts}`. There is **no
assistant-side `chat.message` trigger**. The round-1 fallback example event
names (`chat.message.completed`, `session.turn.end`) do **not exist** in this
build. What does exist and is verified-firing: `session.idle` (already used by
this plugin for summarization — `plugin.ts:252-376`) and the `message.updated`
/ `message.part.updated` events. The issue's own mapping says `event` for
"monitor turn completion and trigger post-turn update" — the plan now **follows
that mapping directly**.

**Primary trigger: `session.idle` branch in the existing `event` handler.** The
plugin already has an `event` handler (`plugin.ts:252-376`) that branches on
`session.created` and `session.idle`. Add the delta loop as a new
`session.idle` action that runs **BEFORE** the existing LLM summarization
(summarization stays last; evaluateDelta is local heuristics, fast, and the
`brainLoop` master switch (C4 fix) gates it in):

```ts
// inside the existing event handler, session.idle branch:
"event": (_input, event) => {
  if (event?.type === "session.created") { /* existing */ }
  else if (event?.type === "session.idle") {
    // C4 fix: master switch — disabled brainLoop => v0.3.0 behavior (no delta loop)
    if (state.config.brainLoop === false) return;
    // C1 fix: double-fire guard — if the chat.message assistant branch
    // (secondary, best-effort) already ran evaluateDelta for this turn, skip.
    if (state.deltaTurnDone) { state.deltaTurnDone = false; return; }
    // C1 fix: PRIMARY delta-loop trigger — detached (INV-017)
    void (async () => {
      const store = await getStore();
      // lastUserText + lastUserIntent were stashed by the prior chat.message user branch.
      // assistantText is not available from session.idle directly; pass "" and let
      // evaluateDelta degrade to userText-only classification + recall_miss on the
      // hit-rate metric (no assistant text to check). The recall_hit_rate metric
      // still works: it checks the assistant's text against injected memory tokens —
      // with assistantText="" the metric records recall_miss (correct: no text to match).
      await evaluateDelta(store, state, state.lastUserText ?? "", "");
      // C2 fix: clear lastToolCapture AFTER evaluateDelta completes (after
      // store/update/reinforce/relate), so the tool_outcome intent + content
      // template both see the prior turn's tool capture.
      state.lastToolCapture = null;
    })().catch((error) => log("error", `evaluateDelta failed: ${String(error)}`));
    // existing LLM summarization runs after (opt-in, unchanged)
  }
}
```

**Secondary trigger (best-effort future-proofing, NOT relied upon):** an
assistant-message branch is added to the existing `chat.message` handler
(`plugin.ts:452`), which currently returns early for non-user messages at
line 456. It is wired identically to the primary (`if (state.config.brainLoop
=== false) return;` gate, detached `evaluateDelta`, error-safe), and exists
ONLY so that a future OpenCode version that does fire `chat.message` for
assistant messages gets per-turn granularity. **Double-fire protection:** the
`chat.message` assistant branch sets `state.deltaTurnDone = true` before
running `evaluateDelta`; the `session.idle` branch checks that flag and skips
if the assistant branch already ran for this turn (reset the flag in the
`chat.message` user branch at turn start). This prevents double metrics/stores
the day a future host fires both. If (as in the installed host) `chat.message`
never fires for assistant messages, the flag stays `false`, `session.idle`
runs the delta loop, and the assistant branch is dead code that costs nothing.
A Worker MAY drop the assistant branch entirely — the primary `session.idle`
trigger is sufficient. If retained, the double-fire guard is mandatory.

**Why `session.idle` is the right primary:** it is verified-firing in the
installed host, the plugin already uses it for summarization (proven reliable),
and it fires once per assistant turn-end (per-turn granularity is preserved).
The `assistantText` argument to `evaluateDelta` is `""` on this trigger (the
`session.idle` payload does not carry the assistant message text) — this is
acceptable: `evaluateDelta`'s intent classification comes from
`state.lastUserIntent` (stashed by the user branch, not re-derived from
assistant text), and the `recall_hit_rate` metric records `recall_miss` when
`assistantText` is empty (correct: no text to match against injected tokens).
The §4.1.5 content templates use `userText` (not `assistantText`) for
correction/repetition/preference; only `recall_hit_rate` reads `assistantText`
and it degrades cleanly.

**Issue alignment note:** the issue's mapping ("`event`: monitor turn
completion and trigger post-turn update") is now the plan's primary path, not
a fallback. The `chat.message` assistant branch was round 1's speculative
primary; round-2 verification proved it dead, so the plan follows the issue.

#### 4.1.2 PluginState additions (C2 + C4 fix)

All new fields are declared on `interface PluginState` (`src/plugin.ts:28-37`)
and initialized in the `state` object (`src/plugin.ts:199-211`):

```ts
interface PluginState {
  // ... existing fields ...
  /** Most recent user message text. Set in chat.message user branch. */
  lastUserText: string | null;
  /** Classified intent of the most recent user message. Set in chat.message
   *  user branch (after classifyIntent, before push to recentUserTexts). Read
   *  by evaluateDelta on the assistant branch — avoids re-classification
   *  self-match. */
  lastUserIntent: Intent | null;
  /** Ring buffer (max 5) of PRIOR user message texts (normalized). Pushed in
   *  chat.message user branch AFTER classification (classify-first-then-push,
   *  C4 fix). Read by classifyIntent (repetition check). */
  recentUserTexts: string[];
  /** Summary of the most recent tool execution in this turn. Set in
    *  tool.execute.after when it stores a lesson_learned or codebase_fact.
    *  Read by classifyIntent (tool_outcome branch) in the NEXT chat.message
    *  user branch — BEFORE any clear (C2 fix: the prior user-branch reset
    *  nulled it before classify, making tool_outcome unreachable). Cleared
    *  AFTER evaluateDelta completes on session.idle (after
    *  store/update/reinforce/relate), so both the intent classification AND
    *  the §4.1.5 content template see the prior turn's tool capture. The
    *  user branch does NOT clear it. (C2 + C4 fix) */
  lastToolCapture: {
    tool: string;
    filePath?: string;
    command?: string;
    isError: boolean;
    timestamp: number;
  } | null;
  /** Memory IDs delivered via system.transform this turn. Set in
    *  experimental.chat.system.transform BEFORE clearing pendingInjection.
    *  Reset to null at the start of the next user message. Read by
    *  evaluateDelta step 6 (recall_hit_rate metric). (C2 fix — replaces the
    *  broken pendingInjection read). */
  lastInjectedMemoryIds: string[] | null;
  /** C1 fix (round 2): double-fire guard. Set to true by the chat.message
    *  assistant branch (secondary trigger) when it runs evaluateDelta, so the
    *  session.idle branch (primary) can skip if both fire on the same turn.
    *  Reset to false in the chat.message user branch at turn start. In the
    *  installed host the assistant branch never fires, so this stays false
    *  and session.idle always runs the delta loop. */
  deltaTurnDone: boolean;
}
```

**Initialization** (`src/plugin.ts:199-211`):
```ts
lastUserText: null,
lastUserIntent: null,
recentUserTexts: [],
lastToolCapture: null,
lastInjectedMemoryIds: null,
deltaTurnDone: false,
```

#### 4.1.3 classifyIntent — pure function, local heuristics, NO LLM call

`classifyIntent(userText: string, assistantText: string, recentUserTexts:
string[], lastToolCapture: PluginState["lastToolCapture"]): Intent` —
preserves INV-017 non-blocking; avoids worsening Drift #5. Returns one of:
`correction | repetition | preference | tool_outcome | generic`.

- `correction`: regex `/\b(no|wrong|actually|instead|i said|i meant|not that|don't|stop|that's not)\b/i` matched in `userText`.
- `repetition`: a normalized hash of `userText` (lowercase, trimmed,
  punctuation stripped) is already present in `recentUserTexts`. **C4 fix:
  "already present" means the buffer holds a PRIOR sighting (the current
  message has NOT been pushed yet — classify-first-then-push). If
  `recentUserTexts` is empty, no repetition is possible.**
- `preference`: regex `/\b(always|never|prefer|don't|always use|never use|from now on)\b/i` matched in `userText`.
- `tool_outcome`: `lastToolCapture` is non-null (set by `tool.execute.after`
  when it stored a `lesson_learned` or `codebase_fact` in the same turn). **C4
  fix: `lastToolCapture` is passed as a parameter (not read from `state`
  inside the function) so the pure function is testable without a PluginState
  mock.**
- `generic`: fallback when none of the above fire.

Priority order: `correction` > `repetition` > `preference` > `tool_outcome` >
`generic` (a correction is the strongest signal — the agent got something wrong
and the user is fixing it).

**`isHighSignal(intent)`**: returns `true` for `correction | repetition |
preference | tool_outcome`; `false` for `generic`.

**`dynamicLimit(intent)`**: `correction | preference` → 5; `repetition |
tool_outcome` → 4; `generic` → 3 (current fixed value). Used by the user-message
recall path (replaces the hardcoded `limit: 3` at `plugin.ts:470`).

#### 4.1.4 evaluateDelta — runs on the session.idle event branch, detached

`evaluateDelta(store: MemoryStore, state: PluginState, userText: string |
null, assistantText: string): Promise<void>`

**Trigger (C1 fix):** runs on `session.idle` in the existing `event` handler
(§4.1.1), BEFORE the LLM summarization, gated by `state.config.brainLoop !==
false` (C4 fix — the master switch; when false, the whole #22 per-turn delta
path is skipped and v0.3.0 fixed-`limit: 3` recall behavior is the disabled
state). The `chat.message` assistant branch is secondary/best-effort and
double-fire-guarded (§4.1.1).

Steps:

1. **Null-userText guard (C4 fix):** if `userText` (which is
   `state.lastUserText`) is `null` → return early (first message of session,
   or a missed user hook — no delta to evaluate). If `state.lastUserIntent` is
   `null` → return early (user branch didn't run — safety net).
2. `const intent = state.lastUserIntent;` (reuse the user branch's
   classification — no re-classification, avoids the self-match bug per C4 fix).
3. If `!isHighSignal(intent)` → record `preference_compliance` metric (1.0 if no
   known preference contradicted, 0.0 otherwise — naive keyword check) and
   return. Do not store generic chat.
4. If high-signal: build a `StoreInput` from the delta using the **exact
   content template per intent** (C3 fix — literal templates below). All
   high-signal stores set `scope: "project"` (INV-004), `concise: true` (§4.5
   cap), and the fields specified in the template table.
5. `const stored = await store.store(input);` — inherits `scrubSecrets`
   (INV-001) and dedup+reinforce (INV-018). If `store()` reinforced an existing
   memory instead of inserting, `stored.id` is the reinforced memory's id.
6. If `config.autoRelate` → `await store.maybeRelate(stored.id, stored.content,
   stored.type);` (§4.2).
7. Record metrics (§4.3):
   - `duplicate_rate`: if `store()` took the reinforce path (detectable —
     `stored.reinforcementCount > 0` AND `stored.createdAt !== stored.updatedAt`
     — i.e. it existed before this call), increment `duplicate_caught` counter.
   - `correction_retention`: if intent is `correction`, increment
     `correction_stored` counter. If the same correction keyword pattern
     re-appears in a later `evaluateDelta` (within N turns), increment
     `correction_repeated` counter (the retention metric is
     `1 - correction_repeated / correction_stored`).
    - **`recall_hit_rate` (C2 fix):** reads `state.lastInjectedMemoryIds`
      (NOT `state.pendingInjection` — which is always null at this point per
      the C2 finding). If `state.lastInjectedMemoryIds` was non-null when
      `evaluateDelta` runs (i.e. a memory was injected into this turn's
      system prompt) AND the assistant's response references a token/domain/tag
      from one of those memories (naive substring check against the injected
      memory content, recalled by ID), increment `recall_hit`; else
      `recall_miss`. Hit rate = `recall_hit / (recall_hit + recall_miss)`.
      **On the `session.idle` primary trigger (C1 fix), `assistantText` is
      `""` (the event payload doesn't carry assistant text), so the metric
      records `recall_miss` by default — correct degradation (no text to
      match). To record `recall_hit`, a test harness calls `evaluateDelta`
      directly with non-empty `assistantText`, OR fires the secondary
      `chat.message` assistant branch with real assistant text.**
      **The `lastInjectedMemoryIds` field is set in
      `experimental.chat.system.transform` before clearing `pendingInjection`
      (§4.1.6) and reset to `null` at the start of the next user message — so
      it persists across the turn, unlike `pendingInjection` which is cleared
      at delivery time.**
    - `preference_compliance`: (recorded in step 3 as well) — naive check
      against known `user_preference` memories' content keywords.
8. **C2 fix — clear `lastToolCapture` AFTER the delta evaluation completes.**
   The caller (the `session.idle` event branch, §4.1.1) sets
   `state.lastToolCapture = null` after this function resolves. This ordering
   is load-bearing: classifyIntent (step 2, via `state.lastUserIntent` set in
   the prior user branch) and the §4.1.5 `tool_outcome` content template (step
   4, reading `state.lastToolCapture.tool`/`.isError`/`.command`/`.filePath`)
   both read `lastToolCapture` BEFORE the clear. Round-2 C2 found the prior
   spec cleared it at the START of the user branch — before classifyIntent —
   making the `tool_outcome` intent unreachable in production while its unit
   test still passed. The clear now happens here, after use. The user branch
   does NOT clear `lastToolCapture`.

**No LLM call anywhere in evaluateDelta.** This is the load-bearing design
decision: it preserves INV-017 (the loop runs in milliseconds on local string
matching, never blocks the tool loop) and avoids compounding Drift #5 (the
unaddressed secret-leak in `session.idle` summarization — see §6, "Out of
scope").

#### 4.1.5 Content templates per intent (C3 fix — literal, zero-interpretation)

The `content` string for each delta class is derived mechanically from the
inputs using the exact templates below. A Worker builds these with zero
interpretation. The `concise: true` flag applies the `concisenessCap` (default
280) truncation in `store()` step 3b — a safety net since most templates are
under the cap.

| Intent | `content` template (literal) | `type` | `scope` | `confidence` | `tags` | `metadata` |
|--------|------------------------------|--------|---------|-------------|--------|------------|
| `correction` | `"User corrected the agent: " + userText.slice(0, 200)` | `lesson_learned` | `project` | `0.6` | `["correction", "auto-brain-loop"]` | `{ intent: "correction", source: "evaluateDelta" }` |
| `repetition` | `"Repeated request: " + userText.slice(0, 200)` | `task_pattern` | `project` | `0.5` | `["repetition", "auto-brain-loop"]` | `{ intent: "repetition", source: "evaluateDelta" }` |
| `preference` | `"User preference: " + userText.slice(0, 200)` | `user_preference` | `project` | `0.6` | `["preference", "auto-brain-loop"]` | `{ intent: "preference", source: "evaluateDelta" }` |
| `tool_outcome` | `"Tool outcome (" + state.lastToolCapture.tool + "): " + (state.lastToolCapture.isError ? "error" : "success") + " — " + (state.lastToolCapture.command \|\| state.lastToolCapture.filePath \|\| "").slice(0, 120)` | `lesson_learned` | `project` | `0.5` | `["tool_outcome", "auto-brain-loop"]` | `{ intent: "tool_outcome", source: "evaluateDelta", tool: state.lastToolCapture.tool, isError: state.lastToolCapture.isError }` |
| `generic` | (no store — skipped by `isHighSignal` gate) | — | — | — | — | — |

**Note on `tool_outcome`:** this creates a NEW delta memory recording that the
brain loop observed a tool outcome in this turn (separate from the tool-capture
memory stored by `tool.execute.after`, which records the tool execution
itself). `maybeRelate` (§4.2) links the two if they're semantically similar.
`state.lastToolCapture` is guaranteed non-null when intent is `tool_outcome`
(classifyIntent only returns `tool_outcome` when `lastToolCapture` is set).

#### 4.1.6 system.transform update (C2 fix — set lastInjectedMemoryIds)

In `experimental.chat.system.transform` (`plugin.ts:497-510`), **before**
clearing `state.pendingInjection` at line 509, stash the injected memory IDs:

```ts
"experimental.chat.system.transform": (_input, output) => {
  if (!state.pendingInjection) return;
  if (!Array.isArray(output?.system)) {
    state.pendingInjection = null;
    return;
  }
  // C2 fix: stash the IDs delivered THIS TURN before clearing, so the
  // hit-rate metric can read them on the assistant branch (pendingInjection
  // is about to be cleared, but lastInjectedMemoryIds persists until the
  // next user message).
  state.lastInjectedMemoryIds = Array.from(state.injectedMemoryIds).slice(-5);
  output.system.push(state.pendingInjection);
  state.pendingInjection = null;
},
```

**Reset at next user message:** in the `chat.message` user branch, at the
start of the handler (before classify/push), reset the per-turn injection
state only. **C2 fix: do NOT clear `lastToolCapture` here** — it must survive
from the prior turn's `tool.execute.after` through the user branch's
`classifyIntent` (which reads it) AND through `session.idle`'s `evaluateDelta`
(which renders the §4.1.5 `tool_outcome` template from it). It is cleared
AFTER `evaluateDelta` completes (§4.1.4 step 8). Only `lastInjectedMemoryIds`
is reset here (it's read in a LATER hook — `evaluateDelta` on `session.idle` —
and must be null so the next turn's hit-rate metric starts clean; the clear
here is safe because `evaluateDelta` for THIS turn already ran on the prior
`session.idle`):

```ts
// Reset per-turn injection state (new user message starts a new turn).
// NOTE (C2 fix): lastToolCapture is NOT cleared here — classifyIntent reads
// it from the prior turn's tool.execute.after, and evaluateDelta clears it
// after use on session.idle.
state.lastInjectedMemoryIds = null;
state.deltaTurnDone = false; // C1 fix: reset the double-fire guard for the new turn
```

**Note on `injectedMemoryIds` vs `lastInjectedMemoryIds`:** the existing
`state.injectedMemoryIds: Set<string>` tracks ALL IDs delivered this session
(to prevent re-injection). The new `state.lastInjectedMemoryIds: string[]`
tracks only the IDs delivered THIS TURN (for the hit-rate metric). We take the
last 5 entries from the set (the most recent deliveries) as a turn-scoped
approximation. A more precise approach would track which IDs were staged in
`pendingInjection` specifically — but `pendingInjection` is a formatted string,
not a list of IDs. The Worker should extract the IDs from `newResults` in the
`chat.message` user branch (line 481: `newResults.forEach((r) =>
state.injectedMemoryIds.add(r.memory.id))`) and store them in
`state.lastInjectedMemoryIds` directly, rather than slicing from the session
set. The Worker documents which approach was taken.

### 4.2 Auto-relate (`maybeRelate`)

New MemoryStore method: `maybeRelate(memoryId: string, content: string, type:
MemoryType): Promise<number>` — returns the number of edges created.

**Algorithm:**

1. Recall (semantic if embeddings available, else FTS5 keyword) the top
   `maxRelatedPerMemory` (default 3) memories matching `content`, excluding
   `memoryId` itself, in `scope: "all"` (so cross-project relations form too).
2. For each candidate above the recall threshold:
   - Determine edge type: `extends` by default; `derived_from` if the new memory
     is a `lesson_learned` and the candidate is a `user_preference` or
     `task_pattern` (the lesson derives from the pattern); `reinforces` if the
     new memory is the same type as the candidate (the brain loop's
     reinforcement signal).
   - Call `this.relate(memoryId, candidate.id, edgeType)`.
   - Catch `DuplicateRelationshipError` (INV-008) silently — idempotent. Catch
     `SelfRelationshipError` (shouldn't happen — `memoryId` is excluded) and
     `MemoryNotFoundError` (candidate archived between recall and relate)
     silently.
3. Return the count of edges created.
4. Cap at `maxRelatedPerMemory` — never creates more edges than the cap per
   call, preventing graph explosion.

**Wiring:** the plugin calls `maybeRelate` after `store()` on the auto-capture
paths (`tool.execute.after`, `evaluateDelta`) when `config.autoRelate` is true.
The explicit MCP `store_memory` path does NOT auto-relate — it already accepts
explicit `relationships` in `StoreInput`, and surprising a user who explicitly
stores a memory with auto-edges would violate the principle of least
astonishment. `maybeRelate` is also exposed as a public MemoryStore method so
the MCP `relate` tool remains the manual path.

### 4.3 Metrics (schema v4 + recording + query)

**SCHEMA_V4** (new, idempotent — follows the SCHEMA_V2 meta-table pattern):

```sql
CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_recorded_at ON metrics(recorded_at);
```

Bump `CURRENT_SCHEMA_VERSION` from 3 to 4. Add `4: SCHEMA_V4` to the
`MIGRATIONS` map. The existing `runMigrations` runner handles the rest — it
applies each migration in version order if not already in `schema_version`,
all statements use `IF NOT EXISTS`, re-running on a migrated DB is a no-op that
still records the version row (INV-005 preserved).

**MemoryStore methods** (mirror the `getMeta`/`setMeta` pattern at
`store.ts:1484-1501`):

- `recordMetric(name: string, value: number, sessionId?: string): Promise<void>`
  — INSERT (ULID id, ISO `recorded_at`).
- `getMetricSummary(name?: string, since?: string): Promise<Array<{
  metric_name: string; count: number; sum: number; avg: number; latest: number;
  latest_at: string }>>` — aggregate query. When `name` is omitted, returns all
  metrics; `since` filters by `recorded_at >= since`.
- `getBloatRatio(): Promise<number>` — `COUNT(weight < archiveThreshold) /
  COUNT(status='active')`. Recorded as a `memory_bloat_ratio` snapshot on each
  decay/compacting pass.

**The 5 metrics** (heuristic, approximate — the issue explicitly says
"minimal" and "approximate"):

| Metric | How recorded | How to interpret |
|--------|--------------|------------------|
| `recall_hit_rate` | `evaluateDelta` step 7: was a recalled memory's token/domain/tag present in the assistant's response? (naive substring check against the content of memories whose IDs are in `state.lastInjectedMemoryIds` — C2 fix, NOT `state.pendingInjection` which is always null at this point) | `hits / (hits + misses)` over a window. Higher = injected memory is being used. |
| `correction_retention` | `evaluateDelta` step 7: on `correction` intent, increment `correction_stored`; if the same correction keyword pattern re-appears in a later turn, increment `correction_repeated` | `1 - repeated / stored`. Higher = corrections are sticking. |
| `duplicate_rate` | `store()` reinforce path (detected in `evaluateDelta` step 7 via `reinforcementCount > 0 && createdAt !== updatedAt`) | `duplicates_caught / total_stores`. Lower = the brain is storing novel memories, not re-storing. |
| `memory_bloat_ratio` | `getBloatRatio()` snapshot, recorded on `decay()` / `compacting` pass | `low_weight / total`. Lower = the store is healthy. |
| `preference_compliance` | `evaluateDelta` step 3/7: naive keyword check — did the assistant's response contradict a known `user_preference` memory? (records 1.0 aligned, 0.0 contradicted) | `aligned / (aligned + contradicted)`. Higher = the agent is respecting stored prefs. |

**Query surface:** new MCP tool `get_metrics` (zod schema: optional `name`
string, optional `since` ISO string) added to `createMcpTools` in
`mcp-server.ts` — calls `store.getMetricSummary(name, since)`. New browser
route `GET /api/metrics` in `src/browser/server.ts` (localhost-only,
read-only — same ADR-006/007 posture as the existing `/api/graph`,
`/api/stats`, `/api/domains` routes). Both return JSON.

### 4.4 `experimental.session.compacting` hygiene hook + conciseness

**Compacting hook:** add a new handler for `experimental.session.compacting`
(the issue names this event explicitly). **Verification step for the Worker:**
confirm whether `experimental.session.compacting` is a *hook* (like
`experimental.chat.system.transform`) or an *Event* (like `session.created`).
The Epic #3 lesson: `message.updated` was an Event, not a hook, and never
fired — wiring it as a hook silently did nothing. If it's a hook, add a
top-level handler; if it's an Event, add a branch to the existing `event`
handler keyed on `event.type === "experimental.session.compacting"`. The plan
assumes the hook form (matches the `experimental.*` namespace convention); the
Worker verifies and adjusts.

```ts
"experimental.session.compacting": () => {
  // Fire-and-forget hygiene (INV-017)
  void (async () => {
    const store = await getStore();
    // 1. Rate-limited decay (separate meta key from session.created's decay:lastRun)
    const ran = await store.maybeDecay("decay:compacting", compactingIntervalHours);
    if (!ran) {
      // Still run a lightweight dedup pass + bloat snapshot even if decay skipped
    }
    // 2. Dedup pass — merge near-duplicate active memories
    await store.dedupPass();
    // 3. Archive low-weight (decay already does this if it ran; if it skipped,
    //    a direct decay() call archives below archiveThreshold)
    if (!ran) await store.decay();
    // 4. Record bloat snapshot
    await store.recordMetric("memory_bloat_ratio", await store.getBloatRatio());
    await log("info", "Compacting hygiene completed");
  })().catch((error) => log("error", `Compacting hygiene failed: ${...}`));
}
```

**`MemoryStore.dedupPass()` — new method:** scans active memories (capped at
1000 rows, ordered by `updated_at DESC` — most-recently-touched first), finds
near-duplicate pairs (using the existing `findDuplicate` logic in embedding or
keyword mode), and merges: reinforces the higher-weight memory, archives the
lower-weight one. Catches the case where two memories drifted into
near-duplication over time (the per-store `findDuplicate` only checks at insert
time). Bounded scan keeps it fast.

**Conciseness enforcement:** add a new optional `concise?: boolean` field to
`StoreInput` in `types.ts`. In `store()` step 3 (after `scrubSecrets`, before
the dedup check), if `input.concise === true` and `content.length >
config.concisenessCap` (default 280), truncate to the cap:

```ts
// step 3b: conciseness cap (auto-stored memories only)
if (input.concise === true) {
  const cap = this.config.concisenessCap ?? 280;
  if (content.length > cap) {
    // Truncate at the last word boundary before the cap, append "…"
    const cut = content.slice(0, cap - 1);
    const lastSpace = cut.lastIndexOf(" ");
    content = (lastSpace > cap * 0.6 ? content.slice(0, lastSpace) : cut) + "…";
  }
}
```

**Wiring:** the plugin's auto-capture paths (`tool.execute.after`,
`evaluateDelta`, `session.idle` auto-summarize) pass `concise: true`. The MCP
`store_memory` handler does NOT set `concise` — explicit user stores keep full
content. This keeps auto-captured memory bloat in check without surprising a
user who deliberately stores a verbose memory.

### 4.5 ADR-008 — Brain-loop behavior + plugin role/boundary (C5 fix — expanded to cover Drift #1 full surface)

The Worker creates `/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md`
(from `TEMPLATES/adr.md`). **This file lives in the unversioned workspace**
(`/home/royce/mission-control/PROJECTS/realmemory/docs/adr/` — where ADR-001
through ADR-007 live; the repo README links to them as `../docs/adr/…`), **NOT
in the repo** (`PROJECTS/realmemory/repo/`).
It is NOT part of any PR and is NOT reverted by `git revert` (see §11). It
ratifies the brain-loop architecture shipped in Epic #3 *and* the #22
additions, **and explicitly covers Drift #1's full surface: the plugin's
role, its public-vs-private boundary, and whether its config knobs are a
stable public config surface.** It does **not** supersede any existing ADR.
Summary of the ADR content (the Worker writes the full file):

- **Context:** Epic #3 shipped a self-improving memory loop (auto-recall,
  auto-capture, dedup+reinforce, decay, delivery) without an ADR (Drift #1,
  #7). Issue #22 extends it (per-turn delta evaluation, auto-relate, metrics,
  compacting hygiene, conciseness). This ADR ratifies the whole surface so
  future changes have a decision record.
- **Decision:**
  - **(a) Brain-loop behavior — per-turn delta evaluation via local heuristics
    only** (no LLM call — preserves INV-017 non-blocking, avoids Drift #5).
  - **(b) Auto-relate capped at `maxRelatedPerMemory`.**
  - **(c) Metrics in a SQLite `metrics` table** (no external dep — preserves
    INV-014).
  - **(d) `experimental.session.compacting` hygiene hook** (fire-and-forget).
  - **(e) Conciseness cap on auto-stored memories only.**
  - **(f) Plugin role (C5 fix — Drift #1 full surface):** `src/plugin.ts` is
    OpenCode-only glue that wires the library's `MemoryStore` into OpenCode's
    hook system. It is **NOT part of the npm library's public API** — it is not
    exported by the library's main entry point (`src/index.ts`). Consumers
    who integrate realmemory as an OpenCode plugin use the plugin; consumers
    who import the library use `MemoryStore` directly. The plugin's purpose is
    the brain loop: auto-recall, auto-capture, `evaluateDelta`, auto-relate,
    decay, compacting hygiene.
  - **(g) Public-vs-private boundary (C5 fix):** `src/store.ts` (MemoryStore
    class + public methods), `src/types.ts` (StoreInput, RecallQuery,
    MemoryStoreConfig, etc.), `src/config.ts` (DEFAULTS, validateConfig), and
    `src/db/schema.ts` (schema + migrations) are the **public library API**.
    `src/plugin.ts` is internal plugin glue (not exported by the library
    main entry). `src/mcp-server.ts` and `src/browser/server.ts` are
    standalone servers (separate entry points, not part of the library
    public API).
  - **(h) Config-surface question (C5 fix):** `MemoryStoreConfig` (including
    existing knobs `autoCapture`, `autoSummarize`, `summaryProvider`,
    `decayIntervalHours`, `archiveThreshold`, `recallThreshold`,
    `maxRecallResults`, and the new #22 knobs `concisenessCap`, `autoRelate`,
    `brainLoop`, `compactingIntervalHours`) is a **stable public config
    surface** for both library users and plugin users. Config knobs are
    additive (new knobs are optional with defaults — INV-015 preserved).
    Breaking changes to config knobs require a MAJOR version bump per
    ADR-004. The config surface is the stable contract; the hook
    implementations behind it may evolve.
  - **(i) INV-017 contract ratified:** all brain-loop hooks
    (`session.idle` delta-evaluation branch [C1 PRIMARY], `chat.message`
    user/assistant branches [assistant is secondary/best-effort, may be
    absent], `tool.execute.after`, `experimental.chat.system.transform`,
    `experimental.session.compacting`, `session.created` decay scheduling)
    are detached `void (async () => {...})().catch(...)` promises. No hook
    handler may block the host's tool loop or message processing.
- **Options considered:** (A) LLM-based per-turn reflection — rejected (blocks
  the tool loop per INV-017, compounds Drift #5 secret-leak); (B) external
  metrics/tracing library — rejected (violates INV-014 three-dep cap, already
  violated by zod); (C) local heuristics + SQLite metrics — chosen.
- **Consequences — positive:** loop is observable (metrics), graph self-
  organizes (auto-relate), store doesn't bloat (conciseness + compacting
  hygiene), no new deps, no new LLM surface, plugin role/boundary documented.
- **Consequences — negative/trade-offs:** local heuristics are less nuanced
  than LLM reflection (correction/repetition/preference detection is keyword-
  based — paraphrases may be missed); metrics are approximate (heuristic
  proxies, not ground truth); auto-relate may create spurious edges (capped,
  idempotent, and the user can `forget` them).
- **Risks:** (a) heuristic false positives store noise — mitigated by
  `isHighSignal` gate + decay; (b) auto-relate graph explosion — mitigated by
  `maxRelatedPerMemory` cap; (c) compacting hook never fires if OpenCode
  doesn't emit it — Worker verifies the hook exists (Epic #3 lesson); (d)
  `chat.message` assistant branch does NOT fire in the installed host (round-2
  verified) — the `session.idle` primary trigger carries the feature; the
  assistant branch is secondary/best-effort future-proofing (double-fire-
  guarded, may be dropped).
- **Related decisions:** ADR-003 (dep policy — NOT superseded; #22 adds zero
  deps); ADR-004 (versioning — 0.3.0 → 0.4.0 is a MINOR bump per pre-1.0
  semver); notes Drift #5 (secrets-before-LLM-call in `session.idle`
  summarization) as a **pre-existing issue #22 does NOT fix** — out of scope,
  logged to `PARKING_LOT.md`.

**Intent-layer updates (part of A22.1 + A22.6 scope) — C3 fix: all paths are
absolute workspace paths, NOT repo paths. These files live in the unversioned
workspace (`PROJECTS/realmemory/docs/`), not in the repo
(`PROJECTS/realmemory/repo/`). They are NOT in any PR and NOT reverted by
`git revert` (see §11):**

- **A22.1 (ADR story):** `/home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md`
  — add ADR-008 row to Active Decisions; mark Drift #1 ("Plugin/brain-loop
  surface") as **resolved by ADR-008** in Open Items (now fully resolved —
  ADR-008 covers the plugin role, public/private boundary, config-surface
  question, and INV-017 contract, per the C5 fix). Drift #7 (schema-v3
  structure model) remains open for a future ADR-009. The ADR-008 file itself
  goes at `/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md`
  (where ADR-001…ADR-007 live).
- **A22.6 (final story):** `/home/royce/mission-control/PROJECTS/realmemory/docs/SYSTEM_MAP.md`
  — update Drift Log #1 to **resolved by ADR-008**; #7 (schema-v3 ADR-less)
  remains open. Note the new `metrics` table, `maybeRelate`, `dedupPass`,
  `evaluateDelta`, compacting hook in the module map + data flow. (The
  Cartographer re-maps post-merge; the Worker's edits are the interim
  update.) `/home/royce/mission-control/PROJECTS/realmemory/docs/INVARIANTS.md`
  — add a note to INV-017 that the brain-loop's `evaluateDelta` + compacting
  hook are covered by it.

**What IS in the repo and IS reverted by `git revert`:** the agile workspace
at `PROJECTS/realmemory/repo/docs/06-agile/` (this plan, the review reports,
the tracking table) IS in the repo and IS reverted by `git revert`. The
source code under `PROJECTS/realmemory/repo/src/` is in the repo and IS
reverted. The intent-layer files above are NOT.

### 4.6 Version bump

0.3.0 → 0.4.0 (MINOR, pre-1.0 per ADR-004). The new `concise?: boolean` field
on `StoreInput` is additive (existing callers unaffected — INV-015 preserved).
The new MemoryStore methods (`recordMetric`, `getMetricSummary`,
`getBloatRatio`, `maybeRelate`, `dedupPass`) are additive. The new MCP tool
(`get_metrics`) is additive. Update `package.json` `version` and
`mcp-server.ts` `SERVER_VERSION`.

---

## 5. Alternatives Considered

| Option | Why not chosen |
|--------|----------------|
| **LLM-based per-turn reflection** (call an LLM on each assistant turn to classify intent + extract memories) | Violates INV-017 (a per-turn LLM call blocks the agent's tool loop — even detached, it's wasteful and adds latency pressure). Compounds Drift #5 (the unaddressed secret-leak in `session.idle` — a per-turn LLM call would send every user+assistant exchange to a third-party endpoint un-scrubbed). Local heuristics are fast, free, and secret-safe. The issue's pseudocode (`evaluateDelta`) is local-pattern-based, not LLM-based. |
| **External metrics/tracing library** (e.g. prom-client, opentelemetry) | Violates INV-014 (three-dep cap — already violated by `zod` per Drift #6; adding a 5th dep compounds the violation and would require superseding ADR-003 first, which is out of scope for #22). SQLite `metrics` table uses the existing store, zero new deps. |
| **Store metrics in the existing `meta` KV table** (key=value, not a dedicated table) | The `meta` table is a durable KV for single values (e.g. `decay:lastRun` timestamp). Metrics need append-many + aggregate queries (count/sum/avg over time by name). A dedicated `metrics` table with indexes is the right shape; shoehorning time-series into KV would require JSON-array values and in-JS aggregation — slower and harder to query. |
| **Auto-relate on explicit `store_memory` MCP calls too** (not just auto-capture) | Surprises a user who explicitly stores a memory with unrequested edges. The MCP `store_memory` tool already accepts explicit `relationships` in `StoreInput`; auto-relate is for the brain loop's auto-captured memories where the user isn't in the loop. Exposing `maybeRelate` as a public method lets a caller opt in programmatically. |
| **Full LLM-based secret scrubbing before `session.idle` summarization** (fix Drift #5 as part of #22) | Out of scope — #22's delta loop uses local heuristics (no LLM), so it doesn't touch the Drift #5 surface. Fixing Drift #5 properly requires an ADR for the summary-provider integration (its opt-in posture, transcript scrubbing, security implications) — that's a separate issue. Logged to `PARKING_LOT.md`. |
| **Schema-v3 ADR as part of ADR-008** (ratify schema-v3 structure model too) | ADR-008 is scoped to the brain-loop + plugin role/boundary (Drift #1 full surface per C5 fix). The schema-v3 structure model (Drift #7 — `domain`/`category`/`source`, `MemoryMetadata`, dedup+promotion) is a distinct decision surface and deserves its own ADR (ADR-009 or similar). Bundling them would make ADR-008 unfocused. Drift #7 remains open. |

---

## 6. Intent Constraints

Classification against the intent layer
(`/home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md`,
`/home/royce/mission-control/PROJECTS/realmemory/docs/INVARIANTS.md`) per the
Intent Conflict Policy (`AGENTS/arbiter.md`):

**Classification: Additive.** No existing ADR is superseded. No existing
invariant is violated. No intent conflict gate is needed (that's for
Contradicting plans).

| Constraint | Status | Notes |
|-----------|--------|-------|
| **ADR-003** (three-dep cap) | **PRESERVED — not superseded** | #22 adds ZERO new runtime deps. Metrics use the existing SQLite store; evaluateDelta uses local heuristics (no LLM library); auto-relate uses the existing recall engine. INV-014 is already violated by `zod` (Drift #6) — #22 does not compound it. Resolving Drift #6 (superseding ADR-003 to ratify `zod`, or removing `zod`) is out of scope — logged to `PARKING_LOT.md`. |
| **ADR-004** (semver) | **PRESERVED** | 0.3.0 → 0.4.0 is a MINOR bump (pre-1.0). The new `concise?: boolean` field on `StoreInput` is additive — existing callers are unaffected (INV-015). New MemoryStore methods + MCP tool are additive. |
| **ADR-006 / ADR-007** (localhost read-only browser) | **PRESERVED** | New `/api/metrics` route is localhost-only (127.0.0.1), read-only (GET-only), no framework — same posture as existing `/api/graph`, `/api/stats`, `/api/domains`. |
| **INV-001** (secrets scrubbed before write) | **PRESERVED** | `evaluateDelta`'s `store()` calls inherit `scrubSecrets` (it's in `store()` step 3). No new write path outside `store()` / `update()`. |
| **INV-004** (project-scope default) | **PRESERVED** | `evaluateDelta` stores with `scope: "project"`. Auto-capture paths already use `scope: "project"`. |
| **INV-005** (schema versioning) | **PRESERVED** | SCHEMA_V4 is idempotent (`IF NOT EXISTS`), added to the `MIGRATIONS` map, `CURRENT_SCHEMA_VERSION` bumped to 4, recorded in `schema_version` by the existing `runMigrations` runner. Follows the exact SCHEMA_V2 meta-table pattern. |
| **INV-014** (three-dep cap) | **PRESERVED (not worsened)** | Zero new runtime deps. INV-014 is already violated by `zod` (Drift #6) — #22 does not add a 5th. |
| **INV-015** (public API stable) | **PRESERVED** | New `concise?: boolean` field on `StoreInput` is optional — existing callers compile + behave unchanged. New MemoryStore methods are additive. New MCP tool is additive. ADR-008 (C5 fix) ratifies the config-surface (`MemoryStoreConfig` knobs) as a stable public surface — new knobs are optional with defaults. |
| **INV-017** (non-blocking hooks) | **PRESERVED — load-bearing** | `evaluateDelta` (assistant branch), `maybeRelate` (called from detached paths), the compacting hygiene hook, and all metrics recording run on detached `void (async () => {...})().catch(...)` promises. `evaluateDelta` uses local heuristics (no LLM call) — it runs in milliseconds. A slow store/recall/relate never blocks the tool loop or message processing. ADR-008 explicitly ratifies this contract (C5 fix). |
| **INV-018** (dedup+reinforce) | **PRESERVED** | `evaluateDelta` calls `store()`, which already does dedup+reinforce. `dedupPass()` reuses `findDuplicate`. No change to the dedup contract. The C3 content templates ensure deterministic content strings so dedup behavior is reproducible. |

**Out of scope — flagged, not fixed by #22:**

- **Drift #5** (secrets-before-LLM-call in `session.idle` summarization): #22's
  delta loop uses local heuristics (no LLM), so it does NOT worsen this. Fixing
  Drift #5 requires an ADR for the summary-provider integration — separate
  issue. Logged to `PROJECTS/realmemory/PARKING_LOT.md` (the Worker adds the
  entry in A22.1).
- **Drift #6** (`zod` as 4th runtime dep, INV-014 violated): #22 adds zero deps,
  so it doesn't compound the violation. Resolving it (superseding ADR-003 or
  removing `zod`) is out of scope. Logged to `PARKING_LOT.md` (the Worker adds
  the entry in A22.1 if not already present).
- **Drift #7** (schema-v3 structure model ADR-less): ADR-008 covers Drift #1's
  full surface (brain-loop + plugin role/boundary/config-surface per C5 fix).
  Drift #7 (schema-v3 structure model) remains open for a future ADR-009.

---

## 7. Design Consistency

**N/A — no UI.** realmemory is `project_type: library`; the `library` manifest
skips the UX track (no `docs/ux-design.md`, no design-system sprint, no
Prototype Sprint gate). The graph browser is a developer-observability surface,
not a product UI.

The new `/api/metrics` browser route returns JSON only (no new HTML/CSS/JS in
`assets.ts`). It follows the existing `/api/stats` / `/api/graph` / `/api/domains`
pattern — same localhost-only, read-only, GET-only, no-framework posture. No
new visual pattern ships. (A future increment could render metrics in the
browser UI — logged to `PARKING_LOT.md`, out of scope for #22.)

---

## 8. Blast Radius & Regression Risk

| At risk | Why it's in the blast radius | Protection |
|---------|------------------------------|------------|
| **Existing `chat.message` user-recall path** (`plugin.ts:452-491`) | The user branch changes from fixed `limit: 3` to `dynamicLimit(intent)` and adds per-turn state resets (C2 fix: `lastToolCapture` NOT cleared here) + classify-before-push + the `deltaTurnDone` double-fire-guard reset. The assistant branch (C1 secondary/best-effort) is added to the same handler but is verified-dead in the installed host and double-fire-guarded. | The user branch's role check (`role === "user"`) is preserved; the assistant branch is a new `else if` that sets `deltaTurnDone=true` before running `evaluateDelta` (so `session.idle` skips if both fire). `dynamicLimit` returns 3 for `generic` intent (the default), so the user-recall behavior is unchanged for generic chat. New test: `tests/plugin-brain-loop.test.ts` asserts the user path still recalls with limit 3 for generic intent, 5 for correction/preference; the `session.idle` branch runs `evaluateDelta` (primary trigger); `brainLoop:false` skips the delta loop entirely (C4 fix). |
| **`store()` dedup + reinforce contract** (INV-018) | `evaluateDelta` + auto-capture paths call `store()` with `concise: true`; the conciseness cap mutates `content` before the dedup check. | The cap is applied *after* `scrubSecrets` and *before* `findDuplicate` — a truncated memory is still dedup-checked against existing memories (a truncated correction that matches an existing preference still reinforces it). The C3 content templates produce deterministic strings so dedup matching is reproducible. New test: `tests/store-conciseness.test.ts` asserts truncation + dedup interaction. Existing `tests/store*.test.ts` (dedup, reinforce, cross-project promotion) must pass unchanged (they don't set `concise`). |
| **`relate()` + relationship graph** (INV-007, INV-008) | `maybeRelate` creates edges automatically; a bug could create self-relationships, duplicates, or graph explosion. | `maybeRelate` excludes the source memory from candidates (no self-relationships — INV-007), catches `DuplicateRelationshipError` silently (INV-008 idempotent), caps at `maxRelatedPerMemory` (no explosion). New test: `tests/store-maybe-relate.test.ts` asserts caps + idempotency + no self-edges. |
| **`decay()` + `maybeDecay`** (rate-limiting) | The compacting hook calls `maybeDecay("decay:compacting", ...)` with a *separate* meta key from `session.created`'s `decay:lastRun`. | Separate keys mean the two rate-limiters are independent — compacting doesn't reset the session.created cadence and vice versa. New test: `tests/plugin-compacting.test.ts` asserts both keys are independent. |
| **Schema migrations** (INV-005) | SCHEMA_V4 adds a new table; a malformed migration could corrupt the DB. | The migration is `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — idempotent, re-runnable. Existing `tests/schema.test.ts` (v1→v2→v3 migration tests) must pass; new test asserts v4 migration applies cleanly on a v3 DB and is a no-op on a v4 DB. |
| **MCP server tool registry** | Adding a 9th tool (`get_metrics`) changes the `tools/list` response; a malformed zod schema could break the server. | The new tool follows the exact `zodToInputSchema` + handler pattern of the existing 8. Existing `tests/mcp-server.test.ts` (tool list, tool call) must pass; new test asserts the 9th tool is listed + callable. |
| **Browser server routes** | A new `/api/metrics` route could collide with an existing path or break the GET-only invariant. | The route is `GET /api/metrics` — no collision with `/api/graph`, `/api/memory/:id`, `/api/stats`, `/api/domains`, `/static/*`, `/`. GET-only (INV-013 preserved). New test: `tests/browser-server.test.ts` asserts the route returns JSON + rejects non-GET. |
| **`experimental.chat.system.transform` delivery** (`plugin.ts:497-510`) | The C2 fix adds `state.lastInjectedMemoryIds` assignment before the `pendingInjection` clear. A bug could break delivery or leave stale injection state. | The assignment is before the existing `push` + `null` clear — delivery behavior is unchanged. The reset in the user branch clears `lastInjectedMemoryIds` at turn start. New test: `tests/plugin-brain-loop.test.ts` asserts `lastInjectedMemoryIds` is set after delivery + cleared on next user message. |
| **`session.idle` auto-summarize** (existing LLM path) | The delta loop (C1 fix primary trigger) now runs on `session.idle` BEFORE the LLM summarization. A bug could block summarization or fire in the wrong order. | `evaluateDelta` runs on a detached promise (INV-017) and uses local heuristics only — it cannot block the LLM call. It runs BEFORE summarization (so its `lastToolCapture` clear doesn't affect the LLM path). The `brainLoop` master switch (C4 fix) gates the whole delta path — when `false`, `session.idle` runs only the existing summarization (v0.3.0 behavior). Existing `tests/plugin-session-idle.test.ts` passes unchanged. New test: `tests/plugin-brain-loop.test.ts` asserts the delta loop runs before summarization and `brainLoop:false` skips it. |
| **`brainLoop` config knob** (C4 fix) | Declared in A22.2 and ADR-ratified as a stable public config surface, but with no consumer it is dead code — a user setting `brainLoop: false` would be silently ignored. | **C4 fix: wired as the master switch.** The `session.idle` event branch checks `if (state.config.brainLoop === false) return;` BEFORE `classifyIntent`/`evaluateDelta` (§4.1.1). When `false`, no delta memories are stored, no delta metrics recorded — v0.3.0 fixed-`limit: 3` recall behavior is the disabled state (the user-branch `dynamicLimit`/classification work is part of the same #22 path and is gated too). New acceptance criterion in A22.3: with `brainLoop: false`, firing `session.idle` stores nothing and records no metrics. |
| **Public library API** (INV-015) | New `concise?: boolean` on `StoreInput`; new MemoryStore methods; new PluginState fields. | The field is optional — existing callers compile + behave unchanged. New methods are additive. PluginState is internal (not exported). `npm run typecheck` + existing `tests/store*.test.ts` guard the contract. |

**Migrations:** additive/idempotent — SCHEMA_V4 is `CREATE TABLE IF NOT
EXISTS`. No down migration needed for revert (dropping the `metrics` table is
safe but not required — the table is new and unused after revert). See §11.

---

## 9. Story Breakdown

**Six stories, in build order (C6 fix — ADR-008 lands FIRST as A22.1, before any
hook/config knob story).** The ADR is the intent authorization; the code is the
implementation. Each becomes a task brief with §6a Intent Constraints filled
from §6 above. Each story's §3a Experience Script is the literal walkthrough
the Experience Runner drives (for a library/plugin: load the plugin or
MemoryStore, simulate hooks, verify side effects in SQLite).

---

### Story A22.1 — ADR-008 + DECISIONS.md update + PARKING_LOT entries (C6 fix: ADR first, pure docs)

**As a** a maintainer **I want** the brain-loop behavior and plugin
role/boundary ratified by an ADR before any code ships **so that** the intent
layer authorizes the surface expansion (config knobs, hooks) that the
following stories implement.

**Scope (C3 fix — absolute workspace paths; these files live in the
unversioned workspace, NOT in the repo):**
`/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md`
(new, from ADR template — where ADR-001…ADR-007 live),
`/home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md` (update
Active Decisions + Open Items),
`/home/royce/mission-control/PROJECTS/realmemory/PARKING_LOT.md` (Drift #5 + #6 entries).

- Create `/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md`
  per §4.5 (full ADR content: context, decision (a)–(i) including the C5
  plugin role/boundary/config-surface expansion, options, consequences,
  risks, related decisions).
- Update `/home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md`:
  add ADR-008 row to Active Decisions; mark "Plugin/brain-loop surface"
  (Drift #1) as **resolved by ADR-008** in Open Items (fully resolved —
  ADR-008 covers plugin role, public/private boundary, config-surface
  question, and INV-017 contract per the C5 fix). Drift #7 (schema-v3
  structure model) remains open.
- Add `/home/royce/mission-control/PROJECTS/realmemory/PARKING_LOT.md`
  entries: "Drift #5 — secrets-before-LLM-call in session.idle summarization
  (needs ADR for summary-provider integration)" + "Drift #6 — zod as 4th
  runtime dep (needs ADR-003 supersession or regression fix)" — if not
  already present.

**Acceptance criteria:**

- [ ] `/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md`
  exists, follows the ADR template, states the decision + options +
  consequences + risks.
- [ ] ADR-008 explicitly covers Drift #1's full surface (C5 fix): plugin role
  (§4.5(f) — `src/plugin.ts` is OpenCode-only glue, not part of the npm
  library public API), public/private boundary (§4.5(g) — `src/store.ts` +
  `src/types.ts` + `src/config.ts` are the public library API),
  config-surface question (§4.5(h) — `MemoryStoreConfig` knobs are a stable
  public config surface, additive with defaults), and INV-017 contract
  ratification (§4.5(i)).
- [ ] ADR-008 explicitly notes it does NOT supersede ADR-003 and does NOT add
  LLM calls (avoids Drift #5).
- [ ] `/home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md`
  Active Decisions table has an ADR-008 row; Open Items marks Drift #1
  resolved by ADR-008; Drift #7 remains open.
- [ ] `/home/royce/mission-control/PROJECTS/realmemory/PARKING_LOT.md` has
  entries for Drift #5 + #6.
- [ ] `npm run check` passes in the repo (`PROJECTS/realmemory/repo/`) — no
  code changes (docs only). The edited files are in the workspace
  (`PROJECTS/realmemory/docs/`), not the repo; the check is run in the repo to
  confirm no source was touched.

**Experience Script (§3a):**

```
1. Read /home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md.
   VERIFY: it exists, follows the ADR template (context, decision, options,
   consequences, risks, related decisions), covers Drift #1's full surface
   (plugin role, public/private boundary, config-surface, INV-017 — sections
   f/g/h/i), notes no new deps + no LLM calls.
2. Read /home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md.
   VERIFY: ADR-008 row present in Active Decisions; Drift #1 marked "resolved
   by ADR-008" in Open Items; Drift #7 remains open.
3. Read /home/royce/mission-control/PROJECTS/realmemory/PARKING_LOT.md.
   VERIFY: entries for Drift #5 (secrets-before-LLM in session.idle) and
   Drift #6 (zod 4th dep) exist.
4. Run: npm run check   (in PROJECTS/realmemory/repo/ — the edited files are in
   the workspace, not the repo; this confirms no source was touched)
5. VERIFY: typecheck + lint pass (no code changed).
```

---

### Story A22.2 — Schema v4 + metrics meta table + MemoryStore metrics methods + config knobs

**As a** plugin author **I want** a versioned metrics table and recording/query
methods on MemoryStore **so that** the brain loop can record observable signals
and surface them via MCP + browser.

**Scope:** `src/db/schema.ts`, `src/store.ts`, `src/types.ts`, `src/config.ts`.

- Add `SCHEMA_V4` (metrics table + indexes, idempotent) to `src/db/schema.ts`.
- Bump `CURRENT_SCHEMA_VERSION` from 3 to 4. Add `4: SCHEMA_V4` to `MIGRATIONS`.
- Add `MemoryStore.recordMetric(name, value, sessionId?)` (INSERT with ULID +
  ISO timestamp).
- Add `MemoryStore.getMetricSummary(name?, since?)` (aggregate: count, sum, avg,
  latest, latest_at per metric_name).
- Add `MemoryStore.getBloatRatio()` (low-weight / total active).
- Add config knobs to `DEFAULTS` + `MemoryStoreConfig` + `validateConfig`:
  `concisenessCap: 280`, `autoRelate: true`, `brainLoop: true`,
  `compactingIntervalHours: 4`. **C4 fix: the `brainLoop` knob is consumed in
  A22.3** — wired as the master switch in the `session.idle` event branch
  (`if (state.config.brainLoop === false) return;` before
  `classifyIntent`/`evaluateDelta`, §4.1.1). A22.2 declares + validates it;
  A22.3 wires the consumer. The knob is ADR-ratified (ADR-008(h)) as a stable
  public config surface.

**Prerequisite:** A22.1 (ADR-008) is merged — the config knobs are ratified by
the ADR before they ship (C6 fix).

**Acceptance criteria:**

- [ ] SCHEMA_V4 migration applies cleanly on a v3 DB (new `metrics` table + 2
  indexes appear) and is a no-op on a v4 DB (re-running `runMigrations` records
  the version row without error).
- [ ] `recordMetric("recall_hit_rate", 1.0, "sess-123")` inserts a row;
  `getMetricSummary("recall_hit_rate")` returns `{ metric_name, count, sum, avg,
  latest, latest_at }` with the recorded value.
- [ ] `getMetricSummary()` (no name) returns all metrics; `getMetricSummary(name,
  since)` filters by `recorded_at >= since`.
- [ ] `getBloatRatio()` returns 0.0 on an empty store; returns the correct
  fraction when memories with `weight < archiveThreshold` exist.
- [ ] `validateConfig` rejects `concisenessCap <= 0`, `compactingIntervalHours
  <= 0`, non-boolean `autoRelate`/`brainLoop`.
- [ ] `npm run check` passes. `npm test` passes (existing 404 tests + new
  schema/metrics tests).

**Experience Script (§3a):**

```
1. Run: npm test -- tests/schema.test.ts tests/store-metrics.test.ts
2. VERIFY: all tests pass (v3→v4 migration, idempotent re-run, recordMetric/
   getMetricSummary round-trip, getBloatRatio on empty + populated store,
   validateConfig rejects bad knobs).
3. Run: npm run check
4. VERIFY: typecheck + lint pass.
5. Run: npm run build
6. VERIFY: build succeeds; dist/ contains updated schema.js + store.js.
7. (Integration) Write a Node script that constructs a MemoryStore against a
   temp SQLite file, calls init(), records 3 metrics, queries the summary, and
   prints the result. VERIFY: the summary aggregates correctly (count=3, sum,
   avg, latest).
```

---

### Story A22.3 — Per-turn delta evaluation (session.idle event-branch PRIMARY trigger [C1 round-2 fix], chat.message assistant branch SECONDARY, classifyIntent, evaluateDelta, isHighSignal, dynamicLimit, brainLoop master switch [C4 fix]) + dynamic recall limit + PluginState additions + lastToolCapture clear-after-evaluateDelta [C2 fix]

**As a** the brain loop **I want** to evaluate each turn's delta and store/
reinforce high-signal memories **so that** the store self-improves from
corrections, repetitions, and preferences without storing generic chat.

**Scope:** `src/plugin.ts` (new `session.idle` delta branch in the `event`
handler [C1 PRIMARY], new `chat.message` assistant branch [C1 SECONDARY/
best-effort, double-fire-guarded], user-branch dynamicLimit + PluginState
additions + system.transform `lastInjectedMemoryIds` update + per-turn
state resets [C2 fix: `lastToolCapture` NOT cleared in user branch]),
new `src/brain-loop.ts` (pure functions: `classifyIntent`, `isHighSignal`,
`dynamicLimit`, `evaluateDelta`), `src/types.ts` (Intent type export for
testing).

**PluginState additions (C1 + C2 + C4 fix):**
- `lastUserText: string | null` — set in `chat.message` user branch.
- `lastUserIntent: Intent | null` — set in `chat.message` user branch (after
  classifyIntent, before push). Read by `evaluateDelta` on `session.idle`
  (no re-classification — avoids self-match per C4 fix).
- `recentUserTexts: string[]` — ring buffer, max 5. **Order: classify FIRST
  (check if userText is already in the buffer), THEN push (C4 fix).** "Seen
  twice" means the buffer already held it before this message.
- `lastToolCapture: { tool: string; filePath?: string; command?: string;
  isError: boolean; timestamp: number } | null` — **C2 + C4 fix: declare on
  PluginState.** Set in `tool.execute.after` when it stores a `lesson_learned`
  or `codebase_fact`. Read by `classifyIntent` (tool_outcome branch, passed as
  a parameter) in the NEXT user branch AND by `evaluateDelta` step 4 (§4.1.5
  tool_outcome content template). **Cleared AFTER `evaluateDelta` completes on
  `session.idle` (§4.1.4 step 8), NOT in the user branch** — round-2 C2 found
  the prior spec cleared it at user-branch start, before classifyIntent,
  making tool_outcome unreachable in production while its unit test passed.
- `lastInjectedMemoryIds: string[] | null` — **C2 fix.** Set in
  `experimental.chat.system.transform` before clearing `pendingInjection`.
  Reset to `null` at the start of the next user message. Read by
  `evaluateDelta` step 7 (recall_hit_rate metric).
- `deltaTurnDone: boolean` — **C1 round-2 fix: double-fire guard.** Set `true`
  by the `chat.message` assistant branch (secondary) when it runs
  `evaluateDelta`; the `session.idle` branch (primary) skips if it's `true`.
  Reset to `false` in the user branch at turn start. In the installed host the
  assistant branch never fires, so this stays `false` and `session.idle`
  always runs the delta loop.

**C1 fix (round 2) — PRIMARY trigger is `session.idle`, NOT `chat.message`
assistant:**
- **Round-2 verification confirmed** (against the installed OpenCode binary):
  `chat.message` fires ONLY for user-message creation — there is no assistant
  trigger, and the round-1 fallback event names (`chat.message.completed`,
  `session.turn.end`) don't exist. `session.idle` is verified-firing and
  already used by the plugin for summarization.
- **PRIMARY:** add a `session.idle` action to the existing `event` handler
  (`plugin.ts:252-376`) that runs `evaluateDelta` (detached, INV-017) BEFORE
  the LLM summarization, gated by `config.brainLoop !== false` (C4 fix). See
  §4.1.1 for the exact code. `evaluateDelta` is called with
  `(store, state, state.lastUserText ?? "", "")` — `assistantText` is `""`
  (session.idle doesn't carry assistant text); the `recall_hit_rate` metric
  records `recall_miss` on empty `assistantText` (correct degradation).
- **SECONDARY (best-effort future-proofing, may be dropped):** an assistant
  branch on `chat.message` (`plugin.ts:452`) wired identically, setting
  `state.deltaTurnDone = true` before running `evaluateDelta`. The
  `session.idle` branch checks `if (state.deltaTurnDone) { state.deltaTurnDone
  = false; return; }` to avoid double-fire. If retained, the guard is
  mandatory; if dropped, `session.idle` alone is sufficient.
- The issue's own `event`-based mapping ("monitor turn completion and trigger
  post-turn update") is now the plan's PRIMARY path (the plan follows the
  issue, not a speculative hook).

**C2 fix — lastToolCapture clear ordering:**
- The user branch does NOT clear `lastToolCapture` (only clears
  `lastInjectedMemoryIds` + `deltaTurnDone`). `classifyIntent` reads
  `lastToolCapture` (still set from the prior turn's `tool.execute.after`).
  `evaluateDelta` (on `session.idle`) renders the §4.1.5 tool_outcome
  template from `state.lastToolCapture`, stores, and the caller clears
  `lastToolCapture = null` AFTER `evaluateDelta` completes (§4.1.4 step 8).
  This ordering is load-bearing — the unit test alone (which injects
  `lastToolCapture` directly into `classifyIntent`) cannot catch a
  misordering; an integration test is required (see acceptance criteria).

**C4 fix — brainLoop master switch consumer:**
- The `session.idle` delta branch checks `if (state.config.brainLoop ===
  false) return;` BEFORE `classifyIntent`/`evaluateDelta` (§4.1.1). This is
  the wired consumer for the `brainLoop` knob declared in A22.2. When
  `false`, no delta memories are stored, no delta metrics recorded — v0.3.0
  behavior (the user-branch `dynamicLimit`/classification is part of the same
  #22 path and is gated by the same switch via the user branch's own
  `brainLoop` check).

**`classifyIntent` order (C4 fix):** called from the `chat.message` user branch
with `(currentUserText, "", state.recentUserTexts, state.lastToolCapture)` —
`recentUserTexts` does NOT include `currentUserText` (push happens AFTER
classification). Repetition = `currentUserText` (normalized) is already in
`recentUserTexts` (prior messages). If `recentUserTexts` is empty, no
repetition is possible. `lastToolCapture` is the PRIOR turn's tool capture
(still set — C2 fix: not cleared in the user branch).

**`evaluateDelta` null handling (C4 fix):** if `state.lastUserText` is `null`
(first message of session, or a missed user hook) → return early without
storing. If `state.lastUserIntent` is `null` → return early (safety net).

**Content templates (C3 fix):** use the exact literal templates from §4.1.5
for each intent class. A Worker builds these with zero interpretation. The
`tool_outcome` template reads `state.lastToolCapture` (still set at
`evaluateDelta` time per C2 fix).

- Add `src/brain-loop.ts` with pure exported functions:
  - `classifyIntent(userText, assistantText, recentUserTexts, lastToolCapture): Intent`
  - `isHighSignal(intent): boolean`
  - `dynamicLimit(intent): number`
  - `evaluateDelta(store, state, userText, assistantText): Promise<void>` —
    runs the §4.1.4 algorithm (null guard → read lastUserIntent → isHighSignal
    gate → store with C3 content template → maybeRelate (in A22.4, no-op stub
    for now) → record metrics). For A22.3, `maybeRelate` is a no-op stub
    (wired in A22.4); metrics recording calls `store.recordMetric` (available
    from A22.2). **Does NOT clear `lastToolCapture`** — the caller
    (`session.idle` event branch) clears it after `evaluateDelta` resolves
    (§4.1.4 step 8, C2 fix).
- Modify `chat.message` user branch: extract user text → **reset per-turn
  state** (`lastInjectedMemoryIds = null`, `deltaTurnDone = false` — **C2
  fix: do NOT clear `lastToolCapture` here**) → `classifyIntent(currentUserText,
  "", recentUserTexts, lastToolCapture)` (BEFORE push, reads prior turn's
  `lastToolCapture`) → `dynamicLimit(intent)` for the recall `limit`
  (replaces fixed `3` at `plugin.ts:470`) → push `currentUserText` to
  `recentUserTexts` (ring buffer, AFTER classify) → set `lastUserText =
  currentUserText` → set `lastUserIntent = intent`. Gate the classification
  + dynamicLimit work on `config.brainLoop !== false` (C4 fix — when disabled,
  use fixed `limit: 3` and skip classify).
- Modify `experimental.chat.system.transform` (C2 fix): before clearing
  `pendingInjection`, set `state.lastInjectedMemoryIds` (see §4.1.6).
- Add `session.idle` delta branch to the `event` handler (§4.1.1 — PRIMARY
  trigger, C1 round-2 fix): gated by `config.brainLoop !== false` (C4 fix),
  detached `evaluateDelta`, clears `lastToolCapture` after (C2 fix). Runs
  BEFORE the LLM summarization.
- Add `chat.message` assistant branch (§4.1.1 — SECONDARY/best-effort, C1
  round-2 fix): detached `evaluateDelta`, sets `deltaTurnDone = true` before
  running (double-fire guard). May be dropped by the Worker (session.idle
  alone is sufficient).

**Acceptance criteria:**

- [ ] `classifyIntent("no, use postgres not mysql", "", [], null)` returns
  `"correction"`.
- [ ] `classifyIntent("always run tests before committing", "", [], null)`
  returns `"preference"`.
- [ ] `classifyIntent("the save button is broken", "", ["the save button is
  broken"], null)` returns `"repetition"` — **the buffer holds a PRIOR sighting
  of this query (classify-first-then-push semantics, C4 fix); the current
  message is the repeat.**
- [ ] `classifyIntent("the save button is broken", "", [], null)` does NOT
  return `"repetition"` — buffer empty, no prior sighting (falls through to
  `generic` or another intent).
- [ ] `classifyIntent("hello, how are you?", "", [], null)` returns `"generic"`.
- [ ] `classifyIntent("thanks", "", [], { tool: "bash", command: "npm test",
  isError: false, timestamp: 0 })` returns `"tool_outcome"` (lastToolCapture
  is set; no correction/repetition/preference keywords).
- [ ] `isHighSignal("correction")` / `"repetition"` / `"preference"` /
  `"tool_outcome"` → `true`; `isHighSignal("generic")` → `false`.
- [ ] `dynamicLimit("correction")` → 5; `dynamicLimit("generic")` → 3.
- [ ] `evaluateDelta` with a high-signal intent calls `store.store()` exactly
  once with `concise: true`, `scope: "project"`, and the correct `type` per
  intent. `evaluateDelta` with `generic` intent does NOT call `store.store()`.
- [ ] **`evaluateDelta` with `state.lastUserText = null` returns without calling
  `store.store()` (C4 fix — first message of session or missed user hook).**
- [ ] **`evaluateDelta` with `state.lastUserIntent = null` returns without
  calling `store.store()` (C4 fix — safety net).**
- [ ] **Content templates (C3 fix):** `evaluateDelta` with intent=`correction`
  and `userText = "no, use postgres not mysql"` stores content =
  `"User corrected the agent: no, use postgres not mysql"`. With intent=
  `preference` and `userText = "always run tests"` stores content =
  `"User preference: always run tests"`. A test asserts the stored content
  equals the template output for a given input (no interpretation).
- [ ] The `chat.message` user branch still recalls for generic intent with
  `limit: 3` (no regression); for `correction`/`preference` it recalls with
  `limit: 5`.
- [ ] **C1 fix (round 2):** the `session.idle` event branch (PRIMARY trigger)
  runs `evaluateDelta` on a detached promise (INV-017) — a test that makes
  `store.store()` throw verifies the handler does not reject and the error is
  logged via `log()`. The `chat.message` assistant branch (SECONDARY) is either
  absent or double-fire-guarded (`deltaTurnDone` flag).
- [ ] **C2 fix:** `experimental.chat.system.transform` sets
  `state.lastInjectedMemoryIds` before clearing `pendingInjection`; a test
  asserts `lastInjectedMemoryIds` is non-null after delivery + null on the next
  user message.
- [ ] **C2 fix:** `evaluateDelta` records `recall_hit` when
  `state.lastInjectedMemoryIds` is non-null AND the assistant's response
  references a token from one of those memories; records `recall_miss` when
  `lastInjectedMemoryIds` is non-null AND the response doesn't reference them;
  records nothing when `lastInjectedMemoryIds` is null (no injection this turn).
  **A test asserts `recall_hit` is recorded on a turn where an injection was
  actually delivered — this test would FAIL against the old `pendingInjection`
  spec (which is always null at assistant time).** On the `session.idle`
  primary trigger, `assistantText` is `""` so the metric records `recall_miss`
  (correct degradation — no text to match); the `recall_hit` test fires the
  secondary `chat.message` assistant branch with real assistant text OR uses a
  test harness that injects `assistantText` directly into `evaluateDelta`.
- [ ] **C2 fix (lastToolCapture ordering — integration test, NOT just a unit
  test):** an integration test fires `tool.execute.after` (e.g. a bash error
  capturing a `lesson_learned`) → fires the next `chat.message` user message
  ("thanks") → fires `session.idle` → asserts a `tool_outcome` memory was
  stored with the §4.1.5 template content (`"Tool outcome (bash): error — …"`)
  AND that `state.lastToolCapture` is `null` after `evaluateDelta` completes.
  **This test FAILS against the prior spec** (which cleared
  `lastToolCapture` at user-branch start, before `classifyIntent`, so
  `tool_outcome` never fired in production). The unit test alone (injecting
  `lastToolCapture` into `classifyIntent` directly) cannot catch this — the
  integration test is mandatory.
- [ ] **C4 fix (brainLoop master switch):** with `config.brainLoop: false`,
  firing `session.idle` stores nothing and records no delta metrics (the whole
  #22 per-turn delta path is skipped — v0.3.0 behavior). A test asserts no
  memory is stored and no metric recorded when `brainLoop: false`.
- [ ] `npm run check` passes. `npm test` passes (existing + new
  `tests/brain-loop.test.ts` + `tests/plugin-brain-loop.test.ts`).

**Experience Script (§3a):**

```
1. Run: npm test -- tests/brain-loop.test.ts tests/plugin-brain-loop.test.ts
2. VERIFY: all tests pass (classifyIntent keyword coverage + tool_outcome via
   lastToolCapture, isHighSignal truth table, dynamicLimit, evaluateDelta
   stores on high-signal / skips on generic / skips on null lastUserText,
   content templates match exactly, session.idle branch detached + error-safe
   [C1 PRIMARY trigger], user-branch dynamicLimit + classify-before-push,
   lastInjectedMemoryIds set on delivery + cleared on next user message,
   recall_hit recorded on injected turn, tool_outcome integration test fires
   end-to-end [C2 fix], brainLoop:false stores nothing [C4 fix]).
3. Run: npm run check
4. VERIFY: typecheck + lint pass.
5. (Integration — C1 PRIMARY trigger) Write a Node script that imports the
   plugin default export, constructs a fake OpenCodePluginContext, fires a
   `chat.message` with role:"user" + parts:[{type:"text", text:"no, use
   postgres not mysql"}] (user branch stashes lastUserText + lastUserIntent),
   then fires an `event` with type:"session.idle" (the PRIMARY delta-loop
   trigger). After a tick, query the MemoryStore for lesson_learned memories
   with tag "correction". VERIFY: exactly one memory was stored with content
   = "User corrected the agent: no, use postgres not mysql" (C3 template),
   concise (<=280 chars), scope:"project". VERIFY: state.lastToolCapture is
   null after evaluateDelta completed (C2 fix — cleared after use).
6. Fire a second user message "hello" + event session.idle. After a tick,
   query the store. VERIFY: no new memory was stored (generic intent, skipped).
7. (C2 fix — tool_outcome integration test) Fire `tool.execute.after` that
   stores a lesson_learned (bash error) — this sets state.lastToolCapture.
   Fire the next `chat.message` role:"user" with text "thanks" (classifyIntent
   reads lastToolCapture → tool_outcome). Fire `event` session.idle
   (evaluateDelta renders the §4.1.5 tool_outcome template). After a tick,
   query the store. VERIFY: a tool_outcome memory was stored with content
   starting "Tool outcome (bash): error — …" (C3 template). VERIFY:
   state.lastToolCapture is null after evaluateDelta completed. This test
   FAILS against the prior spec (which cleared lastToolCapture before
   classifyIntent — tool_outcome never fired in production).
8. (C4 fix — brainLoop master switch) Set config.brainLoop: false. Fire a
   user message "no, use postgres" + event session.idle. After a tick, query
   the store. VERIFY: no new memory was stored, no delta metric recorded
   (the whole #22 per-turn delta path is skipped — v0.3.0 behavior). Set
   config.brainLoop: true (default) and re-fire; VERIFY: the memory IS
   stored.
9. (Live-host verification — C1 fix) In a real OpenCode host (or by reading
   the OpenCode plugin API source for the version in use), VERIFY that
   `session.idle` fires after the assistant responds (the plugin already
   uses it for summarization — this is known to work). RECORD: the event
   payload shape. This step confirms the PRIMARY trigger fires in the real
   host — the fake-context integration script (step 5) cannot prove the real
   host fires it, but session.idle is verified-firing today (used by the
   existing summarization path).
```

---

### Story A22.4 — Auto-relate (maybeRelate on store/reinforce, capped)

**As a** the brain loop **I want** new/reinforced memories to automatically
link to semantically similar existing memories **so that** the graph self-
organizes without manual `relate()` calls.

**Scope:** `src/store.ts` (new `maybeRelate` method), `src/plugin.ts` (wire
`maybeRelate` into `evaluateDelta` + `tool.execute.after` auto-capture paths,
gated by `config.autoRelate`).

- Add `MemoryStore.maybeRelate(memoryId, content, type): Promise<number>` (§4.2):
  - Recall top `maxRelatedPerMemory` (default 3) candidates matching `content`,
    `scope: "all"`, excluding `memoryId`.
  - For each candidate above the recall threshold: determine edge type
    (`extends` default; `derived_from` if new is `lesson_learned` and candidate
    is `user_preference`/`task_pattern`; `reinforces` if same type) → call
    `this.relate(memoryId, candidate.id, edgeType)` → catch
    `DuplicateRelationshipError` / `MemoryNotFoundError` silently.
  - Return count of edges created. Cap at `maxRelatedPerMemory`.
- Wire `evaluateDelta` (A22.3): after `store.store()`, if `config.autoRelate`,
  call `store.maybeRelate(stored.id, stored.content, stored.type)`.
- Wire `tool.execute.after` auto-capture (existing): after `store.store()`, if
  `config.autoRelate`, call `store.maybeRelate(...)`.
- The MCP `store_memory` path does NOT auto-relate (explicit `relationships` in
  `StoreInput` is the manual path).

**Acceptance criteria:**

- [ ] `maybeRelate` on a store with no similar memories creates 0 edges and
  returns 0.
- [ ] `maybeRelate` on a store with 5 similar memories creates at most
  `maxRelatedPerMemory` (3) edges, returns ≤ 3.
- [ ] `maybeRelate` never creates a self-relationship (the source memory is
  excluded from candidates — INV-007).
- [ ] Calling `maybeRelate` twice on the same memory (e.g. after a reinforce)
  does not create duplicate edges (catches `DuplicateRelationshipError` —
  INV-008 idempotent).
- [ ] Edge type selection: a `lesson_learned` stored against an existing
  `user_preference` creates a `derived_from` edge; two `user_preference`
  memories create a `reinforces` edge; default is `extends`.
- [ ] With `config.autoRelate: false`, `evaluateDelta` and `tool.execute.after`
  do NOT call `maybeRelate` (auto-relate disabled).
- [ ] The MCP `store_memory` tool does NOT auto-relate (explicit
  `relationships` only) — a test stores a memory via the MCP handler and
  asserts no auto-edges were created.
- [ ] `npm run check` passes. `npm test` passes (existing + new
  `tests/store-maybe-relate.test.ts`).

**Experience Script (§3a):**

```
1. Run: npm test -- tests/store-maybe-relate.test.ts
2. VERIFY: all tests pass (no-similar → 0 edges, 5-similar → capped at 3, no
   self-edges, idempotent on re-call, edge-type selection, autoRelate:false
   disables, MCP store_memory does not auto-relate).
3. Run: npm run check
4. VERIFY: typecheck + lint pass.
5. (Integration) Using the plugin from A22.3's integration script: pre-seed the
   store with a user_preference "always run tests before committing" (via
   store.store). Fire a chat.message user "no, run lint before committing"
   (user branch stashes lastUserText + lastUserIntent=correction) + event
   session.idle (C1 PRIMARY trigger runs evaluateDelta → stores the correction).
   After a tick, query the new lesson_learned memory's relationships. VERIFY:
   a `derived_from` edge links it to the user_preference memory (auto-relate
   created it).
```

---

### Story A22.5 — experimental.session.compacting hygiene hook + conciseness enforcement in store()

**As a** the brain loop **I want** memory hygiene to run on context compaction
and auto-stored memories to be concise **so that** the store doesn't bloat with
verbose or stale entries.

**Scope:** `src/plugin.ts` (new `experimental.session.compacting` handler — or
`event` branch if it's an Event, Worker verifies), `src/store.ts` (new
`dedupPass` method + `concise` truncation in `store()`), `src/types.ts` (new
`concise?: boolean` on `StoreInput`).

- **Worker verification step:** confirm `experimental.session.compacting` is a
  hook (like `experimental.chat.system.transform`) or an Event (like
  `session.created`). Wire accordingly. If it's neither (doesn't exist in the
  OpenCode version in use), log to `PARKING_LOT.md` and skip the hook — the
  `dedupPass` + conciseness still ship (they're valuable independently); the
  hygiene trigger falls back to the existing `session.created` decay scheduling.
- Add `MemoryStore.dedupPass(): Promise<number>` — scans active memories
  (capped at 1000, `ORDER BY updated_at DESC`), finds near-duplicate pairs via
  the existing `findDuplicate` logic, merges (reinforces higher-weight +
  archives lower-weight). Returns count of merges. Bounded scan.
- Add `concise?: boolean` to `StoreInput` in `src/types.ts`.
- In `store()` step 3 (after `scrubSecrets`, before `findDuplicate`): if
  `input.concise === true`, truncate content to `config.concisenessCap` (default
  280) at the last word boundary, append "…".
- Wire `tool.execute.after` + `evaluateDelta` + `session.idle` auto-summarize
  to pass `concise: true` on their `store()` calls. The MCP `store_memory`
  handler does NOT set `concise`.
- Add the `experimental.session.compacting` handler (§4.4): detached
  `maybeDecay("decay:compacting", compactingIntervalHours)` + `dedupPass()` +
  `decay()` (if maybeDecay skipped) + `recordMetric("memory_bloat_ratio",
  getBloatRatio())`.

**Acceptance criteria:**

- [ ] `store({ content: "a".repeat(500), type: "lesson_learned", concise: true })`
  stores content of length ≤ 280 (truncated at the last word boundary + "…").
- [ ] `store({ content: "short", type: "lesson_learned", concise: true })` does
  NOT truncate (content under the cap).
- [ ] `store({ content: "a".repeat(500), type: "lesson_learned" })` (no
  `concise`) stores the full 500-char content (explicit stores are not
  truncated).
- [ ] The MCP `store_memory` tool stores full content (does not set `concise`).
- [ ] `dedupPass()` on a store with 2 near-duplicate active memories merges
  them (reinforces the higher-weight one, archives the lower-weight one) and
  returns 1. On a store with no duplicates, returns 0 and archives nothing.
- [ ] `dedupPass()` scans at most 1000 active memories (bounded — a test with
  1500 memories asserts only the 1000 most-recently-touched are scanned).
- [ ] The compacting handler runs on a detached promise (INV-017) — a test that
  makes `dedupPass()` throw verifies the handler does not reject.
- [ ] The compacting handler's `maybeDecay` uses the `decay:compacting` meta
  key (separate from `session.created`'s `decay:lastRun`) — a test asserts the
  two rate-limiters are independent.
- [ ] `npm run check` passes. `npm test` passes (existing + new
  `tests/store-conciseness.test.ts` + `tests/store-dedup-pass.test.ts` +
  `tests/plugin-compacting.test.ts`).

**Experience Script (§3a):**

```
1. Run: npm test -- tests/store-conciseness.test.ts tests/store-dedup-pass.test.ts
   tests/plugin-compacting.test.ts
2. VERIFY: all tests pass (truncation with concise:true, no truncation without,
   MCP store_memory full content, dedupPass merges duplicates + bounded scan,
   compacting handler detached + error-safe + independent decay keys).
3. Run: npm run check
4. VERIFY: typecheck + lint pass.
5. (Integration) Using the plugin: pre-seed the store with 3 memories, 2 of
   which are near-duplicates (same content, different IDs — insert directly via
   store.store without concise). Fire the compacting hook (or event). After a
   tick, query the store. VERIFY: the 2 near-duplicates were merged (one
   archived, one reinforced with reinforcementCount incremented); the 3rd
   unrelated memory is unchanged; a memory_bloat_ratio metric row was recorded.
6. (Conciseness) Fire a chat.message user "no, use postgres not mysql" +
   event session.idle (C1 PRIMARY trigger → evaluateDelta stores the
   correction). Query the stored correction. VERIFY: content is ≤280 chars
   (concise:true was passed by evaluateDelta) AND content matches the C3
   template "User corrected the agent: no, use postgres not mysql".
```

---

### Story A22.6 — Metrics query (MCP tool + /api/metrics endpoint) + version bump + final intent-layer sync

**As a** a maintainer **I want** metrics queryable via MCP + browser, the
version bumped, and the intent layer fully synced **so that** the architecture
is documented, the change is traceable, and the brain loop is observable.

**Scope:** `src/mcp-server.ts` (new `get_metrics` tool), `src/browser/server.ts`
(new `GET /api/metrics` route), `package.json` + `src/mcp-server.ts` (version
bump 0.3.0 → 0.4.0), `/home/royce/mission-control/PROJECTS/realmemory/docs/SYSTEM_MAP.md`
(update Drift Log #1 + module map — C3 fix: absolute workspace path, NOT in
the repo), `/home/royce/mission-control/PROJECTS/realmemory/docs/INVARIANTS.md`
(INV-017 note — C3 fix: absolute workspace path).

- Add `get_metrics` MCP tool to `createMcpTools` (zod schema: optional `name`
  string, optional `since` ISO string; handler calls
  `store.getMetricSummary(name, since)`).
- Add `GET /api/metrics` route to `src/browser/server.ts` (localhost, read-only
  — calls `store.getMetricSummary()`; query params `name` + `since`).
- Bump `package.json` `version` 0.3.0 → 0.4.0; bump `mcp-server.ts`
  `SERVER_VERSION` 0.3.0 → 0.4.0.
- Update `/home/royce/mission-control/PROJECTS/realmemory/docs/SYSTEM_MAP.md`
  (C5 fix final sync; C3 fix: absolute workspace path): Drift Log #1 →
  resolved by ADR-008; note the new `metrics` table, `maybeRelate`,
  `dedupPass`, `evaluateDelta`, compacting hook in the module map + data
  flow. (The Cartographer re-maps post-merge; the Worker's edits are the
  interim update.)
- Update `/home/royce/mission-control/PROJECTS/realmemory/docs/INVARIANTS.md`
  (C3 fix: absolute workspace path): add a note to INV-017 that
  `evaluateDelta` + compacting hook are covered by it.
- Integration test: end-to-end brain loop — user message (`chat.message`
  role:"user") → recall → `event` session.idle (C1 PRIMARY trigger) →
  evaluateDelta → store → maybeRelate → metrics recorded → queryable via
  `get_metrics` MCP tool + `GET /api/metrics`.

**Acceptance criteria:**

- [ ] The MCP `tools/list` response includes `get_metrics`; calling it returns
  JSON with metric summaries.
- [ ] `GET http://127.0.0.1:9333/api/metrics` returns JSON; non-GET (POST/PUT/
  DELETE) returns 405 (INV-013 read-only preserved).
- [ ] `package.json` version is 0.4.0; `mcp-server.ts` SERVER_VERSION is
  "0.4.0".
- [ ] `/home/royce/mission-control/PROJECTS/realmemory/docs/SYSTEM_MAP.md`
  Drift Log #1 is marked resolved; the module map + data flow note the new
  surface (metrics table, maybeRelate, dedupPass, evaluateDelta, compacting
  hook). (C3 fix: absolute workspace path — NOT in the repo, NOT reverted by
  git revert.)
- [ ] `/home/royce/mission-control/PROJECTS/realmemory/docs/INVARIANTS.md`
  INV-017 note covers `evaluateDelta` + compacting. (C3 fix: absolute workspace
  path.)
- [ ] End-to-end integration test passes: fire user message (`chat.message`
  role:"user") + `event` session.idle (C1 PRIMARY trigger) → verify a memory
  stored, an auto-relate edge created, metrics recorded → query `get_metrics`
  → verify the metric appears → query `/api/metrics` → verify the same.
- [ ] **E2E recall_hit assertion (C2 fix):** the E2E test includes a turn where
  a memory is injected (recalled + delivered via system.transform) and the
  assistant's response references a token from that memory — VERIFY a
  `recall_hit` metric row is recorded (not `recall_miss`). This test would
  fail against the old `pendingInjection`-based spec.
- [ ] `npm run check` passes. `npm test` passes (existing + new
  `tests/mcp-metrics.test.ts` + `tests/browser-metrics.test.ts` +
  `tests/brain-loop-e2e.test.ts`). Total test count increases from 404.

**Experience Script (§3a):**

```
1. Run: npm test
2. VERIFY: all tests pass (existing 404 + new metrics/E2E tests; pre-existing
   5 EADDRINUSE environmental tests remain unaffected).
3. Run: npm run check
4. VERIFY: typecheck + lint pass.
5. Run: npm run build
6. VERIFY: build succeeds; dist/ contains updated code.
7. (MCP integration) Start the MCP server (node dist/bin.js). Send a
   tools/list request over stdio. VERIFY: the response includes "get_metrics".
   Send a tools/call for get_metrics with no args. VERIFY: the response is JSON
   (possibly empty if no metrics recorded yet, but well-formed).
8. (Browser integration) With the server running, curl
   http://127.0.0.1:9333/api/metrics. VERIFY: 200 + JSON body. curl -X POST
   http://127.0.0.1:9333/api/metrics. VERIFY: 405 Method Not Allowed (read-only
   preserved).
9. (E2E) Using the plugin: fire a chat.message user "always run tests before
   committing" (user branch stashes lastUserText + lastUserIntent=preference)
   + event session.idle (C1 PRIMARY trigger runs evaluateDelta). Fire a
   chat.message user "no, run lint before committing" + event session.idle.
   After a tick:
   - Query the store for lesson_learned memories with tag "correction".
     VERIFY: one memory stored, content = "User corrected the agent: no, run
     lint before committing" (C3 template), concise (≤280 chars), scope:"project".
   - Query that memory's relationships. VERIFY: a `derived_from` (or
     `reinforces`) edge links it to the user_preference memory from the first
     turn (auto-relate).
   - Call get_metrics. VERIFY: a recall_hit_rate or correction_retention metric
     row exists (the brain loop recorded it).
   - curl /api/metrics. VERIFY: the same metric appears in the JSON response.
10. (E2E recall_hit — C2 fix) Fire a user message that triggers recall (a
    message matching an existing memory). VERIFY: system.transform delivers the
    memory (pendingInjection → output.system) AND lastInjectedMemoryIds is set.
    Fire event session.idle (evaluateDelta runs; on session.idle the
    assistantText is "" so the metric records recall_miss by default). To test
    recall_HIT, use a test harness that calls evaluateDelta directly with a
    non-empty assistantText referencing a token from the injected memory, OR
    fire the chat.message assistant branch (secondary trigger) with real
    assistant text. After a tick, call get_metrics. VERIFY: a recall_hit metric
    row was recorded (NOT recall_miss — this is the test that would fail against
    the old broken pendingInjection spec).
11. (Intent layer — C3 fix: absolute workspace paths) Read
    /home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md. VERIFY:
    ADR-008 row present (from A22.1), Drift #1 marked resolved. Read
    /home/royce/mission-control/PROJECTS/realmemory/docs/SYSTEM_MAP.md. VERIFY:
    Drift #1 marked resolved, module map mentions metrics/maybeRelate/
    dedupPass/evaluateDelta/compacting. Read
    /home/royce/mission-control/PROJECTS/realmemory/docs/INVARIANTS.md. VERIFY:
    INV-017 note covers evaluateDelta + compacting.
```

---

## 10. Test & Verification Plan

- **Automated:** vitest, `environment: "node"`, `pool: "forks"`, `singleFork:
  true` (existing config). New test files:
  - `tests/schema.test.ts` (extend existing) — v3→v4 migration, idempotent
    re-run, `metrics` table + indexes present.
  - `tests/store-metrics.test.ts` — `recordMetric` / `getMetricSummary` /
    `getBloatRatio` round-trip + aggregation + filtering.
  - `tests/brain-loop.test.ts` — `classifyIntent` keyword coverage (including
    `tool_outcome` via `lastToolCapture` parameter — C4 fix),
    `isHighSignal` truth table, `dynamicLimit`, `evaluateDelta` stores on
    high-signal / skips on generic / **skips on null lastUserText** (C4 fix),
    **content templates match exactly per C3 fix**.
  - `tests/plugin-brain-loop.test.ts` — **session.idle event branch detached
    (INV-017) + error-safe [C1 PRIMARY trigger]**; chat.message assistant
    branch double-fire-guarded [C1 SECONDARY] or absent; user-branch
    `dynamicLimit` + **classify-before-push order** (C4 fix);
    `lastUserText` + `lastUserIntent` + `recentUserTexts` ring buffer;
    **`lastInjectedMemoryIds` set on delivery + cleared on next user message**
    (C2 fix); **`recall_hit` recorded on injected turn** (C2 fix — test that
    would fail against old `pendingInjection` spec); **`tool_outcome`
    integration test: tool.execute.after → next user message → session.idle →
    tool_outcome memory stored + lastToolCapture cleared after evaluateDelta**
    (C2 fix — test that fails against the prior clear-before-classify order);
    **`brainLoop:false` stores nothing + records no metrics** (C4 fix).
  - `tests/store-maybe-relate.test.ts` — caps, idempotency, no self-edges,
    edge-type selection, `autoRelate:false` disables, MCP `store_memory` does
    not auto-relate.
  - `tests/store-conciseness.test.ts` — truncation with `concise:true`, no
    truncation without, MCP `store_memory` full content, truncation + dedup
    interaction.
  - `tests/store-dedup-pass.test.ts` — merges near-duplicates, bounded scan
    (1000), no-op on no duplicates.
  - `tests/plugin-compacting.test.ts` — compacting handler detached +
    error-safe, independent `decay:compacting` meta key, bloat metric recorded.
  - `tests/mcp-metrics.test.ts` — `get_metrics` tool listed + callable, zod
    schema validates `name` + `since`.
  - `tests/browser-metrics.test.ts` — `GET /api/metrics` returns JSON, non-GET
    returns 405.
  - `tests/brain-loop-e2e.test.ts` — end-to-end: user message + event
    `session.idle` [C1 PRIMARY trigger] → memory stored + auto-relate edge +
    metric recorded → queryable via MCP + browser. **Includes the C2 fix
    recall_hit assertion: a turn with injection + assistant response
    referencing the injected memory → `recall_hit` recorded.** **Includes the
    C2 fix tool_outcome integration assertion: tool.execute.after → next user
    message → session.idle → tool_outcome memory stored.** **Includes the C4
    fix brainLoop assertion: `brainLoop:false` stores nothing.**
- **Experience:** the §9 per-story Experience Scripts (each is a CLI + Node-
  script walkthrough the Experience Runner drives). The E2E script (A22.6 §3a
  steps 9–10) is the full brain-loop drive-through — it must return PASS before
  A22.6 clears the build loop. **A22.3 §3a step 9 is the live-host firing
  verification (C1 fix — round 2)** — the Experience Runner must confirm the
  real host fires `session.idle` after the assistant responds (known-firing —
  the plugin already uses it for summarization) before A22.3 clears.
- **Regression:** existing 404 tests must pass unchanged (they don't set
  `concise`, don't fire `session.idle` for the delta loop, don't call
  `maybeRelate`/`dedupPass`/`recordMetric`, don't reference
  `lastInjectedMemoryIds`). The 5 pre-existing EADDRINUSE environmental tests
  remain unaffected. `npm run check` (typecheck + lint) guards INV-015 (public
  API stability — the new `concise?: boolean` field must not break existing
  callers).
- **Manual:** Royce confirms the intent-layer updates (ADR-008 reads correctly,
  DECISIONS.md + SYSTEM_MAP.md + INVARIANTS.md reflect the change) and the
  end-to-end brain-loop behavior (corrections are stored concisely, auto-relate
  edges form, metrics are queryable). In autonomous mode, the Product Owner
  Proxy may waive Royce's manual re-drive per its human-only rules — but never
  waives the Experience Runner pass on the E2E script.

---

## 11. Rollback Plan

Filled before execution so reverting never requires archaeology:

- **Branch:** `issue/22-brain-loop` — all commits reference `#22`
- **Merge:** single squash merge per PR; SHA recorded in the issue Tracking
  table. Tag `issue-22` (and `v0.4.0` for the release).
- **Revert:** `git revert <squash SHA>` — single revert commit per PR (6 PRs
  for 6 stories). Source returns to the pre-#22 state (v0.3.0 behavior).
- **Migrations:** **none required for revert.** SCHEMA_V4 is additive
  (`CREATE TABLE IF NOT EXISTS metrics`) — the `metrics` table remains in the
  DB file after revert but is unused (no code references it). Dropping it is
  safe (`DROP TABLE IF EXISTS metrics`) but not required — a revert does not
  need to touch the DB. The `schema_version` row for v4 remains recorded; the
  next post-revert init skips v4 (it's already applied) — no error.
- **Version:** after revert, `package.json` version returns to 0.3.0 (the
  revert restores the file). If a `v0.4.0` tag was published to npm, a
  `v0.4.1` revert-release tag is cut per ADR-004 (pre-1.0 semver — a revert is
  a MINOR bump documenting the rollback). Coordinate with the deploy skill.
- **Intent layer (C3 fix — these files are NOT in the repo, NOT in any PR,
  and NOT reverted by `git revert`):** the ADR-008 file
  (`/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md`),
  DECISIONS.md, SYSTEM_MAP.md, and INVARIANTS.md all live in the unversioned
  workspace (`PROJECTS/realmemory/docs/`), NOT in the repo
  (`PROJECTS/realmemory/repo/`). `git revert` does NOT touch them. **Workspace-
  level rollback is a MANUAL edit performed alongside the `git revert`:** remove
  the ADR-008 file, restore the Drift #1 Open Item in DECISIONS.md (mark it
  open again), remove the SYSTEM_MAP.md Drift Log #1 "resolved" marker + the
  metrics/maybeRelate/dedupPass/evaluateDelta/compacting module-map rows, and
  remove the INV-017 evaluateDelta note. If the revert lands after a
  Cartographer re-map picked them up, the next Cartographer run re-detects the
  rollback (the map follows the code). **What IS in the repo and IS reverted
  by `git revert`:** the source under `src/`, `package.json`, and the agile
  workspace at `repo/docs/06-agile/` (this plan, the review reports).
- **Deploy rollback:** per `anymake-deploy` — realmemory is a library
  distributed via npm; the rollback is a `v0.4.1` publish (or a re-tag of
  `latest` to `v0.3.0` if preferred). No runtime deploy (no hosted
  infrastructure).

---

## 12. Review Log

Appended each round — never deleted. Review files live beside this plan.

| Round | Date | Reviewer verdict | Report | Resolution |
|-------|------|------------------|--------|------------|
| 1 | 2026-08-11 | NEEDS CHANGES | `review-round-1.md` | All 6 comments addressed in round 2 (see below). |
| 2 | 2026-08-11 | NEEDS CHANGES | `review-round-2.md` | All 4 comments addressed in round 3 (see below). |

**Round 1 comment resolutions:**

| Comment | Resolution |
|---------|-----------|
| [1]-C1 (chat.message assistant firing unverified) | **fixed in §4.1.1 + §9 A22.3.** Added explicit Worker verification step (confirm chat.message fires for assistant messages from OpenCode plugin API source/docs). Named two fallback triggers: (1) turn-completion `event` branch on the existing `event` handler at `plugin.ts:255` (aligns with issue's own `event` mapping), (2) `session.idle` degradation (verified-firing hook, coarser). Discussed issue's `event`-based mapping and rationale for preferring `chat.message` (per-turn granularity). A22.3 §3a step 7 adds a live-host verification smoke step the Experience Runner must pass (not just fake-context). |
| [1]-C2 (recall_hit_rate reads cleared state) | **fixed in §4.1.2 + §4.1.4 step 7 + §4.1.6 + §9 A22.3.** Introduced `PluginState.lastInjectedMemoryIds: string[] \| null` — set in `experimental.chat.system.transform` BEFORE clearing `pendingInjection` (plugin.ts:509), reset to `null` at the start of the next user message. The hit-rate metric reads `lastInjectedMemoryIds` (not `pendingInjection` which is always null at assistant time). A22.3 criteria + A22.6 E2E §3a step 10 assert `recall_hit` is recorded on a turn where injection was actually delivered — a test that would fail against the old spec. |
| [1]-C3 (delta content derivation unspecified) | **fixed in §4.1.5 + §9 A22.3.** Added a literal content-template table per intent class with exact string templates, slice limits, type, scope, confidence, tags, and metadata. `correction` → `"User corrected the agent: " + userText.slice(0, 200)`; `repetition` → `"Repeated request: " + userText.slice(0, 200)`; `preference` → `"User preference: " + userText.slice(0, 200)`; `tool_outcome` → template from `lastToolCapture` fields. A22.3 criteria assert the stored content equals the template output for a given input (no interpretation). |
| [1]-C4 (PluginState contract incomplete) | **fixed in §4.1.2 + §4.1.3 + §4.1.4 + §9 A22.3.** (a) Declared `lastToolCapture: { tool, filePath?, command?, isError, timestamp } \| null` on PluginState — set in `tool.execute.after`, cleared at next user message, passed as a parameter to `classifyIntent`. (b) Renamed `recentQueries` → `recentUserTexts`; pinned order as classify-first-then-push (repetition = buffer already held it before this message). (c) Rewrote acceptance criteria to match: `classifyIntent("X", "", ["X"], null)` → `"repetition"` (prior sighting); `classifyIntent("X", "", [], null)` → not repetition (buffer empty). (d) Added null-lastUserText guard: `evaluateDelta` returns early when `state.lastUserText` is `null` or `state.lastUserIntent` is `null`. Added `lastUserIntent` to PluginState (set by user branch, read by evaluateDelta — avoids re-classification self-match). |
| [1]-C5 (ADR-008 doesn't cover Drift #1 full surface) | **fixed in §4.5 + §6 + §9 A22.1.** Expanded ADR-008 content to cover Drift #1's full surface: (f) plugin role (`src/plugin.ts` is OpenCode-only glue, not part of the npm library public API), (g) public/private boundary (`src/store.ts` + `src/types.ts` + `src/config.ts` are the public library API), (h) config-surface question (`MemoryStoreConfig` knobs are a stable public config surface, additive with defaults), (i) INV-017 contract ratification. Drift #1 is now fully resolved by ADR-008 (not partially). §6 and A22.1 criteria honestly reflect the full resolution. |
| [1]-C6 (story order ships hooks/config before ADR) | **fixed in §9.** Reordered to 6 stories: **A22.1 = ADR-008 + DECISIONS.md + PARKING_LOT (pure docs, intent authorization first)**, then A22.2 (schema + metrics + config knobs — ADR exists), A22.3 (delta loop + assistant hook — ADR exists), A22.4 (auto-relate), A22.5 (compacting hook + conciseness — ADR exists), A22.6 (MCP + browser + version + intent-layer sync). The ADR lands before any story that adds a hook or config knob. The old A22.5's ADR/intent-layer content is split: ADR + DECISIONS.md → A22.1; SYSTEM_MAP.md + INVARIANTS.md → A22.6 (after code is built). |

**Round 2 comment resolutions:**

| Comment | Resolution |
|---------|-----------|
| [2]-C1 (chat.message verified dead for assistant; promote event-branch to primary) | **fixed in §4.1.1 + §3 (Flows + key anchors) + §8 (blast radius) + §9 A22.3 (scope, criteria, §3a) + §9 A22.6 (E2E) + §10.** Promoted the `session.idle` event branch in the existing `event` handler (`plugin.ts:252-376`) to the PRIMARY delta-loop trigger — runs `evaluateDelta` (detached, INV-017) BEFORE the LLM summarization. Recorded the round-2 evidence (the installed binary has exactly one `chat.message` trigger site — user-message creation only; the fallback event names `chat.message.completed`/`session.turn.end` don't exist; `session.idle` is verified-firing). Demoted the `chat.message` assistant branch to SECONDARY/best-effort future-proofing (may be dropped by the Worker), double-fire-guarded via the new `PluginState.deltaTurnDone` flag so the day a future OpenCode fires `chat.message` for assistants there's no double metrics/stores. Added `deltaTurnDone` to PluginState (set by assistant branch, checked + reset by session.idle, reset by user branch). The §3a verification step changed from "verify chat.message fires for assistant" to "verify session.idle fires after assistant response" (known-firing — the plugin uses it for summarization today). Updated A22.3 acceptance criteria + Experience Script (steps 5-9) to fire `event session.idle` instead of `chat.message` assistant. Updated §8 blast radius (session.idle row + brainLoop row). Updated §10 test descriptions. The plan now FOLLOWS the issue's own `event` mapping ("monitor turn completion and trigger post-turn update"), not a speculative hook. |
| [2]-C2 (lastToolCapture set to null BEFORE classifyIntent — temporal bug) | **fixed in §4.1.2 (lastToolCapture doc) + §4.1.4 step 8 (clear after evaluateDelta) + §4.1.6 (user-branch reset — lastToolCapture NOT cleared) + §9 A22.3 (scope, criteria, §3a).** Moved the `lastToolCapture = null` clear to AFTER the delta evaluation completes (after store/update/reinforce/relate) — the `session.idle` event branch clears it after `evaluateDelta` resolves (§4.1.4 step 8, §4.1.1). The user branch does NOT clear `lastToolCapture` (only `lastInjectedMemoryIds` + `deltaTurnDone`). Pinned the ordering explicitly: (1) chat.message user branch fires → (2) classifyIntent reads lastToolCapture (still set from the prior turn's tool.execute.after) → (3) evaluateDelta uses the intent (session.idle) → (4) store/update/reinforce/relate → (5) THEN clear lastToolCapture. Added an A22.3 acceptance criterion + §3a step 7 for an integration test (NOT just a unit test) that fires tool.execute.after (bash error) → next user message → session.idle → asserts a tool_outcome memory was stored with the §4.1.5 template content AND lastToolCapture is null after evaluateDelta. This test FAILS against the prior clear-before-classify order. |
| [2]-C3 (intent-layer files live in workspace, not repo; §11 git revert claim false) | **fixed in §4.5 (ADR-008 path + intent-layer updates) + §9 A22.1 (scope, criteria, §3a) + §9 A22.6 (scope, criteria, §3a) + §11 (Rollback).** Used ABSOLUTE workspace paths everywhere the plan references intent-layer files: `/home/royce/mission-control/PROJECTS/realmemory/docs/adr/ADR-008-brain-loop-behavior.md` (where ADR-001…007 live), `/home/royce/mission-control/PROJECTS/realmemory/docs/DECISIONS.md`, `.../docs/SYSTEM_MAP.md`, `.../docs/INVARIANTS.md`. The ADR-008 file goes in the workspace `docs/adr/`. Stated explicitly these files live OUTSIDE the repo, are NOT in any PR, and are NOT reverted by `git revert`. Updated §11 Rollback: intent-layer updates are a MANUAL workspace-level edit (remove the ADR-008 file, restore the Drift #1 Open Item, remove the added rows) performed alongside `git revert`, NOT by it. Clarified what IS in the repo and IS reverted (source under `src/`, `package.json`, the agile workspace at `repo/docs/06-agile/`). A22.1 criterion clarified: `npm run check` runs in the repo while the edited files are in the workspace. |
| [2]-C4 (brainLoop config knob declared but never consumed) | **fixed in §4.1.1 (event handler gate) + §4.1.4 (trigger note) + §4.5(h) (ADR config-surface) + §9 A22.2 (knob — consumer noted) + §9 A22.3 (consumer wired + criteria) + §8 (blast radius row).** Wired the `brainLoop` knob into the `session.idle` event handler (the new PRIMARY trigger from C1): `if (state.config.brainLoop === false) return;` at the top of the session.idle delta-evaluation branch (before classifyIntent/evaluateDelta, §4.1.1). This is the master switch for the brain loop. Added an A22.3 acceptance criterion: with `brainLoop: false`, firing `session.idle` stores nothing and records no delta metrics (v0.3.0 behavior is the disabled state). The knob goes in A22.2 (config) and is consumed in A22.3 (delta evaluation) — the exact consumer location is the session.idle event branch (`plugin.ts:252-376`). Noted in §8 blast radius that the whole #22 per-turn path (including the user-branch dynamicLimit/classification) is gated by the same switch. |

---

*End of plan — Issue #22, brain-loop completion (per-turn delta evaluation,
auto-relate, metrics, compacting hygiene, conciseness, ADR-008). Classification:
Additive. Six stories (C6 fix: ADR first). Zero new runtime deps. No LLM calls in
the delta loop (local heuristics only — preserves INV-017, avoids Drift #5).
Round-1 C1–C6 fixes: hook firing verified + fallback, lastInjectedMemoryIds for
hit-rate, literal content templates, complete PluginState contract, ADR-008
covers Drift #1 full surface, ADR-first story order. Round-2 C1–C4 fixes:
session.idle promoted to PRIMARY delta-loop trigger (chat.message assistant
demoted to secondary/best-effort, double-fire-guarded); lastToolCapture cleared
AFTER evaluateDelta (not before classifyIntent — temporal bug fixed, integration
test added); intent-layer files use absolute workspace paths + §11 rollback
corrected (manual workspace edit, not git revert); brainLoop knob wired as the
master switch in the session.idle event branch.*
