# Development Plan — Issue #32: Synthetic-brain Phase 1: ReflexCache + tool.execute.before warn inhibition

**Author:** Anymake Solution Architect
**Project:** realmemory — `project_type: library`
**Issue:** https://github.com/R3dy/RealMemory/issues/32 — `type:feature`
**Code state analyzed:** `9444aaf` (main, v0.6.0, post-issue-#30 hook probe)
**Status:** In Review (round 2)
**Location:** `PROJECTS/realmemory/repo/docs/06-agile/issue-32/plan.md`

---

## 1. Problem Statement

Issue #32 requests the next phase of the synthetic-brain epic: build the in-RAM `ReflexCache` and wire the `tool.execute.before` plugin hook with `warn`-only inhibition. The synthetic-brain design doc (`docs/architecture/synthetic-brain.md` §3, §4.3, §5) identifies a structural gap: all four writable gates that change what the agent *does* (not just what it reads) are unused — `tool.execute.before`, `permission.ask`, `chat.params`, `tool.definition`. Today realmemory is a passive context supplier. Phase 0 (issue #30, shipped) proved hooks fire. Phase 1 is the first step toward closing that gap: advisory `warn` notes only — nothing blocked or rewritten yet.

---

## 2. Root Cause / Motivation

**Motivation (feature):** The design doc §1 frames the honest framing: "realmemory cannot be inside the reasoning. It can be the thing that decides what the reasoning starts from, what it is allowed to do, and what it becomes afterward — on every step, without the agent ever choosing to consult it." Today the plugin owns 4 of ~11 gates and all 4 writable behavioral gates are unused. A brain's memory is not advisory; it must be able to gate actions. Phase 1 builds the cheapest possible gate: a synchronous, in-RAM cache lookup before every tool call that queues a one-line note if the call matches a known lesson. The note is delivered via the existing `pendingInjection` mechanism — no new delivery path.

The success model for a `library` project type is API quality and adoption. The synthetic brain is what makes realmemory fundamentally different from every other memory tool: it doesn't just remember, it *inhibits*. That distinction is the adoption driver. Phase 1 is the first step that delivers that distinction in a low-risk, advisory-only form.

---

## 3. Current-State Review

| Touched | Details |
|---------|---------|
| Modules | `src/plugin.ts` (5 hook handlers, `tool.execute.before` NOT registered), `src/hook-probe.ts` (6 probed hooks, `tool.execute.before` absent), `src/config.ts` (defaults + loadConfig), `src/types.ts` (MemoryStoreConfig — no `brain.*` fields) |
| Data model | No schema changes. `reflex_fire` metrics are additive rows in the existing metrics table (schema v4). ReflexCache is in-RAM only — never persisted. |
| Flows | Plugin load → session.created (detached cache build) → tool.execute.before (synchronous cache lookup) → experimental.chat.system.transform (delivers pending warn note alongside recall block) |
| Integrations | None — pure in-process, no new deps, no external services |

**Intent-layer freshness:** SYSTEM_MAP last mapped 2026-08-12 at `issue/28-plugin-hooks-broken` HEAD. Issue #30 (post-map) was additive diagnostics (`hook-probe.ts`, `--doctor`, store methods) — no architectural decisions or invariant changes. The intent layer is current for Phase 1 planning.

### Plugin hook registration pattern (`src/plugin.ts:282`)

The `realmemoryPlugin` function (default export, `src/plugin.ts:217`) returns an object with hook handler keys. Each handler:
1. Calls `recordHookFired(getStore, state.probe, "hookName")` at the top (Phase 0 probe)
2. Checks config gates
3. Does its work (detached for deliberative-path, synchronous for reflex-path)

The `tool.execute.after` handler (line 468) receives `(input: { tool, args }, output: { args, output })`. The `tool.execute.before` hook has the same signature but `output.args` is mutable and throwing aborts the call. For Phase 1 `warn`, we leave args alone and queue a note.

### Delivery mechanism (`experimental.chat.system.transform`, line 632)

`state.pendingInjection` is a `string | null`. The transform hook pushes it to `output.system` and clears it. Phase 1 adds a **separate** `state.pendingWarnNote: string | null` field — the transform hook concatenates both at delivery time (warn note first, then recall block). This avoids the race where `chat.message`'s detached recall does `state.pendingInjection = formatRecallResults(...)` (assignment, line 617) and overwrites a warn note that `tool.execute.before` had already queued. With separate fields, the two writers never collide.

---

## 4. Solution Design

### 4.1 New module: `src/reflex.ts`

Pure TypeScript, no deps. Exports:

```typescript
/** A single reflex rule compiled from a memory. */
export interface ReflexRule {
  memoryId: string;
  match: RegExp | ((call: ToolCall) => boolean);
  action: "warn";  // Phase 1: "warn" only. "rewrite" and "block" are Phase 4.
  note: string;        // shown to the model when the rule fires
  salience: number;    // 0..1 — drives ordering
  confidence: number;  // 0..1 — the source memory's confidence
}

/** In-RAM reflex cache. Built at session.created, refreshed on compaction. */
export interface ReflexCache {
  rules: ReflexRule[];          // hard cap 100, sorted by salience × confidence desc
  preferences: string[];        // top global user_preference contents (identity block)
  arousal: number;              // 0..1 — recent correction/failure density (stub: 0 for Phase 1)
  builtAt: number;
}

/** Shape of a tool call passed to matchCall. */
export interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

/** Weight floor for reflex-eligible memories. */
export const REFLEX_WEIGHT_FLOOR = 0.3;

/** Maximum rules in the cache. */
export const REFLEX_RULE_CAP = 100;

/**
 * Compile a single memory into a reflex rule (or null if it can't be compiled).
 * Compilation is deliberately dumb — literal command substrings, file-path
 * globs, tool-name matches derived from metadata.command / metadata.filePath.
 * No LLM, no embedding, no inference. A memory that can't be compiled to a
 * cheap matcher is simply not a reflex; it stays a recall candidate.
 */
export function compileRule(memory: Memory): ReflexRule | null;

/**
 * Build the reflex cache from the store. One store.search() for lesson_learned
 * + user_preference above the weight floor, compiled into rules. Detached
 * (called from session.created). A cold cache (not yet built) means no
 * inhibition — the safe failure mode.
 */
export async function buildReflexCache(store: MemoryStore): Promise<ReflexCache>;

/**
 * Synchronous cache-only lookup. Returns the first matching rule (sorted by
 * salience × confidence), or null if no match. MUST complete within 5ms.
 * No DB access, no I/O, no LLM, no embedding. This is the reflex path.
 */
export function matchCall(cache: ReflexCache | null, call: ToolCall): ReflexRule | null;

/** Create an empty reflex cache (cold start). */
export function emptyReflexCache(): ReflexCache;
```

**`compileRule` logic:**
- For `lesson_learned` memories: extract `metadata.command` (bash tool), `metadata.filePath` (read tool), or the memory content. If a command exists, compile a rule matching `tool === "bash" && args.command.includes(commandSubstring)`. If a filePath exists, compile a rule matching `tool === "read" && args.filePath.includes(pathSubstring)`. The note is the memory content (truncated to 120 chars). Salience = `memory.weight`. Confidence = `memory.confidence`.
- For `user_preference` memories: these become the `preferences` array (identity block), not rules. They don't match tool calls — they're delivered as context.
- If neither a command nor a filePath can be extracted, return `null` — the memory stays a recall candidate for the deliberative path.

**`buildReflexCache` logic:**
```typescript
async function buildReflexCache(store: MemoryStore): Promise<ReflexCache> {
  const results = await store.search({
    types: ["lesson_learned", "user_preference"],
    minWeight: REFLEX_WEIGHT_FLOOR,
    sortBy: "weight",
    sortOrder: "desc",
    limit: 200,
  });
  const rules: ReflexRule[] = [];
  const preferences: string[] = [];
  for (const item of results.memories) {
    if (item.type === "user_preference") {
      preferences.push(item.content);
      continue;
    }
    const rule = compileRule(item);
    if (rule) rules.push(rule);
  }
  rules.sort((a, b) => (b.salience * b.confidence) - (a.salience * a.confidence));
  return {
    rules: rules.slice(0, REFLEX_RULE_CAP),
    preferences: preferences.slice(0, 10),
    arousal: 0, // Phase 1 stub — Phase 4 (arousal) populates this
    builtAt: Date.now(),
  };
}
```

**`matchCall` logic:**
```typescript
function matchCall(cache: ReflexCache | null, call: ToolCall): ReflexRule | null {
  if (!cache || cache.rules.length === 0) return null;
  for (const rule of cache.rules) {
    if (typeof rule.match === "function") {
      if (rule.match(call)) return rule;
    } else {
      // RegExp — match against a stringified form of the call
      const callStr = `${call.tool} ${JSON.stringify(call.args ?? {})}`;
      if (rule.match.test(callStr)) return rule;
    }
  }
  return null;
}
```

### 4.2 Plugin wiring: `src/plugin.ts`

**PluginState additions:**
```typescript
interface PluginState {
  // ... existing fields ...
  /** Synthetic-brain Phase 1: in-RAM reflex cache. Built at session.created (detached). */
  reflexCache: ReflexCache | null;
  /** Synthetic-brain Phase 1: warn note queued by tool.execute.before. Separate from
   *  pendingInjection to avoid the race where chat.message's detached recall
   *  overwrites pendingInjection (assignment at plugin.ts:617) after tool.execute.before
   *  has appended a warn note. The transform hook concatenates both at delivery time. */
  pendingWarnNote: string | null;
}
```

**session.created handler (existing `event` handler):** add a detached `buildReflexCache` call:
```typescript
// After existing decay/recall work, before return:
if ((state.config as { brain?: { reflex?: boolean } }).brain?.reflex !== false) {
  void (async () => {
    try {
      const store = await getStore();
      state.reflexCache = await buildReflexCache(store);
      await log("debug", `ReflexCache built: ${state.reflexCache.rules.length} rules`);
    } catch (error) {
      await log("error", `ReflexCache build failed: ${error instanceof Error ? error.message : String(error)}`);
      // Cold cache = no inhibition — safe failure mode
    }
  })();
}
```

**New `tool.execute.before` handler:**
```typescript
"tool.execute.before": (
  input: { tool: string; args?: Record<string, unknown> },
  output: { args?: Record<string, unknown> },
) => {
  // Phase 0 probe: record fire.
  recordHookFired(getStore, state.probe, "tool.execute.before");

  // Config gate: brain.reflex defaults true; brain.inhibition defaults "warn".
  const brainConfig = state.config as { brain?: { reflex?: boolean; inhibition?: string } };
  if (brainConfig.brain?.reflex === false) return;
  if (brainConfig.brain?.inhibition === "off") return;

  // Reflex path: synchronous, cache-only, no I/O. Cold cache = no-op.
  const cache = state.reflexCache;
  if (!cache) return;

  const call: ToolCall = { tool: input.tool, args: input.args ?? output.args };
  const rule = matchCall(cache, call);
  if (!rule) return;

  // Warn: queue a one-line note into pendingWarnNote (separate field — avoids the
  // race where chat.message's detached recall overwrites pendingInjection).
  // The transform hook concatenates pendingWarnNote with pendingInjection at delivery.
  const note = `[realmemory reflex] ${rule.note}`;
  state.pendingWarnNote = note;

  // Record reflex_fire metric (detached — non-blocking).
  void (async () => {
    try {
      const store = await getStore();
      await store.recordMetric(`reflex_fire:${rule.memoryId}`, 1, state.sessionId ?? undefined);
    } catch {
      // Fire-safe.
    }
  })();
},
```

### 4.3 Transform hook modification: deliver `pendingWarnNote`

The `experimental.chat.system.transform` handler (line 632) must be modified to also deliver `state.pendingWarnNote`:

```typescript
// Existing: deliver pendingInjection (recall block).
if (state.pendingInjection) {
  output.system.push(state.pendingInjection);
  state.pendingInjection = null;
}
// NEW: deliver pendingWarnNote (reflex warn). Concatenated after recall block.
if (state.pendingWarnNote) {
  output.system.push(state.pendingWarnNote);
  state.pendingWarnNote = null;
}
```

This eliminates the race (1-C2): `tool.execute.before` writes to `pendingWarnNote`, `chat.message` writes to `pendingInjection` — the two detached writers never collide, and the transform hook delivers both.

### 4.4 Config: `src/types.ts` + `src/config.ts`

**`MemoryStoreConfig` additions (`src/types.ts`):**
```typescript
export interface MemoryStoreConfig {
  // ... existing fields ...
  /**
   * Synthetic-brain Phase 1: reflex cache + inhibition.
   * When true (default), build ReflexCache at session start and wire
   * tool.execute.before. When false, no inhibition (today's behavior).
   */
  brain?: {
    reflex?: boolean;        // default true
    inhibition?: "off" | "warn";  // default "warn". "rewrite" and "block" are Phase 4.
  };
}
```

**`DEFAULTS` additions (`src/config.ts`):**
```typescript
brain: {
  reflex: true,
  inhibition: "warn",
},
```

Note: the `DEFAULTS` type currently uses `Pick<MemoryStoreConfig, ...>`. Add `brain` to the Pick union. The `brain` field is a nested object — verify `loadConfig`'s merge handles nested objects correctly (deep merge or replace). If it's a shallow merge (likely), document that `brain` is replaced wholesale (not deep-merged) and that's acceptable for this config shape.

### 4.5 Hook probe: `src/hook-probe.ts`

Add `tool.execute.before` to `CONDITIONAL_HOOKS`:
```typescript
export const CONDITIONAL_HOOKS = [
  "tool.execute.after",
  "experimental.session.compacting",
  "tool.execute.before",   // Phase 1 — fires on tool calls
] as const;
```

This makes the `--doctor` report include `tool.execute.before` as a conditional hook (fires on tool calls, no-evidence if no tools were called). No other probe changes needed — `recordHookFired` is already called at the top of the new handler.

### 4.6 INV-017 amendment → superseding ADR-010

The reviewer (round 1) correctly identified that the INV-017 amendment is a **contradiction**, not a clarification — the original says "**All** OpenCode plugin hooks are non-blocking (fire-and-forget)" and the new `tool.execute.before` handler is synchronous. "All hooks are non-blocking" and "some hooks are synchronous" are mutually exclusive. Per `docs/DECISIONS.md` "Superseding a Decision" section, a contradiction requires a superseding ADR gated through the Product Owner Proxy (autonomous mode) or Royce.

**Commit to writing ADR-010 (two-pathway constraint) BEFORE execution:**

ADR-010 will:
1. Name INV-017 as the invariant being amended.
2. State the two-pathway constraint: deliberative-path hooks are detached and unbounded (unchanged); reflex-path hooks (`tool.execute.before`, and future `permission.ask`/`chat.params`/`tool.definition`) are synchronous, must complete within 5ms, and may only read `ReflexCache`. No hook may await I/O on the reflex path.
3. Justify the amendment: synchronous gates (`tool.execute.before`, `permission.ask`) are incompatible with detached promises — the host waits on the return value to decide what happens next. A detached promise there is a no-op (design doc §3).
4. Be gated through the Product Owner Proxy (autonomous mode, gate type `intent-conflict`).

The ADR file will be created at `docs/adr/ADR-010-two-pathway-constraint.md` as the first execution step. `docs/INVARIANTS.md` INV-017 row will be updated as part of the post-merge Cartographer refresh.

### 4.7 tsup entry + dist rebuild

`src/reflex.ts` is an internal module imported by `src/plugin.ts` → bundled transitively by `src/plugin-entry.ts` (which IS a tsup entry point). No tsup entry point change needed — `reflex.ts` is bundled automatically when `plugin.ts` imports it. Rebuild `dist/` (INV-019 — dist committed to git).

---

## 5. Alternatives Considered

| Option | Why not chosen |
|--------|----------------|
| **Block from day one** (skip `warn`, implement `block` immediately) | A false-positive `block` wastes a turn and confuses the model. The design doc §7 explicitly requires `warn` first to measure the false-positive rate before escalating to `block`. `block` requires explicit config opt-in + salience ≥ 0.8 + `category: safety\|cost` — all Phase 4. Phase 1 `warn` is the necessary data-gathering step. |
| **Use the deliberative path for inhibition** (detached `store.recall()` in `tool.execute.before`) | Violates the 5ms budget. `store.recall()` embeds the query and cosine-scores every row in JS — tens to hundreds of milliseconds, on a path that fires before every tool call. Would make the agent feel broken. The two-pathway design (§3) is the resolution: reflex path is cache-only, deliberative path is unbounded. |
| **Build ReflexCache on every tool call** (lazy, no session.created build) | First tool call would be slow (search + compile). Session.created build (detached) means the cache is warm by the time the first tool call happens. A cold cache (first call races the build) = no inhibition = safe failure mode. |

---

## 6. Intent Constraints

**Classification: Additive with one superseding ADR (ADR-010)**

- **ADR-008** (brain-loop + plugin role/boundary): preserved. Phase 1 extends the plugin with a new hook + new module — within ADR-008's plugin boundary (hooks are the plugin's role).
- **ADR-009** (plugin entry point + distribution): preserved. `src/reflex.ts` is bundled transitively via `plugin.ts` → `plugin-entry.ts` (no tsup entry change). `dist/` rebuilt (INV-019). No entry-point structure change.
- **INV-014** (runtime dep cap = 3 + zod): preserved. Phase 1 adds NO new deps — pure TypeScript, in-RAM. No `package.json` changes.
- **INV-017** (non-blocking hooks): **superseded by ADR-010** — the original says "all hooks are non-blocking"; the amendment introduces a synchronous reflex-path. This is a contradiction, gated through the Product Owner Proxy (autonomous mode, gate type `intent-conflict`). ADR-010 is written as the FIRST execution step, before any code changes. The two-pathway constraint: deliberative-path hooks remain detached and unbounded (unchanged); reflex-path hooks are synchronous, <5ms, cache-only, no I/O.
- **INV-019** (dist committed to git): preserved — dist rebuilt and committed.

