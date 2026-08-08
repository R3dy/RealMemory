import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import {
  MemoryNotFoundError,
  DuplicateRelationshipError,
  SelfRelationshipError,
} from "../src/errors";
import type { Memory, RelationshipType } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore({ storagePath: uniqueDbPath() });
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

const NO_SIDE_EFFECT_TYPES: RelationshipType[] = [
  "extends",
  "exception_to",
  "derived_from",
];

describe("MemoryStore.relate()", () => {
  it("creates a relationship and returns a Relationship with all fields", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    const rel = await store.relate(a.id, b.id, "extends");
    expect(rel.id).toEqual(expect.any(String));
    expect(rel.sourceId).toBe(a.id);
    expect(rel.targetId).toBe(b.id);
    expect(rel.type).toBe("extends");
    expect(rel.createdAt).toEqual(expect.any(String));
    await store.close();
  });

  it("shows the outgoing edge when getting source with includeRelationships=true", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    await store.relate(a.id, b.id, "extends");
    const got = await store.get(a.id, true);
    expect(got.relationships).toHaveLength(1);
    expect(got.relationships[0].direction).toBe("outgoing");
    expect(got.relationships[0].type).toBe("extends");
    expect(got.relationships[0].memory.id).toBe(b.id);
    await store.close();
  });

  it("shows the incoming edge when getting target with includeRelationships=true", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    await store.relate(a.id, b.id, "extends");
    const got = await store.get(b.id, true);
    expect(got.relationships).toHaveLength(1);
    expect(got.relationships[0].direction).toBe("incoming");
    expect(got.relationships[0].type).toBe("extends");
    expect(got.relationships[0].memory.id).toBe(a.id);
    await store.close();
  });

  it("throws MemoryNotFoundError when source does not exist", async () => {
    const store = await freshStore();
    const b = await store.store({ content: "B", type: "lesson_learned" });
    await expect(
      store.relate("NONEXISTENTID0000000000", b.id, "extends"),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    await store.close();
  });

  it("throws MemoryNotFoundError when target does not exist", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    await expect(
      store.relate(a.id, "NONEXISTENTID0000000000", "extends"),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    await store.close();
  });

  it("throws SelfRelationshipError when relating a memory to itself", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "lesson_learned" });
    await expect(store.relate(a.id, a.id, "extends")).rejects.toBeInstanceOf(
      SelfRelationshipError,
    );
    await store.close();
  });

  it("throws DuplicateRelationshipError for an identical (source, target, type) edge", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    await store.relate(a.id, b.id, "extends");
    await expect(store.relate(a.id, b.id, "extends")).rejects.toBeInstanceOf(
      DuplicateRelationshipError,
    );
    await store.close();
  });

  it("allows the same source+target with a different type", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    await store.relate(a.id, b.id, "extends");
    const rel = await store.relate(a.id, b.id, "derived_from");
    expect(rel.type).toBe("derived_from");
    const got = await store.get(a.id, true);
    expect(got.relationships).toHaveLength(2);
    await store.close();
  });

  describe('type === "reinforces"', () => {
    it("boosts the source's confidence with diminishing returns (0.5 -> 0.55)", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned", confidence: 0.5 }),
        store.store({ content: "B", type: "lesson_learned" }),
      ]);
      await store.relate(a.id, b.id, "reinforces");
      const got = await store.get(a.id, false);
      expect(got.memory.confidence).toBeCloseTo(0.55, 10);
      await store.close();
    });

    it("increments the source's reinforcementCount", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned", confidence: 0.5 }),
        store.store({ content: "B", type: "lesson_learned" }),
      ]);
      const before = a.reinforcementCount;
      await store.relate(a.id, b.id, "reinforces");
      const got = await store.get(a.id, false);
      expect(got.memory.reinforcementCount).toBe(before + 1);
      await store.close();
    });

    it("recomputes the source's weight (weight increases)", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned", confidence: 0.5 }),
        store.store({ content: "B", type: "lesson_learned" }),
      ]);
      const before = a.weight;
      await store.relate(a.id, b.id, "reinforces");
      const got = await store.get(a.id, false);
      expect(got.memory.weight).toBeGreaterThan(before);
      await store.close();
    });

    it("does NOT affect the target's confidence", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned", confidence: 0.5 }),
        store.store({ content: "B", type: "lesson_learned", confidence: 0.7 }),
      ]);
      await store.relate(a.id, b.id, "reinforces");
      const got = await store.get(b.id, false);
      expect(got.memory.confidence).toBe(b.confidence);
      await store.close();
    });
  });

  describe('type === "contradicts"', () => {
    it("decays the target's confidence by 10% of its current value (0.8 -> 0.72)", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned" }),
        store.store({ content: "B", type: "lesson_learned", confidence: 0.8 }),
      ]);
      await store.relate(a.id, b.id, "contradicts");
      const got = await store.get(b.id, false);
      expect(got.memory.confidence).toBeCloseTo(0.72, 10);
      await store.close();
    });

    it("recomputes the target's weight (weight decreases)", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned" }),
        store.store({ content: "B", type: "lesson_learned", confidence: 0.8 }),
      ]);
      const before = b.weight;
      await store.relate(a.id, b.id, "contradicts");
      const got = await store.get(b.id, false);
      expect(got.memory.weight).toBeLessThan(before);
      await store.close();
    });

    it("does NOT affect the source's confidence", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned", confidence: 0.6 }),
        store.store({ content: "B", type: "lesson_learned", confidence: 0.8 }),
      ]);
      await store.relate(a.id, b.id, "contradicts");
      const got = await store.get(a.id, false);
      expect(got.memory.confidence).toBe(a.confidence);
      await store.close();
    });
  });

  describe.each(NO_SIDE_EFFECT_TYPES)("type === %s", (t) => {
    it("has no confidence side effects on either memory", async () => {
      const store = await freshStore();
      const [a, b] = await Promise.all([
        store.store({ content: "A", type: "lesson_learned", confidence: 0.5 }),
        store.store({ content: "B", type: "lesson_learned", confidence: 0.7 }),
      ]);
      const beforeA = a.weight;
      const beforeB = b.weight;
      await store.relate(a.id, b.id, t);
      const gotA = await store.get(a.id, false);
      const gotB = await store.get(b.id, false);
      expect(gotA.memory.confidence).toBe(a.confidence);
      expect(gotA.memory.reinforcementCount).toBe(a.reinforcementCount);
      expect(gotA.memory.weight).toBe(beforeA);
      expect(gotB.memory.confidence).toBe(b.confidence);
      expect(gotB.memory.reinforcementCount).toBe(b.reinforcementCount);
      expect(gotB.memory.weight).toBe(beforeB);
      await store.close();
    });
  });

  it("throws MemoryNotFoundError when relating to an archived memory", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    await store.forget(b.id);
    await expect(store.relate(a.id, b.id, "extends")).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    await store.close();
  });

  it("throws MemoryNotFoundError when relating from an archived memory", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.store({ content: "A", type: "lesson_learned" }),
      store.store({ content: "B", type: "lesson_learned" }),
    ]);
    await store.forget(a.id);
    await expect(store.relate(a.id, b.id, "extends")).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    await store.close();
  });
});
