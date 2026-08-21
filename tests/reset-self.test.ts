import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../src/store";
import { parseArgs } from "../src/bin";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-reset-"));
  return join(dir, "test.db");
}

describe("archiveByType (store, Phase 10 --reset-self --identity)", () => {
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = uniqueDbPath();
    store = new MemoryStore({ storagePath: dbPath, projectId: "test" });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("archives all active memories of the given type", async () => {
    await store.store({
      content: "self fact 1",
      type: "self_model",
      scope: "project",
      tags: ["test"],
      confidence: 0.5,
      metadata: {},
    });
    await store.store({
      content: "self fact 2",
      type: "self_model",
      scope: "project",
      tags: ["test"],
      confidence: 0.5,
      metadata: {},
    });
    await store.store({
      content: "a lesson",
      type: "lesson_learned",
      scope: "project",
      tags: ["test"],
      confidence: 0.5,
      metadata: {},
    });

    const archived = await store.archiveByType("self_model");
    expect(archived).toBe(2);

    // Remaining self_model memories should be 0 active.
    const remaining = await store.search({
      types: ["self_model"],
      scope: "all",
      limit: 10,
    });
    expect(remaining.memories.length).toBe(0);

    // Lessons are untouched.
    const lessons = await store.search({
      types: ["lesson_learned"],
      scope: "all",
      limit: 10,
    });
    expect(lessons.memories.length).toBe(1);
  });

  it("is idempotent (already-archived rows are skipped)", async () => {
    await store.store({
      content: "self fact",
      type: "self_model",
      scope: "project",
      tags: ["test"],
      confidence: 0.5,
      metadata: {},
    });
    const first = await store.archiveByType("self_model");
    expect(first).toBe(1);
    const second = await store.archiveByType("self_model");
    expect(second).toBe(0);
  });
});

describe("bin.ts parseArgs (--reset-self parsing)", () => {
  it("parses --reset-self (scope all)", () => {
    const parsed = parseArgs(["node", "bin", "--reset-self"]);
    expect(parsed.resetSelf).toBe("all");
    expect(parsed.ui).toBe(false);
    expect(parsed.doctor).toBe(false);
  });

  it("parses --reset-self=traits", () => {
    const parsed = parseArgs(["node", "bin", "--reset-self=traits"]);
    expect(parsed.resetSelf).toBe("traits");
  });

  it("parses bare --identity", () => {
    const parsed = parseArgs(["node", "bin", "--identity"]);
    expect(parsed.resetSelf).toBe("identity");
  });

  it("reset-self is null when not present", () => {
    const parsed = parseArgs(["node", "bin", "--ui"]);
    expect(parsed.resetSelf).toBeNull();
  });

  it("still parses --ui + --doctor alongside reset-self absence", () => {
    const p1 = parseArgs(["node", "bin", "--ui", "--port=9400"]);
    expect(p1.ui).toBe(true);
    expect(p1.port).toBe(9400);
    const p2 = parseArgs(["node", "bin", "--doctor"]);
    expect(p2.doctor).toBe(true);
  });
});