**Conflict gate outcome:** ADR-010 (two-pathway constraint) will be approved via Product Owner Proxy (autonomous mode) at the approval gate. The plan does not proceed to execution until ADR-010 is committed to `docs/adr/ADR-010-two-pathway-constraint.md`.

---

## 7. Design Consistency

N/A — no UI changes. The graph browser, list view, and detail panel are unchanged. `reflex_fire` metrics are visible via `get_metrics` MCP tool (already exists) and the `/api/metrics` endpoint (already exists), but no new UI is added.

---

## 8. Blast Radius & Regression Risk

| At risk | Why it's in the blast radius | Protection |
|---------|------------------------------|------------|
| Plugin load path (all hooks) | New `tool.execute.before` handler is added to the returned object. If the handler throws, it could break the tool loop. | Handler is synchronous, cache-only, wrapped in config gates. No throw path — `matchCall` is pure, note queuing is a string assignment. Existing 543 tests + new Phase 1 tests. |
| Config defaults | New `brain` config field. If `loadConfig`'s merge doesn't handle nested objects, the default could be lost. | Test config merge with nested `brain` object. Default `brain.reflex: true` + `brain.inhibition: "warn"` — if merge fails, the handler checks `!== false` and `!== "off"` (both default to active). |
| session.created handler | Adding a detached `buildReflexCache` call to the existing session.created flow. If it throws, it could affect decay/recall. | Detached (`void (async () => {…})()`), try/catch, logs error and continues. Cold cache = no inhibition. |
| experimental.chat.system.transform | Transform hook now delivers both `pendingInjection` (recall block from `chat.message`) and `pendingWarnNote` (warn note from `tool.execute.before`). Two separate fields avoid the race where `chat.message`'s detached recall (assignment at `plugin.ts:617`) overwrites a warn note. | Test: both fields delivered in one transform call; warn note survives a slow recall. |
| Hook probe (`--doctor`) | `tool.execute.before` added to CONDITIONAL_HOOKS. Doctor report gains a row. | Additive — existing rows unchanged. New test for the added row. |
| Test suite (543 tests) | New module + new hook + config changes. | Run full suite. 5 pre-existing EADDRINUSE (port 9333) are environmental. |

