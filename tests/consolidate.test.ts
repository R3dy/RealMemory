import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import type { EmbeddingProvider } from "../src/embeddings";
import {
  findClusters,
  synthesizeRule,
  consolidatePass,
  type ConsolidationCandidate,
} from "../src/consolidate";
import type { StoreInput } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `consolidate-${generateUlid()}.db`);
}

/** Deterministic fake embedding provider: bag-of-words hashing. */
function fakeEmbeddingProvider(): EmbeddingProvider {
  return {
    model: "fake-bow",
    dimensions: 256,
    embed: async (text: string): Promise<Float32Array> => {
      const vec = new Float32Array(256);
      const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const t of tokens) {
        let hash = 0;
        for (let i = 0; i < t.length; i++) {
          hash = ((hash << 5) - hash + t.charCodeAt(i)) | 0;
        }
        vec[Math.abs(hash) % 256] = 1;
      }
      return vec;
    },
  };
}

vi.mock("../src/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings")>();
  return {
    ...actual,
    createEmbeddingProvider: vi.fn(async (config) => {
      if (!config.embeddingModel) return null;
      return fakeEmbeddingProvider();
    }),
  };
});

/** Build an embedding-mode store. */
async function embeddingStore(opts?: {
  projectId?: string | null;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId ?? "test-proj",
    embeddingModel: "fake-bow",
    recallThreshold: 0.0,
  });
  await store.init();
  return store;
}

/** Build a keyword-only store (no embedding provider). */
async function keywordStore(opts?: {
  projectId?: string | null;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId ?? "test-proj",
    embeddingModel: null,
    recallThreshold: 0.0,
  });
  await store.init();
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-consolidate-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("findClusters", () => {
  it("clusters memories above the threshold", () => {
    // 3 identical-content memories → cosine = 1.0 → cluster of 3
    const base: ConsolidationCandidate = {
      id: "a1",
      content: "AWS CLI requires AWS_PROFILE env var",
      type: "lesson_learned",
      scope: "project",
      weight: 0.5,
      confidence: 0.7,
      tags: ["aws", "cli"],
      domain: "aws",
      embedding: new Float32Array(256).fill(0),
    };
    base.embedding![0] = 1;
    base.embedding![1] = 1;

    const b: ConsolidationCandidate = { ...base, id: "a2", embedding: new Float32Array(base.embedding!) };
    const c: ConsolidationCandidate = { ...base, id: "a3", embedding: new Float32Array(base.embedding!) };
    const d: ConsolidationCandidate = {
      ...base,
      id: "a4",
      content: "Completely unrelated memory about gardening",
      embedding: new Float32Array(256).fill(0),
    };
    d.embedding![100] = 1;

    const clusters = findClusters([base, b, c, d], 0.80, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].episodes).toHaveLength(3);
    expect(clusters[0].episodes.map((e) => e.id)).toContain("a1");
  });

  it("emits no clusters when group is below minCluster", () => {
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const a: ConsolidationCandidate = {
      id: "x1",
      content: "test",
      type: "lesson_learned",
      scope: "project",
      weight: 0.5,
      confidence: 0.5,
      tags: [],
      domain: null,
      embedding,
    };
    const b: ConsolidationCandidate = { ...a, id: "x2" };

    // Only 2 similar memories, minCluster=3 → no clusters
    const clusters = findClusters([a, b], 0.80, 3);
    expect(clusters).toHaveLength(0);
  });

  it("threshold boundary: memory at exactly 0.80 is eligible (inclusive >=)", () => {
    // Two vectors with cosine similarity exactly ~0.80 is hard to craft
    // deterministically, so test that the threshold check is >= by using
    // identical vectors (similarity 1.0) and threshold 1.0.
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const a: ConsolidationCandidate = {
      id: "t1",
      content: "test a",
      type: "lesson_learned",
      scope: "project",
      weight: 0.5,
      confidence: 0.5,
      tags: [],
      domain: null,
      embedding,
    };
    const b: ConsolidationCandidate = { ...a, id: "t2" };
    const c: ConsolidationCandidate = { ...a, id: "t3" };

    // threshold=1.0, identical vectors → sim=1.0, which is >= 1.0 → eligible
    const clusters = findClusters([a, b, c], 1.0, 3);
    expect(clusters).toHaveLength(1);
  });

  it("returns empty when no memories have embeddings", () => {
    const a: ConsolidationCandidate = {
      id: "n1",
      content: "no embedding",
      type: "lesson_learned",
      scope: "project",
      weight: 0.5,
      confidence: 0.5,
      tags: [],
      domain: null,
      embedding: null,
    };
    const clusters = findClusters([a, a, a], 0.80, 3);
    expect(clusters).toHaveLength(0);
  });
});

