import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  computeWeight,
  computeRecencyFactor,
  computeFrequencyFactor,
} from "../src/weighting";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import type { Memory } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(opts?: {
  projectId?: string | null;
  decayHalfLifeDays?: number;
  archiveThreshold?: number;
}): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: opts?.projectId,
    decayHalfLifeDays: opts?.decayHalfLifeDays,
    archiveThreshold: opts?.archiveThreshold,
  });
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

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("computeRecencyFactor", () => {
  it("returns ~1.0 for a 0-day-old memory", () => {
    const factor = computeRecencyFactor(new Date().toISOString(), 30);
    expect(factor).toBeCloseTo(1.0, 1);
  });

  it("returns ~0.368 (exp(-1)) for a 30-day-old memory with halfLife=30", () => {
    const factor = computeRecencyFactor(daysAgoIso(30), 30);
    expect(factor).toBeCloseTo(Math.exp(-1), 1);
  });

  it("returns ~0.135 (exp(-2)) for a 60-day-old memory with halfLife=30", () => {
    const factor = computeRecencyFactor(daysAgoIso(60), 30);
    expect(factor).toBeCloseTo(Math.exp(-2), 1);
  });
});

describe("computeFrequencyFactor", () => {
  it("returns a non-zero baseline for (0, 0)", () => {
    const factor = computeFrequencyFactor(0, 0);
    expect(factor).toBeGreaterThan(0);
    expect(factor).toBeCloseTo(0.5, 5);
  });

  it("returns a higher factor for (10, 0) than (0, 0)", () => {
    expect(computeFrequencyFactor(10, 0)).toBeGreaterThan(computeFrequencyFactor(0, 0));
  });

  it("returns near 1.0 for (100, 50)", () => {
    const factor = computeFrequencyFactor(100, 50);
    expect(factor).toBeGreaterThan(0.9);
    expect(factor).toBeLessThanOrEqual(1);
  });
});