**Migrations:** none. `reflex_fire` metrics are additive rows in the existing metrics table (schema v4). ReflexCache is in-RAM only — never persisted, no schema change.

---

## 9. Story Breakdown

### Story A32.0 — ADR-010: two-pathway constraint (conflict gate prerequisite)

**As a** project maintainer **I want** the INV-017 contradiction formalized as a superseding ADR **so that** the two-pathway constraint (deliberative-path: detached; reflex-path: synchronous <5ms) is a documented decision, not an undocumented amendment.

**Acceptance criteria:**
- [ ] `docs/adr/ADR-010-two-pathway-constraint.md` created with: (1) names INV-017 as amended, (2) states the two-pathway constraint, (3) justifies the amendment (synchronous gates are incompatible with detached promises — design doc §3), (4) references the design doc.
- [ ] ADR-010 approved via Product Owner Proxy (autonomous mode, gate type `intent-conflict`).
- [ ] This story is a prerequisite for A32.1 and A32.2 — no code is written until ADR-010 is committed.

**Experience Script:** N/A — documentation artifact, no runtime-verifiable behavior.

### Story A32.1 — `src/reflex.ts`: ReflexCache, compileRule, buildReflexCache, matchCall

**As a** plugin developer **I want** a pure, in-RAM reflex cache module **so that** tool-call matching can happen synchronously in under 5ms without touching the DB.

