import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from "../src/db/schema";
import { generateUlid } from "../src/db/ulid";
import { validateConfig } from "../src/config";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

async function freshStore(): Promise<{ store: MemoryStore; dbPath: string }> {
  const dbPath = uniqueDbPath();
  const store = new MemoryStore({ storagePath: dbPath, projectId: "test" });
  await store.init();
  return { store, dbPath };
}

/** Open a raw connection to a DB file on disk (the store keeps its own open). */
async function openRaw(path: string) {
  const { openDatabase } = await import("../src/db/dialect");
  return openDatabase(path);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Schema v4 + metrics", () => {
  it("applies v4 migration cleanly on a v3 DB", async () => {
    // Build a DB that is exactly at schema version 3 (v1+v2+v3 applied).
    const dbPath = uniqueDbPath();
    const raw = await openRaw(dbPath);
    raw.exec(SCHEMA_V1);
    raw.exec(SCHEMA_V2);
    raw.exec(SCHEMA_V3);
    raw.exec(
      "INSERT INTO schema_version (version) VALUES (1), (2), (3)",
    );
    raw.close();

    // init() runs runMigrations, which should apply only version 4.
    const store = new MemoryStore({ storagePath: dbPath, projectId: "test" });
    await store.init();

    const check = await openRaw(dbPath);
    const table = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='metrics'",
      )
      .get() as { name?: string } | undefined;
    expect(table?.name).toBe("metrics");

    const idx = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_metrics_name', 'idx_metrics_recorded') ORDER BY name",
      )
      .all() as { name: string }[];
    expect(idx.map((r) => r.name)).toEqual([
      "idx_metrics_name",
      "idx_metrics_recorded",
    ]);

    const versions = (
      check
        .prepare("SELECT version FROM schema_version ORDER BY version")
        .all() as { version: number }[]
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4]);

    check.close();
    await store.close();
  });

  it("is idempotent (re-running migrations is a no-op)", async () => {
    const { store: store1, dbPath } = await freshStore();
    await store1.close();

    // Re-opening the same DB runs runMigrations again — must not error.
    const store2 = new MemoryStore({ storagePath: dbPath, projectId: "test" });
    await expect(store2.init()).resolves.toBeUndefined();

    const check = await openRaw(dbPath);
    const row = check
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='metrics'",
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("metrics");
    check.close();
    await store2.close();
  });

  it("recordMetric inserts a row; getMetricSummary returns it", async () => {
    const { store } = await freshStore();
    await store.recordMetric("recall_hit_rate", 1.0, "sess-123");

    const summary = await store.getMetricSummary("recall_hit_rate");
    expect(summary).toHaveLength(1);
    expect(summary[0].metric_name).toBe("recall_hit_rate");
    expect(summary[0].count).toBe(1);
    expect(summary[0].sum).toBe(1.0);
    expect(summary[0].avg).toBe(1.0);
    expect(summary[0].latest).toBe(1.0);
    expect(summary[0].latest_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await store.close();
  });

  it("getMetricSummary with no name returns all metrics", async () => {
    const { store } = await freshStore();
    await store.recordMetric("recall_hit_rate", 0.8);
    await store.recordMetric("duplicate_rate", 0.1);

    const summary = await store.getMetricSummary();
    expect(summary).toHaveLength(2);
    const names = summary.map((s) => s.metric_name).sort();
    expect(names).toEqual(["duplicate_rate", "recall_hit_rate"]);
    for (const s of summary) {
      expect(s.count).toBe(1);
      expect(s.latest_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    await store.close();
  });

  it("getMetricSummary with since filters by recorded_at", async () => {
    const { store, dbPath } = await freshStore();
    // Insert two observations at known timestamps via a raw connection so the
    // filter boundary is deterministic.
    const raw = await openRaw(dbPath);
    const insert = raw.prepare(
      "INSERT INTO metrics (id, metric_name, metric_value, session_id, recorded_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("m1", "recall_hit_rate", 1.0, null, "2026-01-01T00:00:00.000Z");
    insert.run("m2", "recall_hit_rate", 0.5, null, "2026-01-02T00:00:00.000Z");
    raw.close();

    const all = await store.getMetricSummary("recall_hit_rate");
    expect(all).toHaveLength(1);
    expect(all[0].count).toBe(2);
    expect(all[0].sum).toBe(1.5);

    const sinceJan2 = await store.getMetricSummary(
      "recall_hit_rate",
      "2026-01-02T00:00:00.000Z",
    );
    expect(sinceJan2).toHaveLength(1);
    expect(sinceJan2[0].count).toBe(1);
    expect(sinceJan2[0].latest).toBe(0.5);

    const sinceFuture = await store.getMetricSummary(
      "recall_hit_rate",
      "2999-01-01T00:00:00.000Z",
    );
    expect(sinceFuture).toHaveLength(0);
    await store.close();
  });

  it("getBloatRatio returns 0.0 on empty store", async () => {
    const { store } = await freshStore();
    expect(await store.getBloatRatio()).toBe(0);
    await store.close();
  });

  it("getBloatRatio returns correct fraction for low-weight memories", async () => {
    const { store, dbPath } = await freshStore();
    const heavy = await store.store({
      content:
        "The staging deploy uses blue-green with a two-minute health-check drain window.",
      type: "codebase_fact",
    });
    const light = await store.store({
      content:
        "QA sign-off checklist lives in the release-engineering doc, updated each milestone.",
      type: "codebase_fact",
    });

    // Push one memory below the default archiveThreshold (0.05) directly.
    const raw = await openRaw(dbPath);
    raw
      .prepare("UPDATE memories SET weight = 0.01 WHERE id = ?")
      .run(light.id);
    raw.close();

    expect(await store.getBloatRatio()).toBe(0.5);
    // Heavy memory still well above threshold.
    expect(heavy.id).not.toBe(light.id);
    await store.close();
  });

  it("validateConfig rejects concisenessCap <= 0", () => {
    expect(() => validateConfig({ concisenessCap: 0 })).toThrow(
      /concisenessCap/,
    );
    expect(() => validateConfig({ concisenessCap: -1 })).toThrow(
      /concisenessCap/,
    );
  });

  it("validateConfig rejects compactingIntervalHours <= 0", () => {
    expect(() => validateConfig({ compactingIntervalHours: 0 })).toThrow(
      /compactingIntervalHours/,
    );
    expect(() =>
      validateConfig({ compactingIntervalHours: -4 }),
    ).toThrow(/compactingIntervalHours/);
  });

  it("validateConfig rejects non-boolean autoRelate", () => {
    expect(() =>
      validateConfig({ autoRelate: "yes" as unknown as boolean }),
    ).toThrow(/autoRelate/);
  });

  it("validateConfig rejects non-boolean brainLoop", () => {
    expect(() =>
      validateConfig({ brainLoop: 1 as unknown as boolean }),
    ).toThrow(/brainLoop/);
  });

  it("validateConfig accepts valid brain-loop knobs", () => {
    expect(() =>
      validateConfig({
        concisenessCap: 280,
        autoRelate: true,
        brainLoop: true,
        compactingIntervalHours: 4,
      }),
    ).not.toThrow();
  });

  it("store() with concise=true truncates content exceeding cap", async () => {
    const { store } = await freshStore();
    const longContent = "learned ".repeat(50).trim(); // 400 chars
    expect(longContent.length).toBeGreaterThan(280);

    const mem = await store.store({
      content: longContent,
      type: "lesson_learned",
      concise: true,
    });
    expect(mem.content.length).toBe(283); // 280 + "..."
    expect(mem.content.endsWith("...")).toBe(true);
    expect(mem.content.slice(0, 280)).toBe(longContent.slice(0, 280));
    await store.close();
  });

  it("store() without concise does NOT truncate", async () => {
    const { store } = await freshStore();
    const longContent = "contextual ".repeat(45).trim(); // 330 chars
    expect(longContent.length).toBeGreaterThan(280);

    const mem = await store.store({
      content: longContent,
      type: "contextual_note",
    });
    expect(mem.content).toBe(longContent);
    expect(mem.content.endsWith("...")).toBe(false);
    await store.close();
  });
});