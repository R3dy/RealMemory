import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { RecallEngine } from "../src/recall";
import { createEmbeddingProvider } from "../src/embeddings";
import type { EmbeddingProvider } from "../src/embeddings";
import { cosineSimilarity } from "../src/similarity";
import { generateUlid } from "../src/db/ulid";
import type { MemoryStoreConfig } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

/**
 * A store in keyword-only mode (no embedding model). Always works — no
 * network or model download required.
 */
async function keywordStore(opts?: { projectId?: string | null }): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId ?? null,
    embeddingModel: null,
  });
  await store.init();
  return store;
}

/**
 * Attempt a store with the local embedding model. Returns null if the model
 * can't be loaded (no network / download failure) so embedding tests can skip.
 */
async function embeddingStore(opts?: { projectId?: string | null }): Promise<MemoryStore | null> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId ?? null,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
  });
  await store.init();
  // If the provider failed to load, the store falls back to keyword-only.
  // Detect this by checking whether store() produces an embedding.
  const probe = await store.store({ content: "probe", type: "contextual_note" });
  const hasEmbedding = probe.embedding !== undefined && probe.embedding.length > 0;
  await store.forget(probe.id, true);
  if (!hasEmbedding) {
    await store.close();
    return null;
  }
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* --------------------------- cosineSimilarity --------------------------- */

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns 0 for zero vector", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1]))).toBe(0);
  });

  it("returns 0 for empty arrays", () => {
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
  });

  it("computes similarity for partially aligned vectors", () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([1, 0]);
    // cos = 1 / (sqrt(2) * 1) ≈ 0.707
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 4);
  });
});

/* --------------------------- createEmbeddingProvider --------------------------- */