**Acceptance criteria:**
- [ ] `src/reflex.ts` exports: `ReflexRule`, `ReflexCache`, `ToolCall`, `REFLEX_WEIGHT_FLOOR`, `REFLEX_RULE_CAP`, `compileRule`, `buildReflexCache`, `matchCall`, `emptyReflexCache`.
- [ ] `compileRule(memory)` returns a `ReflexRule` for `lesson_learned` memories with extractable `metadata.command` or `metadata.filePath`; returns `null` for memories without extractable matchers (they stay recall candidates).
- [ ] `compileRule` for `user_preference` memories returns `null` (preferences go into the `preferences` array, not rules).
- [ ] `buildReflexCache(store)` calls `store.search({ types: ["lesson_learned", "user_preference"], minWeight: 0.3, sortBy: "weight", sortOrder: "desc", limit: 200 })`, compiles rules, sorts by `salience × confidence` desc, caps at 100.
- [ ] `matchCall(cache, call)` returns the first matching rule or null. Is synchronous (no async, no I/O). Cold cache (null) returns null.
- [ ] **Latency assertion:** a test that calls `matchCall` with a cache of 100 rules and asserts it completes in <5ms (use `performance.now()` before/after, assert `elapsed < 5`). This is a hard budget, not a comment.
- [ ] Rule cap enforced: if `buildReflexCache` gets 200 memories that all compile to rules, only 100 are kept (sorted by salience × confidence desc).
- [ ] `emptyReflexCache()` returns `{ rules: [], preferences: [], arousal: 0, builtAt: 0 }`.
- [ ] No new dependencies added to `package.json` (INV-014 preserved).

