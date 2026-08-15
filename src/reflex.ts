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
  /** If present, this rule can rewrite args (deterministic fix). Phase 4a. */
  rewrite?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** If true, this rule is eligible to block (category safety|cost). Phase 4a. */
  blockEligible?: boolean;
  /** The tool this rule targets ("bash", "read", etc.) — for tool.definition matching. Phase 5. */
  tool?: string;
  /** The note shown to the model when the rule fires. */
  note: string;
  /** 0..1 — drives ordering (higher = more salient). */
  salience: number;
  /** 0..1 — the source memory's confidence. Decremented on override (extinction). */
  confidence: number;
}

/** In-RAM reflex cache. Built at session.created, refreshed on compaction. */
export interface ReflexCache {
  /** Hard cap REFLEX_RULE_CAP, sorted by salience × confidence desc. */
  rules: ReflexRule[];
  /** Top global user_preference contents (identity block — future use, Phase 3). */
  preferences: string[];
  /** 0..1 — recent correction/failure density (stub: 0 for Phase 1; Phase 5 populates this). */
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

/** Phase 5: arousal temperature delta (max clamp-down). */
export const AROUSAL_TEMP_DELTA = 0.15;

/** Phase 5: arousal threshold — below this, no modulation. */
export const AROUSAL_THRESHOLD = 0.3;

/** Phase 5: arousal normalization — N bad outcomes = arousal 1.0. */
export const AROUSAL_NORMALIZATION = 3;

/** Phase 5: arousal signal weights. */
export const AROUSAL_WEIGHT_CORRECTION = 1.0;
export const AROUSAL_WEIGHT_BLOCK = 0.8;
export const AROUSAL_WEIGHT_HIGH_SURPRISE = 0.6;

/** Phase 5: arousal ring buffer size (last N turns). */
export const AROUSAL_WINDOW = 5;

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
  let toolName: string | undefined;