describe("synthesizeRule", () => {
  it("produces a task_pattern StoreInput from a cluster", () => {
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const episodes: ConsolidationCandidate[] = [
      {
        id: "e1",
        content: "AWS CLI requires AWS_PROFILE env var",
        type: "lesson_learned",
        scope: "project",
        weight: 0.6,
        confidence: 0.7,
        tags: ["aws", "cli"],
        domain: "aws",
        embedding,
      },
      {
        id: "e2",
        content: "AWS SDK requires AWS_PROFILE env var",
        type: "lesson_learned",
        scope: "project",
        weight: 0.5,
        confidence: 0.6,
        tags: ["aws", "sdk"],
        embedding: new Float32Array(embedding),
      },
      {
        id: "e3",
        content: "AWS terraform requires AWS_PROFILE env var",
        type: "lesson_learned",
        scope: "project",
        weight: 0.4,
        confidence: 0.5,
        tags: ["aws", "terraform"],
        embedding: new Float32Array(embedding),
      },
    ];

    const rep = episodes.reduce((a, b) => (a.weight >= b.weight ? a : b));
    const rule = synthesizeRule({ episodes, representative: rep });

    expect(rule.type).toBe("task_pattern");
    expect(rule.scope).toBe("project");
    expect(rule.content).toBe("AWS CLI requires AWS_PROFILE env var"); // highest-weight rep
    expect(rule.tags).toEqual(["aws"]); // intersection
    expect(rule.domain).toBe("aws");
    // maxConfidence = 0.7, clusterSize = 3 → 0.7 + 0.1 * 2 = 0.9
    expect(rule.confidence).toBeCloseTo(0.9, 5);
  });

  it("caps confidence at 1.0 for large clusters", () => {
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const episodes: ConsolidationCandidate[] = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      content: "test",
      type: "lesson_learned",
      scope: "project",
      weight: 0.5,
      confidence: 0.95,
      tags: ["common"],
      domain: null,
      embedding,
    }));

    const rep = episodes[0];
    const rule = synthesizeRule({ episodes, representative: rep });
    // 0.95 + 0.1 * (12-1) = 0.95 + 1.1 = 2.05 → capped at 1.0
    expect(rule.confidence).toBe(1.0);
  });

  it("scope: mixed project + global → global", () => {
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const episodes: ConsolidationCandidate[] = [
      { id: "m1", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: [], domain: null, embedding },
      { id: "m2", content: "test", type: "lesson_learned", scope: "global", weight: 0.5, confidence: 0.5, tags: [], domain: null, embedding: new Float32Array(embedding) },
      { id: "m3", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: [], domain: null, embedding: new Float32Array(embedding) },
    ];

    const rep = episodes[0];
    const rule = synthesizeRule({ episodes, representative: rep });
    expect(rule.scope).toBe("global");
  });

  it("tags: empty intersection → empty array", () => {
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const episodes: ConsolidationCandidate[] = [
      { id: "t1", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: ["aws"], domain: null, embedding },
      { id: "t2", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: ["gcp"], domain: null, embedding: new Float32Array(embedding) },
      { id: "t3", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: ["azure"], domain: null, embedding: new Float32Array(embedding) },
    ];

    const rep = episodes[0];
    const rule = synthesizeRule({ episodes, representative: rep });
    expect(rule.tags).toEqual([]);
  });

  it("metadata includes synthesized flag, sourceEpisodeIds, and timestamp", () => {
    const embedding = new Float32Array(256).fill(0);
    embedding[0] = 1;

    const episodes: ConsolidationCandidate[] = [
      { id: "d1", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: [], domain: null, embedding },
      { id: "d2", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: [], domain: null, embedding: new Float32Array(embedding) },
      { id: "d3", content: "test", type: "lesson_learned", scope: "project", weight: 0.5, confidence: 0.5, tags: [], domain: null, embedding: new Float32Array(embedding) },
    ];

    const rep = episodes[0];
    const rule = synthesizeRule({ episodes, representative: rep });

    expect(rule.metadata).toBeDefined();
    expect((rule.metadata as Record<string, unknown>).synthesized).toBe(true);
    expect((rule.metadata as Record<string, unknown>).sourceEpisodeIds).toEqual(["d1", "d2", "d3"]);
    expect(typeof (rule.metadata as Record<string, unknown>).synthesizedAt).toBe("string");
  });
});

