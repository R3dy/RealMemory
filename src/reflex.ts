/**
 * Synthetic-brain Phase 1: ReflexCache + reflex-path matching.
 *
 * The reflex path is a synchronous, in-RAM, cache-only lookup that fires before
 * every tool call (`tool.execute.before` hook). It must complete within 5ms and
 * may NEVER touch the DB, await I/O, or call an LLM. See ADR-010 (two-pathway
 * constraint) and `docs/architecture/synthetic-brain.md` §3.
 *
 * The cache is built once at `session.created` (detached) via one `store.search()`
 * for `lesson_learned` + `user_preference` memories above a weight floor,
 * compiled into rules. A cold cache (not yet built) means no inhibition — the
 * safe failure mode.
 */

import type { Memory, SearchQuery, SearchResult } from "./types";
import type { MemoryStore } from "./store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a tool call passed to matchCall. */
export interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

/** A single reflex rule compiled from a memory. */
export interface ReflexRule {
  /** The source memory's ID — every rule traces to a memory the user can inspect and forget. */
  memoryId: string;
  /** A matcher — either a RegExp (tested against a stringified call) or a predicate function. */
  match: RegExp | ((call: ToolCall) => boolean);
  /** Phase 1: "warn" only. "rewrite" and "block" are Phase 4 (explicitly out of scope). */
  action: "warn";
  /** The note shown to the model when the rule fires. */
  note: string;
  /** 0..1 — drives ordering (higher = more salient). */
  salience: number;
  /** 0..1 — the source memory's confidence. */
  confidence: number;
}

