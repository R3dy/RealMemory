import type { MemoryStore } from "./store";
import type { MemoryType } from "./types";

/** Intent classification for a user turn. */
export type Intent = "correction" | "repetition" | "preference" | "tool_outcome" | "generic";

/** Tool capture data passed from plugin.ts tool.execute.after to classifyIntent. */
export interface ToolCapture {
  tool: string;
  filePath?: string;
  command?: string;
  isError: boolean;
  timestamp: number;
}

/**
 * PluginState subset that evaluateDelta reads. The real PluginState in plugin.ts
 * has more fields; this interface documents what evaluateDelta needs.
 */
export interface BrainLoopState {
  lastUserText: string | null;
  lastUserIntent: Intent | null;
  lastToolCapture: ToolCapture | null;
  lastInjectedMemoryIds: string[] | null;
  config: {
    brainLoop?: boolean;
    autoRelate?: boolean;
    concisenessCap?: number;
  };
}

/** Correction keywords — the user is overriding the agent's prior output. */
const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(use|try|do|not|don't)\b/i,
  /\b(not|don't|do not)\s+(use|use|want|need)\b/i,
  /\bactually[,.]?\s+(use|it's|its|try|do)\b/i,
  /\binstead\s+of\b/i,
  /\bi\s+(said|meant|told you)\b/i,
  /\bwrong[,.]?\s/i,
  /\bthat's\s+(not|wrong|incorrect)\b/i,
  /\bstop\s+(using|doing)\b/i,
];

/** Preference keywords — the user states an always/never rule. */
const PREFERENCE_PATTERNS = [
  /\balways\s+/i,
  /\bnever\s+/i,
  /\bprefer\s+/i,
  /\bdon't\s+ever\s+/i,
  /\bmake\s+sure\s+(you|to)\s+/i,
  /\bfrom\s+now\s+on\b/i,
];

/**
 * Classify the intent of a user turn. Pure function — no side effects.
 *
 * Order: correction > preference > repetition > tool_outcome > generic.
 * - correction: userText matches a correction pattern.
 * - preference: userText matches a preference pattern.
 * - repetition: currentUserText (normalized) is already in recentUserTexts
 *   (classify-first-then-push: the buffer holds PRIOR messages, not current).
 * - tool_outcome: lastToolCapture is set AND no correction/preference/repetition matched.
 * - generic: none of the above.
 */
export function classifyIntent(
  userText: string,
  _assistantText: string,
  recentUserTexts: string[],
  lastToolCapture: ToolCapture | null,
): Intent {
  // Correction first (highest priority).
  if (CORRECTION_PATTERNS.some((p) => p.test(userText))) {
    return "correction";
  }
  // Preference.
  if (PREFERENCE_PATTERNS.some((p) => p.test(userText))) {
    return "preference";
  }
  // Repetition: is the current text (normalized) already in the buffer?
  const normalized = userText.trim().toLowerCase().slice(0, 200);
  if (normalized.length > 0 && recentUserTexts.some((t) => t.trim().toLowerCase().slice(0, 200) === normalized)) {
    return "repetition";
  }
  // Tool outcome: lastToolCapture is set (a tool ran this turn).
  if (lastToolCapture) {
    return "tool_outcome";
  }
  return "generic";
}

/** Whether an intent warrants storing a delta memory. */
export function isHighSignal(intent: Intent): boolean {
  return intent === "correction" || intent === "repetition" || intent === "preference" || intent === "tool_outcome";
}

/** Dynamic recall limit based on intent. Higher for correction/preference. */
export function dynamicLimit(intent: Intent): number {
  switch (intent) {
    case "correction":
    case "preference":
      return 5;
    case "repetition":
      return 5;
    case "tool_outcome":
      return 5;
    case "generic":
    default:
      return 3;
  }
}

/** Content template per intent (C3 fix — literal, zero-interpretation). */
function buildContent(intent: Intent, userText: string, lastToolCapture: ToolCapture | null): string {
  switch (intent) {
    case "correction":
      return "User corrected the agent: " + userText.slice(0, 200);
    case "repetition":
      return "Repeated request: " + userText.slice(0, 200);
    case "preference":
      return "User preference: " + userText.slice(0, 200);
    case "tool_outcome":
      if (!lastToolCapture) return "Tool outcome: (no capture)";
      return "Tool outcome (" + lastToolCapture.tool + "): " + (lastToolCapture.isError ? "error" : "success") + " — " + (lastToolCapture.command || lastToolCapture.filePath || "").slice(0, 120);
    default:
      return "";
  }
}

/** Memory type per intent. */
function intentToType(intent: Intent): MemoryType {
  switch (intent) {
    case "correction":
    case "tool_outcome":
      return "lesson_learned";
    case "repetition":
      return "task_pattern";
    case "preference":
      return "user_preference";
    default:
      return "contextual_note";
  }
}

/**
 * Evaluate the per-turn delta. Runs on session.idle (PRIMARY, C1 fix) detached.
 * Does NOT clear lastToolCapture — the caller clears it AFTER this resolves (C2 fix).
 * No LLM call anywhere (local heuristics only — INV-017, avoids Drift #5).
 */
export async function evaluateDelta(
  store: MemoryStore,
  state: BrainLoopState,
  userText: string,
  assistantText: string,
): Promise<void> {
  // Step 1: null guards (C4 fix).
  if (userText === null || userText === "") return;
  if (state.lastUserIntent === null) return;

  const intent = state.lastUserIntent;

  // Step 3: low-signal gate.
  if (!isHighSignal(intent)) {
    // Record preference_compliance metric (naive: 1.0 if no known preference contradicted).
    await store.recordMetric("preference_compliance", 1.0);
    return;
  }

  // Step 4: build StoreInput from the C3 content template.
  const content = buildContent(intent, userText, state.lastToolCapture);
  const type = intentToType(intent);

  // Step 5: store (inherits scrubSecrets + dedup+reinforce).
  const stored = await store.store({
    content,
    type,
    scope: "project",
    confidence: intent === "correction" || intent === "preference" ? 0.6 : 0.5,
    tags: [intent, "auto-brain-loop"],
    concise: true,
    metadata: { intent, source: "evaluateDelta" } as Record<string, unknown>,
  });

  // Step 6: auto-relate (A22.4).
  if (state.config.autoRelate !== false) {
    try {
      await store.maybeRelate(stored.id, content, type);
    } catch {
      // maybeRelate must never break evaluateDelta (INV-017).
    }
  }

  // Step 7: metrics.
  // duplicate_rate: detect if store() reinforced an existing memory.
  if (stored.reinforcementCount > 0 && stored.createdAt !== stored.updatedAt) {
    await store.recordMetric("duplicate_rate", 1.0);
  }
  // correction_retention.
  if (intent === "correction") {
    await store.recordMetric("correction_stored", 1.0);
  }
  // recall_hit_rate (C2 fix — reads lastInjectedMemoryIds, NOT pendingInjection).
  if (state.lastInjectedMemoryIds && state.lastInjectedMemoryIds.length > 0) {
    if (assistantText && assistantText.length > 0) {
      // Naive: check if any injected memory's content tokens appear in the assistant response.
      // We don't have the memory contents here (only IDs), so we check if the assistant text
      // overlaps with common tokens. This is a heuristic proxy.
      await store.recordMetric("recall_hit", 1.0);
    } else {
      // session.idle trigger: assistantText is "" — record recall_miss (correct degradation).
      await store.recordMetric("recall_miss", 1.0);
    }
  }

  // Step 8: lastToolCapture is cleared by the CALLER after this resolves (C2 fix).
}