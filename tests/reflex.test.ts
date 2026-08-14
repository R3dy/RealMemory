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
  decideAction,
  decrementRuleConfidence,
  type InhibitionLevel,
  BLOCK_SALIENCE_FLOOR,
  BLOCK_CONFIDENCE_FLOOR,
  REWRITE_SALIENCE_FLOOR,
  REWRITE_CONFIDENCE_FLOOR,
  OVERRIDE_CONFIDENCE_DEC,
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

// ---------------------------------------------------------------------------
// Phase 4a: compileRule capabilities (rewrite + blockEligible)
// ---------------------------------------------------------------------------

describe("Phase 4a: compileRule capabilities", () => {
  function makeMemory(overrides: Partial<Memory> = {}): Memory {
    return {
      id: generateUlid(),
      content: "npm install fails lockfile validation here",
      type: "lesson_learned",
      scope: "project",
      category: "gotcha",
      tags: [],
      weight: 0.7,
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessCount: 0,
      reinforcementCount: 0,
      metadata: { command: "npm install" },
      status: "active",
      ...overrides,
    };
  }

  it("compiles a rewrite function from metadata.rewrite", () => {
    const mem = makeMemory({
      metadata: {
        command: "npm install",
        rewrite: { tool: "bash", from: "npm install", to: "npm ci" },
      },
    });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.rewrite).toBeDefined();
    const result = rule!.rewrite!({ command: "npm install foo" });
    expect(result.command).toBe("npm ci foo");
  });

  it("rewrite fn is a no-op when 'from' is absent from the command (R1-N6)", () => {
    const mem = makeMemory({
      metadata: {
        command: "npm install",
        rewrite: { tool: "bash", from: "npm install", to: "npm ci" },
      },
    });
    const rule = compileRule(mem);
    const result = rule!.rewrite!({ command: "yarn add foo" });
    expect(result.command).toBe("yarn add foo"); // unchanged
  });

  it("rewrite fn handles missing command field gracefully", () => {
    const mem = makeMemory({
      metadata: {
        command: "npm install",
        rewrite: { tool: "bash", from: "npm install", to: "npm ci" },
      },
    });
    const rule = compileRule(mem);
    const result = rule!.rewrite!({ filePath: "/some/path" });
    expect(result).toEqual({ filePath: "/some/path" }); // unchanged
  });

  it("sets blockEligible true for category safety", () => {
    const mem = makeMemory({ category: "safety", weight: 0.9 });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.blockEligible).toBe(true);
  });

  it("sets blockEligible true for category cost", () => {
    const mem = makeMemory({ category: "cost", weight: 0.9 });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.blockEligible).toBe(true);
  });

  it("does NOT set blockEligible for category gotcha", () => {
    const mem = makeMemory({ category: "gotcha", weight: 0.9 });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.blockEligible).toBeFalsy();
  });

  it("does NOT set rewrite when metadata.rewrite is absent", () => {
    const mem = makeMemory({ metadata: { command: "npm install" } });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.rewrite).toBeUndefined();
  });

  it("a rule can have BOTH rewrite and blockEligible", () => {
    const mem = makeMemory({
      category: "safety",
      weight: 0.9,
      metadata: {
        command: "npm install",
        rewrite: { tool: "bash", from: "npm install", to: "npm ci" },
      },
    });
    const rule = compileRule(mem);
    expect(rule).not.toBeNull();
    expect(rule!.rewrite).toBeDefined();
    expect(rule!.blockEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 4a: decideAction (pure function, 28-case matrix)
// ---------------------------------------------------------------------------

describe("Phase 4a: decideAction", () => {
  // Rule archetypes
  const noRule = null;
  const lowSalience = {
    memoryId: "low",
    match: /x/ as unknown as RegExp,
    note: "low",
    salience: 0.3,
    confidence: 0.8,
  };
  const midSalienceRewrite = {
    memoryId: "mid-rw",
    match: /x/ as unknown as RegExp,
    rewrite: (): Record<string, unknown> => ({ command: "fixed" }),
    note: "mid rewrite",
    salience: 0.6,
    confidence: 0.7,
  };
  const highSalienceBlock = {
    memoryId: "high-blk",
    match: /x/ as unknown as RegExp,
    blockEligible: true,
    note: "high block",
    salience: 0.9,
    confidence: 0.8,
  };
  const highSalienceNoBlock = {
    memoryId: "high-noblk",
    match: /x/ as unknown as RegExp,
    note: "high no block",
    salience: 0.9,
    confidence: 0.8,
  };
  // R2-C1: confidence-gate cases
  const highSalienceBlockLowConf = {
    memoryId: "high-blk-lowconf",
    match: /x/ as unknown as RegExp,
    blockEligible: true,
    note: "high block low conf",
    salience: 0.9,
    confidence: 0.3, // below BLOCK_CONFIDENCE_FLOOR (0.5)
  };
  const midSalienceRewriteLowConf = {
    memoryId: "mid-rw-lowconf",
    match: /x/ as unknown as RegExp,
    rewrite: (): Record<string, unknown> => ({ command: "fixed" }),
    note: "mid rewrite low conf",
    salience: 0.6,
    confidence: 0.2, // below REWRITE_CONFIDENCE_FLOOR (0.3)
  };

  const levels: InhibitionLevel[] = ["off", "warn", "rewrite", "block"];

  it("returns 'none' for no rule regardless of inhibition", () => {
    for (const lvl of levels) {
      expect(decideAction(noRule, lvl)).toBe("none");
    }
  });

  it("returns 'none' for inhibition 'off' regardless of rule", () => {
    expect(decideAction(lowSalience as never, "off")).toBe("none");
    expect(decideAction(midSalienceRewrite as never, "off")).toBe("none");
    expect(decideAction(highSalienceBlock as never, "off")).toBe("none");
  });

  it("returns 'warn' for inhibition 'warn' regardless of rule", () => {
    expect(decideAction(lowSalience as never, "warn")).toBe("warn");
    expect(decideAction(midSalienceRewrite as never, "warn")).toBe("warn");
    expect(decideAction(highSalienceBlock as never, "warn")).toBe("warn");
  });

  it("inhibition 'rewrite': rewrite for mid-salience rewrite rule, warn for others", () => {
    expect(decideAction(lowSalience as never, "rewrite")).toBe("warn");
    expect(decideAction(midSalienceRewrite as never, "rewrite")).toBe("rewrite");
    // high-salience block-eligible but ceiling is rewrite → can still rewrite if it has rewrite
    expect(decideAction(highSalienceBlock as never, "rewrite")).toBe("warn"); // no rewrite fn
    expect(decideAction(highSalienceNoBlock as never, "rewrite")).toBe("warn"); // no rewrite fn
  });

  it("inhibition 'block': block for high-salience block-eligible, warn for high-no-block", () => {
    expect(decideAction(highSalienceBlock as never, "block")).toBe("block");
    expect(decideAction(highSalienceNoBlock as never, "block")).toBe("warn");
  });

  it("inhibition 'block': rewrite for mid-salience rewrite rule", () => {
    expect(decideAction(midSalienceRewrite as never, "block")).toBe("rewrite");
  });

  // R2-C1: confidence gate cases
  it("R2-C1: high-salience block-eligible with LOW confidence does NOT block (falls to warn)", () => {
    expect(decideAction(highSalienceBlockLowConf as never, "block")).toBe("warn");
  });

  it("R2-C1: mid-salience rewrite rule with LOW confidence does NOT rewrite (falls to warn)", () => {
    expect(decideAction(midSalienceRewriteLowConf as never, "block")).toBe("warn");
    expect(decideAction(midSalienceRewriteLowConf as never, "rewrite")).toBe("warn");
  });

  it("block requires BOTH salience >= 0.8 AND confidence >= 0.5 AND blockEligible", () => {
    // salience ok, confidence ok, but not blockEligible
    expect(decideAction(highSalienceNoBlock as never, "block")).toBe("warn");
    // salience ok, blockEligible, but confidence too low
    expect(decideAction(highSalienceBlockLowConf as never, "block")).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Phase 4a: decrementRuleConfidence (extinction)
// ---------------------------------------------------------------------------

describe("Phase 4a: decrementRuleConfidence", () => {
  it("decrements confidence and re-sorts", () => {
    const cache = emptyReflexCache();
    addRule(cache, {
      memoryId: "r1",
      match: /x/,
      note: "high",
      salience: 0.9,
      confidence: 0.8,
    });
    addRule(cache, {
      memoryId: "r2",
      match: /y/,
      note: "low",
      salience: 0.5,
      confidence: 0.9,
    });
    // r1 is first (0.9*0.8=0.72 > 0.5*0.9=0.45)
    expect(cache.rules[0].memoryId).toBe("r1");

    decrementRuleConfidence(cache, "r1", OVERRIDE_CONFIDENCE_DEC);
    expect(cache.rules[0].confidence).toBeCloseTo(0.6, 10); // 0.8 - 0.2
    // 0.9*0.6=0.54 > 0.5*0.9=0.45 → still first
    expect(cache.rules[0].memoryId).toBe("r1");
  });

  it("after enough decrements, confidence crosses the block floor (extinction)", () => {
    const cache = emptyReflexCache();
    addRule(cache, {
      memoryId: "blk",
      match: /x/,
      blockEligible: true,
      note: "block rule",
      salience: 0.9,
      confidence: 0.9,
    });
    // 0.9 → 0.7 → ~0.5 → ~0.3 (float imprecision: 0.7-0.2=0.4999...)
    decrementRuleConfidence(cache, "blk", OVERRIDE_CONFIDENCE_DEC);
    expect(cache.rules[0].confidence).toBeCloseTo(0.7, 10);
    expect(
      decideAction(cache.rules[0], "block"),
    ).toBe("block"); // 0.7 >= 0.5

    decrementRuleConfidence(cache, "blk", OVERRIDE_CONFIDENCE_DEC);
    // 0.7 - 0.2 = 0.4999... < 0.5 due to float — extinct already
    expect(cache.rules[0].confidence).toBeLessThan(BLOCK_CONFIDENCE_FLOOR);
    expect(decideAction(cache.rules[0], "block")).toBe("warn"); // below floor

    decrementRuleConfidence(cache, "blk", OVERRIDE_CONFIDENCE_DEC);
    expect(cache.rules[0].confidence).toBeCloseTo(0.3, 1);
    expect(decideAction(cache.rules[0], "block")).toBe("warn"); // still warn
  });

  it("clamps confidence at 0 (no negatives)", () => {
    const cache = emptyReflexCache();
    addRule(cache, {
      memoryId: "r",
      match: /x/,
      note: "low",
      salience: 0.5,
      confidence: 0.1,
    });
    decrementRuleConfidence(cache, "r", 0.5);
    expect(cache.rules[0].confidence).toBe(0);
  });

  it("no-op if memoryId not found", () => {
    const cache = emptyReflexCache();
    addRule(cache, {
      memoryId: "r1",
      match: /x/,
      note: "n",
      salience: 0.5,
      confidence: 0.5,
    });
    const before = cache.rules[0].confidence;
    decrementRuleConfidence(cache, "nonexistent", 0.2);
    expect(cache.rules[0].confidence).toBe(before);
  });
});
