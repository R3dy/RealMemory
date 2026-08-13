/**
 * Synthetic-brain Phase 2: prediction error (surprise-driven encoding).
 *
 * The learning rule that makes "learns like a human" true rather than
 * decorative. Today storage is triggered by keyword heuristics; Phase 2 drives
 * encoding by **surprise** — the gap between what was expected and what
 * occurred (Rescorla–Wagner; dopaminergic reward-prediction-error).
 *
 * Two pathways (ADR-010):
 * - `predictOutcome` runs on the **reflex path** (`tool.execute.before`):
 *   synchronous, cache-only, <5ms. It consumes the *already-matched* rule
 *   from `matchCall` (Phase 1) — no additional cache scan, no DB, no I/O.
 * - `classifyOutcome` / `computeSurprise` / `shouldEncode` / `describe` run on
 *   the **deliberative path** (`tool.execute.after`, detached): they may touch
 *   the store to encode or reinforce.
 *
 * See `docs/architecture/synthetic-brain.md` §4.5 for the design.
 */

import type { ReflexRule, ToolCall } from "./reflex";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A prediction about a tool call's outcome, produced on the reflex path. */
export interface Prediction {
  /** Whether the call is predicted to succeed. */
  willSucceed: boolean;
  /** 0..1 — confidence in the prediction. */
  confidence: number;
  /** The memory that produced this prediction (the matched reflex rule's
   *  source memory), or null for the uncertain default (no matching rule). */
  sourceMemoryId: string | null;
}