describe("createEmbeddingProvider", () => {
  it("returns null when embeddingModel is empty (keyword-only mode)", async () => {
    const config: MemoryStoreConfig = { embeddingModel: null };
    const provider = await createEmbeddingProvider(config);
    expect(provider).toBeNull();
  });

  it("returns null when embeddingModel is undefined", async () => {
    const config: MemoryStoreConfig = {};
    const provider = await createEmbeddingProvider(config);
    expect(provider).toBeNull();
  });

  it("uses remote provider when embeddingApiUrl + embeddingApiKey are set", async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl = "";
    let calledAuth = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      calledAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const provider = await createEmbeddingProvider({
        embeddingApiUrl: "https://example.com/v1/",
        embeddingApiKey: "test-key",
        embeddingModel: "text-embedding-3-small",
      });
      expect(provider).not.toBeNull();
      expect(provider!.model).toBe("text-embedding-3-small");
      const vec = await provider!.embed("hello");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(3);
      expect(calledUrl).toBe("https://example.com/v1/embeddings");
      expect(calledAuth).toBe("Bearer test-key");
      expect(provider!.dimensions).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("remote provider throws on non-OK response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("error", { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;
    try {
      const provider = await createEmbeddingProvider({
        embeddingApiUrl: "https://example.com/v1",
        embeddingApiKey: "test-key",
      });
      expect(provider).not.toBeNull();
      await expect(provider!.embed("hello")).rejects.toThrow(/Embedding API error: 500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/* --------------------------- Embedding integration --------------------------- */

/**
 * Try to load the local embedding model. If it can't be downloaded (no
 * network, sandboxed CI), these tests pass with no assertions rather than
 * failing the suite.
 */
async function tryLocalProvider(): Promise<EmbeddingProvider | null> {
  try {
    const provider = await createEmbeddingProvider({
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      storagePath: uniqueDbPath(),
    });
    if (!provider) return null;
    // Probe: actually embed something to confirm the model loaded.
    await provider.embed("probe");
    return provider;
  } catch {
    return null;
  }
}

describe("local embedding provider", () => {
  // Model load from disk can be slow on first run; allow up to 30s per test.
  it("embeds text into a 384-dim Float32Array", async () => {
    const provider = await tryLocalProvider();
    if (!provider) return; // model unavailable — skip
    const vec = await provider.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
    expect(provider.dimensions).toBe(384);
  }, 30000);

  it("embeds same text twice with cosine similarity > 0.99", async () => {
    const provider = await tryLocalProvider();
    if (!provider) return;
    const a = await provider.embed("the quick brown fox");
    const b = await provider.embed("the quick brown fox");
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
  }, 30000);

  it("embeds different texts with cosine similarity < 0.9", async () => {
    const provider = await tryLocalProvider();
    if (!provider) return;
    const a = await provider.embed("the quick brown fox jumps over the lazy dog");
    const b = await provider.embed("quantum mechanics describes subatomic particles");
    expect(cosineSimilarity(a, b)).toBeLessThan(0.9);
  }, 30000);
});

/* --------------------------- Recall (keyword-only) --------------------------- */
// These always run — no embedding model required.

describe("recall (keyword-only mode)", () => {
  it("returns [] for an empty database", async () => {
    const store = await keywordStore();
    const results = await store.recall({ query: "anything" });
    expect(results).toEqual([]);
    await store.close();
  });

  it("returns keyword matches via FTS5", async () => {
    const store = await keywordStore();
    await store.store({
      content: "The user prefers tabs over spaces for indentation.",
      type: "user_preference",
    });
    await store.store({
      content: "Quantum entanglement is a physics phenomenon.",
      type: "codebase_fact",
    });
    const results = await store.recall({ query: "tabs indentation" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.content).toContain("tabs");
    expect(results[0].matchedBy).toBe("keyword");
    await store.close();
  });

  it("returns [] when no matches above threshold", async () => {
    const store = await keywordStore();
    await store.store({
      content: "The user prefers tabs over spaces.",
      type: "user_preference",
    });
    const results = await store.recall({ query: "quantum physics astronomy", threshold: 0.99 });
    expect(results).toEqual([]);
    await store.close();
  });

  it("respects scope filter (project memories not returned when scope=global)", async () => {
    const store = await keywordStore({ projectId: "proj-A" });
    await store.store({
      content: "Project-specific config uses tabs.",
      type: "user_preference",
      scope: "project",
    });
    await store.store({
      content: "Global standard uses spaces globally.",
      type: "user_preference",
      scope: "global",
    });
    const results = await store.recall({ query: "tabs spaces", scope: "global" });
    expect(results.every((r) => r.memory.scope === "global")).toBe(true);
    await store.close();
  });

  it("respects types filter", async () => {
    const store = await keywordStore();
    await store.store({
      content: "User likes tabs for indentation.",
      type: "user_preference",
    });
    await store.store({
      content: "Tabs are a UI component in web design.",
      type: "codebase_fact",
    });
    const results = await store.recall({
      query: "tabs",
      types: ["user_preference"],
    });
    expect(results.every((r) => r.memory.type === "user_preference")).toBe(true);
    await store.close();
  });

  it("respects tags filter", async () => {
    const store = await keywordStore();
    await store.store({
      content: "Use tabs for indentation in this project.",
      type: "user_preference",
      tags: ["coding-style"],
    });
    await store.store({
      content: "Tabs are also a navigation element.",
      type: "contextual_note",
      tags: ["ui"],
    });
    const results = await store.recall({
      query: "tabs",
      tags: ["coding-style"],
    });
    expect(results.every((r) => r.memory.tags.includes("coding-style"))).toBe(true);
    await store.close();
  });

  it("respects limit", async () => {
    const store = await keywordStore();
    for (let i = 0; i < 10; i++) {
      await store.store({
        content: `Memory about tabs and indentation number ${i}.`,
        type: "user_preference",
      });
    }
    const results = await store.recall({ query: "tabs indentation", limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
    await store.close();
  });

  it("increments access_count on matched memories", async () => {
    const store = await keywordStore();
    const mem = await store.store({
      content: "The user prefers tabs over spaces.",
      type: "user_preference",
    });
    expect(mem.accessCount).toBe(0);
    await store.recall({ query: "tabs" });
    const retrieved = await store.get(mem.id);
    expect(retrieved.memory.accessCount).toBe(1);
    await store.close();
  });

  it("includes related memories when traverse=true (default)", async () => {
    const store = await keywordStore();
    const mem1 = await store.store({
      content: "Use tabs for indentation.",
      type: "user_preference",
    });
    // mem2's content deliberately does NOT match "tabs indentation" so it
    // won't appear in the recall results — leaving it free to surface as a
    // related memory via traversal.
    const mem2 = await store.store({
      content: "Editor configuration file settings.",
      type: "codebase_fact",
    });
    await store.relate(mem1.id, mem2.id, "extends");
    const results = await store.recall({ query: "tabs indentation" });
    const hit = results.find((r) => r.memory.id === mem1.id);
    expect(hit).toBeDefined();
    expect(hit!.related.length).toBeGreaterThanOrEqual(1);
    expect(hit!.related.some((r) => r.id === mem2.id)).toBe(true);
    await store.close();
  });

  it("excludes related memories when traverse=false", async () => {
    const store = await keywordStore();
    const mem1 = await store.store({
      content: "Use tabs for indentation.",
      type: "user_preference",
    });
    const mem2 = await store.store({
      content: "Editor configuration file settings.",
      type: "codebase_fact",
    });
    await store.relate(mem1.id, mem2.id, "extends");
    const results = await store.recall({ query: "tabs indentation", traverse: false });
    const hit = results.find((r) => r.memory.id === mem1.id);
    expect(hit).toBeDefined();
    expect(hit!.related).toEqual([]);
    await store.close();
  });

  it("deduplicates related (a memory in results doesn't appear in related)", async () => {
    const store = await keywordStore();
    const mem1 = await store.store({
      content: "Use tabs for indentation here.",
      type: "user_preference",
    });
    const mem2 = await store.store({
      content: "Tabs indentation is the standard.",
      type: "codebase_fact",
    });
    await store.relate(mem1.id, mem2.id, "extends");
    // Both match "tabs indentation" — mem2 is in results, so it must NOT
    // appear in mem1's related list.
    const results = await store.recall({ query: "tabs indentation" });
    const hit1 = results.find((r) => r.memory.id === mem1.id);
    const hit2 = results.find((r) => r.memory.id === mem2.id);
    if (hit1 && hit2) {
      expect(hit1.related.some((r) => r.id === mem2.id)).toBe(false);
    }
    await store.close();
  });
});

/* --------------------------- RecallEngine wrapper --------------------------- */

describe("RecallEngine", () => {
  it("wraps MemoryStore.recall()", async () => {
    const store = await keywordStore();
    await store.store({
      content: "The user prefers tabs over spaces.",
      type: "user_preference",
    });
    const engine = new RecallEngine(store);
    const results = await engine.recall({ query: "tabs" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    await store.close();
  });
});

/* --------------------------- Recall (semantic, model-gated) --------------------------- */
// These run only if the local embedding model can be loaded.

describe("recall (semantic mode)", () => {
  let store: MemoryStore | null = null;

  afterEach(async () => {
    if (store) {
      await store.close();
      store = null;
    }
  });

  it("returns semantically similar memories with high score", async () => {
    store = await embeddingStore();
    if (!store) return; // skip if model unavailable
    await store.store({
      content: "The user prefers using tabs for code indentation.",
      type: "user_preference",
    });
    const results = await store.recall({ query: "what indentation style does the user like?" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.content).toContain("tabs");
    expect(results[0].matchedBy).toBe("semantic");
    // score = relevance * storedWeight. A fresh memory has weight ≈ 0.25
    // (frequency 0.5 × confidence 0.5), so even a strong semantic match
    // (~0.6-0.8 cosine sim) yields a composite score around 0.15-0.20.
    expect(results[0].score).toBeGreaterThan(0.1);
  }, 60000);

  it("does not return unrelated memories", async () => {
    store = await embeddingStore();
    if (!store) return;
    await store.store({
      content: "The user prefers using tabs for code indentation.",
      type: "user_preference",
    });
    const results = await store.recall({
      query: "quantum physics subatomic particles",
      threshold: 0.5,
    });
    expect(results.length).toBe(0);
  }, 60000);

  it("matchedBy is 'semantic' for embedding matches", async () => {
    store = await embeddingStore();
    if (!store) return;
    await store.store({
      content: "Always commit code with a descriptive message.",
      type: "user_preference",
    });
    const results = await store.recall({ query: "how should I write git commits?" });
    if (results.length > 0) {
      expect(results[0].matchedBy).toBe("semantic");
    }
  }, 60000);
});

/* --------------------------- store() embedding persistence --------------------------- */

describe("store() embedding persistence", () => {
  let store: MemoryStore | null = null;

  afterEach(async () => {
    if (store) {
      await store.close();
      store = null;
    }
  });

  it("stores an embedding when provider is available", async () => {
    store = await embeddingStore();
    if (!store) return;
    const mem = await store.store({
      content: "The user prefers tabs over spaces.",
      type: "user_preference",
    });
    expect(mem.embedding).toBeDefined();
    expect(mem.embedding!.length).toBe(384);
  }, 60000);

  it("does not store an embedding in keyword-only mode", async () => {
    store = await keywordStore();
    const mem = await store.store({
      content: "The user prefers tabs over spaces.",
      type: "user_preference",
    });
    expect(mem.embedding).toBeUndefined();
  });
});