**Experience Script:** N/A — this is a pure logic module with no runtime-verifiable UI/CLI behavior. The Experience Runner will verify the integrated behavior in A32.2.

### Story A32.2 — Plugin wiring: tool.execute.before hook + config + hook probe

**As a** realmemory user **I want** the plugin to warn me when I'm about to repeat a known-failed tool call **so that** I don't repeat mistakes the memory system has already recorded.

**Acceptance criteria:**
- [ ] `src/plugin.ts` registers `tool.execute.before` handler in the returned object.
- [ ] Handler calls `recordHookFired(getStore, state.probe, "tool.execute.before")` at the top.
- [ ] Handler checks `config.brain?.reflex !== false` and `config.brain?.inhibition !== "off"` — both default to active.
- [ ] Handler calls `matchCall(state.reflexCache, { tool, args })` synchronously. If no match, returns immediately.
- [ ] On match: queues `[realmemory reflex] ${rule.note}` into `state.pendingWarnNote` (separate field from `pendingInjection` — avoids race). Records `reflex_fire:${rule.memoryId}` metric (detached).
- [ ] `experimental.chat.system.transform` handler modified to deliver `pendingWarnNote` in addition to `pendingInjection` (warn note first, then recall block). Both cleared after delivery.
- [ ] `session.created` handler (in the `event` handler) builds the ReflexCache detached: `state.reflexCache = await buildReflexCache(store)`. Gated on `config.brain?.reflex !== false`. Try/catch, logs error, cold cache = safe.
- [ ] `PluginState` includes `reflexCache: ReflexCache | null` and `pendingWarnNote: string | null`.
- [ ] `src/hook-probe.ts` `CONDITIONAL_HOOKS` includes `"tool.execute.before"`.
- [ ] `src/types.ts` `MemoryStoreConfig` includes `brain?: { reflex?: boolean; inhibition?: "off" | "warn" }`.
- [ ] `src/config.ts` `DEFAULTS` includes `brain: { reflex: true, inhibition: "warn" }`.
- [ ] Config toggle test: `brain.reflex: false` → handler is a no-op (no metric recorded). `brain.inhibition: "off"` → handler is a no-op.
- [ ] Metric recording test: when a rule matches, `reflex_fire:<memoryId>` metric is recorded (query via `getMetricSummary` or `getLatestMetricRow`).
- [ ] Race-free delivery test: `pendingWarnNote` survives a `chat.message` recall overwrite of `pendingInjection`. Both delivered by transform hook.
- [ ] `tool.execute.before` fires in the `--doctor` report (added to CONDITIONAL_HOOKS).
- [ ] Verify `src/reflex.ts` is bundled transitively via `plugin.ts` → `plugin-entry.ts` — no tsup entry point change needed.
- [ ] `dist/` rebuilt and committed (INV-019).
- [ ] Existing 543 tests still pass (5 EADDRINUSE are pre-existing/environmental).