  if (command) {
    toolName = "bash";
    // Bash tool: match when the call's command includes the stored command substring.
    const cmdSubstring = command.slice(0, 100);
    matcher = (call: ToolCall): boolean => {
      if (call.tool !== "bash") return false;
      const callCommand = (call.args as { command?: unknown })?.command;
      if (typeof callCommand !== "string") return false;
      return callCommand.includes(cmdSubstring);
    };
  } else if (filePath) {
    toolName = "read";
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

  // Phase 4a: compile capabilities from memory metadata + category.
  // rewrite: only from explicit metadata.rewrite { tool, from, to }.
  let rewrite: ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;
  const rewriteMeta = (metadata.rewrite ?? null) as
    | { tool?: string; from?: string; to?: string }
    | null;
  if (
    rewriteMeta &&
    typeof rewriteMeta.from === "string" &&
    typeof rewriteMeta.to === "string" &&
    rewriteMeta.from.length > 0
  ) {
    const from = rewriteMeta.from;
    const to = rewriteMeta.to;
    rewrite = (args: Record<string, unknown>): Record<string, unknown> => {
      const cmd = (args as { command?: unknown })?.command;
      if (typeof cmd !== "string" || !cmd.includes(from)) return args; // no-op if absent (R1-N6)
      return { ...args, command: cmd.split(from).join(to) };
    };
  }

  // blockEligible: only for category safety|cost.
  const blockEligible =
    memory.category === "safety" || memory.category === "cost";

  return {
    memoryId: memory.id,
    match: matcher,
    rewrite,
    blockEligible,
    tool: toolName,
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
    arousal: 0, // Phase 1 stub — Phase 5 (arousal) populates this
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

// ---------------------------------------------------------------------------
// Phase 4a: decideAction (pure) + decrementRuleConfidence (extinction)
// ---------------------------------------------------------------------------

/** Config-controlled inhibition ceiling. Default "warn" (Phase 1 behavior). */
export type InhibitionLevel = "off" | "warn" | "rewrite" | "block";

/** Confidence gates for each action (R2-C1 fix — makes extinction effective). */
export const BLOCK_CONFIDENCE_FLOOR = 0.5;
export const REWRITE_CONFIDENCE_FLOOR = 0.3;
export const BLOCK_SALIENCE_FLOOR = 0.8;
export const REWRITE_SALIENCE_FLOOR = 0.5;
export const OVERRIDE_CONFIDENCE_DEC = 0.2;

/**
 * Decide the inhibition action for a matched rule, given the config ceiling.
 *
 * Pure function — no I/O, no side effects. Reflex path safe (<5ms).
 *
 * The config ceiling sets the maximum action allowed:
 * - "off" → no action
 * - "warn" → warn only (Phase 1 behavior, regression-free default)
 * - "rewrite" → warn or rewrite (block not allowed)
 * - "block" → warn, rewrite, or block (all allowed)
 *
 * Block requires salience >= 0.8 AND confidence >= 0.5 AND blockEligible
 * (category safety|cost). Rewrite requires salience >= 0.5 AND
 * confidence >= 0.3 AND a rewrite function. The confidence gates (R2-C1)
 * are what make `decrementRuleConfidence` effective: after 1-3 overrides,
 * confidence drops below the floor and the action degrades to "warn".
 */
export function decideAction(
  rule: ReflexRule | null,
  inhibition: InhibitionLevel,
): "none" | "warn" | "rewrite" | "block" {
  if (inhibition === "off" || rule === null) return "none";
  if (inhibition === "warn") return "warn";

  // inhibition is "rewrite" or "block"
  if (
    inhibition === "block" &&
    rule.salience >= BLOCK_SALIENCE_FLOOR &&
    rule.confidence >= BLOCK_CONFIDENCE_FLOOR &&
    rule.blockEligible
  ) {
    return "block";
  }
  if (
    rule.salience >= REWRITE_SALIENCE_FLOOR &&
    rule.confidence >= REWRITE_CONFIDENCE_FLOOR &&
    rule.rewrite
  ) {
    return "rewrite";
  }
  return "warn";
}

/**
 * Decrement a rule's confidence in the in-RAM cache (extinction mechanism).
 *
 * Called on the deliberative path (override detection in tool.execute.before's
 * detached branch). Finds the rule by memoryId, decrements its confidence
 * (clamped >= 0), and re-sorts the rules array by salience x confidence desc.
 *
 * Combined with the confidence gates in `decideAction`, this is what breaks
 * the block/override alternation loop within a session: after 1-3 overrides
 * (0.2 each), confidence drops below 0.5 (no more blocks) or 0.3 (no more
 * rewrites). The rule stays in the cache (it may still warn) but can no
 * longer change behavior.
 */
export function decrementRuleConfidence(
  cache: ReflexCache,
  memoryId: string,
  amount: number,
): void {
  const rule = cache.rules.find((r) => r.memoryId === memoryId);
  if (!rule) return;
  rule.confidence = Math.max(0, rule.confidence - amount);
  cache.rules.sort(
    (a, b) => b.salience * b.confidence - a.salience * a.confidence,
  );
}

// ---------------------------------------------------------------------------
// Phase 5: Arousal (chat.params modulation)
// ---------------------------------------------------------------------------

/** A per-turn arousal signal — which bad outcomes occurred this turn. */
export interface ArousalSignal {
  correction: boolean;
  block: boolean;
  highSurprise: boolean;
}

/** A ring buffer of the last AROUSAL_WINDOW arousal signals. */
export interface ArousalTracker {
  signals: ArousalSignal[];
}

/** Create an empty arousal tracker. */
export function emptyArousalTracker(): ArousalTracker {
  return { signals: [] };
}

/**
 * Compute arousal (0..1) from the tracker's rolling window.
 *
 * arousal = min(1, sum(signal_weights) / AROUSAL_NORMALIZATION)
 *
 * 3 bad outcomes in 5 turns → arousal 1.0. Each correction = 1.0,
 * each block = 0.8, each high-surprise = 0.6.
 */
export function computeArousal(tracker: ArousalTracker): number {
  if (tracker.signals.length === 0) return 0;
  let sum = 0;
  for (const s of tracker.signals) {
    if (s.correction) sum += AROUSAL_WEIGHT_CORRECTION;
    if (s.block) sum += AROUSAL_WEIGHT_BLOCK;
    if (s.highSurprise) sum += AROUSAL_WEIGHT_HIGH_SURPRISE;
  }
  return Math.min(1, sum / AROUSAL_NORMALIZATION);
}

/**
 * Push an arousal signal onto the tracker, evicting the oldest if over capacity.
 */
export function pushArousalSignal(tracker: ArousalTracker, signal: ArousalSignal): void {
  tracker.signals.push(signal);
  if (tracker.signals.length > AROUSAL_WINDOW) {
    tracker.signals.shift();
  }
}

/**
 * Phase 5: find the top reflex rule matching a tool name (for tool.definition).
 *
 * Matches on the rule's `tool` field (set at compile time by compileRule),
 * NOT on the full predicate — tool.definition fires before the agent proposes
 * specific args, so we only know the tool name, not what command it will run.
 * The note is still relevant ("this tool has burned you before") even without
 * the specific command.
 *
 * Scans cache.rules (sorted by salience × confidence desc) and returns the
 * first rule whose `tool` field matches.
 */
export function matchTool(cache: ReflexCache | null, toolName: string): ReflexRule | null {
  if (!cache || cache.rules.length === 0) return null;
  for (const rule of cache.rules) {
    if (rule.tool === toolName) return rule;
  }
  return null;
}
