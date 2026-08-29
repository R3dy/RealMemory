/**
 * Valence and persistent affect (synthetic-self Phase 11).
 *
 * Arousal (Phase 5) is ephemeral and answers "how bad", never "bad about what."
 * This module adds the second axis (valence: -1..1 per domain) and makes both
 * survive the session, stored in `meta` under `affect:v1`.
 *
 * Design rules (synthetic-self.md §4 Phase 11 + §9 risk #2):
 * - Per-domain `{ valence: -1..1, arousal: 0..1, n, updatedAt }`. Domain comes
 *   from the existing `memories.domain` column.
 * - Decays slowly toward neutral per elapsed day, reusing
 *   `computeRecencyFactor` from `weighting.ts` (no second decay curve).
 * - Affect drives ONLY: recall bias, chat.params temperature, trait updates,
 *   one identity line. NEVER tone of voice — "an agent that sounds frustrated
 *   is theater" (§7). This is the single most common failure mode of
 *   "synthetic personality" projects and is rejected explicitly.
 * - OPT-IN: `brain.affect` defaults to `false`.
 *
 * See `docs/architecture/synthetic-self.md` §4 Phase 11 + §7 (what not to drive).
 */

import type { MemoryStore } from "./store";
import { computeRecencyFactor } from "./weighting";

/** Meta key under which the affect state is persisted. */
export const AFFECT_META_KEY = "affect:v1";

/** Half-life (days) for affect decay toward neutral. Matches decayHalfLifeDays default. */
const AFFECT_DECAY_HALFLIFE_DAYS = 30;

/** The per-domain affect record. */
export interface DomainAffect {
  /** Valence: -1 (bad/negative) .. 1 (good/positive). 0 = neutral. */
  valence: number;
  /** Arousal: 0 (calm) .. 1 (high). Carried over from Phase 5 + updated here. */
  arousal: number;
  /** Number of observations recorded for this domain. */
  n: number;
  /** ISO timestamp of the last update (for decay). */
  updatedAt: string;
}

/** The full affect state: domain name -> DomainAffect. */
export type AffectState = Record<string, DomainAffect>;

/** Clamp a valence value to [-1, 1]. */
export function clampValence(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(-1, v));
}

/** Clamp an arousal value to [0, 1]. */
export function clampArousal(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** A safe empty affect state. */
export function emptyAffect(): AffectState {
  return {};
}

/** Returns true if the given object is a well-formed AffectState. */
export function isAffectState(v: unknown): v is AffectState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  for (const values of Object.values(o)) {
    if (typeof values !== "object" || values === null) return false;
    const d = values as Record<string, unknown>;
    if (typeof d.valence !== "number" || !Number.isFinite(d.valence)) return false;
    if (typeof d.arousal !== "number" || !Number.isFinite(d.arousal)) return false;
    if (typeof d.n !== "number" || !Number.isFinite(d.n)) return false;
    if (typeof d.updatedAt !== "string") return false;
  }
  return true;
}

/**
 * Apply time-based decay to a single DomainAffect toward neutral, given the
 * current time. Valence decays toward 0; arousal decays toward 0. Uses
 * `computeRecencyFactor` (exp(-ageDays/halfLife)) so a domain untouched for
 * 30 days has its valence pulled to ~37% of its recorded value.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function decayAffect(
  affect: DomainAffect,
  now: Date = new Date(),
  halfLifeDays: number = AFFECT_DECAY_HALFLIFE_DAYS,
): DomainAffect {
  const factor = computeRecencyFactor(affect.updatedAt, halfLifeDays, now);
  return {
    valence: clampValence(affect.valence * factor),
    arousal: clampArousal(affect.arousal * factor),
    n: affect.n,
    updatedAt: affect.updatedAt,
  };
}

/**
 * Record an affect observation for a domain. Updates valence (EMA toward the
 * observed) + arousal (EMA toward the observed) + n + updatedAt.
 *
 * `observed.valence` in [-1, 1]; `observed.arousal` in [0, 1]. A failure ->
 * negative valence + high arousal; a success -> positive valence + low arousal.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function recordAffectOne(
  current: DomainAffect | undefined,
  domain: string,
  observed: { valence: number; arousal: number },
  alpha: number = 0.1,
  now: Date = new Date(),
): DomainAffect {
  const prev = current ?? {
    valence: 0,
    arousal: 0,
    n: 0,
    updatedAt: now.toISOString(),
  };
  // Apply decay since last update, then EMA the new observation.
  const decayed = decayAffect(prev, now);
  const newValence = clampValence(
    decayed.valence + alpha * (clampValence(observed.valence) - decayed.valence),
  );
  const newArousal = clampArousal(
    decayed.arousal + alpha * (clampArousal(observed.arousal) - decayed.arousal),
  );
  return {
    valence: newValence,
    arousal: newArousal,
    n: prev.n + 1,
    updatedAt: now.toISOString(),
  };
}

/**
 * Load the affect state from the store. Returns an empty state if no row
 * exists or the row is corrupt. Never throws.
 */
export async function loadAffect(store: MemoryStore): Promise<AffectState> {
  try {
    const raw = await store.getMeta(AFFECT_META_KEY);
    if (!raw || raw === "") return emptyAffect();
    const parsed: unknown = JSON.parse(raw);
    if (!isAffectState(parsed)) return emptyAffect();
    return parsed;
  } catch {
    return emptyAffect();
  }
}

/**
 * Persist the affect state to the store. Never throws.
 */
export async function saveAffect(
  store: MemoryStore,
  state: AffectState,
): Promise<void> {
  try {
    await store.setMeta(AFFECT_META_KEY, JSON.stringify(state));
  } catch {
    // Fire-safe.
  }
}

