import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import type { EmbeddingProvider } from "../src/embeddings";
import type { MemoryType } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `xpromo-${generateUlid()}.db`);
}

/**
 * Open the SQLite file directly (read-only) and read the raw scope/project_id
 * columns, so tests can verify promotion at the DB layer — the public Memory
 * object does not expose project_id.
 */
function rawRow(
  storagePath: string,
  id: string,
): { scope: string; project_id: string | null } | undefined {
  const db = new Database(storagePath, { readonly: true });
  try {
    return db
      .prepare("SELECT scope, project_id FROM memories WHERE id = ?")
      .get(id) as { scope: string; project_id: string | null } | undefined;
  } finally {
    db.close();
  }
}

/**
 * Deterministic fake embedding provider for embedding-mode promotion tests.
 * Uses bag-of-words hashing: each lowercase word is hashed to one of 256
 * dimensions (set to 1). Identical text → identical vectors (cosine = 1.0).
 * Makes cosine-similarity dedup predictable and testable offline.
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

/** Build a keyword-mode store (embeddingModel: null) for FTS-based dedup. */
async function keywordStore(opts?: {
  storagePath?: string;
  projectId?: string | null;
  crossProjectPromotionThreshold?: number;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: opts?.storagePath ?? uniqueDbPath(),
    projectId: opts?.projectId ?? "proj-aaa",
    embeddingModel: null,
    recallThreshold: 0.0,
    crossProjectPromotionThreshold: opts?.crossProjectPromotionThreshold,
  });
  await store.init();
  return store;
}

/** Build an embedding-mode store (mocked provider). */
async function embeddingStore(opts?: {
  storagePath?: string;
  projectId?: string | null;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: opts?.storagePath ?? uniqueDbPath(),
    projectId: opts?.projectId ?? "proj-aaa",
    embeddingModel: "fake-bow",
    recallThreshold: 0.0,
  });
  await store.init();
  return store;
}

/**
 * Store the same content from two different project scopes on the same DB:
 * project A first, then project B (which hits the cross-project dedup path).
 * Returns the stores (caller closes), the originating memory, the B-side
 * result, and the shared storage path.
 */
