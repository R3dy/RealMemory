/**
 * Synthetic-brain Phase 3: working-memory window.
 *
 * A budgeted, slotted, rebuilt-per-turn injection that replaces the old
 * one-shot `pendingInjection` + never-re-inject `injectedMemoryIds` mechanism.
 *
 * The transform hook is synchronous — it cannot do async store queries. All
 * slot data is pre-staged in `state.workingMemory` by detached hooks
 * (`session.created`, `chat.message`, `tool.execute.after`). This module's
 * `assembleWorkingMemory` is a PURE function that reads the staged in-RAM data
 * and produces the formatted window string. No I/O, no side effects.
 *
 * See `docs/architecture/synthetic-brain.md` §4.2 for the design.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A staged slot of memory content, populated by detached hooks. */
export interface WorkingMemorySlot {
  /** Pre-formatted content string (already markdown). Empty string = slot not populated. */
  content: string;
  /** Memory IDs delivered in this slot (for injectedMemoryIds tracking). */
  memoryIds: string[];
}

/**
 * The staged slots, populated by detached hooks, consumed by the transform.
 *
 * activeLessons is split into two sub-slots to avoid the two-writer race
 * (review round-1 C4): chat.message assigns queriedLessons (detached store
 * query); tool.execute.after assigns freshLessons (the just-encoded lesson).
 * Neither overwrites the other. The assembler merges them at assembly time.
 *
 * openPredictions is reinterpreted from design doc §4.2's "unresolved
 * predictions" as "recently-surprising outcomes" (resolved predictions with
 * surprise >= 0.2 from lastPredictionOutcome). Genuinely-open predictions
 * (pendingPredictions) are near-empty at transform time because tool.execute.after
 * resolves within the same turn. The reinterpreted form is the useful brain-analog:
 * the just-fired surprise signal.
 *
 * Lifecycle (review round-2 2-C1 fix): tool.execute.after stages the surprise
 * (assignment). The NEXT transform consumes-and-clears the slot (delivery-then-
 * clear, mirroring pendingInjection today). A surprise from turn N's tool loop
 * is delivered on turn N+1's transform. NOT cleared at chat.message turn start
 * (that would make the slot write-only — the surprise is staged after the
 * turn's only transform and would be cleared before the next one can read it).
 */
export interface WorkingMemorySlots {
  identity: WorkingMemorySlot;
  taskFrame: WorkingMemorySlot;
  queriedLessons: WorkingMemorySlot;
  freshLessons: WorkingMemorySlot;
  openPredictions: WorkingMemorySlot;
}

/** An empty slot, used for initialization and clearing. */
export function emptySlot(): WorkingMemorySlot {
  return { content: "", memoryIds: [] };
}

/** An empty set of slots, used for initialization. */
export function emptySlots(): WorkingMemorySlots {
  return {
    identity: emptySlot(),
    taskFrame: emptySlot(),
    queriedLessons: emptySlot(),
    freshLessons: emptySlot(),
    openPredictions: emptySlot(),
  };
}

// ---------------------------------------------------------------------------
// Token estimation (zero-dep heuristic)
// ---------------------------------------------------------------------------

/** Token budget per slot (from design doc §4.2). */
export const SLOT_BUDGETS = {
  identity: 150,
  taskFrame: 200,
  activeLessons: 300, // merged queriedLessons + freshLessons, shared budget
  openPredictions: 150,
} as const;

/** Default total token budget for the working-memory window. */
export const DEFAULT_WORKING_MEMORY_TOKENS = 800;

/**
 * Zero-dep token estimate: ~4 chars/token (industry rough heuristic).
 * Over-estimating is safe (window is smaller than budget).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Window assembly (pure function — no I/O, no side effects)
// ---------------------------------------------------------------------------

/**
 * Truncate content to fit a token budget, cutting at line boundaries
 * (whole-line granularity — don't cut mid-sentence).
 */
