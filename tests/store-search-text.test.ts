import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: "test-project",
    embeddingModel: null,
  });
  await store.init();
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-st-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MemoryStore.searchText", () => {
  it("returns memories matching the query via FTS5", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "AWS EC2 instances leaked billing", type: "lesson_learned" });
    const b = await store.store({ content: "Terraform plan destroys running resources", type: "codebase_fact" });
    await store.store({ content: "unrelated content about cooking", type: "contextual_note" });

    const results = await store.searchText("AWS billing");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.id === a.id)).toBe(true);
    expect(results.some((m) => m.id === b.id)).toBe(false);
    await store.close();
  });

  it("does NOT bump access_count (read-only)", async () => {
    const store = await freshStore();
    const m = await store.store({ content: "unique searchable phrase zzz", type: "contextual_note" });
    expect(m.accessCount).toBe(0);

    await store.searchText("unique searchable phrase zzz");
    await store.searchText("unique searchable phrase zzz");

    const after = await store.get(m.id, false);
    expect(after.memory.accessCount).toBe(0);
    await store.close();
  });

  it("returns [] for an empty / no-token query", async () => {
    const store = await freshStore();
    await store.store({ content: "some memory", type: "contextual_note" });
    expect(await store.searchText("")).toEqual([]);
    expect(await store.searchText("---***")).toEqual([]);
    await store.close();
  });

  it("respects the limit parameter", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5; i++) {
      await store.store({ content: `common keyword number ${i}`, type: "contextual_note" });
    }
    const results = await store.searchText("common keyword", 2);
    expect(results.length).toBe(2);
    await store.close();
  });
});

describe("MemoryStore.getRelationshipsForNodes", () => {
  it("returns edges where source OR target is in the set", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "memory a", type: "contextual_note" });
    const b = await store.store({ content: "memory b", type: "contextual_note" });
    const c = await store.store({ content: "memory c", type: "contextual_note" });
    await store.relate(a.id, b.id, "reinforces");
    await store.relate(c.id, a.id, "extends");

    const rels = await store.getRelationshipsForNodes([a.id, b.id]);
    expect(rels).toHaveLength(2);
    expect(rels.some((r) => r.sourceId === a.id && r.targetId === b.id)).toBe(true);
    expect(rels.some((r) => r.sourceId === c.id && r.targetId === a.id)).toBe(true);
    await store.close();
  });

  it("returns [] for an empty input set", async () => {
    const store = await freshStore();
    expect(await store.getRelationshipsForNodes([])).toEqual([]);
    await store.close();
  });
});

describe("MemoryStore.getStats", () => {
  it("returns aggregate counts", async () => {
    const store = await freshStore();
    await store.store({ content: "pref", type: "user_preference", scope: "global" });
    await store.store({ content: "fact", type: "codebase_fact" });
    const a = await store.store({ content: "lesson", type: "lesson_learned" });
    const b = await store.store({ content: "pattern", type: "task_pattern" });
    await store.relate(a.id, b.id, "extends");

    const stats = await store.getStats();
    expect(stats.totalMemories).toBe(4);
    expect(stats.byType.codebase_fact).toBe(1);
    expect(stats.byType.lesson_learned).toBe(1);
    expect(stats.byScope.global).toBe(1);
    expect(stats.byScope.project).toBe(3);
    expect(stats.totalRelationships).toBe(1);
    await store.close();
  });
});
