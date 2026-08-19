import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../src/store";
import { recordSelfEpisode, assembleIdentity, type SelfEpisodeState } from "../src/self";
import type { MemoryType } from "../src/types";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-self-"));
  return join(dir, "test.db");
}

describe("self (synthetic-self Phase 9)", () => {
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

  describe("recordSelfEpisode", () => {
    const baseState: SelfEpisodeState = {
      sessionId: "sess-1",
      lastUserText: "no, use pnpm not npm",
      lastUserIntent: "correction",
      lastToolCapture: { tool: "bash", isError: false, command: "pnpm test" },
      lastPredictionOutcome: null,
      lastBlock: null,
      reflexCache: { rules: new Array(5), arousal: 0.3 },
      injectedMemoryIds: new Set(),
      lastInjectedMemoryIds: null,
      config: { brain: { selfModel: true } },
    };

    it("writes 0 rows when selfModel is disabled", async () => {
      const count = await recordSelfEpisode(store, {
        ...baseState,
        config: { brain: { selfModel: false } },
      });
      expect(count).toBe(0);
    });

    it("writes a correction episode when intent is correction", async () => {
      const count = await recordSelfEpisode(store, baseState);
      expect(count).toBeGreaterThan(0);
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      expect(results.memories.length).toBeGreaterThan(0);
      const correctionRow = results.memories.find((m) =>
        m.content.includes("I was corrected by the user"),
      );
      expect(correctionRow).toBeDefined();
      expect(correctionRow!.type).toBe("self_model");
    });

    it("writes an override episode when lastBlock is set", async () => {
      const count = await recordSelfEpisode(store, {
        ...baseState,
        lastBlock: { tool: "bash", memoryId: "01ABCDEF", confidence: 0.7 },
      });
      expect(count).toBeGreaterThan(0);
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      const overrideRow = results.memories.find((m) =>
        m.content.includes("I blocked bash"),
      );
      expect(overrideRow).toBeDefined();
    });

    it("writes a high-surprise episode when surprise >= 0.5", async () => {
      const count = await recordSelfEpisode(store, {
        ...baseState,
        lastPredictionOutcome: {
          prediction: { willSucceed: true, confidence: 0.8 },
          actual: { success: false },
          surprise: 0.75,
          encodedMemoryId: null,
        },
      });
      expect(count).toBeGreaterThan(0);
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      const surpriseRow = results.memories.find((m) =>
        m.content.includes("I expected success"),
      );
      expect(surpriseRow).toBeDefined();
    });

    it("writes a tool-mix episode when lastToolCapture is set", async () => {
      const count = await recordSelfEpisode(store, baseState);
      expect(count).toBeGreaterThan(0);
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      const toolRow = results.memories.find((m) =>
        m.content.includes("I used bash"),
      );
      expect(toolRow).toBeDefined();
    });

    it("writes a reflex-state episode when reflexCache has rules", async () => {
      const count = await recordSelfEpisode(store, baseState);
      expect(count).toBeGreaterThan(0);
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      const reflexRow = results.memories.find((m) =>
        m.content.includes("reflex rules cached"),
      );
      expect(reflexRow).toBeDefined();
    });

    it("does not write a surprise episode when surprise < 0.5", async () => {
      await recordSelfEpisode(store, {
        ...baseState,
        lastPredictionOutcome: {
          prediction: { willSucceed: true, confidence: 0.8 },
          actual: { success: true },
          surprise: 0.1,
          encodedMemoryId: null,
        },
      });
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      const surpriseRow = results.memories.find((m) =>
        m.content.includes("I expected success"),
      );
      expect(surpriseRow).toBeUndefined();
    });

    it("deduplicates + reinforces on repeated identical episodes", async () => {
      // Record the same correction twice.
      await recordSelfEpisode(store, baseState);
      await recordSelfEpisode(store, baseState);
      const results = await store.search({
        types: ["self_model" as MemoryType],
        scope: "all",
      });
      // The correction content should appear once (deduped), with reinforcementCount > 0.
      const correctionRows = results.memories.filter((m) =>
        m.content.includes("I was corrected by the user"),
      );
      expect(correctionRows.length).toBe(1);
      expect(correctionRows[0]!.reinforcementCount).toBeGreaterThan(0);
    });

    it("is fire-safe — never throws on store errors", async () => {
      // Pass a store that's been closed.
      await store.close();
      const count = await recordSelfEpisode(store, baseState);
      expect(count).toBe(0); // no throw, returns 0
    });
  });

  describe("assembleIdentity", () => {
    it("returns empty content when no self_model rows exist", async () => {
      const identity = await assembleIdentity(store, { identityTokens: 350 });
      // With no self_model, it falls back to user_preference (also none) → empty.
      expect(identity.content).toBe("");
      expect(identity.memoryIds).toEqual([]);
    });

    it("returns the top user_preference as fallback when no self_model exists", async () => {
      await store.store({
        content: "User prefers pnpm over npm.",
        type: "user_preference",
        scope: "global",
        confidence: 0.8,
        tags: ["preference"],
      });
      const identity = await assembleIdentity(store, { identityTokens: 350 });
      expect(identity.content).toContain("pnpm");
      expect(identity.memoryIds.length).toBeGreaterThan(0);
    });

    it("returns self_model rows when they exist (Tier 1)", async () => {
      await store.store({
        content: "I reach for bash before reading files.",
        type: "self_model",
        scope: "project",
        confidence: 0.6,
        weight: 0.7,
        tags: ["self-episode", "disposition"],
        metadata: { category: "disposition" },
      });
      const identity = await assembleIdentity(store, { identityTokens: 350 });
      expect(identity.content).toContain("bash");
      expect(identity.memoryIds.length).toBeGreaterThan(0);
    });

    it("includes lesson_learned in Tier 2 (situational)", async () => {
      await store.store({
        content: "Always run migrations before deploy.",
        type: "lesson_learned",
        scope: "project",
        confidence: 0.8,
        weight: 0.7,
        tags: ["process"],
      });
      const identity = await assembleIdentity(store, { identityTokens: 350 });
      expect(identity.content).toContain("migrations");
    });

    it("respects the identityTokens budget", async () => {
      // Store many self_model rows.
      for (let i = 0; i < 20; i++) {
        await store.store({
          content: `Disposition ${i}: I tend to do thing ${i} repeatedly in this project context.`,
          type: "self_model",
          scope: "project",
          confidence: 0.5,
          weight: 0.5 + i * 0.01,
          tags: ["self-episode"],
          metadata: { category: "disposition" },
        });
      }
      const identity = await assembleIdentity(store, { identityTokens: 100 });
      // Tier 1 budget = 60 tokens. Each line is ~60 chars ≈ 15 tokens.
      // So at most ~4 lines fit in Tier 1.
      const lines = identity.content.split("\n");
      expect(lines.length).toBeLessThanOrEqual(5);
    });
  });
});