**Experience Script:**
1. Seed the store with a `lesson_learned` memory: `{ content: "npm install fails lockfile validation in this project", type: "lesson_learned", metadata: { command: "npm install" }, weight: 0.5, scope: "project" }`.
2. Load the plugin (or call `realmemoryPlugin` in a test harness).
3. Trigger `session.created` (so ReflexCache builds).
4. Call `tool.execute.before` with `{ tool: "bash", args: { command: "npm install --save foo" } }`.
5. Assert `state.pendingWarnNote` contains `[realmemory reflex]` and the memory note.
6. Trigger `experimental.chat.system.transform` — assert `output.system` contains the warn note.
7. Query `getLatestMetricRow("reflex_fire:")` — assert a metric row exists with value 1.

---

## 10. Test & Verification Plan

- **Automated:**
  - `tests/reflex.test.ts` — compileRule (command, filePath, no-match, user_preference), buildReflexCache (sorting, cap, preferences), matchCall (match, no-match, cold cache, latency <5ms), emptyReflexCache.
  - `tests/plugin-reflex.test.ts` (or extension of existing plugin tests) — tool.execute.before handler: config toggle (reflex:false → no-op, inhibition:off → no-op), match → note queued, no-match → no-op, metric recording, session.created builds cache, cold cache (no session.created) → no-op.
  - `tests/hook-probe.test.ts` (extension) — `tool.execute.before` in CONDITIONAL_HOOKS, `--doctor` report includes the row.
  - `tests/config.test.ts` (extension) — `brain` config default + override.
