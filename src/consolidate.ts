/**
 * Synthetic-brain Phase 6: schema formation (episodic-to-semantic consolidation).
 *
 * When >= N episodic memories cluster above a similarity threshold, synthesize
 * one abstract rule (`task_pattern`), link it `derived_from` each episode, then
 * let the episodes decay normally. The store converges on rules whose count
 * tracks the number of distinct things true about the project, not the number
 * of events.
 *
 * Design doc: docs/architecture/synthetic-brain.md §4.6.
 * Deliberative path (ADR-010): detached, async, runs on compaction. Fire-safe
 * — errors are caught and never thrown (INV-017).
 */

import { cosineSimilarity, embeddingFromBuffer } from "./similarity";
import type { Memory, MemoryScope, MemoryStoreConfig, StoreInput } from "./types";

/** A memory row with its embedding deserialized, for clustering. */
export interface ConsolidationCandidate {
  id: string;
  content: string;
  type: string;
  scope: string;
  weight: number;
  confidence: number;
  tags: string[];
  domain: string | null;
  embedding: Float32Array | null;
}

/**
 * Cluster of episodic memories that are semantically similar enough to
 * synthesize into a single abstract rule.
 */
export interface MemoryCluster {
  /** The episodes in this cluster (>= minCluster). */
  episodes: ConsolidationCandidate[];
  /** The representative (highest-weight) episode. */
  representative: ConsolidationCandidate;
}

/**
 * Find clusters of episodic memories by cosine similarity.
 *
 * Bounded scan: at most 1000 most-recently-touched active episodic memories
 * (types `lesson_learned`, `contextual_note`). Memories with an existing
 * `derived_from` edge to a `task_pattern` are skipped (idempotency).
 *
 * @param candidates - The episodic memories with embeddings to cluster.
 * @param threshold - Cosine similarity threshold (default 0.80). Inclusive (>=).
 * @param minCluster - Minimum cluster size to emit (default 3).
 * @returns Clusters with >= minCluster members above the threshold.
 */
export function findClusters(
  candidates: ConsolidationCandidate[],
  threshold: number = 0.80,
  minCluster: number = 3,
): MemoryCluster[] {
  // Only cluster memories that have embeddings.
  const withEmbeddings = candidates.filter((c) => c.embedding !== null);
  if (withEmbeddings.length < minCluster) return [];

  // Group by type first (same as dedupPass grouping).
  const byType = new Map<string, ConsolidationCandidate[]>();
  for (const c of withEmbeddings) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c);
  }

  const clusters: MemoryCluster[] = [];
  for (const [, group] of byType) {
    if (group.length < minCluster) continue;

    // Greedy clustering: for each unassigned memory, find all others above
    // the threshold. If the cluster has >= minCluster members, emit it.
    const assigned = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      if (assigned.has(group[i].id)) continue;
      const cluster: ConsolidationCandidate[] = [group[i]];
      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        if (assigned.has(group[j].id)) continue;
        const sim = cosineSimilarity(
          group[i].embedding!,
          group[j].embedding!,
        );
        // Inclusive threshold (>=).
        if (sim >= threshold) {
          cluster.push(group[j]);
        }
      }
      if (cluster.length >= minCluster) {
        // Mark all cluster members as assigned.
        for (const m of cluster) assigned.add(m.id);
        // The representative is the highest-weight episode.
        const representative = cluster.reduce((a, b) =>
          a.weight >= b.weight ? a : b,
        );
        clusters.push({ episodes: cluster, representative });
      }
    }
  }
  return clusters;
}

/**
 * Synthesize a `task_pattern` StoreInput from a cluster of episodic memories.
 *
 * The highest-weight episode's content is used as the rule content — the type
 * promotion from `lesson_learned` → `task_pattern` IS the abstraction. Future
 * phases could add LLM synthesis; this phase is the mechanical substrate.
 *
 * @param cluster - The cluster to synthesize from.
 * @returns A StoreInput ready for `MemoryStore.store()`.
 */
export function synthesizeRule(
  cluster: MemoryCluster,
): StoreInput {
  const episodes = cluster.episodes;
  const rep = cluster.representative;

  // Scope: if all project-scoped → project; mixed or all global → global.
  const allProject = episodes.every((e) => e.scope === "project");
  const scope: MemoryScope = allProject ? "project" : "global";

  // Tags: intersection of all episodes' tags.
  const tagIntersection = episodes.reduce<Set<string>>((acc, e, idx) => {
    if (idx === 0) return new Set(e.tags);
    for (const t of acc) {
      if (!e.tags.includes(t)) acc.delete(t);
    }
    return acc;
  }, new Set<string>());

  // Confidence: min(1.0, maxEpisodeConfidence + 0.1 * (clusterSize - 1)).
  const maxConfidence = Math.max(...episodes.map((e) => e.confidence));
  const confidence = Math.min(1.0, maxConfidence + 0.1 * (episodes.length - 1));

  return {
    content: rep.content,
    type: "task_pattern",
    scope,
    tags: Array.from(tagIntersection),
    domain: rep.domain ?? undefined,
    confidence,
    metadata: {
      synthesized: true,
      sourceEpisodeIds: episodes.map((e) => e.id),
      synthesizedAt: new Date().toISOString(),
    },
  };
}

/**
 * Run a full consolidation pass: cluster episodic memories, synthesize abstract
 * rules, link episodes via `derived_from`, and let episodes decay normally.
 *
 * @param store - The MemoryStore instance.
 * @param config - The store config (for thresholds).
 * @returns The number of rules synthesized. Fire-safe — never throws.
 */
export async function consolidatePass(
  store: {
    getConsolidationCandidates(): Promise<ConsolidationCandidate[]>;
    store(input: StoreInput): Promise<Memory>;
    relate(sourceId: string, targetId: string, type: "derived_from"): Promise<unknown>;
  },
  config: MemoryStoreConfig,
): Promise<number> {
  const brain = (config as { brain?: Record<string, unknown> }).brain ?? {};
  const threshold =
    typeof brain.schemaFormationThreshold === "number"
      ? brain.schemaFormationThreshold
      : 0.80;
  const minCluster =
    typeof brain.schemaFormationMinCluster === "number"
      ? brain.schemaFormationMinCluster
      : 3;

  try {
    const candidates = await store.getConsolidationCandidates();
    if (candidates.length === 0) return 0;

    // No embedding provider → no embeddings → no clustering possible.
    if (candidates.every((c) => c.embedding === null)) return 0;

    const clusters = findClusters(candidates, threshold, minCluster);
    if (clusters.length === 0) return 0;

    let rulesSynthesized = 0;
    for (const cluster of clusters) {
      try {
        const ruleInput = synthesizeRule(cluster);
        const rule = await store.store(ruleInput);
        // Link each episode to the rule via derived_from.
        for (const episode of cluster.episodes) {
          try {
            await store.relate(episode.id, rule.id, "derived_from");
          } catch {
            // DuplicateRelationshipError (idempotent) or MemoryNotFoundError — skip.
          }
        }
        rulesSynthesized++;
      } catch {
        // Skip this cluster on error — fire-safe (INV-017).
      }
    }
    return rulesSynthesized;
  } catch {
    // consolidatePass must never break the caller (INV-017 deliberative-path).
    return 0;
  }
}