function truncateToTokens(content: string, budget: number): string {
  if (estimateTokens(content) <= budget) return content;
  const lines = content.split("\n");
  let result = "";
  for (const line of lines) {
    const candidate = result ? result + "\n" + line : line;
    if (estimateTokens(candidate) > budget) break;
    result = candidate;
  }
  return result;
}

/**
 * Truncate content to fit a token budget, cutting at line boundaries.
 * Returns the truncated content AND the memory IDs that survived
 * (IDs whose content lines are still present).
 */
function truncateSlotContent(
  content: string,
  memoryIds: string[],
  budget: number,
): { content: string; survivingIds: string[] } {
  if (estimateTokens(content) <= budget) {
    return { content, survivingIds: memoryIds };
  }
  const truncated = truncateToTokens(content, budget);
  // If we have N memory IDs and M content lines, we can't precisely map
  // which IDs survived. Use a proportional heuristic: if content was
  // truncated to X% of its token size, keep the first ceil(N * X%) IDs.
  // This is imperfect but safe — the IDs are for dedup tracking, not
  // correctness-critical.
  const ratio = estimateTokens(truncated) / Math.max(estimateTokens(content), 1);
  const survivingCount = Math.ceil(memoryIds.length * ratio);
  return { content: truncated, survivingIds: memoryIds.slice(0, survivingCount) };
}

/**
 * Assemble the working-memory window from staged slots + pending warn note.
 * PURE function — no I/O, no side effects. Called from the synchronous
 * transform hook.
 *
 * - The warn note (C1 fix) is delivered even when all slots are empty —
 *   a non-null pendingWarnNote is by itself sufficient for a non-null result.
 *   The warn note is prepended to the "Active lessons" section and counts
 *   against the activeLessons budget (C15 fix).
 * - Each slot's content is truncated to its budget (whole-line granularity).
 * - Total window is capped at `workingMemoryTokens` (default 800).
 *   If total exceeds the budget, trim openPredictions first, then queriedLessons,
 *   then freshLessons (warn note protected). identity and taskFrame are protected.
 * - Returns the formatted window string (or null if all slots empty AND
 *   pendingWarnNote is null).
 * - deliveredMemoryIds contains only taskFrame IDs (C3 fix — preserves
 *   recall_hit_rate semantics; lastInjectedMemoryIds must measure recall only).
 */
