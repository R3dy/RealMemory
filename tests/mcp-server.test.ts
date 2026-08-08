import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { createMcpTools } from "../src/mcp-server";
import type { McpToolHandler } from "../src/mcp-server";
import { generateUlid } from "../src/db/ulid";
import { MemoryNotFoundError } from "../src/errors";

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
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-mcp-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("createMcpTools — definitions", () => {
  it("returns exactly 8 tools", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    expect(tools).toHaveLength(8);
    await store.close();
  });

  it("each tool has a name, description, and inputSchema", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.inputSchema.properties).toBe("object");
    }
    await store.close();
  });

  it("exposes the expected tool names", async () => {
    const store = await freshStore();
    const names = createMcpTools(store).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "store_memory",
        "recall",
        "search",
        "relate",
        "update_memory",
        "forget",
        "list_memories",
        "get_memory",
      ]),
    );
    expect(names).toHaveLength(8);
    await store.close();
  });
});

describe("store_memory tool", () => {
  it("stores a valid memory and returns a Memory object", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "store_memory");
    const result = (await tool.handler({
      content: "Always use tabs.",
      type: "user_preference",
    })) as { id: string; content: string };
    expect(result.id).toHaveLength(26);
    expect(result.content).toBe("Always use tabs.");
    expect(result.type).toBe("user_preference");
    await store.close();
  });

  it("returns an error when content is missing", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "store_memory");
    await expect(tool.handler({ type: "user_preference" })).rejects.toThrow();
    await store.close();
  });

  it("returns an error when type is invalid", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "store_memory");
    await expect(
      tool.handler({ content: "x", type: "bogus_type" }),
    ).rejects.toThrow();
    await store.close();
  });
});

describe("recall tool", () => {
  it("returns a RecallResult array for a query", async () => {
    const store = await freshStore();
    await store.store({ content: "tabs not spaces", type: "user_preference" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "recall");
    const result = (await tool.handler({ query: "tabs" })) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    await store.close();
  });

  it("returns an empty array on an empty DB", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "recall");
    const result = (await tool.handler({ query: "anything" })) as unknown[];
    expect(result).toEqual([]);
    await store.close();
  });
});

describe("search tool", () => {
  it("returns a SearchResult with filters applied", async () => {
    const store = await freshStore();
    await store.store({ content: "one", type: "task_pattern" });
    await store.store({ content: "two", type: "lesson_learned" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "search");
    const result = (await tool.handler({
      types: ["task_pattern"],
      limit: 10,
    })) as { memories: unknown[]; total: number };
    expect(result.total).toBe(1);
    expect(result.memories).toHaveLength(1);
    await store.close();
  });
});

describe("relate tool", () => {
  it("creates a relationship between two memories", async () => {
    const store = await freshStore();
    const a = await store.store({ content: "A", type: "contextual_note" });
    const b = await store.store({ content: "B", type: "contextual_note" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "relate");
    const result = (await tool.handler({
      sourceId: a.id,
      targetId: b.id,
      type: "extends",
    })) as { id: string; sourceId: string; targetId: string };
    expect(result.sourceId).toBe(a.id);
    expect(result.targetId).toBe(b.id);
    expect(result.type).toBe("extends");
    await store.close();
  });

  it("returns an error when the source memory does not exist", async () => {
    const store = await freshStore();
    const b = await store.store({ content: "B", type: "contextual_note" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "relate");
    await expect(
      tool.handler({
        sourceId: "nonexistent-id",
        targetId: b.id,
        type: "extends",
      }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    await store.close();
  });
});

describe("update_memory tool", () => {
  it("returns the updated memory", async () => {
    const store = await freshStore();
    const m = await store.store({ content: "old", type: "task_pattern" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "update_memory");
    const result = (await tool.handler({
      id: m.id,
      content: "new content",
    })) as { id: string; content: string };
    expect(result.id).toBe(m.id);
    expect(result.content).toBe("new content");
    await store.close();
  });

  it("returns an error for a non-existent id", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "update_memory");
    await expect(
      tool.handler({ id: "nonexistent-id", content: "x" }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
    await store.close();
  });
});

describe("forget tool", () => {
  it("archives a memory and returns a ForgetResult", async () => {
    const store = await freshStore();
    const m = await store.store({ content: "bye", type: "contextual_note" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "forget");
    const result = (await tool.handler({ id: m.id })) as {
      id: string;
      archived: boolean;
      relationshipsRemoved: number;
    };
    expect(result.id).toBe(m.id);
    expect(result.archived).toBe(true);
    await store.close();
  });
});

describe("list_memories tool", () => {
  it("returns a paginated ListResult", async () => {
    const store = await freshStore();
    await store.store({ content: "a", type: "task_pattern" });
    await store.store({ content: "b", type: "task_pattern" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "list_memories");
    const result = (await tool.handler({ limit: 10 })) as {
      memories: unknown[];
      total: number;
      offset: number;
      limit: number;
    };
    expect(result.total).toBe(2);
    expect(result.memories).toHaveLength(2);
    await store.close();
  });
});

describe("get_memory tool", () => {
  it("returns a MemoryWithRelations", async () => {
    const store = await freshStore();
    const m = await store.store({ content: "hello", type: "contextual_note" });
    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_memory");
    const result = (await tool.handler({ id: m.id })) as {
      memory: { id: string };
      relationships: unknown[];
    };
    expect(result.memory.id).toBe(m.id);
    expect(Array.isArray(result.relationships)).toBe(true);
    await store.close();
  });

  it("returns an error for a non-existent id", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = getTool(tools, "get_memory");
    await expect(tool.handler({ id: "nonexistent-id" })).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    await store.close();
  });
});