- **Experience:** the §9 Story A32.2 Experience Script — seed a lesson, trigger session.created, call tool.execute.before with a matching call, assert pendingInjection contains the warn note + metric recorded.
- **Regression:** run full test suite (543+ tests). The 5 EADDRINUSE (port 9333) are pre-existing/environmental.
- **Manual:** Royce restarts OpenCode (picks up the rebuilt plugin). After a session with the instrumented plugin, run `node dist/bin.js --doctor` — expect `tool.execute.before` in the doctor table (conditional, fires on tool calls).

---

## 11. Rollback Plan

- **Branch:** `issue/32-reflex-warn-inhibition` — all commits reference `#32`
- **Merge:** single squash merge commit; SHA recorded in the issue Tracking table
- **Revert:** `git revert -m 1 [merge SHA]` (or `git revert [squash SHA]`)
- **Migrations:** none. `reflex_fire` metrics are additive rows — no down migration needed. ReflexCache is in-RAM only — never persisted.
- **Intent layer:** if INV-017 amendment was written to `docs/INVARIANTS.md`, revert that section too. If a superseding ADR-010 was written (only if reviewer classifies the amendment as a contradiction), revert the ADR file.
- **Deploy rollback:** re-run `npm run build` (tsup) to rebuild `dist/` after revert (the revert removes `src/reflex.ts` but `dist/reflex.js` may linger if not cleaned). Or: `git checkout main -- dist/` after revert.
- **Version:** 0.6.0 → 0.7.0 (MINOR — new feature, no breaking change; pre-1.0 semver per ADR-004).

---

## 12. Review Log

| Round | Date | Reviewer verdict | Report | Resolution |
|-------|------|------------------|--------|------------|
| 1 | 2026-08-12 | NEEDS CHANGES | `review-round-1.md` | 1-C1: fixed in §4.6 + §6 — committed to ADR-010 (superseding ADR, not conditional). 1-C2: fixed in §4.2 + §4.3 + §8 — separate `pendingWarnNote` field eliminates the race. Minor notes: fixed function name (`realmemoryPlugin`), fixed tsup entry (transitive bundling, no entry change). |
| 2 | pending | pending | `review-round-2.md` | pending |