describe("consolidatePass (integration with MemoryStore)", () => {
  it("synthesizes a task_pattern rule from 3 similar lesson_learned memories", async () => {
    const store = await embeddingStore();

    // Store 3 similar memories (bag-of-words embedding → high cosine similarity).
    const content = "AWS CLI requires AWS_PROFILE environment variable to be set";
    await store.store({ content, type: "lesson_learned", scope: "project", tags: ["aws"], confidence: 0.7, domain: "aws" } as StoreInput);
    await store.store({ content: "AWS SDK requires AWS_PROFILE environment variable to be set", type: "lesson_learned", scope: "project", tags: ["aws"], confidence: 0.6, domain: "aws" } as StoreInput);
    await store.store({ content: "AWS terraform requires AWS_PROFILE environment variable to be set", type: "lesson_learned", scope: "project", tags: ["aws"], confidence: 0.5, domain: "aws" } as StoreInput);

    const rules = await consolidatePass(store, { embeddingModel: "fake-bow" } as never);
    expect(rules).toBeGreaterThanOrEqual(1);

    // Verify the rule was stored as a task_pattern.
    const search = await store.search({ query: content, types: ["task_pattern"] });
    expect(search.memories.length).toBeGreaterThanOrEqual(1);
    expect(search.memories[0].type).toBe("task_pattern");
  });

  it("returns 0 when no embedding provider is configured (keyword store)", async () => {
    const store = await keywordStore();

    await store.store({ content: "test lesson one", type: "lesson_learned", scope: "project", tags: [], confidence: 0.5 } as StoreInput);
    await store.store({ content: "test lesson two", type: "lesson_learned", scope: "project", tags: [], confidence: 0.5 } as StoreInput);
    await store.store({ content: "test lesson three", type: "lesson_learned", scope: "project", tags: [], confidence: 0.5 } as StoreInput);

    const rules = await consolidatePass(store, { embeddingModel: null } as never);
    expect(rules).toBe(0);
  });

  it("returns 0 on an empty store", async () => {
    const store = await embeddingStore();
    const rules = await consolidatePass(store, { embeddingModel: "fake-bow" } as never);
    expect(rules).toBe(0);
  });

  it("is idempotent: second pass on already-consolidated memories returns 0", async () => {
    const store = await embeddingStore();

    const content = "AWS requires AWS_PROFILE env var missing error";
    await store.store({ content, type: "lesson_learned", scope: "project", tags: ["aws"], confidence: 0.7 } as StoreInput);
    await store.store({ content: "AWS needs AWS_PROFILE env var missing error", type: "lesson_learned", scope: "project", tags: ["aws"], confidence: 0.6 } as StoreInput);
    await store.store({ content: "AWS demands AWS_PROFILE env var missing error", type: "lesson_learned", scope: "project", tags: ["aws"], confidence: 0.5 } as StoreInput);

    const first = await consolidatePass(store, { embeddingModel: "fake-bow" } as never);
    expect(first).toBeGreaterThanOrEqual(1);

    // Second pass: all episodes now have derived_from edges → skipped.
    const second = await consolidatePass(store, { embeddingModel: "fake-bow" } as never);
    expect(second).toBe(0);
  });

  it("is fire-safe: errors are caught and never thrown", async () => {
    const failingStore = {
      getConsolidationCandidates: vi.fn().mockRejectedValue(new Error("DB on fire")),
      store: vi.fn(),
      relate: vi.fn(),
    };

    const rules = await consolidatePass(failingStore as never, {} as never);
    expect(rules).toBe(0);
  });
});

describe("MemoryStore.getConsolidationCandidates", () => {
  it("returns active episodic memories with embeddings", async () => {
    const store = await embeddingStore();

    await store.store({ content: "lesson one", type: "lesson_learned", scope: "project", tags: ["test"], confidence: 0.5 } as StoreInput);
    await store.store({ content: "note one", type: "contextual_note", scope: "project", tags: ["test"], confidence: 0.5 } as StoreInput);
    await store.store({ content: "preference one", type: "user_preference", scope: "project", tags: ["test"], confidence: 0.5 } as StoreInput);

    const candidates = await store.getConsolidationCandidates();
    // Should include lesson_learned and contextual_note, but NOT user_preference.
    expect(candidates.length).toBe(2);
    expect(candidates.every((c) => c.type === "lesson_learned" || c.type === "contextual_note")).toBe(true);
  });

  it("excludes memories with existing derived_from edges to task_pattern", async () => {
    const store = await embeddingStore();

    // Store an episode + a task_pattern, link them.
    const episode = await store.store({ content: "lesson one", type: "lesson_learned", scope: "project", tags: [], confidence: 0.5 } as StoreInput);
    const rule = await store.store({ content: "abstract rule", type: "task_pattern", scope: "project", tags: [], confidence: 0.9 } as StoreInput);
    await store.relate(episode.id, rule.id, "derived_from");

    // Store a second unlinked episode.
    await store.store({ content: "lesson two unrelated", type: "lesson_learned", scope: "project", tags: [], confidence: 0.5 } as StoreInput);

    const candidates = await store.getConsolidationCandidates();
    // The linked episode should be excluded; only the unlinked one remains.
    expect(candidates.length).toBe(1);
    expect(candidates[0].content).toBe("lesson two unrelated");
  });
});
