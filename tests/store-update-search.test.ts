import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import {
  InvalidConfidenceError,
  MemoryNotFoundError,
} from "../src/errors";
import type { Memory } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(opts?: { projectId?: string | null }): Promise<MemoryStore> {
  const store = new MemoryStore({ storagePath: uniqueDbPath(), projectId: opts?.projectId });
  await store.init();
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

describe("MemoryStore.update()", () => {
  it("updates content and bumps updated_at", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "old content", type: "lesson_learned" });
    // Ensure updated_at differs from created_at by waiting a tick of time.
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.update(mem.id, { content: "new content" });
    expect(updated.content).toBe("new content");
    expect(updated.updatedAt).not.toBe(mem.updatedAt);
    expect(updated.updatedAt).not.toBe(mem.createdAt);
    // Other fields unchanged.
    expect(updated.type).toBe(mem.type);
    expect(updated.confidence).toBe(mem.confidence);
    await store.close();
  });

  it("throws MemoryNotFoundError for a non-existent id", async () => {
    const store = await freshStore();
    await expect(
      store.update("NONEXISTENTID0000000000", { content: "x" }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    await store.close();
  });

  it("updates confidence to a valid value", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned", confidence: 0.5 });
    const updated = await store.update(mem.id, { confidence: 0.9 });
    expect(updated.confidence).toBe(0.9);
    await store.close();
  });

  it("throws InvalidConfidenceError when confidence > 1", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned" });
    await expect(store.update(mem.id, { confidence: 1.5 })).rejects.toBeInstanceOf(
      InvalidConfidenceError,
    );
    await store.close();
  });

  it("throws InvalidConfidenceError when confidence < 0", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned" });
    await expect(store.update(mem.id, { confidence: -0.2 })).rejects.toBeInstanceOf(
      InvalidConfidenceError,
    );
    await store.close();
  });

  it("replaces tags (not a merge)", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "x",
      type: "lesson_learned",
      tags: ["old", "stale"],
    });
    const updated = await store.update(mem.id, { tags: ["new", "fresh"] });
    expect(updated.tags).toEqual(["new", "fresh"]);
    // Verify persisted.
    const fetched = await store.get(mem.id);
    expect(fetched.memory.tags).toEqual(["new", "fresh"]);
    await store.close();
  });

  it("merges metadata with existing (existing keys preserved, new keys added, same keys overwritten)", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "x",
      type: "codebase_fact",
      metadata: { file: "src/a.ts", line: 10, keep: "preserved" },
    });
    const updated = await store.update(mem.id, {
      metadata: { line: 99, added: "new" },
    });
    expect(updated.metadata).toEqual({
      file: "src/a.ts",
      line: 99,
      keep: "preserved",
      added: "new",
    });
    // Verify persisted.
    const fetched = await store.get(mem.id);
    expect(fetched.memory.metadata).toEqual({
      file: "src/a.ts",
      line: 99,
      keep: "preserved",
      added: "new",
    });
    await store.close();
  });

  it("increments reinforcementCount when reinforce=true", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned", confidence: 0.5 });
    const updated = await store.update(mem.id, { reinforce: true });
    expect(updated.reinforcementCount).toBe(mem.reinforcementCount + 1);
    await store.close();
  });

  it("boosts confidence from 0.5 to 0.55 when reinforce=true", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned", confidence: 0.5 });
    const updated = await store.update(mem.id, { reinforce: true });
    expect(updated.confidence).toBeCloseTo(0.55, 10);
    await store.close();
  });

  it("boosts confidence from 0.9 to 0.91 when reinforce=true (diminishing returns)", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned", confidence: 0.9 });
    const updated = await store.update(mem.id, { reinforce: true });
    expect(updated.confidence).toBeCloseTo(0.91, 10);
    await store.close();
  });

  it("applies explicit confidence first, then reinforce boost on top", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned", confidence: 0.5 });
    // Set confidence to 0.8, then reinforce: 0.8 + 0.1 * (1 - 0.8) = 0.82.
    const updated = await store.update(mem.id, { confidence: 0.8, reinforce: true });
    expect(updated.confidence).toBeCloseTo(0.82, 10);
    expect(updated.reinforcementCount).toBe(mem.reinforcementCount + 1);
    await store.close();
  });

  it("scrubs secrets from new content before storing", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "contextual_note" });
    const updated = await store.update(mem.id, {
      content: "creds: AKIAIOSFODNN7EXAMPLE",
    });
    expect(updated.content).toBe("creds: [REDACTED]");
    const fetched = await store.get(mem.id);
    expect(fetched.memory.content).toBe("creds: [REDACTED]");
    await store.close();
  });

  it("always updates updated_at even with an empty patch", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "x", type: "lesson_learned" });
    const before = mem.updatedAt;
    // Wait a tick so the new ISO timestamp differs.
    await new Promise((r) => setTimeout(r, 10));
    const updated = await store.update(mem.id, {});
    expect(updated.updatedAt).not.toBe(before);
    // Other fields unchanged.
    expect(updated.content).toBe(mem.content);
    expect(updated.confidence).toBe(mem.confidence);
    expect(updated.tags).toEqual(mem.tags);
    expect(updated.metadata).toEqual(mem.metadata);
    expect(updated.reinforcementCount).toBe(mem.reinforcementCount);
    await store.close();
  });
});

