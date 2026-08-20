/**
 * The trait vector (synthetic-self Phase 10).
 *
 * Temperament is currently a set of constants (`BLOCK_SALIENCE_FLOOR`,
 * `decayHalfLifeDays`, `AROUSAL_WEIGHT_CORRECTION`) — identical everywhere,
 * forever. This module makes them per-install state that drifts with
 * experience, giving the agent an organic personality that forms over months.
 *
 * Design rules (synthetic-self.md §4 Phase 10 + §9 risks):
 * - Six traits, each `0..1` with baseline `0.5`. Stored as a single `meta`
 *   row `traits:v1` (JSON). No schema change — `getMeta`/`setMeta` exist.
 * - EMA update rule, evaluated **once per session** at idle (never per turn):
 *   `trait <- clamp(0.15, 0.85, trait + alpha * (observed - trait))`, with a
 *   slow pull toward 0.5 when there is no supporting evidence. At alpha = 0.02
 *   a trait needs ~50 consistent sessions to move meaningfully.
 * - Traits shift existing constants within a clamped band, never replace them.
 *   `caution` moves `BLOCK_SALIENCE_FLOOR` within `0.8 +/- 0.1`; `tenacity`
 *   moves `decayHalfLifeDays` within `30 +/- 10`. The constants stay the
 *   center of the band.
 * - A trait may never move a value the user set explicitly in config. Only
 *   defaults drift (mirrors the existing arousal rule).
 * - Every drift emits a `trait.drift` brain event; when a trait crosses a 0.1
 *   boundary, a `self_model` row is written so "why are you like this?" has an
 *   answer in the store.
 * - OPT-IN: `brain.traits` defaults to `false`. This is the first phase that
 *   alters behavior on evidence the user did not review, so both ship gates
 *   (`--reset-self` + twin harness) land BEFORE the drift rule is wired.
 *
 * See `docs/architecture/synthetic-self.md` §4 Phase 10.
 */

import type { MemoryStore } from "./store";

/** The six traits, each `0..1` with baseline `0.5`. */
export type TraitName =
  | "caution"
  | "curiosity"
  | "skepticism"
  | "tenacity"
  | "thoroughness"
  | "tempo";

/** All trait names, in canonical order. */
export const TRAIT_NAMES: readonly TraitName[] = [
  "caution",
  "curiosity",
  "skepticism",
  "tenacity",
  "thoroughness",
  "tempo",
] as const;

/** A full trait vector. */
export type TraitVector = Record<TraitName, number>;

/** The baseline vector — every trait starts at 0.5. */
export const BASELINE_TRAITS: TraitVector = {
  caution: 0.5,
  curiosity: 0.5,
  skepticism: 0.5,
  tenacity: 0.5,
  thoroughness: 0.5,
  tempo: 0.5,
};

/** Meta key under which the trait vector is persisted. */
export const TRAITS_META_KEY = "traits:v1";

/** Clamp range for trait values (§4 Phase 10: `[0.15, 0.85]`). */
export const TRAIT_MIN = 0.15;
export const TRAIT_MAX = 0.85;

/** Default EMA learning rate (§4 Phase 10: `alpha <= 0.02`). */
export const DEFAULT_TRAIT_LEARNING_RATE = 0.02;

/** Max allowed learning rate (config validation ceiling). */
export const MAX_TRAIT_LEARNING_RATE = 0.05;

/**
 * Slow pull toward 0.5 applied per update when evidence is absent. Small so
 * that traits fade over many sessions rather than snapping back.
 */
const DECAY_TOWARD_BASELINE = 0.002;

/** Boundary (in trait-value units) that, when crossed, writes a self_model row. */
const BOUNDARY_BUCKET = 0.1;

/**
 * Validate + clamp a single trait value into `[TRAIT_MIN, TRAIT_MAX]`.
 * Non-finite values fall back to baseline (0.5).
 */
export function clampTrait(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, value));
}

/** Returns true if the given object is a well-formed TraitVector. */
export function isTraitVector(v: unknown): v is TraitVector {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  for (const name of TRAIT_NAMES) {
    const val = o[name];
    if (typeof val !== "number" || !Number.isFinite(val)) return false;
  }
  return true;
}

/** A safe baseline vector copy (defensive). */
export function baselineTraits(): TraitVector {
  return { ...BASELINE_TRAITS };
}

/**
 * Load the trait vector from the store. Returns the baseline if no row exists
 * or the row is corrupt. Never throws — traits are best-effort.
 */