describe("computeWeight", () => {
  it("returns a high weight for a fresh memory with confidence 0.9", () => {
    const weight = computeWeight(
      { createdAt: new Date().toISOString(), accessCount: 0, reinforcementCount: 0, confidence: 0.9 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    // ~1.0 (recency) * 1.0 (relevance) * 0.5 (freq baseline) * 0.9 = ~0.45
    expect(weight).toBeGreaterThan(0.3);
  });

  it("returns a lower weight for an old memory (60 days, confidence 0.5)", () => {
    const freshWeight = computeWeight(
      { createdAt: new Date().toISOString(), accessCount: 0, reinforcementCount: 0, confidence: 0.5 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    const oldWeight = computeWeight(
      { createdAt: daysAgoIso(60), accessCount: 0, reinforcementCount: 0, confidence: 0.5 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    expect(oldWeight).toBeLessThan(freshWeight);
  });

  it("returns a higher weight for a frequently accessed memory vs unaccessed", () => {
    const createdAt = new Date().toISOString();
    const unaccessed = computeWeight(
      { createdAt, accessCount: 0, reinforcementCount: 0, confidence: 0.8 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    const accessed = computeWeight(
      { createdAt, accessCount: 50, reinforcementCount: 20, confidence: 0.8 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    expect(accessed).toBeGreaterThan(unaccessed);
  });

  it("clamps the result to [0, 1]", () => {
    const weight = computeWeight(
      { createdAt: new Date().toISOString(), accessCount: 1e9, reinforcementCount: 1e9, confidence: 1 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    expect(weight).toBeGreaterThanOrEqual(0);
    expect(weight).toBeLessThanOrEqual(1);
  });
});

describe("MemoryStore store() with weight", () => {
  it("stores a memory with non-zero weight", async () => {
    const store = await freshStore();
    const mem = await store.store({ content: "test", type: "lesson_learned" });
    expect(mem.weight).toBeGreaterThan(0);
    await store.close();
  });

  it("stores a fresh memory with confidence 0.9 with weight > 0.4", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "test",
      type: "lesson_learned",
      confidence: 0.9,
    });
    expect(mem.weight).toBeGreaterThan(0.4);
    await store.close();
  });

  it("stores a fresh memory with higher weight than an old memory", async () => {
    const store = await freshStore();
    const fresh = await store.store({
      content: "fresh",
      type: "lesson_learned",
      confidence: 0.8,
    });
    // Manually insert an old memory via the db connection.
    const oldId = generateUlid();
    const oldCreated = daysAgoIso(60);
    const oldWeight = computeWeight(
      { createdAt: oldCreated, accessCount: 0, reinforcementCount: 0, confidence: 0.8 },
      1.0,
      { decayHalfLifeDays: 30 },
    );
    const db = (store as unknown as { db: { exec: (s: string) => void; prepare: (s: string) => { run: (...p: unknown[]) => void } } }).db;
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO memories
        (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      oldId,
      "old memory content",
      "lesson_learned",
      "project",
      "[]",
      oldWeight,
      0.8,
      oldCreated,
      oldCreated,
      0,
      0,
      "{}",
      null,
    );
    db.exec("COMMIT");
    const old = await store.get(oldId, false);
    expect(fresh.weight).toBeGreaterThan(old.memory.weight);
    await store.close();
  });
});

describe("MemoryStore update() with reinforce", () => {
  it("increases weight when reinforcing (confidence boost)", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "test",
      type: "lesson_learned",
      confidence: 0.5,
    });
    const updated = await store.update(mem.id, { reinforce: true });
    expect(updated.weight).toBeGreaterThan(mem.weight);
    expect(updated.reinforcementCount).toBe(mem.reinforcementCount + 1);
    await store.close();
  });
});

describe("MemoryStore decay()", () => {
  // Helper to read a memory row directly from the DB (regardless of status).
  function readRow(store: MemoryStore, id: string): { weight: number; status: string } {
    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...p: unknown[]) => Record<string, unknown> | undefined } } }).db;
    const row = db.prepare("SELECT weight, status FROM memories WHERE id = ?").get(id) as
      | { weight: number; status: string }
      | undefined;
    if (!row) throw new Error(`row not found: ${id}`);
    return row;
  }

  it("reduces weight of old memories", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "old memory",
      type: "lesson_learned",
      confidence: 0.8,
    });
    // Force the created_at back 90 days to simulate age.
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...p: unknown[]) => void } } }).db;
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(daysAgoIso(90), mem.id);
    await store.decay();
    // 90 days / 30 half-life => recencyFactor ≈ exp(-3) ≈ 0.05
    // weight ≈ 0.05 * 1.0 * 0.5 * 0.8 ≈ 0.02 < archiveThreshold (0.05) → archived.
    const row = readRow(store, mem.id);
    expect(row.status).toBe("archived");
    expect(row.weight).toBeLessThan(mem.weight);
    await store.close();
  });

  it("auto-archives memories below archiveThreshold", async () => {
    const store = await freshStore({ archiveThreshold: 0.05 });
    const mem = await store.store({
      content: "low confidence old memory",
      type: "lesson_learned",
      confidence: 0.3,
    });
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...p: unknown[]) => void } } }).db;
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(daysAgoIso(120), mem.id);
    await store.decay();
    const row = readRow(store, mem.id);
    expect(row.status).toBe("archived");
    await store.close();
  });

  it("does not touch already-archived memories", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "to be archived",
      type: "lesson_learned",
      confidence: 0.5,
    });
    await store.forget(mem.id, false);
    const beforeForget = await store.get(mem.id, false).catch(() => null);
    // get() only returns active memories; archived ones throw. Verify decay is a no-op for archived.
    await store.decay();
    // Confirm the memory is still archived by inspecting the table directly.
    const db = (store as unknown as { db: { prepare: (s: string) => { get: (...p: unknown[]) => Record<string, unknown> | undefined } } }).db;
    const row = db.prepare("SELECT status FROM memories WHERE id = ?").get(mem.id) as { status: string } | undefined;
    expect(row?.status).toBe("archived");
    await store.close();
  });

  it("leaves fresh memories active with high weight", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "fresh memory",
      type: "lesson_learned",
      confidence: 0.9,
    });
    await store.decay();
    const after = await store.get(mem.id, false);
    expect(after.memory.status).toBe("active");
    expect(after.memory.weight).toBeGreaterThan(0.3);
    await store.close();
  });

  it("is idempotent (calling twice yields same weight + status)", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "idempotent test",
      type: "lesson_learned",
      confidence: 0.7,
    });
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...p: unknown[]) => void } } }).db;
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(daysAgoIso(45), mem.id);
    await store.decay();
    const db2 = (store as unknown as { db: { prepare: (s: string) => { get: (...p: unknown[]) => Record<string, unknown> | undefined } } }).db;
    const row1 = db2.prepare("SELECT weight, status FROM memories WHERE id = ?").get(mem.id) as { weight: number; status: string };
    // Call again immediately — timestamps haven't moved meaningfully, so weight should be ~equal.
    await store.decay();
    const row2 = db2.prepare("SELECT weight, status FROM memories WHERE id = ?").get(mem.id) as { weight: number; status: string };
    expect(row2.weight).toBeCloseTo(row1.weight, 5);
    expect(row2.status).toBe(row1.status);
    await store.close();
  });
});