/** In-RAM reflex cache. Built at session.created, refreshed on compaction. */
export interface ReflexCache {
  /** Hard cap REFLEX_RULE_CAP, sorted by salience × confidence desc. */
  rules: ReflexRule[];
  /** Top global user_preference contents (identity block — future use, Phase 3). */
  preferences: string[];
  /** 0..1 — recent correction/failure density (stub: 0 for Phase 1; Phase 4 populates this). */
  arousal: number;
  /** When the cache was built (epoch ms). */
  builtAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Weight floor for reflex-eligible memories. */
export const REFLEX_WEIGHT_FLOOR = 0.3;

/** Maximum rules in the cache. */
export const REFLEX_RULE_CAP = 100;

/** Maximum preferences entries. */
export const PREFERENCES_CAP = 10;

/** Search limit when building the cache. */
const SEARCH_LIMIT = 200;

/** Maximum note length (chars). */
const NOTE_MAX_LENGTH = 120;

// ---------------------------------------------------------------------------
// Cache construction
// ---------------------------------------------------------------------------

/**
 * Create an empty reflex cache (cold start). A cold cache means no inhibition —
 * the safe failure mode (matchCall returns null for an empty cache).
 */
export function emptyReflexCache(): ReflexCache {
  return {
    rules: [],
    preferences: [],
    arousal: 0,
    builtAt: 0,
  };
}

/**
 * Compile a single memory into a reflex rule (or null if it can't be compiled).
 *
 * Compilation is deliberately dumb — literal command substrings, file-path
 * substrings, tool-name matches derived from metadata.command / metadata.filePath.
 * No LLM, no embedding, no inference. A memory that can't be compiled to a
 * cheap matcher is simply not a reflex; it stays a recall candidate for the
 * deliberative path.
 *
 * Only `lesson_learned` memories become rules. `user_preference` memories go
 * into the `preferences` array (handled by buildReflexCache, not here).
 */
export function compileRule(memory: Memory): ReflexRule | null {
  if (memory.type !== "lesson_learned") return null;

  const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
  const command = typeof metadata.command === "string" ? metadata.command : null;
  const filePath = typeof metadata.filePath === "string" ? metadata.filePath : null;

  // Extract a matcher from the memory's metadata.
  let matcher: RegExp | ((call: ToolCall) => boolean) | null = null;

  if (command) {
    // Bash tool: match when the call's command includes the stored command substring.
    const cmdSubstring = command.slice(0, 100);
    matcher = (call: ToolCall): boolean => {
      if (call.tool !== "bash") return false;
      const callCommand = (call.args as { command?: unknown })?.command;
      if (typeof callCommand !== "string") return false;
      return callCommand.includes(cmdSubstring);
    };
  } else if (filePath) {
    // Read tool: match when the call's filePath includes the stored path substring.
    const pathSubstring = filePath.slice(0, 200);
    matcher = (call: ToolCall): boolean => {
      if (call.tool !== "read") return false;
      const callFilePath = (call.args as { filePath?: unknown })?.filePath;
      if (typeof callFilePath !== "string") return false;
      return callFilePath.includes(pathSubstring);
    };
  }

  if (!matcher) return null;

  // Truncate note to NOTE_MAX_LENGTH.
  const note = memory.content.length > NOTE_MAX_LENGTH
    ? `${memory.content.slice(0, NOTE_MAX_LENGTH - 3)}...`
    : memory.content;

  return {
    memoryId: memory.id,
    match: matcher,
    action: "warn",
    note,
    salience: Math.max(0, Math.min(1, memory.weight)),
    confidence: Math.max(0, Math.min(1, memory.confidence)),
  };
}

/**
 * Build the reflex cache from the store. One store.search() for lesson_learned
 * + user_preference above the weight floor, compiled into rules.
 *
 * Detached (called from session.created). A cold cache (not yet built) means
 * no inhibition — the safe failure mode.
 */
export async function buildReflexCache(store: MemoryStore): Promise<ReflexCache> {
  const query: SearchQuery = {
    types: ["lesson_learned", "user_preference"],
    minWeight: REFLEX_WEIGHT_FLOOR,
    sortBy: "weight",
    sortOrder: "desc",
    limit: SEARCH_LIMIT,
  };

  const results: SearchResult = await store.search(query);

  const rules: ReflexRule[] = [];
  const preferences: string[] = [];

  for (const memory of results.memories) {
    if (memory.type === "user_preference") {
      preferences.push(memory.content);
      continue;
    }
    const rule = compileRule(memory);
    if (rule) rules.push(rule);
  }

  // Sort by salience × confidence descending (highest first).
  rules.sort((a, b) => (b.salience * b.confidence) - (a.salience * a.confidence));

  return {
    rules: rules.slice(0, REFLEX_RULE_CAP),
    preferences: preferences.slice(0, PREFERENCES_CAP),
    arousal: 0, // Phase 1 stub — Phase 4 (arousal) populates this
    builtAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Reflex-path matching (synchronous, cache-only, <5ms)
// ---------------------------------------------------------------------------

/**
 * Synchronous cache-only lookup. Returns the first matching rule (sorted by
 * salience × confidence), or null if no match. MUST complete within 5ms.
 *
 * No DB access, no I/O, no LLM, no embedding. This is the reflex path.
 * A cold cache (null or empty) returns null — no inhibition.
 */
export function matchCall(cache: ReflexCache | null, call: ToolCall): ReflexRule | null {
  if (!cache || cache.rules.length === 0) return null;

  for (const rule of cache.rules) {
    if (typeof rule.match === "function") {
      if (rule.match(call)) return rule;
    } else {
      // RegExp — match against a stringified form of the call.
      const callStr = `${call.tool} ${JSON.stringify(call.args ?? {})}`;
      if (rule.match.test(callStr)) return rule;
    }
  }

  return null;
}

/**
 * Synthetic-brain Phase 2: mutate the cache in place to add a rule, then
 * re-sort by `salience × confidence` desc and trim to `REFLEX_RULE_CAP`.
 *
 * Used by the high-surprise (`surprise > 0.7`) immediate-reflex path so a
 * strong lesson becomes a reflex for the very next tool call, without waiting
 * for the next `session.created` rebuild. `compileRule` (above) turns the
 * newly-stored memory into a rule; this function inserts it.
 *
 * This is NOT on the reflex path — it runs on the deliberative path
 * (`tool.execute.after`, detached). Mutating the in-RAM cache from the
 * deliberative path is safe: the reflex path reads the cache synchronously,
 * and a mid-turn rule insertion is visible to the next call's `matchCall`
 * (which is the point).
 */
export function addRule(cache: ReflexCache, rule: ReflexRule): void {
  cache.rules.push(rule);
  cache.rules.sort(
    (a, b) => b.salience * b.confidence - a.salience * a.confidence,
  );
  if (cache.rules.length > REFLEX_RULE_CAP) {
    cache.rules.length = REFLEX_RULE_CAP;
  }
}
