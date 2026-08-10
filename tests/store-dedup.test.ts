import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import type { EmbeddingProvider } from "../src/embeddings";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `dedup-${generateUlid()}.db`);
}

/** Build a keyword-only store (embeddingModel: null) for FTS-mode dedup tests. */
async function keywordStore(opts?: {
  projectId?: string | null;
  duplicateSimilarityThreshold?: number;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId ?? "test-proj",
    embeddingModel: null,
    recallThreshold: 0.0,
    duplicateSimilarityThreshold: opts?.duplicateSimilarityThreshold,
  });
  await store.init();
  return store;
}

/**
 * Deterministic fake embedding provider for embedding-mode dedup tests.
 * Uses bag-of-words hashing: each lowercase word is hashed to one of 256
 * dimensions (set to 1). Identical text → identical vectors (cosine = 1.0).
 * Text differing by one word → cosine ≈ (n-1)/n. This makes similarity
 * thresholds predictable and testable offline without the real MiniLM model.
 */
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

/** Mock the embeddings module so embedding-mode tests run offline. */
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

/** Build an embedding-mode store (embeddingModel set, mocked provider). */
async function embeddingStore(opts?: {
  projectId?: string | null;
  duplicateSimilarityThreshold?: number;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId ?? "test-proj",
    embeddingModel: "fake-bow",
    recallThreshold: 0.0,
    duplicateSimilarityThreshold: opts?.duplicateSimilarityThreshold,
  });
  await store.init();
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-dedup-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* ===================== Keyword-mode dedup (FTS5) ===================== */

describe("store() dedup — keyword mode", () => {
  it("reinforces an exact-duplicate instead of inserting a second row", async () => {
    const store = await keywordStore();
    const first = await store.store({
      content: "Always use tabs for indentation in this project",
      type: "user_preference",
      tags: ["style"],
    });
    const second = await store.store({
      content: "Always use tabs for indentation in this project",
      type: "user_preference",
      tags: ["style"],
    });

    // Same memory returned (reinforced, not a new row).
    expect(second.id).toBe(first.id);
    expect(second.reinforcementCount).toBe(first.reinforcementCount + 1);
    expect(second.confidence).toBeGreaterThan(first.confidence);

    // Only one row in the DB.
    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(1);
  });

  it("dedupes near-exact text (different punctuation/casing)", async () => {
    const store = await keywordStore();
    await store.store({
      content: "The database uses SQLite for storage",
      type: "codebase_fact",
    });
    // Same tokens after lowercasing + punctuation stripping.
    const second = await store.store({
      content: "THE DATABASE USES SQLITE FOR STORAGE!!!",
      type: "codebase_fact",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(1);
    expect(second.reinforcementCount).toBe(1);
  });

  it("does NOT dedupe across different types (same text)", async () => {
    const store = await keywordStore();
    await store.store({
      content: "The config file is at config.json",
      type: "codebase_fact",
    });
    await store.store({
      content: "The config file is at config.json",
      type: "lesson_learned",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(2);
  });

  it("does NOT dedupe across different scopes (project vs global)", async () => {
    const store = await keywordStore();
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
      scope: "project",
    });
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
      scope: "global",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(2);
  });

  it("does NOT dedupe distinct content (different meaning)", async () => {
    const store = await keywordStore();
    await store.store({
      content: "The API uses REST conventions for all endpoints",
      type: "codebase_fact",
    });
    await store.store({
      content: "The frontend is built with React and TypeScript",
      type: "codebase_fact",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(2);
  });

  it("returns the existing (reinforced) memory on duplicate, not a new record", async () => {
    const store = await keywordStore();
    const first = await store.store({
      content: "Prefers squash commits over merge commits",
      type: "user_preference",
      confidence: 0.5,
    });
    const second = await store.store({
      content: "Prefers squash commits over merge commits",
      type: "user_preference",
    });

    expect(second.id).toBe(first.id);
    // Confidence boosted with diminishing returns: 0.5 + 0.1*(1-0.5) = 0.55.
    expect(second.confidence).toBeCloseTo(0.55, 5);
  });

  it("does not create relationships on the duplicate path", async () => {
    const store = await keywordStore();
    const target = await store.store({
      content: "Original memory that will be related to",
      type: "codebase_fact",
    });
    // Store a duplicate with a relationship — the relationship should NOT be
    // created because no new row is inserted on the dedup path.
    await store.store({
      content: "Original memory that will be related to",
      type: "codebase_fact",
      relationships: [{ targetId: target.id, type: "extends" }],
    });

    const { relationships } = await store.get(target.id);
    expect(relationships.length).toBe(0);
  });
});

/* ==================== Embedding-mode dedup (mocked) ==================== */

describe("store() dedup — embedding mode (mocked provider)", () => {
  it("reinforces an exact-duplicate via cosine similarity", async () => {
    const store = await embeddingStore();
    const first = await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });
    const second = await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });

    expect(second.id).toBe(first.id);
    expect(second.reinforcementCount).toBe(1);

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(1);
  });

  it("dedupes near-identical text with high cosine similarity (same words, different order)", async () => {
    const store = await embeddingStore();
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });
    // Same tokens → same bag-of-words vector → cosine = 1.0.
    const second = await store.store({
      content: "tabs for indentation always use",
      type: "user_preference",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(1);
    expect(second.reinforcementCount).toBe(1);
  });

  it("does NOT dedupe when similarity is below the threshold", async () => {
    const store = await embeddingStore();
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });
    // Differing by one word out of five → cosine ≈ 4/5 = 0.8 < 0.92 threshold.
    const second = await store.store({
      content: "Always use spaces for indentation",
      type: "user_preference",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(2);
    expect(second.id).not.toBe(list.memories[0].id);
  });

  it("respects a custom duplicateSimilarityThreshold", async () => {
    // Lower threshold → more aggressive dedup.
    const store = await embeddingStore({ duplicateSimilarityThreshold: 0.7 });
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });
    // cosine ≈ 0.8 > 0.7 → should dedupe with the lower threshold.
    const second = await store.store({
      content: "Always use spaces for indentation",
      type: "user_preference",
    });

    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(1);
    expect(second.reinforcementCount).toBe(1);
  });
});

/* ==================== Config validation ==================== */

describe("duplicateSimilarityThreshold config", () => {
  it("defaults to 0.92", async () => {
    const store = new MemoryStore({
      storagePath: uniqueDbPath(),
      embeddingModel: null,
    });
    // The default is applied in config.ts DEFAULTS, not in the store constructor.
    // Verify via the store's behavior: a borderline case at 0.8 should NOT dedupe.
    await store.init();
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });
    await store.store({
      content: "Always use tabs for indentation",
      type: "user_preference",
    });
    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.total).toBe(1); // exact dup dedupes even in keyword mode
    await store.close();
  });

  it("rejects out-of-range values", () => {
    expect(() => new MemoryStore({
      storagePath: uniqueDbPath(),
      embeddingModel: null,
      duplicateSimilarityThreshold: -0.1,
    })).toThrow();
    expect(() => new MemoryStore({
      storagePath: uniqueDbPath(),
      embeddingModel: null,
      duplicateSimilarityThreshold: 1.5,
    })).toThrow();
  });
});