/**
 * Reset the affect state to empty and persist it. Returns the empty state.
 * Used by `--reset-self --affect`.
 */
export async function resetAffect(store: MemoryStore): Promise<AffectState> {
  const empty = emptyAffect();
  await saveAffect(store, empty);
  return empty;
}

/**
 * Record an affect observation for a domain, persisting the updated state.
 * Returns the updated DomainAffect for that domain (or null if domain is
 * empty/invalid). Fire-safe.
 */
export async function recordAffect(
  store: MemoryStore,
  domain: string,
  observed: { valence: number; arousal: number },
  alpha: number = 0.1,
): Promise<DomainAffect | null> {
  if (!domain || typeof domain !== "string") return null;
  const state = await loadAffect(store);
  const updated = recordAffectOne(state[domain], domain, observed, alpha);
  state[domain] = updated;
  await saveAffect(store, state);
  return updated;
}

/**
 * The recall-bias adjustment for a domain. Negative valence lowers the
 * effective recall threshold (surface caution rules earlier); positive
 * valence raises it slightly (don't over-surface in a domain the agent is
 * confident in). The adjustment is bounded to [-0.15, 0.15] — a clamp, not a
 * replacement of the user's threshold.
 *
 * `effectiveThreshold = userThreshold + getAffectBias(valence)`. A valence of
 * -1 (very negative) biases the threshold DOWN by up to 0.15; valence of +1
 * biases it UP by up to 0.15; valence of 0 is neutral.
 *
 * Pure function. Exported for unit testing.
 */
export function getAffectBias(valence: number): number {
  const v = clampValence(valence);
  // effectiveThreshold = userThreshold + bias. Lower threshold = more recalls
  // (caution rules surface earlier). Negative valence -> negative bias ->
  // lower effective threshold. Bounded to [-0.15, 0.15].
  return v * 0.15;
}

/**
 * The temperature clamp for chat.params, extended by affect. The existing
 * arousal→temperature clamp (Phase 5) clamps temperature DOWN by up to 0.15.
 * This extends it: negative valence in the current domain also clamps DOWN
 * (more careful), positive valence leaves temperature alone (never raises
 * above the agent setting — mirrors the arousal rule).
 *
 * Returns the delta to apply to temperature (always <= 0 — never raises).
 * Pure function. Exported for unit testing.
 */
export function getAffectTemperatureClamp(valence: number, arousal: number): number {
  const v = clampValence(valence);
  const a = clampArousal(arousal);
  // Arousal clamps down (Phase 5). Negative valence clamps down further.
  // Combined: -(arousal * 0.15) - (v < 0 ? -v * 0.15 : 0), capped at -0.15 total.
  const arousalClamp = -a * 0.15;
  const valenceClamp = v < 0 ? v * 0.15 : 0; // v negative -> negative clamp
  const combined = Math.max(-0.15, arousalClamp + valenceClamp);
  return combined;
}

/**
 * The valence-only temperature reduction for chat.params (Phase 11). The
 * existing arousal→temperature clamp (Phase 5) is composed with this: negative
 * valence in the current domain clamps temperature DOWN further. Returns a
 * **positive** reduction (degrees to subtract). Always `>= 0` — affect never
 * raises temperature. Capped at 0.15.
 *
 * Pure function. Exported for unit testing. The combined arousal+valence clamp
 * (capped at -0.15) lives in `getAffectTemperatureClamp` for reference; the
 * plugin composes the two contributions separately so Phase 5 behavior is
 * unchanged when affect is off.
 */
export function valenceTemperatureReduction(valence: number): number {
  const v = clampValence(valence);
  if (v >= 0) return 0;
  return Math.min(0.15, -v * 0.15);
}

/**
 * Whether a domain's valence is "sustained negative" — enough to feed the
 * `caution` trait. Requires n >= minN and valence <= -threshold.
 * Pure function. Exported for unit testing.
 */
export function isSustainedNegative(
  affect: DomainAffect | undefined,
  minN: number = 3,
  threshold: number = -0.2,
): boolean {
  if (!affect || affect.n < minN) return false;
  return affect.valence <= threshold;
}

/**
 * Infer a technical domain from a file path. A best-effort heuristic mapping
 * common path segments to the domain taxonomy used by `memories.domain`. Used
 * by the plugin to attach session-level affect to a domain when no explicit
 * domain signal exists. Returns null for unknown paths (affect recording is
 * skipped — honest: no domain, no affect).
 *
 * Pure function. Exported for unit testing.
 */
export function inferDomainFromPath(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;
  const lower = filePath.toLowerCase();
  const map: Record<string, string> = {
    aws: "aws",
    terraform: "aws",
    ".tf": "aws",
    ec2: "aws",
    s3: "aws",
    lambda: "aws",
    realhax: "realhax",
    realvol: "realvol",
    realcode: "realcode",
    basecamp: "basecamp",
    realmemory: "realmemory",
    ".test.": "testing",
    "tests/": "testing",
    "test/": "testing",
    "__tests__": "testing",
    spec: "testing",
    vitest: "testing",
    playwright: "testing",
    opencode: "opencode",
    ".opencode": "opencode",
    "opencode.json": "opencode",
    docker: "tooling",
    dockerfile: "tooling",
    ".sh": "tooling",
    nginx: "tooling",
    guacamole: "realhax",
    supabase: "testing",
    prisma: "testing",
    stripe: "realvol",
    trpc: "realvol",
    hono: "realvol",
  };
  for (const [seg, domain] of Object.entries(map)) {
    if (lower.includes(seg)) return domain;
  }
  return null;
}
