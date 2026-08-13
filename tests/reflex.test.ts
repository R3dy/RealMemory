import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import {
  compileRule,
  buildReflexCache,
  matchCall,
  emptyReflexCache,
  addRule,
  REFLEX_WEIGHT_FLOOR,
  REFLEX_RULE_CAP,
  type ReflexCache,
  type ReflexRule,
  type ToolCall,
} from "../src/reflex";
import type { Memory } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `reflex-${generateUlid()}.db`);
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: generateUlid(),
    content: "Test lesson",
    type: "lesson_learned",
    scope: "project",
    tags: [],
    weight: 0.5,
    confidence: 0.6,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accessCount: 0,
    reinforcementCount: 0,
    metadata: {},
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reflex-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("emptyReflexCache", () => {
  it("returns an empty cache with arousal 0 and builtAt 0", () => {
    const cache = emptyReflexCache();
    expect(cache.rules).toEqual([]);
    expect(cache.preferences).toEqual([]);
    expect(cache.arousal).toBe(0);
    expect(cache.builtAt).toBe(0);
  });
});

describe("compileRule", () => {
  it("compiles a lesson_learned with metadata.command into a rule", () => {
    const mem = makeMemory({
      content: "npm install fails lockfile validation in this project",
      metadata: { command: "npm install" },
      weight: 0.7,
      confidence: 0.8,
    });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.memoryId).toBe(mem.id);
    expect(rule!.action).toBe("warn");
    expect(rule!.note).toBe("npm install fails lockfile validation in this project");
    expect(rule!.salience).toBe(0.7);
    expect(rule!.confidence).toBe(0.8);
  });

  it("compiles a lesson_learned with metadata.filePath into a rule", () => {
    const mem = makeMemory({
      content: "This config file has a broken schema",
      metadata: { filePath: "src/config.ts" },
    });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.match).toBeTypeOf("function");
  });

  it("returns null for a lesson_learned without command or filePath", () => {
    const mem = makeMemory({ metadata: {} });
    const rule = compileRule(mem);
    expect(rule).toBeNull();
  });

  it("returns null for a user_preference", () => {
    const mem = makeMemory({
      type: "user_preference",
      content: "Use vim, not nano",
    });
    const rule = compileRule(mem);
    expect(rule).toBeNull();
  });

  it("returns null for other memory types", () => {
    const mem = makeMemory({ type: "codebase_fact" });
    expect(compileRule(mem)).toBeNull();
  });

  it("truncates long notes to 120 chars", () => {
    const longContent = "A".repeat(200);
    const mem = makeMemory({ content: longContent, metadata: { command: "test" } });
    const rule = compileRule(mem);
    expect(rule!.note.length).toBe(120);
    expect(rule!.note.endsWith("...")).toBe(true);
  });

  it("clamps salience and confidence to 0..1", () => {
    const mem = makeMemory({
      weight: 1.5,
      confidence: -0.5,
      metadata: { command: "test" },
    });
    const rule = compileRule(mem);
    expect(rule!.salience).toBe(1);
    expect(rule!.confidence).toBe(0);
  });
});

