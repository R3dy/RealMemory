import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import { evaluateDelta, type BrainLoopState } from "../src/brain-loop";
import type { Memory, StoreInput, RelationshipEdge, MemoryType } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

/** Keyword-only store (no embedding provider) — deterministic FTS recall. */
async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    embeddingModel: null,
    recallThreshold: 0.3,
  });
  await store.init();
  return store;
}

/** Outgoing relationship edges of a memory (source -> target). */
async function outgoingEdges(
  store: MemoryStore,
  id: string,
): Promise<RelationshipEdge[]> {
  const got = await store.get(id, true);
  return got.relationships.filter((r) => r.direction === "outgoing");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-mayberelate-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MemoryStore.maybeRelate()", () => {
  it("returns 0 edges on an empty store", async () => {
    const store = await freshStore();
    const edges = await store.maybeRelate(
      "missing-id-0000000000",
      "debug zephyr queue backlog priority metric",
      "lesson_learned",
    );
    expect(edges).toBe(0);
    await store.close();
  });

  it("caps auto-relate at maxRelatedPerMemory (5 similar peers -> <= 3 edges)", async () => {
    const store = await freshStore();
    const source = await store.store({
      content: "zephyr queue backlog priority metric",
      type: "lesson_learned",
      scope: "project",
    });

    const peerCount = 5;
    for (const word of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      await store.store({
        content: `zephyr queue backlog priority metric ${word}`,
        type: "lesson_learned",
        scope: "project",
      });
    }

    const edges = await store.maybeRelate(source.id, source.content, source.type);
    expect(edges).toBeGreaterThan(0);
    expect(edges).toBeLessThanOrEqual(3);

    const out = await outgoingEdges(store, source.id);
    expect(out.length).toBe(edges);
    // Every edge points at a distinct peer — never the source (INV-007).
    const targetIds = out.map((r) => r.memory.id);
    expect(targetIds).not.toContain(source.id);
    expect(new Set(targetIds).size).toBe(targetIds.length);
    expect(peerCount).toBe(5);
    await store.close();
  });

  it("never creates self-relationships", async () => {
    const store = await freshStore();
    const source = await store.store({
      content: "zephyr queue backlog priority metric",
      type: "lesson_learned",
      scope: "project",
    });
    await store.store({
      content: "zephyr queue backlog beta priority metric",
      type: "lesson_learned",
      scope: "project",
    });

    // Must not throw SelfRelationshipError and must not create a self edge.
    const edges = await store.maybeRelate(source.id, source.content, source.type);
    expect(edges).toBeGreaterThan(0);
    const out = await outgoingEdges(store, source.id);
    expect(out.length).toBe(edges);
    expect(out.every((r) => r.memory.id !== source.id)).toBe(true);
    await store.close();
  });

  it("is idempotent — a second maybeRelate creates no duplicate edges", async () => {
    const store = await freshStore();
    const source = await store.store({
      content: "zephyr queue backlog priority metric",
      type: "lesson_learned",
      scope: "project",
    });
    await store.store({
      content: "zephyr queue backlog alpha priority metric",
      type: "lesson_learned",
      scope: "project",
    });
    await store.store({
      content: "zephyr queue backlog beta priority metric",
      type: "lesson_learned",
      scope: "project",
    });

    const first = await store.maybeRelate(source.id, source.content, source.type);
    expect(first).toBeGreaterThan(0);

    // Second pass: every candidate edge already exists — DuplicateRelationshipError
    // is swallowed, so zero new edges are created (INV-008 idempotent).
    const second = await store.maybeRelate(source.id, source.content, source.type);
    expect(second).toBe(0);

    const out = await outgoingEdges(store, source.id);
    expect(out.length).toBe(first);
    const keys = out.map((r) => `${r.memory.id}:${r.type}`);
    expect(new Set(keys).size).toBe(keys.length);
    await store.close();
  });

  describe("edge type selection", () => {
    it("uses derived_from when a lesson_learned relates to a user_preference", async () => {
      const store = await freshStore();
      const pref = await store.store({
        content: "zephyr always run tests before committing",
        type: "user_preference",
        scope: "project",
      });
      const lesson = await store.store({
        content: "zephyr always run tests before committing — lesson",
        type: "lesson_learned",
        scope: "project",
      });

      const edges = await store.maybeRelate(lesson.id, lesson.content, lesson.type);
      expect(edges).toBe(1);
      const out = await outgoingEdges(store, lesson.id);
      expect(out[0].type).toBe("derived_from");
      expect(out[0].memory.id).toBe(pref.id);
      await store.close();
    });

    it("uses derived_from when a lesson_learned relates to a task_pattern", async () => {
      const store = await freshStore();
      const pattern = await store.store({
        content: "zephyr run tests before committing pattern",
        type: "task_pattern",
        scope: "project",
      });
      const lesson = await store.store({
        content: "zephyr run tests before committing — lesson",
        type: "lesson_learned",
        scope: "project",
      });

      const edges = await store.maybeRelate(lesson.id, lesson.content, lesson.type);
      expect(edges).toBe(1);
      const out = await outgoingEdges(store, lesson.id);
      expect(out[0].type).toBe("derived_from");
      expect(out[0].memory.id).toBe(pattern.id);
      await store.close();
    });

    it("uses reinforces when source and candidate share the same type", async () => {
      const store = await freshStore();
      const a = await store.store({
        content: "zephyr queue backlog alpha",
        type: "lesson_learned",
        scope: "project",
      });
      const b = await store.store({
        content: "zephyr queue backlog beta",
        type: "lesson_learned",
        scope: "project",
      });

      const edges = await store.maybeRelate(a.id, a.content, a.type);
      expect(edges).toBe(1);
      const out = await outgoingEdges(store, a.id);
      expect(out[0].type).toBe("reinforces");
      expect(out[0].memory.id).toBe(b.id);
      await store.close();
    });

    it("defaults to extends when types differ without a lesson-derived rule", async () => {
      const store = await freshStore();
      const note = await store.store({
        content: "zephyr queue backlog note",
        type: "contextual_note",
        scope: "project",
      });
      const fact = await store.store({
        content: "zephyr queue backlog fact",
        type: "codebase_fact",
        scope: "project",
      });

      const edges = await store.maybeRelate(fact.id, fact.content, fact.type);
      expect(edges).toBe(1);
      const out = await outgoingEdges(store, fact.id);
      expect(out[0].type).toBe("extends");
      expect(out[0].memory.id).toBe(note.id);
      await store.close();
    });
  });
});

