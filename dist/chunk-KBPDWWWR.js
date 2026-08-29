// src/weighting.ts
function computeWeight(memory, relevanceScore, config) {
  const recencyFactor = computeRecencyFactor(memory.createdAt, config.decayHalfLifeDays);
  const relevanceFactor = clamp01(relevanceScore);
  const frequencyFactor = computeFrequencyFactor(memory.accessCount, memory.reinforcementCount);
  const confidenceFactor = clamp01(memory.confidence);
  return clamp01(recencyFactor * relevanceFactor * frequencyFactor * confidenceFactor);
}
function computeRecencyFactor(createdAt, halfLifeDays, now = /* @__PURE__ */ new Date()) {
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1e3 * 60 * 60 * 24);
  return Math.exp(-ageDays / halfLifeDays);
}
function computeFrequencyFactor(accessCount, reinforcementCount) {
  const maxExpected = 100;
  const ratio = Math.log(1 + accessCount + reinforcementCount) / Math.log(1 + maxExpected);
  return clamp01(0.5 + 0.5 * ratio);
}
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

export {
  computeWeight,
  computeRecencyFactor,
  computeFrequencyFactor
};
