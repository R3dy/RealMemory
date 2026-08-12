import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fresh-project smoke test", () => {
  it("can import and use MemoryStore from dist", async () => {
    // Import from the built output, not source — verifies the package
    // exports work against the published artifact.
    const { MemoryStore, VERSION } = await import("../dist/index.js");
    expect(VERSION).toBe("0.6.0");

    const dir = mkdtempSync(join(tmpdir(), "realmemory-smoke-"));
    const store = new MemoryStore({
      storagePath: join(dir, "smoke.db"),
      embeddingModel: null, // keyword-only for a fast, offline test
    });
    await store.init();

    const memory = await store.store({
      content: "Smoke test memory",
      type: "contextual_note",
      scope: "global",
    });
    expect(memory.id).toBeDefined();
    expect(memory.content).toBe("Smoke test memory");

    const retrieved = await store.get(memory.id);
    expect(retrieved.memory.content).toBe("Smoke test memory");

    await store.close();
  });

  it("exports the full public API surface from dist", async () => {
    const mod = await import("../dist/index.js");
    expect(mod.VERSION).toBe("0.6.0");
    expect(typeof mod.MemoryStore).toBe("function");
    expect(typeof mod.RecallEngine).toBe("function");
    expect(typeof mod.loadConfig).toBe("function");
    expect(typeof mod.validateConfig).toBe("function");
    expect(typeof mod.deriveProjectId).toBe("function");
    expect(typeof mod.computeWeight).toBe("function");
    expect(typeof mod.computeRecencyFactor).toBe("function");
    expect(typeof mod.computeFrequencyFactor).toBe("function");
    expect(typeof mod.createEmbeddingProvider).toBe("function");
    expect(typeof mod.cosineSimilarity).toBe("function");
    expect(typeof mod.embeddingFromBuffer).toBe("function");
    expect(typeof mod.embeddingToBuffer).toBe("function");
    expect(typeof mod.createMcpTools).toBe("function");
    expect(typeof mod.startMcpServer).toBe("function");
    expect(typeof mod.scrubSecrets).toBe("function");
  });

  it("can store, relate, and recall through the dist build", async () => {
    const { MemoryStore } = await import("../dist/index.js");
    const dir = mkdtempSync(join(tmpdir(), "realmemory-smoke-"));
    const store = new MemoryStore({
      storagePath: join(dir, "smoke.db"),
      embeddingModel: null,
    });
    await store.init();

    const a = await store.store({
      content: "Smoke lesson A",
      type: "lesson_learned",
      scope: "global",
      tags: ["smoke"],
    });
    const b = await store.store({
      content: "Smoke lesson B extends A",
      type: "lesson_learned",
      scope: "global",
      tags: ["smoke"],
    });
    await store.relate(b.id, a.id, "extends");

    const results = await store.recall({ query: "smoke lesson", limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const topIds = results.map((r: { memory: { id: string } }) => r.memory.id);
    expect(topIds).toContain(a.id);

    await store.close();
  });
});
