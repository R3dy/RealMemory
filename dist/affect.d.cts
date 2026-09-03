import { M as MemoryStore } from './store-C7A06i_s.cjs';
import './types.cjs';

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

/** Meta key under which the affect state is persisted. */
declare const AFFECT_META_KEY = "affect:v1";
/** The per-domain affect record. */
interface DomainAffect {
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
type AffectState = Record<string, DomainAffect>;
/** Clamp a valence value to [-1, 1]. */
declare function clampValence(v: number): number;
/** Clamp an arousal value to [0, 1]. */
declare function clampArousal(v: number): number;
/** A safe empty affect state. */
declare function emptyAffect(): AffectState;
/** Returns true if the given object is a well-formed AffectState. */
declare function isAffectState(v: unknown): v is AffectState;
/**
 * Apply time-based decay to a single DomainAffect toward neutral, given the
 * current time. Valence decays toward 0; arousal decays toward 0. Uses
 * `computeRecencyFactor` (exp(-ageDays/halfLife)) so a domain untouched for
 * 30 days has its valence pulled to ~37% of its recorded value.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
declare function decayAffect(affect: DomainAffect, now?: Date, halfLifeDays?: number): DomainAffect;
/**
 * Record an affect observation for a domain. Updates valence (EMA toward the
 * observed) + arousal (EMA toward the observed) + n + updatedAt.
 *
 * `observed.valence` in [-1, 1]; `observed.arousal` in [0, 1]. A failure ->
 * negative valence + high arousal; a success -> positive valence + low arousal.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
declare function recordAffectOne(current: DomainAffect | undefined, domain: string, observed: {
    valence: number;
    arousal: number;
}, alpha?: number, now?: Date): DomainAffect;
/**
 * Load the affect state from the store. Returns an empty state if no row
 * exists or the row is corrupt. Never throws.
 */
declare function loadAffect(store: MemoryStore): Promise<AffectState>;
/**
 * Persist the affect state to the store. Never throws.
 */
declare function saveAffect(store: MemoryStore, state: AffectState): Promise<void>;
/**
 * Reset the affect state to empty and persist it. Returns the empty state.
 * Used by `--reset-self --affect`.
 */
declare function resetAffect(store: MemoryStore): Promise<AffectState>;
/**
 * Record an affect observation for a domain, persisting the updated state.
 * Returns the updated DomainAffect for that domain (or null if domain is
 * empty/invalid). Fire-safe.
 */
declare function recordAffect(store: MemoryStore, domain: string, observed: {
    valence: number;
    arousal: number;
}, alpha?: number): Promise<DomainAffect | null>;
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
declare function getAffectBias(valence: number): number;
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
declare function getAffectTemperatureClamp(valence: number, arousal: number): number;
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
declare function valenceTemperatureReduction(valence: number): number;
/**
 * Whether a domain's valence is "sustained negative" — enough to feed the
 * `caution` trait. Requires n >= minN and valence <= -threshold.
 * Pure function. Exported for unit testing.
 */
declare function isSustainedNegative(affect: DomainAffect | undefined, minN?: number, threshold?: number): boolean;
/**
 * Infer a technical domain from a file path. A best-effort heuristic mapping
 * common path segments to the domain taxonomy used by `memories.domain`. Used
 * by the plugin to attach session-level affect to a domain when no explicit
 * domain signal exists. Returns null for unknown paths (affect recording is
 * skipped — honest: no domain, no affect).
 *
 * Pure function. Exported for unit testing.
 */
declare function inferDomainFromPath(filePath: string): string | null;

export { AFFECT_META_KEY, type AffectState, type DomainAffect, clampArousal, clampValence, decayAffect, emptyAffect, getAffectBias, getAffectTemperatureClamp, inferDomainFromPath, isAffectState, isSustainedNegative, loadAffect, recordAffect, recordAffectOne, resetAffect, saveAffect, valenceTemperatureReduction };