export async function loadTraits(store: MemoryStore): Promise<TraitVector> {
  try {
    const raw = await store.getMeta(TRAITS_META_KEY);
    if (!raw) return baselineTraits();
    const parsed: unknown = JSON.parse(raw);
    if (!isTraitVector(parsed)) return baselineTraits();
    // Clamp every loaded value (guards against legacy/manual edits).
    const out = baselineTraits();
    for (const name of TRAIT_NAMES) {
      out[name] = clampTrait(parsed[name]);
    }
    return out;
  } catch {
    return baselineTraits();
  }
}

/**
 * Persist the trait vector to the store. Never throws.
 */
export async function saveTraits(
  store: MemoryStore,
  traits: TraitVector,
): Promise<void> {
  try {
    await store.setMeta(TRAITS_META_KEY, JSON.stringify(traits));
  } catch {
    // Fire-safe — trait persistence must never break session.idle.
  }
}

/**
 * Reset the trait vector to baseline and persist it. Returns the reset vector.
 */
export async function resetTraits(store: MemoryStore): Promise<TraitVector> {
  const baseline = baselineTraits();
  await saveTraits(store, baseline);
  return baseline;
}

// ---------------------------------------------------------------------------
// applyTraits — shift existing constants within a clamped band.
// ---------------------------------------------------------------------------

/**
 * The band each trait operates on: the constant name (center), the +/- band,
 * and the min/max the shifted value is clamped to. A trait value of 0.5
 * leaves the constant at its center; 0.85 pushes it to center + band; 0.15
 * pushes it to center - band.
 */
export interface TraitBand {
  /** The center (default) value of the constant. */
  center: number;
  /** How far the trait can push the constant in either direction. */
  band: number;
  /** Hard floor for the shifted value (independent of TRAIT_MIN). */
  min: number;
  /** Hard ceiling for the shifted value. */
  max: number;
}

/**
 * Band definitions. Maps each trait to the constant(s) it shifts. The keys are
 * the string names of the constants (used by applyTraits callers + tests).
 * Only `caution` and `tenacity` have bands today; the other four traits shift
 * behavior that is not yet a single numeric constant (or is threshold-based),
 * so their bands are wired incrementally. The vector still drifts and is
 * audited for all six — only the *wiring* is phased.
 */
export const TRAIT_BANDS: Partial<Record<TraitName, Record<string, TraitBand>>> = {
  caution: {
    BLOCK_SALIENCE_FLOOR: { center: 0.8, band: 0.1, min: 0.5, max: 0.95 },
  },
  tenacity: {
    decayHalfLifeDays: { center: 30, band: 10, min: 5, max: 90 },
  },
};

/**
 * Shift a single constant within its band, given a trait value in `[0.15, 0.85]`.
 * `trait = 0.5` -> center. `trait = 0.85` -> center + band. `trait = 0.15` ->
 * center - band. Clamped to `[band.min, band.max]`.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function shiftInBand(traitValue: number, band: TraitBand): number {
  const clampedTrait = clampTrait(traitValue);
  // Map [0.15, 0.85] -> [-1, 1] around 0.5.
  const normalized = (clampedTrait - 0.5) / (TRAIT_MAX - 0.5);
  const shifted = band.center + normalized * band.band;
  return Math.min(band.max, Math.max(band.min, shifted));
}

/**
 * Apply the trait vector to a set of default constants, returning the
 * effective values. Only constants whose names appear in `TRAIT_BANDS` and
 * are NOT overridden by the user's config are shifted.
 *
 * `userOverrides` is a map of constant-name -> user-set value. A constant that
 * the user set explicitly is returned verbatim (hard rule: a trait may never
 * move a value the user set).
 *
 * `defaults` is a map of constant-name -> default value (the center). Any
 * constant not in `defaults` and not overridden is skipped.
 */