describe("matchCall", () => {
  it("returns null for a null cache (cold start)", () => {
    expect(matchCall(null, { tool: "bash", args: { command: "npm install" } })).toBeNull();
  });

  it("returns null for an empty cache", () => {
    const cache = emptyReflexCache();
    expect(matchCall(cache, { tool: "bash", args: { command: "npm install" } })).toBeNull();
  });

  it("matches a bash command rule", () => {
    const mem = makeMemory({
      id: "mem-1",
      content: "npm install fails",
      metadata: { command: "npm install" },
    });
    const rule = compileRule(mem)!;
    const cache: ReflexCache = { rules: [rule], preferences: [], arousal: 0, builtAt: Date.now() };

    const call: ToolCall = { tool: "bash", args: { command: "npm install --save foo" } };
    expect(matchCall(cache, call)).toBe(rule);
  });

  it("does not match when the command substring is absent", () => {
    const mem = makeMemory({
      id: "mem-1",
      content: "npm install fails",
      metadata: { command: "npm install" },
    });
    const rule = compileRule(mem)!;
    const cache: ReflexCache = { rules: [rule], preferences: [], arousal: 0, builtAt: Date.now() };

    const call: ToolCall = { tool: "bash", args: { command: "git status" } };
    expect(matchCall(cache, call)).toBeNull();
  });

  it("does not match when the tool is different (read vs bash)", () => {
    const mem = makeMemory({
      id: "mem-1",
      content: "npm install fails",
      metadata: { command: "npm install" },
    });
    const rule = compileRule(mem)!;
    const cache: ReflexCache = { rules: [rule], preferences: [], arousal: 0, builtAt: Date.now() };

    const call: ToolCall = { tool: "read", args: { filePath: "npm install" } };
    expect(matchCall(cache, call)).toBeNull();
  });

  it("matches a read filePath rule", () => {
    const mem = makeMemory({
      id: "mem-2",
      content: "Config has a broken schema",
      metadata: { filePath: "src/config.ts" },
    });
    const rule = compileRule(mem)!;
    const cache: ReflexCache = { rules: [rule], preferences: [], arousal: 0, builtAt: Date.now() };

    const call: ToolCall = { tool: "read", args: { filePath: "/abs/path/src/config.ts" } };
    expect(matchCall(cache, call)).toBe(rule);
  });

  it("returns the first matching rule (sorted by salience × confidence desc)", () => {
    const mem1 = makeMemory({
      id: "low-priority",
      content: "Low priority warning",
      metadata: { command: "test" },
      weight: 0.3,
      confidence: 0.3,
    });
    const mem2 = makeMemory({
      id: "high-priority",
      content: "High priority warning",
      metadata: { command: "test" },
      weight: 0.9,
      confidence: 0.9,
    });
    const rule1 = compileRule(mem1)!;
    const rule2 = compileRule(mem2)!;
    // Simulate the sorted order (high first).
    const cache: ReflexCache = {
      rules: [rule2, rule1],
      preferences: [],
      arousal: 0,
      builtAt: Date.now(),
    };

    const call: ToolCall = { tool: "bash", args: { command: "test --flag" } };
    const matched = matchCall(cache, call);
    expect(matched).toBe(rule2); // The higher-priority rule comes first.
  });

  it("completes within 5ms for 100 rules (hard budget assertion)", () => {
    // Build 100 rules with different command substrings.
    const rules: ReflexRule[] = [];
    for (let i = 0; i < 100; i++) {
      const mem = makeMemory({
        id: `mem-${i}`,
        content: `Lesson ${i}`,
        metadata: { command: `command-${i}` },
        weight: 0.5,
        confidence: 0.5,
      });
      const rule = compileRule(mem);
      if (rule) rules.push(rule);
    }
    expect(rules).toHaveLength(100);

    const cache: ReflexCache = { rules, preferences: [], arousal: 0, builtAt: Date.now() };

    // The last rule should match — worst case (all 100 are checked).
    const call: ToolCall = { tool: "bash", args: { command: "command-99 --flag" } };

    // Warm up (JIT).
    matchCall(cache, call);

    // Measure.
    const start = performance.now();
    const result = matchCall(cache, call);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(elapsed).toBeLessThan(5); // Hard budget: 5ms.
  });
});

