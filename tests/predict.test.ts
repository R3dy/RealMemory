import { describe, it, expect } from "vitest";
import {
  predictOutcome,
  classifyOutcome,
  computeSurprise,
  shouldEncode,
  surpriseBin,
  describe as describeCall,
  hashArgs,
  consumePrediction,
  type Prediction,
} from "../src/predict";
import type { ReflexRule } from "../src/reflex";
import { isErrorResult } from "../src/plugin";

// Helper: build a ReflexRule for testing.
function makeRule(overrides: Partial<ReflexRule> = {}): ReflexRule {
  return {
    memoryId: "mem-001",
    match: /test/,
    note: "test note",
    salience: 0.7,
    confidence: 0.6,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// predictOutcome
// ---------------------------------------------------------------------------

describe("predictOutcome", () => {
  it("predicts failure from a matching rule", () => {
    const rule = makeRule({ confidence: 0.8, memoryId: "mem-123" });
    const pred = predictOutcome(rule);
    expect(pred.willSucceed).toBe(false);
    expect(pred.confidence).toBe(0.8);
    expect(pred.sourceMemoryId).toBe("mem-123");
  });

  it("returns the uncertain default for no match (null rule)", () => {
    const pred = predictOutcome(null);
    expect(pred.willSucceed).toBe(true);
    expect(pred.confidence).toBe(0.5);
    expect(pred.sourceMemoryId).toBeNull();
  });

  it("is a pure function — no side effects, <5ms", () => {
    const rule = makeRule();
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      predictOutcome(rule);
    }
    const elapsed = performance.now() - start;
    // 10000 calls should complete well under 50ms total (i.e. <0.005ms each).
    expect(elapsed).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// classifyOutcome
// ---------------------------------------------------------------------------

describe("classifyOutcome", () => {
  it("classifies bash success when isErrorResult returns false", () => {
    expect(classifyOutcome("bash", "done", isErrorResult)).toEqual({ success: true });
  });

  it("classifies bash error when isErrorResult returns true", () => {
    expect(classifyOutcome("bash", "Error: something failed", isErrorResult)).toEqual({
      success: false,
    });
  });

  it("classifies Error instances as failure for non-bash tools", () => {
    expect(classifyOutcome("read", new Error("boom"), isErrorResult)).toEqual({
      success: false,
    });
  });

  it("classifies strings containing 'error:' as failure for non-bash tools", () => {
    expect(classifyOutcome("read", "error: file not found", isErrorResult)).toEqual({
      success: false,
    });
  });

  it("classifies normal non-bash output as success", () => {
    expect(classifyOutcome("read", "file contents here", isErrorResult)).toEqual({
      success: true,
    });
    expect(classifyOutcome("write", { bytes: 42 }, isErrorResult)).toEqual({
      success: true,
    });
  });

  it("handles null/undefined output defensively", () => {
    expect(classifyOutcome("read", null, isErrorResult)).toEqual({ success: true });
    expect(classifyOutcome("read", undefined, isErrorResult)).toEqual({
      success: true,
    });
  });
});

// ---------------------------------------------------------------------------
// computeSurprise
// ---------------------------------------------------------------------------

describe("computeSurprise", () => {
  it("returns 0 when prediction matches actual at full confidence", () => {
    // Predict success at confidence 1.0, actual success → surprise 0.
    const pred: Prediction = { willSucceed: true, confidence: 1.0, sourceMemoryId: null };
    expect(computeSurprise(pred, { success: true })).toBe(0);
  });

  it("returns 1 when prediction is fully wrong", () => {
    // Predict success at confidence 1.0, actual failure → surprise 1.
    const pred: Prediction = { willSucceed: true, confidence: 1.0, sourceMemoryId: null };
    expect(computeSurprise(pred, { success: false })).toBe(1);
  });

  it("returns 0.5 for the uncertain default on failure", () => {
    // Predict success at confidence 0.5, actual failure → surprise 0.5.
    const pred: Prediction = { willSucceed: true, confidence: 0.5, sourceMemoryId: null };
    expect(computeSurprise(pred, { success: false })).toBe(0.5);
  });

  it("returns 0.5 for the uncertain default on success", () => {
    const pred: Prediction = { willSucceed: true, confidence: 0.5, sourceMemoryId: null };
    expect(computeSurprise(pred, { success: true })).toBe(0.5);
  });

  it("computes surprise for failure prediction correctly", () => {
    // Predict failure at confidence 0.8 → expected = 1 - 0.8 = 0.2.
    // Actual failure (0) → surprise = |0 - 0.2| = 0.2.
    const pred: Prediction = { willSucceed: false, confidence: 0.8, sourceMemoryId: "m1" };
    expect(computeSurprise(pred, { success: false })).toBeCloseTo(0.2, 5);
    // Actual success (1) → surprise = |1 - 0.2| = 0.8.
    expect(computeSurprise(pred, { success: true })).toBeCloseTo(0.8, 5);
  });

  it("is always in [0, 1]", () => {
    for (const willSucceed of [true, false]) {
      for (const confidence of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0]) {
        for (const success of [true, false]) {
          const pred: Prediction = { willSucceed, confidence, sourceMemoryId: null };
          const s = computeSurprise(pred, { success });
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// shouldEncode
// ---------------------------------------------------------------------------

describe("shouldEncode", () => {
  it("returns false below 0.2", () => {
    expect(shouldEncode(0)).toBe(false);
    expect(shouldEncode(0.1)).toBe(false);
    expect(shouldEncode(0.19)).toBe(false);
  });

  it("returns true at exactly 0.2 (boundary)", () => {
    expect(shouldEncode(0.2)).toBe(true);
  });

  it("returns true above 0.2", () => {
    expect(shouldEncode(0.5)).toBe(true);
    expect(shouldEncode(1.0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// surpriseBin
// ---------------------------------------------------------------------------

describe("surpriseBin", () => {
  it("returns 'low' for surprise < 0.2", () => {
    expect(surpriseBin(0)).toBe("low");
    expect(surpriseBin(0.19)).toBe("low");
  });

  it("returns 'med' for 0.2 <= surprise <= 0.7", () => {
    expect(surpriseBin(0.2)).toBe("med");
    expect(surpriseBin(0.5)).toBe("med");
    expect(surpriseBin(0.7)).toBe("med"); // boundary: not > 0.7
  });

  it("returns 'high' for surprise > 0.7", () => {
    expect(surpriseBin(0.71)).toBe("high");
    expect(surpriseBin(1.0)).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

describe("describe", () => {
  it("includes tool name, expected, observed, and command", () => {
    const s = describeCall(
      { tool: "bash", args: { command: "rm -rf /tmp" } },
      { success: false },
    );
    expect(s).toContain("bash");
    expect(s).toContain("failure");
    expect(s).toContain("error");
    expect(s).toContain("rm -rf /tmp");
  });

  it("includes filePath when no command", () => {
    const s = describeCall(
      { tool: "read", args: { filePath: "/etc/config" } },
      { success: true },
    );
    expect(s).toContain("read");
    expect(s).toContain("success");
    expect(s).toContain("/etc/config");
  });

  it("truncates long commands to 200 chars", () => {
    const longCmd = "x".repeat(300);
    const s = describeCall(
      { tool: "bash", args: { command: longCmd } },
      { success: false },
    );
    // The command portion should be truncated (the total string includes
    // the prefix, so check the command substring is <= 200 chars).
    const cmdPart = s.slice(s.indexOf("— ") + 2);
    expect(cmdPart.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// hashArgs
// ---------------------------------------------------------------------------

describe("hashArgs", () => {
  it("produces stable output for the same args", () => {
    const args = { command: "ls", flag: true };
    expect(hashArgs(args)).toBe(hashArgs(args));
  });

  it("is key-order-independent (sorted keys)", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(hashArgs(a)).toBe(hashArgs(b));
  });

  it("returns empty string for undefined/null", () => {
    expect(hashArgs(undefined)).toBe("");
    expect(hashArgs(null as unknown as undefined)).toBe("");
  });

  it("handles nested objects with sorted keys", () => {
    const a = { outer: { b: 2, a: 1 } };
    const b = { outer: { a: 1, b: 2 } };
    expect(hashArgs(a)).toBe(hashArgs(b));
  });
});

// ---------------------------------------------------------------------------
// consumePrediction
// ---------------------------------------------------------------------------

describe("consumePrediction", () => {
  it("returns null for an empty Map", () => {
    const pending = new Map<string, Prediction>();
    expect(consumePrediction(pending, "bash", { command: "ls" })).toBeNull();
  });

  it("matches by full tool:argsHash: prefix", () => {
    const pending = new Map<string, Prediction>();
    const args = { command: "rm -rf /tmp" };
    const callId = `bash:${hashArgs(args)}:0`;
    pending.set(callId, { willSucceed: false, confidence: 0.8, sourceMemoryId: "m1" });
    expect(consumePrediction(pending, "bash", args)).toBe(callId);
  });

  it("disambiguates interleaved same-tool calls with different args (C4)", () => {
    const pending = new Map<string, Prediction>();
    const argsA = { command: "ls" };
    const argsB = { command: "rm -rf /tmp" };
    const idA = `bash:${hashArgs(argsA)}:0`;
    const idB = `bash:${hashArgs(argsB)}:1`;
    pending.set(idA, { willSucceed: true, confidence: 0.5, sourceMemoryId: null });
    pending.set(idB, { willSucceed: false, confidence: 0.8, sourceMemoryId: "m1" });
    // Consume A — should match idA, NOT idB (even though B was inserted more recently).
    expect(consumePrediction(pending, "bash", argsA)).toBe(idA);
    // Consume B — should match idB.
    expect(consumePrediction(pending, "bash", argsB)).toBe(idB);
  });

  it("falls back to most-recent-for-tool when no hash matches", () => {
    const pending = new Map<string, Prediction>();
    // Insert with argsA.
    const argsA = { command: "ls" };
    const idA = `bash:${hashArgs(argsA)}:0`;
    pending.set(idA, { willSucceed: true, confidence: 0.5, sourceMemoryId: null });
    // Consume with different args (no full-prefix match) → fallback to tool prefix.
    const result = consumePrediction(pending, "bash", { command: "different" });
    expect(result).toBe(idA);
  });

  it("returns most-recent when multiple entries match the tool prefix", () => {
    const pending = new Map<string, Prediction>();
    const id1 = `bash:${hashArgs({ command: "ls" })}:0`;
    const id2 = `bash:${hashArgs({ command: "pwd" })}:1`;
    pending.set(id1, { willSucceed: true, confidence: 0.5, sourceMemoryId: null });
    pending.set(id2, { willSucceed: true, confidence: 0.5, sourceMemoryId: null });
    // No exact args match → fallback to tool prefix → most-recent (id2).
    const result = consumePrediction(pending, "bash", { command: "different" });
    expect(result).toBe(id2);
  });
});
