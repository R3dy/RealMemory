import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { createMcpTools } from "../src/mcp-server";
import type { McpToolHandler } from "../src/mcp-server";
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

function getTool(tools: McpToolHandler[], name: string): McpToolHandler {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-mcp-metrics-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("get_metrics tool", () => {
  it("is registered as a 9th tool with a name, description, and inputSchema", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_metrics");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toHaveProperty("name");
    expect(tool.inputSchema.properties).toHaveProperty("since");
    await store.close();
  });

  it("returns an empty summary when no metrics have been recorded", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_metrics");
    const result = (await tool.handler({})) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
    await store.close();
  });

  it("with no args returns per-metric aggregates for all recorded metrics", async () => {
    const store = await freshStore();
    await store.recordMetric("recall_hit", 1.0);
    await store.recordMetric("duplicate_rate", 0.1);
    await store.recordMetric("duplicate_rate", 0.2);

    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_metrics");
    const result = (await tool.handler({})) as Array<{
      metric_name: string;
      count: number;
      sum: number;
      avg: number;
      latest: number;
      latest_at: string;
    }>;
    expect(result).toHaveLength(2);
    const byName = new Map(result.map((r) => [r.metric_name, r]));
    expect(byName.get("recall_hit")).toMatchObject({ count: 1, latest: 1.0 });
    const dup = byName.get("duplicate_rate");
    expect(dup!.count).toBe(2);
    expect(dup!.latest).toBe(0.2);
    // SQLite SUM/AVG accumulate in floats — compare within float tolerance.
    expect(dup!.sum).toBeCloseTo(0.3, 10);
    expect(dup!.avg).toBeCloseTo(0.15, 10);
    for (const r of result) {
      expect(r.latest_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    await store.close();
  });

  it("with a name filter returns only that metric", async () => {
    const store = await freshStore();
    await store.recordMetric("recall_hit", 1.0);
    await store.recordMetric("recall_miss", 1.0);
    await store.recordMetric("preference_compliance", 1.0);

    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_metrics");
    const result = (await tool.handler({ name: "recall_hit" })) as Array<{
      metric_name: string;
      count: number;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0].metric_name).toBe("recall_hit");
    expect(result[0].count).toBe(1);
    await store.close();
  });

  it("with a since filter returns only metrics recorded at or after the timestamp", async () => {
    const store = await freshStore();
    await store.recordMetric("recall_hit", 1.0);

    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_metrics");

    // All observations are in the past — a far-future `since` matches nothing.
    const future = await tool.handler({ since: "2999-01-01T00:00:00.000Z" });
    expect(future).toEqual([]);

    // A `since` in the deep past matches everything recorded.
    const past = (await tool.handler({ since: "2000-01-01T00:00:00.000Z" })) as Array<{
      metric_name: string;
    }>;
    expect(past.length).toBeGreaterThan(0);
    expect(past.some((r) => r.metric_name === "recall_hit")).toBe(true);

    // Combined name + since filter works.
    const combined = (await tool.handler({
      name: "recall_hit",
      since: "2000-01-01T00:00:00.000Z",
    })) as Array<{ metric_name: string; count: number }>;
    expect(combined).toHaveLength(1);
    expect(combined[0].count).toBe(1);
    await store.close();
  });

  it("rejects an invalid args payload via zod", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_metrics");
    // `name` must be a string — a number must be rejected by zod parsing.
    await expect(
      tool.handler({ name: 42 as unknown as string }),
    ).rejects.toThrow();
    await store.close();
  });
});