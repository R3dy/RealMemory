import { M as MemoryStore } from './store-C7A06i_s.cjs';
import './types.cjs';

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

/** The six traits, each `0..1` with baseline `0.5`. */
type TraitName = "caution" | "curiosity" | "skepticism" | "tenacity" | "thoroughness" | "tempo";
/** All trait names, in canonical order. */
declare const TRAIT_NAMES: readonly TraitName[];
/** A full trait vector. */
type TraitVector = Record<TraitName, number>;
/** The baseline vector — every trait starts at 0.5. */
declare const BASELINE_TRAITS: TraitVector;
/** Meta key under which the trait vector is persisted. */
declare const TRAITS_META_KEY = "traits:v1";
/** Clamp range for trait values (§4 Phase 10: `[0.15, 0.85]`). */
declare const TRAIT_MIN = 0.15;
declare const TRAIT_MAX = 0.85;
/** Default EMA learning rate (§4 Phase 10: `alpha <= 0.02`). */
declare const DEFAULT_TRAIT_LEARNING_RATE = 0.02;
/** Max allowed learning rate (config validation ceiling). */
declare const MAX_TRAIT_LEARNING_RATE = 0.05;
/**
 * Validate + clamp a single trait value into `[TRAIT_MIN, TRAIT_MAX]`.
 * Non-finite values fall back to baseline (0.5).
 */
declare function clampTrait(value: number): number;
/** Returns true if the given object is a well-formed TraitVector. */
declare function isTraitVector(v: unknown): v is TraitVector;
/** A safe baseline vector copy (defensive). */
declare function baselineTraits(): TraitVector;
/**
 * Load the trait vector from the store. Returns the baseline if no row exists
 * or the row is corrupt. Never throws — traits are best-effort.
 */
declare function loadTraits(store: MemoryStore): Promise<TraitVector>;
/**
 * Persist the trait vector to the store. Never throws.
 */
declare function saveTraits(store: MemoryStore, traits: TraitVector): Promise<void>;
/**
 * Reset the trait vector to baseline and persist it. Returns the reset vector.
 */
declare function resetTraits(store: MemoryStore): Promise<TraitVector>;
/**
 * The band each trait operates on: the constant name (center), the +/- band,
 * and the min/max the shifted value is clamped to. A trait value of 0.5
 * leaves the constant at its center; 0.85 pushes it to center + band; 0.15
 * pushes it to center - band.
 */
interface TraitBand {
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
declare const TRAIT_BANDS: Partial<Record<TraitName, Record<string, TraitBand>>>;
/**
 * Shift a single constant within its band, given a trait value in `[0.15, 0.85]`.
 * `trait = 0.5` -> center. `trait = 0.85` -> center + band. `trait = 0.15` ->
 * center - band. Clamped to `[band.min, band.max]`.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
declare function shiftInBand(traitValue: number, band: TraitBand): number;
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
declare function applyTraits(traits: TraitVector, defaults: Record<string, number>, userOverrides?: Record<string, number>): Record<string, number>;
/**
 * Per-trait observed signal for one session. `null` means "no evidence this
 * session" — the trait is pulled toward 0.5 by `DECAY_TOWARD_BASELINE`.
 * Values are in `[0, 1]` (same scale as the trait itself).
 */
type TraitObservations = Partial<Record<TraitName, number | null>>;
/** The result of a single trait update — for auditing + events. */
interface TraitUpdateResult {
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
declare function updateOneTrait(before: number, observed: number | null, alpha: number): {
    after: number;
    delta: number;
};
/**
 * Did this update cross a 0.1 bucket boundary? (e.g. 0.49 -> 0.52 crosses 0.5).
 * Used to decide whether to write a self_model row.
 */
declare function crossedBoundaryBucket(before: number, after: number): boolean;
/**
 * Update the full trait vector from a session's observations. Pure — does not
 * persist or emit. Returns the new vector + per-trait results (for event
 * emission + self_model row decisions).
 *
 * @param traits  the current vector
 * @param obs     per-trait observations for this session (missing = no evidence)
 * @param alpha   learning rate (clamped to `[0, MAX_TRAIT_LEARNING_RATE]`)
 */
declare function updateTraits(traits: TraitVector, obs: TraitObservations, alpha?: number): {
    vector: TraitVector;
    results: TraitUpdateResult[];
};
/** The scopes `--reset-self` can target. */
type ResetSelfScope = "traits" | "affect" | "identity" | "all";
/** All valid reset scopes (for CLI parsing + validation). */
declare const RESET_SCOPES: readonly ResetSelfScope[];
/** Meta keys for each reset scope. `identity` resets self_model memories. */
declare const RESET_META_KEYS: Record<Exclude<ResetSelfScope, "all" | "identity">, string>;
/**
 * Parse the `--reset-self` scope argument. Accepts `--traits`, `--affect`,
 * `--identity`, `--all` (or `--reset-self=traits` etc.). Returns the scope or
 * null if not a reset-self invocation.
 */
declare function parseResetScope(args: string[]): ResetSelfScope | null;

export { BASELINE_TRAITS, DEFAULT_TRAIT_LEARNING_RATE, MAX_TRAIT_LEARNING_RATE, RESET_META_KEYS, RESET_SCOPES, type ResetSelfScope, TRAITS_META_KEY, TRAIT_BANDS, TRAIT_MAX, TRAIT_MIN, TRAIT_NAMES, type TraitBand, type TraitName, type TraitObservations, type TraitUpdateResult, type TraitVector, applyTraits, baselineTraits, clampTrait, crossedBoundaryBucket, isTraitVector, loadTraits, parseResetScope, resetTraits, saveTraits, shiftInBand, updateOneTrait, updateTraits };
