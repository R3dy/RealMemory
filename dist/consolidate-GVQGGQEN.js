import {
  cosineSimilarity
} from "./chunk-B5S5KXU7.js";

// src/consolidate.ts
function findClusters(candidates, threshold = 0.8, minCluster = 3) {
  const withEmbeddings = candidates.filter((c) => c.embedding !== null);
  if (withEmbeddings.length < minCluster) return [];
  const byType = /* @__PURE__ */ new Map();
  for (const c of withEmbeddings) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type).push(c);
  }
  const clusters = [];
  for (const [, group] of byType) {
    if (group.length < minCluster) continue;
    const assigned = /* @__PURE__ */ new Set();
    for (let i = 0; i < group.length; i++) {
      if (assigned.has(group[i].id)) continue;
      const cluster = [group[i]];
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        if (assigned.has(group[j].id)) continue;
        const sim = cosineSimilarity(
          group[i].embedding,
          group[j].embedding
        );
        if (sim >= threshold) {
          cluster.push(group[j]);
        }
      }
      if (cluster.length >= minCluster) {
        for (const m of cluster) assigned.add(m.id);
        const representative = cluster.reduce(
          (a, b) => a.weight >= b.weight ? a : b
        );
        clusters.push({ episodes: cluster, representative });
      }
    }
  }
  return clusters;
}
function synthesizeRule(cluster) {
  const episodes = cluster.episodes;
  const rep = cluster.representative;
  const allProject = episodes.every((e) => e.scope === "project");
  const scope = allProject ? "project" : "global";
  const tagIntersection = episodes.reduce((acc, e, idx) => {
    if (idx === 0) return new Set(e.tags);
    for (const t of acc) {
      if (!e.tags.includes(t)) acc.delete(t);
    }
    return acc;
  }, /* @__PURE__ */ new Set());
  const maxConfidence = Math.max(...episodes.map((e) => e.confidence));
  const confidence = Math.min(1, maxConfidence + 0.1 * (episodes.length - 1));
  return {
    content: rep.content,
    type: "task_pattern",
    scope,
    tags: Array.from(tagIntersection),
    domain: rep.domain ?? void 0,
    confidence,
    metadata: {
      synthesized: true,
      sourceEpisodeIds: episodes.map((e) => e.id),
      synthesizedAt: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}
async function consolidatePass(store, config) {
  const brain = config.brain ?? {};
  const threshold = typeof brain.schemaFormationThreshold === "number" ? brain.schemaFormationThreshold : 0.8;
  const minCluster = typeof brain.schemaFormationMinCluster === "number" ? brain.schemaFormationMinCluster : 3;
  try {
    const candidates = await store.getConsolidationCandidates();
    if (candidates.length === 0) return 0;
    if (candidates.every((c) => c.embedding === null)) return 0;
    const clusters = findClusters(candidates, threshold, minCluster);
    if (clusters.length === 0) return 0;
    let rulesSynthesized = 0;
    for (const cluster of clusters) {
      try {
        const ruleInput = synthesizeRule(cluster);
        const rule = await store.store(ruleInput);
        for (const episode of cluster.episodes) {
          try {
            await store.relate(episode.id, rule.id, "derived_from");
          } catch {
          }
        }
        rulesSynthesized++;
      } catch {
      }
    }
    return rulesSynthesized;
  } catch {
    return 0;
  }
}
export {
  consolidatePass,
  findClusters,
  synthesizeRule
};