describe("MemoryStore.search()", () => {
  async function seed(store: MemoryStore): Promise<Memory[]> {
    return Promise.all([
      store.store({
        content: "p1 high weight",
        type: "task_pattern",
        tags: ["x"],
        confidence: 0.9,
        scope: "project",
      }),
      store.store({
        content: "p2 mid weight",
        type: "lesson_learned",
        tags: ["y"],
        confidence: 0.5,
        scope: "project",
      }),
      store.store({
        content: "g1 low weight",
        type: "task_pattern",
        tags: ["x"],
        confidence: 0.3,
        scope: "global",
      }),
    ]);
  }

  it("returns all active memories with no filters", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({});
    expect(res.memories).toHaveLength(3);
    expect(res.total).toBe(3);
    expect(res.offset).toBe(0);
    expect(res.limit).toBe(50);
    await store.close();
  });

  it("filters by scope = project (only project-scoped)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ scope: "project" });
    expect(res.memories).toHaveLength(2);
    expect(res.memories.every((m) => m.scope === "project")).toBe(true);
    await store.close();
  });

  it("filters by scope = global (only global-scoped)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ scope: "global" });
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].scope).toBe("global");
    await store.close();
  });

  it("returns both scopes when scope = all", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ scope: "all" });
    expect(res.memories).toHaveLength(3);
    await store.close();
  });

  it("filters by types (multiple)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ types: ["task_pattern"] });
    expect(res.memories).toHaveLength(2);
    expect(res.memories.every((m) => m.type === "task_pattern")).toBe(true);
    await store.close();
  });

  it("filters by tags (OR semantics)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ tags: ["y"] });
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].tags).toContain("y");
    // OR: tag x matches 2.
    const resX = await store.search({ tags: ["x"] });
    expect(resX.memories).toHaveLength(2);
    // OR across multiple tags.
    const resBoth = await store.search({ tags: ["x", "y"] });
    expect(resBoth.memories).toHaveLength(3);
    await store.close();
  });

  it("filters by minWeight", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ minWeight: 0.2 });
    expect(res.memories.every((m) => m.weight >= 0.2)).toBe(true);
    expect(res.memories).toHaveLength(2);
    await store.close();
  });

  it("filters by createdAfter", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const memories = await seed(store);
    // Use the second memory's createdAt as the cutoff.
    const cutoff = memories[1].createdAt;
    const res = await store.search({ createdAfter: cutoff });
    expect(res.memories.every((m) => m.createdAt >= cutoff)).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(2);
    await store.close();
  });

  it("filters by createdBefore", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const memories = await seed(store);
    const cutoff = memories[1].createdAt;
    const res = await store.search({ createdBefore: cutoff });
    expect(res.memories.every((m) => m.createdAt <= cutoff)).toBe(true);
    expect(res.total).toBeGreaterThanOrEqual(1);
    await store.close();
  });

  it("filters by date range (createdAfter AND createdBefore)", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const memories = await seed(store);
    const after = memories[0].createdAt;
    const before = memories[2].createdAt;
    const res = await store.search({ createdAfter: after, createdBefore: before });
    expect(res.memories.every((m) => m.createdAt >= after && m.createdAt <= before)).toBe(true);
    await store.close();
  });

  it("filters by domain", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await store.store({ content: "aws lesson", type: "lesson_learned", domain: "aws" });
    await store.store({ content: "test lesson", type: "lesson_learned", domain: "testing" });
    const res = await store.search({ domain: "aws" });
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].domain).toBe("aws");
    await store.close();
  });

  it("filters by category", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await store.store({ content: "gotcha", type: "lesson_learned", category: "gotcha" });
    await store.store({ content: "cost", type: "lesson_learned", category: "cost" });
    const res = await store.search({ category: "gotcha" });
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0].category).toBe("gotcha");
    await store.close();
  });

  it("sorts by weight descending by default", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({});
    const weights = res.memories.map((m) => m.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    await store.close();
  });

  it("sorts by created ascending when sortBy=created & sortOrder=asc", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const res = await store.search({ sortBy: "created", sortOrder: "asc" });
    const createds = res.memories.map((m) => m.createdAt);
    expect(createds).toEqual([...createds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    await store.close();
  });

  it("paginates with limit + offset and returns correct total", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    await seed(store);
    const page1 = await store.search({ limit: 2, offset: 0 });
    expect(page1.memories).toHaveLength(2);
    expect(page1.total).toBe(3);
    const page2 = await store.search({ limit: 2, offset: 2 });
    expect(page2.memories).toHaveLength(1);
    expect(page2.total).toBe(3);
    // No overlap.
    const ids1 = page1.memories.map((m) => m.id);
    const ids2 = page2.memories.map((m) => m.id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    await store.close();
  });

  it("only returns active (non-archived) memories", async () => {
    const store = await freshStore({ projectId: "proj-1" });
    const memories = await seed(store);
    // Archive one.
    await store.forget(memories[0].id);
    const res = await store.search({});
    expect(res.memories).toHaveLength(2);
    expect(res.total).toBe(2);
    expect(res.memories.map((m) => m.id)).not.toContain(memories[0].id);
    await store.close();
  });
});
