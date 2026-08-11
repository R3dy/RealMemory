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
  return join(tempDir, `concise-${generateUlid()}.db`);
}

/** Keyword-only store (embeddingModel: null) so conciseness is deterministic. */
async function freshStore(): Promise<MemoryStore> {
  const store = new MemoryStore({
    storagePath: uniqueDbPath(),
    projectId: "test",
    embeddingModel: null,
    recallThreshold: 0.0,
  });
  await store.init();
  return store;
}

function longContent(word = "contextual", repeat = 50): string {
  return `${word} `.repeat(repeat).trim(); // 50 words of len 10 = 500 chars
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-concise-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("store() conciseness cap (A22.2 behavior)", () => {
  it("truncates to cap + '...' when concise:true and content exceeds the cap", async () => {
    const store = await freshStore();
    const content = longContent("lesson"); // 500 chars
    expect(content.length).toBeGreaterThan(280);

    const mem = await store.store({
      content,
      type: "lesson_learned",
      concise: true,
    });

    // 280 + "..." = 283.
    expect(mem.content.length).toBeLessThanOrEqual(283);
    expect(mem.content.endsWith("...")).toBe(true);
    expect(mem.content.slice(0, 280)).toBe(content.slice(0, 280));
    await store.close();
  });

  it("keeps short content verbatim when concise:true", async () => {
    const store = await freshStore();
    const mem = await store.store({
      content: "short",
      type: "codebase_fact",
      concise: true,
    });
    expect(mem.content).toBe("short");
    expect(mem.content.endsWith("...")).toBe(false);
    await store.close();
  });

  it("stores full content when concise is NOT set", async () => {
    const store = await freshStore();
    const content = longContent("codebase"); // 500 chars
    expect(content.length).toBeGreaterThan(280);

    const mem = await store.store({
      content,
      type: "codebase_fact",
    });

    expect(mem.content).toBe(content);
    expect(mem.content.length).toBeGreaterThan(283);
    await store.close();
  });

  it("honors a custom concisenessCap config value", async () => {
    const dbPath = uniqueDbPath();
    const store = new MemoryStore({
      storagePath: dbPath,
      projectId: "test",
      embeddingModel: null,
      concisenessCap: 120,
    });
    await store.init();

    const content = longContent("task", 40); // 400 chars
    const mem = await store.store({
      content,
      type: "task_pattern",
      concise: true,
    });
    expect(mem.content.length).toBe(123); // 120 + "..."
    expect(mem.content.endsWith("...")).toBe(true);
    await store.close();
  });
});

describe("MCP store_memory preserves full content", () => {
  it("stores full content (concise not set by the MCP handler)", async () => {
    const store = await freshStore();
    const tools = createMcpTools(store);
    const tool = tools.find((t) => t.name === "store_memory") as McpToolHandler;
    const content = longContent("explicit"); // 500 chars

    const result = (await tool.handler({
      content,
      type: "contextual_note",
    })) as { content: string };

    expect(result.content).toBe(content);
    await store.close();
  });
});