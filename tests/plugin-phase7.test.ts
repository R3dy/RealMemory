import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { createMcpTools } from "../src/mcp-server";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "phase7-"));
  dbPath = join(tempDir, `test-${generateUlid()}.db`);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Phase 7: memory_why", () => {
  it("is registered as an MCP tool", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_why");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("blocked");
  });

  it("returns recent reflex actions with memory IDs + timestamps", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    // Record some reflex metrics.
    await store.recordMetric("reflex_block:mem-001", 1, "sess-1");
    await store.recordMetric("reflex_rewrite:mem-002", 1, "sess-1");
    await store.recordMetric("reflex_fire:mem-003", 1, "sess-1");
    await store.recordMetric("reflex_override:mem-001", 1, "sess-1");

    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_why")!;
    const result = await tool.handler({ limit: 10 }) as Array<{
      action: string;
      memoryId: string;
      sessionId: string | null;
      recordedAt: string;
    }>;

    expect(result.length).toBe(4);
    // Should include all 4 action types.
    const actions = result.map((r) => r.action);
    expect(actions).toContain("block");
    expect(actions).toContain("rewrite");
    expect(actions).toContain("fire");
    expect(actions).toContain("override");

    // Memory IDs should be extracted correctly.
    const memIds = result.map((r) => r.memoryId);
    expect(memIds).toContain("mem-001");
    expect(memIds).toContain("mem-002");
    expect(memIds).toContain("mem-003");
  });

  it("returns empty array when no reflex metrics exist", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_why")!;
    const result = await tool.handler({}) as unknown[];
    expect(result).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    for (let i = 0; i < 20; i++) {
      await store.recordMetric(`reflex_fire:mem-${i}`, 1, "sess-1");
    }

    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_why")!;
    const result = await tool.handler({ limit: 5 }) as unknown[];
    expect(result).toHaveLength(5);
  });
});

describe("Phase 7: memory_recall", () => {
  it("is registered as an MCP tool", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_recall");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("working-memory window");
  });

  it("returns recall results", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "Always use npm ci instead of npm install",
      type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: ["npm"],
    });

    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_recall")!;
    const result = await tool.handler({ query: "npm install" }) as Array<{ memory: { content: string } }>;
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].memory.content).toContain("npm ci");
  });
});

describe("Phase 7: memory_note", () => {
  it("is registered as an MCP tool", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_note");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("remember");
  });

  it("stores a lesson_learned by default", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_note")!;
    const result = await tool.handler({
      content: "This project uses bun, not node",
    }) as { id: string; type: string };

    expect(result.id).toBeDefined();
    expect(result.type).toBe("lesson_learned");
  });

  it("accepts a custom type", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "memory_note")!;
    const result = await tool.handler({
      content: "Royce prefers concise recommendations",
      type: "user_preference",
    }) as { type: string };

    expect(result.type).toBe("user_preference");
  });
});

describe("Phase 7: getRecentMetricsByPrefix (store method)", () => {
  it("returns rows matching the prefix, ordered by recorded_at desc", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    await store.recordMetric("reflex_block:mem-1", 1, "sess-1");
    await new Promise((r) => setTimeout(r, 10));
    await store.recordMetric("reflex_block:mem-2", 1, "sess-1");
    await new Promise((r) => setTimeout(r, 10));
    await store.recordMetric("reflex_fire:mem-3", 1, "sess-1");

    const rows = await store.getRecentMetricsByPrefix("reflex_block:", 10);
    expect(rows).toHaveLength(2);
    // Most recent first.
    expect(rows[0].metric_name).toBe("reflex_block:mem-2");
    expect(rows[1].metric_name).toBe("reflex_block:mem-1");
  });

  it("respects the limit", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    for (let i = 0; i < 10; i++) {
      await store.recordMetric(`reflex_fire:mem-${i}`, 1, "sess-1");
    }

    const rows = await store.getRecentMetricsByPrefix("reflex_fire:", 3);
    expect(rows).toHaveLength(3);
  });

  it("returns empty for no matches", async () => {
    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    const rows = await store.getRecentMetricsByPrefix("nonexistent:", 10);
    expect(rows).toEqual([]);
  });
});