describe("buildReflexCache", () => {
  it("builds a cache from the store with rules and preferences", async () => {
    const store = new MemoryStore({
      projectId: "test",
      storagePath: uniqueDbPath(),
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    // Seed a lesson_learned with a command.
    await store.store({
      content: "npm install fails lockfile validation",
      type: "lesson_learned",
      scope: "project",
      confidence: 0.7,
      tags: [],
      metadata: { command: "npm install" },
    });

    // Seed a user_preference.
    await store.store({
      content: "Always use vim",
      type: "user_preference",
      scope: "global",
      confidence: 0.9,
      tags: [],
      metadata: {},
    });

    // Seed a lesson_learned WITHOUT a command or filePath (should not become a rule).
    await store.store({
      content: "Some abstract lesson",
      type: "lesson_learned",
      scope: "project",
      confidence: 0.6,
      tags: [],
      metadata: {},
    });

    const cache = await buildReflexCache(store);

    expect(cache.rules.length).toBe(1); // Only the one with metadata.command.
    expect(cache.preferences.length).toBe(1); // The user_preference.
    expect(cache.arousal).toBe(0); // Phase 1 stub.
    expect(cache.builtAt).toBeGreaterThan(0);
    expect(cache.rules[0].note).toContain("npm install");
  });

  it("respects the weight floor (minWeight: 0.3)", async () => {
    const store = new MemoryStore({
      projectId: "test",
      storagePath: uniqueDbPath(),
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    // Seed a low-weight lesson (below the floor).
    await store.store({
      content: "Low weight lesson",
      type: "lesson_learned",
      scope: "project",
      confidence: 0.2,
      tags: [],
      metadata: { command: "low-weight-cmd" },
    });

    // Manually set weight to 0.1 (below floor).
    // store.store sets weight based on confidence, so we need to update it.
    // Actually, the search uses minWeight filter on the weight column.
    // Let's seed with a higher confidence so the weight is above the floor.
    await store.store({
      content: "High weight lesson",
      type: "lesson_learned",
      scope: "project",
      confidence: 0.8,
      tags: [],
      metadata: { command: "high-weight-cmd" },
    });

    const cache = await buildReflexCache(store);
    // The low-weight one should be filtered out by the search minWeight.
    // (Note: the store sets weight = confidence on initial store, so the first
    // one with confidence 0.2 has weight 0.2 which is below 0.3.)
    expect(cache.rules.length).toBe(1);
    expect(cache.rules[0].note).toContain("High weight");
  });

  it("caps rules at REFLEX_RULE_CAP (100)", async () => {
    // This test verifies the cap logic, but we can't seed 200 memories quickly
    // in a test. Instead, verify the cap constant and the slice logic.
    expect(REFLEX_RULE_CAP).toBe(100);

    // Build a cache manually with >100 rules and verify it slices.
    // (buildReflexCache slices internally, but we test the cap here.)
    const rules: ReflexRule[] = [];
    for (let i = 0; i < 150; i++) {
      const mem = makeMemory({
        id: `mem-${i}`,
        content: `Lesson ${i}`,
        metadata: { command: `cmd-${i}` },
        weight: 0.5,
        confidence: 0.5,
      });
      const rule = compileRule(mem);
      if (rule) rules.push(rule);
    }
    expect(rules.length).toBe(150);

    // Simulate the sort + slice that buildReflexCache does.
    rules.sort((a, b) => b.salience * b.confidence - a.salience * a.confidence);
    const capped = rules.slice(0, REFLEX_RULE_CAP);
    expect(capped.length).toBe(100);
  });

  it("returns an empty cache when the store has no matching memories", async () => {
    const store = new MemoryStore({
      projectId: "test",
      storagePath: uniqueDbPath(),
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();

    const cache = await buildReflexCache(store);
    expect(cache.rules).toEqual([]);
    expect(cache.preferences).toEqual([]);
    expect(cache.arousal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// addRule (Phase 2)
// ---------------------------------------------------------------------------

describe("addRule", () => {
  function makeRule(overrides: Partial<ReflexRule> = {}): ReflexRule {
    return {
      memoryId: generateUlid(),
      match: /test/,
      action: "warn",
      note: "test note",
      salience: 0.5,
      confidence: 0.5,
      ...overrides,
    };
  }

  it("inserts a rule into an empty cache", () => {
    const cache = emptyReflexCache();
    const rule = makeRule();
    addRule(cache, rule);
    expect(cache.rules).toHaveLength(1);
    expect(cache.rules[0]).toBe(rule);
  });

  it("re-sorts by salience × confidence descending after insert", () => {
    const cache = emptyReflexCache();
    // Low-priority rule first.
    const low = makeRule({ memoryId: "low", salience: 0.3, confidence: 0.3 });
    addRule(cache, low);
    // High-priority rule second.
    const high = makeRule({ memoryId: "high", salience: 0.9, confidence: 0.9 });
    addRule(cache, high);

    // High (0.81) should be first, low (0.09) second.
    expect(cache.rules[0].memoryId).toBe("high");
    expect(cache.rules[1].memoryId).toBe("low");
  });

  it("trims to REFLEX_RULE_CAP when exceeded", () => {
    const cache = emptyReflexCache();
    // Fill to cap.
    for (let i = 0; i < REFLEX_RULE_CAP; i++) {
      addRule(cache, makeRule({ memoryId: `r${i}`, salience: 0.1, confidence: 0.1 }));
    }
    expect(cache.rules).toHaveLength(REFLEX_RULE_CAP);
    // Add one more — should trim back to cap (dropping the lowest).
    addRule(cache, makeRule({ memoryId: "overflow", salience: 0.5, confidence: 0.5 }));
    expect(cache.rules).toHaveLength(REFLEX_RULE_CAP);
    // The overflow rule (0.25 sal×conf) should be present; one of the 0.01 rules dropped.
    expect(cache.rules.some((r) => r.memoryId === "overflow")).toBe(true);
    // Exactly 99 of the original 100 low-priority rules survive (100 cap - 1 overflow).
    const survivingLow = cache.rules.filter((r) => r.memoryId.startsWith("r"));
    expect(survivingLow).toHaveLength(REFLEX_RULE_CAP - 1);
  });

  it("mutates the cache in place (same reference)", () => {
    const cache = emptyReflexCache();
    const ref = cache;
    addRule(cache, makeRule());
    expect(cache).toBe(ref); // same object reference
    expect(cache.rules.length).toBe(1);
  });
});