export function applyTraits(
  traits: TraitVector,
  defaults: Record<string, number>,
  userOverrides: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = { ...defaults };
  for (const traitName of TRAIT_NAMES) {
    const bands = TRAIT_BANDS[traitName];
    if (!bands) continue;
    for (const [constName, band] of Object.entries(bands)) {
      // User override wins — traits never move user-set values.
      if (constName in userOverrides) {
        out[constName] = userOverrides[constName];
        continue;
      }
      // Only shift constants that are in the defaults map (i.e. the caller
      // knows about this constant). This keeps applyTraits additive — callers
      // opt in by passing the constant in `defaults`.
      if (constName in out) {
        out[constName] = shiftInBand(traits[traitName], band);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// updateTraits — the EMA drift rule.
// ---------------------------------------------------------------------------

/**
 * Per-trait observed signal for one session. `null` means "no evidence this
 * session" — the trait is pulled toward 0.5 by `DECAY_TOWARD_BASELINE`.
 * Values are in `[0, 1]` (same scale as the trait itself).
 */
export type TraitObservations = Partial<Record<TraitName, number | null>>;

/** The result of a single trait update — for auditing + events. */
export interface TraitUpdateResult {
  name: TraitName;
  before: number;
  after: number;
  observed: number | null;
  delta: number;
  /** True if the update crossed a 0.1 boundary (triggers a self_model row). */
  crossedBoundary: boolean;
}

/**
 * Update a single trait by the EMA rule.
 *
 * `observed === null` -> no evidence; pull toward 0.5 by `DECAY_TOWARD_BASELINE`.
 * `observed` in `[0,1]` -> `trait <- clamp(0.15, 0.85, trait + alpha * (observed - trait))`.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function updateOneTrait(
  before: number,
  observed: number | null,
  alpha: number,
): { after: number; delta: number } {
  const a = Math.min(MAX_TRAIT_LEARNING_RATE, Math.max(0, alpha));
  if (observed === null || !Number.isFinite(observed)) {
    // Slow pull toward 0.5 — traits fade rather than lock in.
    const towardBaseline = before + DECAY_TOWARD_BASELINE * (0.5 - before);
    const after = clampTrait(towardBaseline);
    return { after, delta: after - before };
  }
  const clampedObs = Math.min(1, Math.max(0, observed));
  const updated = before + a * (clampedObs - before);
  const after = clampTrait(updated);
  return { after, delta: after - before };
}

/**
 * Did this update cross a 0.1 bucket boundary? (e.g. 0.49 -> 0.52 crosses 0.5).
 * Used to decide whether to write a self_model row.
 */
export function crossedBoundaryBucket(before: number, after: number): boolean {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  const b = Math.floor(before / BOUNDARY_BUCKET);
  const a = Math.floor(after / BOUNDARY_BUCKET);
  return b !== a;
}

/**
 * Update the full trait vector from a session's observations. Pure — does not
 * persist or emit. Returns the new vector + per-trait results (for event
 * emission + self_model row decisions).
 *
 * @param traits  the current vector
 * @param obs     per-trait observations for this session (missing = no evidence)
 * @param alpha   learning rate (clamped to `[0, MAX_TRAIT_LEARNING_RATE]`)
 */
export function updateTraits(
  traits: TraitVector,
  obs: TraitObservations,
  alpha: number = DEFAULT_TRAIT_LEARNING_RATE,
): { vector: TraitVector; results: TraitUpdateResult[] } {
  const vector = { ...traits };
  const results: TraitUpdateResult[] = [];
  for (const name of TRAIT_NAMES) {
    const before = vector[name];
    const observed = obs[name] ?? null;
    const { after, delta } = updateOneTrait(before, observed, alpha);
    vector[name] = after;
    results.push({
      name,
      before,
      after,
      observed,
      delta,
      crossedBoundary: crossedBoundaryBucket(before, after),
    });
  }
  return { vector, results };
}

// ---------------------------------------------------------------------------
// Reset scope — what `--reset-self` can revert.
// ---------------------------------------------------------------------------

/** The scopes `--reset-self` can target. */
export type ResetSelfScope = "traits" | "affect" | "identity" | "all";

/** All valid reset scopes (for CLI parsing + validation). */
export const RESET_SCOPES: readonly ResetSelfScope[] = [
  "traits",
  "affect",
  "identity",
  "all",
] as const;

/** Meta keys for each reset scope. `identity` resets self_model memories. */
export const RESET_META_KEYS: Record<Exclude<ResetSelfScope, "all" | "identity">, string> = {
  traits: TRAITS_META_KEY,
  // Phase 11 will add `affect:v1`. Declared here so the CLI is forward-compatible.
  affect: "affect:v1",
};

/**
 * Parse the `--reset-self` scope argument. Accepts `--traits`, `--affect`,
 * `--identity`, `--all` (or `--reset-self=traits` etc.). Returns the scope or
 * null if not a reset-self invocation.
 */
export function parseResetScope(args: string[]): ResetSelfScope | null {
  for (const a of args) {
    if (a === "--reset-self" || a === "--reset-self=all") return "all";
    if (a === "--reset-self=traits" || a === "--traits") return "traits";
    if (a === "--reset-self=affect" || a === "--affect") return "affect";
    if (a === "--reset-self=identity" || a === "--identity") return "identity";
  }
  return null;
}