async function reinforceAcrossProjects(opts: {
  storagePath: string;
  content: string;
  type?: MemoryType;
  threshold?: number;
}): Promise<{
  storeA: MemoryStore;
  storeB: MemoryStore;
  first: Awaited<ReturnType<MemoryStore["store"]>>;
  second: Awaited<ReturnType<MemoryStore["store"]>>;
  storagePath: string;
}> {
  const storeA = await keywordStore({
    storagePath: opts.storagePath,
    projectId: "proj-aaa",
    crossProjectPromotionThreshold: opts.threshold,
  });
  const first = await storeA.store({
    content: opts.content,
    type: opts.type ?? "user_preference",
  });

  const storeB = await keywordStore({
    storagePath: opts.storagePath,
    projectId: "proj-bbb",
    crossProjectPromotionThreshold: opts.threshold,
  });
  const second = await storeB.store({
    content: opts.content,
    type: opts.type ?? "user_preference",
  });

  return { storeA, storeB, first, second, storagePath: opts.storagePath };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-xpromo-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("cross-project promotion (issue #8)", () => {
  it("promotes a user_preference to global scope when the 2nd distinct project reinforces it", async () => {
    const storagePath = uniqueDbPath();
    const { storeA, storeB, first, second } = await reinforceAcrossProjects({
      storagePath,
      content: "Prefers feature flags over long-lived branches",
    });

    // The B-side store() returns the SAME memory (reinforced, not a new row).
    expect(second.id).toBe(first.id);
    expect(second.reinforcementCount).toBe(first.reinforcementCount + 1);

    // Promotion: scope=global at the API level and project_id=NULL at the DB.
    expect(second.scope).toBe("global");
    const row = rawRow(storagePath, first.id);
    expect(row?.scope).toBe("global");
    expect(row?.project_id).toBeNull();

    // The reinforcing project is tracked in metadata.
    const tracked = second.metadata.crossProjectReinforcements as string[];
    expect(tracked).toEqual(["proj-bbb"]);

    await storeA.close();
    await storeB.close();
  });

  it("does not promote below the threshold (only one distinct project reinforces)", async () => {
    const storagePath = uniqueDbPath();
    const storeA = await keywordStore({ storagePath, projectId: "proj-aaa" });
    await storeA.store({
      content: "Uses tabs for indentation",
      type: "user_preference",
    });
    // Same project re-stores the same content: a same-project reinforcement,
    // which is not a cross-project signal and must stay project-scoped.
    const again = await storeA.store({
      content: "Uses tabs for indentation",
      type: "user_preference",
    });

    expect(again.scope).toBe("project");
    const row = rawRow(storagePath, again.id);
    expect(row?.scope).toBe("project");
    expect(row?.project_id).toBe("proj-aaa");
    await storeA.close();
  });

  it("never auto-promotes codebase_fact, even with cross-project reinforcements", async () => {
    const storagePath = uniqueDbPath();
    const { storeA, storeB, first, second } = await reinforceAcrossProjects({
      storagePath,
      content: "Uses SQLite with WAL journal mode and an FTS5 index",
      type: "codebase_fact",
    });

    // Reinforced (deduped) but the scope boundary is preserved.
    expect(second.id).toBe(first.id);
    expect(second.scope).toBe("project");
    const row = rawRow(storagePath, first.id);
    expect(row?.scope).toBe("project");
    expect(row?.project_id).toBe("proj-aaa");

    // The cross-project signal is still tracked.
    const tracked = second.metadata.crossProjectReinforcements as string[];
    expect(tracked).toEqual(["proj-bbb"]);

    await storeA.close();
    await storeB.close();
  });

  it("reinforcing an already-global memory again is idempotent (no error, no re-promotion)", async () => {
    const storagePath = uniqueDbPath();
    const { storeA, storeB, first, second } = await reinforceAcrossProjects({
      storagePath,
      content: "Prefers incremental deploys over big-bang releases",
    });
    expect(second.scope).toBe("global");

    // Project B stores the same content again. The near-duplicate is now a
    // global memory (project_id null), so this is a plain reinforcement — it
    // must not error, must not create a second row, and must not re-promote.
    const third = await storeB.store({
      content: "Prefers incremental deploys over big-bang releases",
      type: "user_preference",
    });
    expect(third.id).toBe(second.id);
    expect(third.scope).toBe("global");
    expect(third.reinforcementCount).toBe(second.reinforcementCount + 1);

    const row = rawRow(storagePath, first.id);
    expect(row?.scope).toBe("global");
    expect(row?.project_id).toBeNull();

    const all = await storeB.list({ scope: "all", limit: 50 });
    expect(all.total).toBe(1);

    await storeA.close();
    await storeB.close();
  });

  it("respects a custom crossProjectPromotionThreshold (N=3)", async () => {
    const storagePath = uniqueDbPath();
    const storeA = await keywordStore({
      storagePath,
      projectId: "proj-aaa",
      crossProjectPromotionThreshold: 3,
    });
    const first = await storeA.store({
      content: "Prefers pair programming on Fridays",
      type: "user_preference",
    });
    await storeA.close();

    // Two distinct projects is below N=3 — still project-scoped.
    const storeB = await keywordStore({
      storagePath,
      projectId: "proj-bbb",
      crossProjectPromotionThreshold: 3,
    });
    const second = await storeB.store({
      content: "Prefers pair programming on Fridays",
      type: "user_preference",
    });
    expect(second.id).toBe(first.id);
    expect(second.scope).toBe("project");
    await storeB.close();

    // The third distinct project crosses the threshold.
    const storeC = await keywordStore({
      storagePath,
      projectId: "proj-ccc",
      crossProjectPromotionThreshold: 3,
    });
    const third = await storeC.store({
      content: "Prefers pair programming on Fridays",
      type: "user_preference",
    });
    expect(third.id).toBe(first.id);
    expect(third.scope).toBe("global");
    const row = rawRow(storagePath, first.id);
    expect(row?.scope).toBe("global");
    expect(row?.project_id).toBeNull();
    await storeC.close();
  });

  it("is visible from any project's list/search/recall at scope=all after promotion", async () => {
    const storagePath = uniqueDbPath();
    const { storeA, storeB, first, second } = await reinforceAcrossProjects({
      storagePath,
      content: "Prefers tabs for indentation",
    });
    expect(second.scope).toBe("global");
    await storeA.close();
    await storeB.close();

    // A brand-new project (never touched the memory) sees it at scope=all.
    const storeC = await keywordStore({ storagePath, projectId: "proj-ccc" });

    const listAll = await storeC.list({ scope: "all" });
    expect(listAll.memories.map((m) => m.id)).toContain(first.id);

    const searchAll = await storeC.search({ scope: "all", types: ["user_preference"] });
    expect(searchAll.memories.map((m) => m.id)).toContain(first.id);

    const recalled = await storeC.recall({ query: "Prefers tabs for indentation", scope: "all" });
    expect(recalled.map((r) => r.memory.id)).toContain(first.id);

    // It does not leak into another project's project-scoped list.
    const projectList = await storeC.list({ scope: "project" });
    expect(projectList.memories.map((m) => m.id)).not.toContain(first.id);

    await storeC.close();
  });

  it("promotes task_pattern via the embedding dedup path too", async () => {
    const storagePath = uniqueDbPath();
    const storeA = await embeddingStore({ storagePath, projectId: "proj-aaa" });
    const first = await storeA.store({
      content: "Prefers conventional commits for all feature work",
      type: "task_pattern",
    });
    await storeA.close();

    const storeB = await embeddingStore({ storagePath, projectId: "proj-bbb" });
    const second = await storeB.store({
      content: "Prefers conventional commits for all feature work",
      type: "task_pattern",
    });
    expect(second.id).toBe(first.id);
    expect(second.scope).toBe("global");
    const row = rawRow(storagePath, first.id);
    expect(row?.project_id).toBeNull();

    await storeB.close();
  });
});