/** The actual observed outcome of a tool call, classified on the deliberative path. */
export interface Outcome {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Reflex-path: predict (synchronous, cache-only, <5ms)
// ---------------------------------------------------------------------------

/**
 * Produce a prediction from the already-matched reflex rule.
 *
 * Reflex path — pure function of `matchedRule` only. No DB, no I/O, no LLM.
 * A matching reflex rule (compiled from a `lesson_learned` memory) predicts
 * FAILURE — the rule exists because something went wrong before, so the prior
 * belief is that it will go wrong again. No match → the uncertain default
 * (the world mostly works): `{ willSucceed: true, confidence: 0.5 }`.
 *
 * @param matchedRule the rule returned by `matchCall` (Phase 1), or null.
 */
export function predictOutcome(matchedRule: ReflexRule | null): Prediction {
  if (matchedRule) {
    return {
      willSucceed: false,
      confidence: matchedRule.confidence,
      sourceMemoryId: matchedRule.memoryId,
    };
  }
  return {
    willSucceed: true,
    confidence: 0.5,
    sourceMemoryId: null,
  };
}

// ---------------------------------------------------------------------------
// Deliberative-path: classify + compare + decide
// ---------------------------------------------------------------------------

/**
 * Classify the actual outcome of a tool call. Dumb — no LLM, no embedding.
 *
 * For `bash`: `success = !isErrorResult(String(output))` — reuses the single
 * existing error-detection heuristic (injected, not re-implemented).
 * For other tools: success unless the output is an Error or a string
 * containing `error:` (defensive — most tools return structured output that
 * doesn't surface errors as bare strings).
 *
 * @param tool the tool name (e.g. "bash", "read", "write").
 * @param output the raw tool output.
 * @param isErrorResult the existing error-detection heuristic from plugin.ts.
 */
export function classifyOutcome(
  tool: string,
  output: unknown,
  isErrorResult: (s: string) => boolean,
): Outcome {
  // bash: delegate to the existing heuristic.
  if (tool === "bash") {
    return { success: !isErrorResult(String(output ?? "")) };
  }
  // Error instance → failure (defensive).
  if (output instanceof Error) {
    return { success: false };
  }
  // String containing error markers → failure (defensive).
  if (typeof output === "string" && /error:/i.test(output)) {
    return { success: false };
  }
  // Default: success.
  return { success: true };
}

/**
 * Compute the surprise (prediction error) between a prediction and the actual
 * outcome. Pure.
 *
 * surprise = | (actual.success ? 1 : 0) - (prediction.willSucceed
 *             ? prediction.confidence : 1 - prediction.confidence) |
 *
 * Range 0..1. 0 = fully predicted; 1 = maximally surprising.
 */
export function computeSurprise(prediction: Prediction, actual: Outcome): number {
  const expected = prediction.willSucceed
    ? prediction.confidence
    : 1 - prediction.confidence;
  const actualValue = actual.success ? 1 : 0;
  return Math.abs(actualValue - expected);
}

/**
 * Whether the surprise is high enough to encode a new lesson_learned row.
 * Pure threshold: surprise >= 0.2 → encode. Below 0.2 → cheaply reinforce the
 * source memory instead (no new row, INV-018).
 */
export function shouldEncode(surprise: number): boolean {
  return surprise >= 0.2;
}

/**
 * Classify a surprise value into a coarse bin for the `prediction_error:<bin>`
 * metric. Bin boundaries match the encode/reinforce (<0.2) and immediate-reflex
 * (>0.7) thresholds, so the metric directly observes the three behavior regimes.
 */
export function surpriseBin(surprise: number): "low" | "med" | "high" {
  if (surprise < 0.2) return "low";
  if (surprise > 0.7) return "high";
  return "med";
}

/**
 * Build a human-readable content string for an encoded lesson. Dumb — no LLM.
 * Shape: `"Prediction error (<tool>): expected <success|failure>, observed
 * <success|error> — <command or filePath>"`. Command/path truncated to 200
 * chars (matching the existing bash-error capture style).
 */
export function describe(call: ToolCall, actual: Outcome): string {
  const args = (call.args ?? {}) as { command?: string; filePath?: string };
  const detail = args.command ?? args.filePath ?? "";
  const detailTrunc = detail.slice(0, 200);
  const expected = actual.success ? "success" : "failure";
  const observed = actual.success ? "success" : "error";
  const suffix = detailTrunc ? ` — ${detailTrunc}` : "";
  return `Prediction error (${call.tool}): expected ${expected}, observed ${observed}${suffix}`;
}

// ---------------------------------------------------------------------------
// Call-ID synthesis (reflex-path helper — pure, no I/O)
// ---------------------------------------------------------------------------

/**
 * Stable stringification of a tool-call's args, for synthesizing a call ID.
 *
 * The call ID embeds an args hash so `tool.execute.after` (which receives the
 * same args) can match the EXACT call even under interleaving
 * (`before A(bash,argsA)` → `before B(bash,argsB)` → `after A` — the full
 * `tool:argsHash:` prefix selects A, not B).
 *
 * Implementation: a deterministic JSON-stringify with sorted keys, truncated
 * to 200 chars. Collisions are possible (two calls with identical args
 * within a turn) but the monotonic counter in the call ID
 * (`${tool}:${hashArgs(args)}:${counter}`) disambiguates them — the consume
 * heuristic uses the full prefix INCLUDING the counter, so identical-args
 * calls are matched in reverse-insertion order (most-recent first).
 */
export function hashArgs(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  try {
    // Deterministic stringify: sort keys at every level.
    const stable = JSON.stringify(sortKeys(args));
    return stable.slice(0, 200);
  } catch {
    return "";
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Deliberative-path: consume prediction from the pending Map (pure lookup)
// ---------------------------------------------------------------------------

/**
 * Find the call ID of the most-recently-inserted pending prediction matching
 * the given tool + args. Used by `tool.execute.after` to consume the exact
 * prediction stashed by `tool.execute.before`.
 *
 * Matching strategy (C4):
 * 1. Full prefix match: `${tool}:${hashArgs(args)}:` — disambiguates
 *    interleaved same-tool calls with different args.
 * 2. Fallback: `${tool}:` prefix — defensive, for hosts whose `after` args
 *    differ from the `before` args (undocumented host behavior). Takes the
 *    most-recent entry for that tool.
 *
 * @param pending insertion-ordered Map (reverse-iterated for most-recent).
 * @param tool the tool name.
 * @param args the args (matched via hashArgs).
 * @returns the matching call ID, or null if no pending prediction matches.
 */
export function consumePrediction(
  pending: Map<string, Prediction>,
  tool: string,
  args: Record<string, unknown> | undefined,
): string | null {
  const fullPrefix = `${tool}:${hashArgs(args)}:`;
  const toolPrefix = `${tool}:`;

  // Reverse-iterate the insertion-ordered Map for most-recent first.
  const keys = Array.from(pending.keys()).reverse();

  // 1. Full prefix match (exact call).
  for (const key of keys) {
    if (key.startsWith(fullPrefix)) return key;
  }

  // 2. Fallback: most-recent-for-tool.
  for (const key of keys) {
    if (key.startsWith(toolPrefix)) return key;
  }

  return null;
}
