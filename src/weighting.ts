import type { Memory } from "./types";

/**
 * Compute the composite weight of a memory.
 * Weight = recencyFactor * relevanceFactor * frequencyFactor * confidenceFactor
 * Each factor is in [0, 1]. The product is also in [0, 1].
 *
 * Frequency uses a 0.5 baseline so a brand-new memory (0 accesses, 0 reinforcements)
 * gets frequencyFactor = 0.5, not 0 — ensuring fresh memories have non-zero weight.
 */
export function computeWeight(
  memory: Pick<Memory, "createdAt" | "accessCount" | "reinforcementCount" | "confidence">,
  relevanceScore: number,
  config: { decayHalfLifeDays: number },
): number {
  const recencyFactor = computeRecencyFactor(memory.createdAt, config.decayHalfLifeDays);
  const relevanceFactor = clamp01(relevanceScore);
  const frequencyFactor = computeFrequencyFactor(memory.accessCount, memory.reinforcementCount);
  const confidenceFactor = clamp01(memory.confidence);
  return clamp01(recencyFactor * relevanceFactor * frequencyFactor * confidenceFactor);
}

/**
 * Recency factor using exponential decay.
 * recencyFactor = exp(-ageDays / halfLifeDays)
 * A 0-day-old memory → factor = 1.0
 * A memory aged halfLifeDays → factor = exp(-1) ≈ 0.368
 * A memory aged 2*halfLifeDays → factor = exp(-2) ≈ 0.135
 */
export function computeRecencyFactor(createdAt: string, halfLifeDays: number): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / halfLifeDays);
}

/**
 * Frequency factor using logarithmic scaling (diminishing returns) with a 0.5 baseline.
 * frequencyFactor = 0.5 + 0.5 * (log(1 + accessCount + reinforcementCount) / log(1 + maxExpected))
 * A new memory (0,0) → 0.5 (baseline, not zero)
 * A memory accessed ~100 times → ~1.0
 */
export function computeFrequencyFactor(accessCount: number, reinforcementCount: number): number {
  const maxExpected = 100;
  const ratio = Math.log(1 + accessCount + reinforcementCount) / Math.log(1 + maxExpected);
  return clamp01(0.5 + 0.5 * ratio);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