export function assembleWorkingMemory(
  slots: WorkingMemorySlots,
  pendingWarnNote: string | null,
  config: { workingMemoryTokens?: number },
): { formatted: string | null; deliveredMemoryIds: string[] } {
  const totalBudget = config.workingMemoryTokens ?? DEFAULT_WORKING_MEMORY_TOKENS;

  // --- Step 1: Build the active-lessons section (warn note + queried + fresh) ---
  const activeLessonsBudget = SLOT_BUDGETS.activeLessons;
  let activeLessonsParts: string[] = [];
  let activeLessonsIds: string[] = [];

  if (pendingWarnNote) {
    activeLessonsParts.push(pendingWarnNote);
  }

  // queriedLessons + freshLessons merged: fresh first, then queried (per Story 36.1)
  if (slots.freshLessons.content) {
    activeLessonsParts.push(slots.freshLessons.content);
    activeLessonsIds.push(...slots.freshLessons.memoryIds);
  }
  if (slots.queriedLessons.content) {
    activeLessonsParts.push(slots.queriedLessons.content);
    activeLessonsIds.push(...slots.queriedLessons.memoryIds);
  }

  const activeLessonsRaw = activeLessonsParts.join("\n");
  let activeLessonsTruncated = truncateSlotContent(activeLessonsRaw, activeLessonsIds, activeLessonsBudget);

  // --- Step 2: Truncate each protected slot to its budget ---
  const identityTruncated = truncateSlotContent(
    slots.identity.content,
    slots.identity.memoryIds,
    SLOT_BUDGETS.identity,
  );
  const taskFrameTruncated = truncateSlotContent(
    slots.taskFrame.content,
    slots.taskFrame.memoryIds,
    SLOT_BUDGETS.taskFrame,
  );
  const openPredictionsTruncated = truncateSlotContent(
    slots.openPredictions.content,
    slots.openPredictions.memoryIds,
    SLOT_BUDGETS.openPredictions,
  );

  // --- Step 3: Check if all slots are empty AND no warn note ---
  const hasIdentity = identityTruncated.content.length > 0;
  const hasTaskFrame = taskFrameTruncated.content.length > 0;
  const hasActiveLessons = activeLessonsTruncated.content.length > 0;
  const hasOpenPredictions = openPredictionsTruncated.content.length > 0;
  const hasWarnNote = pendingWarnNote !== null && pendingWarnNote.length > 0;

  if (!hasIdentity && !hasTaskFrame && !hasActiveLessons && !hasOpenPredictions && !hasWarnNote) {
    return { formatted: null, deliveredMemoryIds: [] };
  }

  // --- Step 4: Total budget enforcement ---
  // Protected: identity (150) + taskFrame (200) = 350
  // Unprotected: activeLessons (300) + openPredictions (150) = 450
  // Total: 800 = default budget. If totalBudget < 800, trim unprotected.
  const protectedTokens = estimateTokens(identityTruncated.content) + estimateTokens(taskFrameTruncated.content);
  const remainingBudget = Math.max(0, totalBudget - protectedTokens);

  // Allocate remaining budget between activeLessons and openPredictions
  // activeLessons gets priority (it includes the warn note which is protected)
  const activeLessonsCurrent = estimateTokens(activeLessonsTruncated.content);
  const openPredictionsCurrent = estimateTokens(openPredictionsTruncated.content);

  let activeLessonsFinal = activeLessonsTruncated;
  let openPredictionsFinal = openPredictionsTruncated;

  if (activeLessonsCurrent + openPredictionsCurrent > remainingBudget) {
    // Trim openPredictions first
    const afterOpenPredictionsTrim = Math.max(0, remainingBudget - activeLessonsCurrent);
    if (openPredictionsCurrent > afterOpenPredictionsTrim) {
      openPredictionsFinal = truncateSlotContent(
        openPredictionsTruncated.content,
        openPredictionsTruncated.survivingIds,
        afterOpenPredictionsTrim,
      );
    }
    // If still over, trim queriedLessons (end-truncation of merged section)
    const stillOver = estimateTokens(activeLessonsFinal.content) + estimateTokens(openPredictionsFinal.content) > remainingBudget;
    if (stillOver) {
      const activeLessonsAllowed = remainingBudget - estimateTokens(openPredictionsFinal.content);
      activeLessonsFinal = truncateSlotContent(
        activeLessonsTruncated.content,
        activeLessonsTruncated.survivingIds,
        Math.max(0, activeLessonsAllowed),
      );
    }
  }

  // --- Step 5: Format the window ---
  const sections: string[] = ["## Working memory", ""];

  if (hasIdentity) {
    sections.push(identityTruncated.content);
    sections.push("");
  }

  if (hasTaskFrame) {
    sections.push("### Task");
    sections.push(taskFrameTruncated.content);
    sections.push("");
  }

  if (activeLessonsFinal.content.length > 0) {
    sections.push("### Active lessons");
    sections.push(activeLessonsFinal.content);
    sections.push("");
  }

  if (openPredictionsFinal.content.length > 0) {
    sections.push(openPredictionsFinal.content);
    sections.push("");
  }

  const formatted = sections.join("\n").trimEnd();

  // C3 fix: deliveredMemoryIds contains ONLY taskFrame IDs
  const deliveredMemoryIds = taskFrameTruncated.survivingIds;

  return { formatted, deliveredMemoryIds };
}
