/**
 * Self-scope memory (synthetic-self Phase 9).
 *
 * Today the agent stores facts about the world and about the user, and has
 * never stored one about itself. This module adds the ability to record
 * first-person episodes from state that already exists in the plugin, and
 * to assemble a tiered identity block from accumulated self_model rows.
 *
 * Design rules (synthetic-self.md §2 Rule 2 — "organic means earned and
 * reversible"):
 * - Content is templated and literal — no LLM, no interpretation. The moment
 *   a self-fact comes from an LLM's characterization rather than a counter,
 *   it is fiction with provenance (§9 risk #2).
 * - Rows deduplicate + reinforce through the existing store.store() path, so
 *   a recurring disposition gains weight naturally instead of accumulating
 *   duplicates.
 * - recordSelfEpisode runs on the deliberative path (session.idle, detached)
 *   — never on the reflex path (ADR-010).
 *
 * See `docs/architecture/synthetic-self.md` §4 Phase 9 + §6 (identity tiers).
 */

import type { MemoryStore } from "./store";

/** Categories for self_model memories. */
export type SelfModelCategory =
  | "disposition" // what the agent tends to do at decision points
  | "competence" // what the agent is good/bad at
  | "failure_mode" // how the agent tends to fail
  | "commitment"; // what the agent has committed to (user preferences applied)

/**
 * State subset that recordSelfEpisode reads. Mirrors the BrainLoopState pattern
 * — documents what self.ts needs without coupling to the full PluginState.
 */
export interface SelfEpisodeState {
  sessionId?: string;
  lastUserText: string | null;
  lastUserIntent: string | null;
  lastToolCapture: { tool: string; isError: boolean; command?: string; filePath?: string } | null;
  lastPredictionOutcome: {
    prediction: { willSucceed: boolean; confidence: number };
    actual: { success: boolean };
    surprise: number;
    encodedMemoryId: string | null;
  } | null;
  lastBlock: { tool: string; memoryId: string; confidence: number } | null;
  reflexCache: { rules: unknown[]; arousal: number } | null;
  injectedMemoryIds: Set<string>;
  lastInjectedMemoryIds: string[] | null;
  config: {
    brain?: { selfModel?: boolean };
  };
}

/**
 * Record self-episodes from the current session state. Called on the
 * deliberative path at session.idle (detached). Writes templated first-person
 * rows — no LLM, no interpretation. Each row deduplicates + reinforces via
 * store.store(), so recurring patterns gain weight naturally.
 *
 * Returns the number of self_model rows written (new + reinforced).
 */
export async function recordSelfEpisode(
  store: MemoryStore,
  state: SelfEpisodeState,
): Promise<number> {
  if (state.config.brain?.selfModel === false) return 0;

  let written = 0;
  const sessionId = state.sessionId ?? undefined;

  // 1. Override episode: "I blocked X and was overruled"
  if (state.lastBlock) {
    const content = `I blocked ${state.lastBlock.tool} (rule ${state.lastBlock.memoryId.slice(0, 8)}, confidence ${state.lastBlock.confidence.toFixed(2)}) and was overruled — the user retried the call.`;
    try {
      await store.store({
        content,
        type: "self_model",
        scope: "project",
        confidence: 0.5,
        tags: ["self-episode", "override"],
        metadata: {
          category: "failure_mode",
          tool: state.lastBlock.tool,
          memoryId: state.lastBlock.memoryId,
          source: "recordSelfEpisode",
        } as Record<string, unknown>,
      });
      written++;
    } catch {
      // Fire-safe — self-episodes must never break session.idle (INV-017 spirit).
    }
  }

  // 2. High-surprise outcome: "I expected X to work here; it does not"
  if (state.lastPredictionOutcome && state.lastPredictionOutcome.surprise >= 0.5) {
    const outcome = state.lastPredictionOutcome;
    const content = `I expected ${outcome.prediction.willSucceed ? "success" : "failure"} for a tool call (confidence ${outcome.prediction.confidence.toFixed(2)}), but observed ${outcome.actual.success ? "success" : "error"} — surprise ${outcome.surprise.toFixed(2)}.`;
    try {
      await store.store({
        content,
        type: "self_model",
        scope: "project",
        confidence: 0.4 + 0.3 * outcome.surprise,
        tags: ["self-episode", "high-surprise"],
        metadata: {
          category: "failure_mode",
          surprise: outcome.surprise,
          predicted: outcome.prediction,
          actual: outcome.actual,
          source: "recordSelfEpisode",
        } as Record<string, unknown>,
      });
      written++;
    } catch {
      // Fire-safe.
    }
  }

  // 3. Correction density: "this session I was corrected N times"
  if (state.lastUserIntent === "correction" && state.lastUserText) {
    const content = `I was corrected by the user this session: "${state.lastUserText.slice(0, 120)}".`;
    try {
      await store.store({
        content,
        type: "self_model",
        scope: "project",
        confidence: 0.6,
        tags: ["self-episode", "correction"],
        metadata: {
          category: "failure_mode",
          intent: "correction",
          source: "recordSelfEpisode",
        } as Record<string, unknown>,
      });
      written++;
    } catch {
      // Fire-safe.
    }
  }

  // 4. Tool mix disposition: "I reach for [tool] frequently"
  if (state.lastToolCapture) {
    const tc = state.lastToolCapture;
    const isError = tc.isError ? "with errors" : "successfully";
    const content = `I used ${tc.tool} ${isError} this session${tc.command ? ` (${tc.command.slice(0, 60)})` : tc.filePath ? ` (${tc.filePath})` : ""}.`;
    try {
      await store.store({
        content,
        type: "self_model",
        scope: "project",
        confidence: 0.3,
        tags: ["self-episode", "tool-mix"],
        metadata: {
          category: "disposition",
          tool: tc.tool,
          isError: tc.isError,
          source: "recordSelfEpisode",
        } as Record<string, unknown>,
      });
      written++;
    } catch {
      // Fire-safe.
    }
  }

  // 5. Reflex cache size: "I have N rules cached"
  if (state.reflexCache && state.reflexCache.rules.length > 0) {
    const content = `I have ${state.reflexCache.rules.length} reflex rules cached (arousal ${state.reflexCache.arousal.toFixed(2)}).`;
    try {
      await store.store({
        content,
        type: "self_model",
        scope: "project",
        confidence: 0.3,
        tags: ["self-episode", "reflex-state"],
        metadata: {
          category: "disposition",
          ruleCount: state.reflexCache.rules.length,
          arousal: state.reflexCache.arousal,
          source: "recordSelfEpisode",
        } as Record<string, unknown>,
      });
      written++;
    } catch {
      // Fire-safe.
    }
  }

  return written;
}