/* --------------- evaluateDelta auto-relate wiring (A22.4) --------------- */

describe("evaluateDelta auto-relate wiring", () => {
  function makeState(overrides: Partial<BrainLoopState> = {}): BrainLoopState {
    return {
      lastUserText: null,
      lastUserIntent: null,
      lastToolCapture: null,
      lastInjectedMemoryIds: null,
      config: { brainLoop: true, autoRelate: true },
      ...overrides,
    };
  }

  function makeMockStore() {
    const maybeRelate = vi.fn(async (_memoryId: string, _content: string, _type: MemoryType) => 0);
    const store = vi.fn(async (input: StoreInput): Promise<Memory> => {
      return {
        id: "mem-delta",
        content: String(input.content ?? ""),
        type: input.type ?? "contextual_note",
        scope: input.scope ?? "project",
        tags: input.tags ?? [],
        weight: 0.5,
        confidence: input.confidence ?? 0.5,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        accessCount: 0,
        reinforcementCount: 0,
        metadata: (input.metadata ?? {}) as Record<string, unknown>,
        status: "active",
      };
    });
    const recordMetric = vi.fn(async () => {});
    return {
      mock: {
        store,
        recordMetric,
        getBloatRatio: vi.fn(async () => 0),
        maybeRelate,
      } as unknown as MemoryStore,
      store,
      recordMetric,
      maybeRelate,
    };
  }

  it("calls maybeRelate after storing when autoRelate is enabled (default)", async () => {
    const { mock, store, maybeRelate } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({ lastUserIntent: "correction" }),
      "no, use postgres not mysql",
      "",
    );
    expect(store).toHaveBeenCalledTimes(1);
    expect(maybeRelate).toHaveBeenCalledTimes(1);
    expect(maybeRelate.mock.calls[0][0]).toBe("mem-delta");
    expect(maybeRelate.mock.calls[0][1]).toBe(
      "User corrected the agent: no, use postgres not mysql",
    );
    expect(maybeRelate.mock.calls[0][2]).toBe("lesson_learned");
  });

  it("does NOT call maybeRelate when config.autoRelate is false", async () => {
    const { mock, store, maybeRelate } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({
        lastUserIntent: "correction",
        config: { brainLoop: true, autoRelate: false },
      }),
      "no, use postgres not mysql",
      "",
    );
    expect(store).toHaveBeenCalledTimes(1);
    expect(maybeRelate).not.toHaveBeenCalled();
  });

  it("never lets a maybeRelate failure break evaluateDelta (INV-017)", async () => {
    const { mock, store, maybeRelate } = makeMockStore();
    maybeRelate.mockRejectedValueOnce(new Error("boom"));
    await expect(
      evaluateDelta(
        mock,
        makeState({ lastUserIntent: "correction" }),
        "no, use postgres not mysql",
        "",
      ),
    ).resolves.toBeUndefined();
    expect(store).toHaveBeenCalledTimes(1);
  });
});