/**
 * Assemble the identity block from accumulated self_model rows. Replaces the
 * single-preference query at plugin.ts:465-476. Returns a tiered block per
 * §6 of the blueprint:
 *
 * - Tier 1 (core): top self_model rows by weight — stable for weeks,
 *   cache-friendly. Hard-capped at identityTokens * 0.6.
 * - Tier 2 (situational): per-task lessons + domain affect. Rebuilt each
 *   turn. Capped at identityTokens * 0.4.
 *
 * Traits + affect (Phases 10-11) will augment this block when they exist.
 * For now, it's self_model rows + the top user_preference (backward compat).
 */
export async function assembleIdentity(
  store: MemoryStore,
  opts: { identityTokens?: number; projectId?: string } = {},
): Promise<{ content: string; memoryIds: string[] }> {
  const tokenBudget = opts.identityTokens ?? 350;
  const tier1Budget = Math.round(tokenBudget * 0.6); // ~210 tokens
  const tier2Budget = tokenBudget - tier1Budget; // ~140 tokens

  const lines: string[] = [];
  const memoryIds: string[] = [];

  // Tier 1: top self_model rows by weight (dispositions the agent has earned).
  try {
    const selfResults = await store.search({
      types: ["self_model"],
      scope: "all",
      minWeight: 0.3,
      sortBy: "weight",
      sortOrder: "desc",
      limit: 5,
    });
    for (const r of selfResults.memories) {
      const line = `- ${r.content.slice(0, 120)}`;
      if (lines.join("\n").length + line.length > tier1Budget) break;
      lines.push(line);
      memoryIds.push(r.id);
    }
  } catch {
    // Self-model query failure is non-fatal — Tier 1 stays empty.
  }

  // Tier 1 fallback: if no self_model rows yet, use the top user_preference
  // (backward compat with the pre-Phase-9 identity slot).
  if (lines.length === 0) {
    try {
      const prefResults = await store.search({
        scope: "global",
        types: ["user_preference"],
        sortBy: "weight",
        sortOrder: "desc",
        limit: 1,
      });
      if (prefResults.memories.length > 0) {
        const m = prefResults.memories[0]!;
        lines.push(`- ${m.content.slice(0, 120)}`);
        memoryIds.push(m.id);
      }
    } catch {
      // Non-fatal.
    }
  }

  // Tier 2: top lesson_learned by weight (the situational context).
  try {
    const lessonResults = await store.search({
      types: ["lesson_learned"],
      scope: "all",
      minWeight: 0.3,
      sortBy: "weight",
      sortOrder: "desc",
      limit: 3,
    });
    const tier2Start = lines.length;
    for (const r of lessonResults.memories) {
      const line = `- ${r.content.slice(0, 100)}`;
      const tier2Len = lines.slice(tier2Start).join("\n").length;
      if (tier2Len + line.length > tier2Budget) break;
      lines.push(line);
      memoryIds.push(r.id);
    }
  } catch {
    // Non-fatal.
  }

  if (lines.length === 0) {
    return { content: "", memoryIds: [] };
  }

  return {
    content: lines.join("\n"),
    memoryIds,
  };
}
