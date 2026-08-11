import { describe, it, expect, vi } from "vitest";
import {
  classifyIntent,
  isHighSignal,
  dynamicLimit,
  evaluateDelta,
  type BrainLoopState,
  type ToolCapture,
} from "../src/brain-loop";
import type { MemoryStore } from "../src/store";
import type { Memory, StoreInput } from "../src/types";

/** A mocked MemoryStore with just the methods evaluateDelta touches. */
function makeMockStore(): {
  mock: MemoryStore;
  store: ReturnType<typeof vi.fn>;
  recordMetric: ReturnType<typeof vi.fn>;
  getBloatRatio: ReturnType<typeof vi.fn>;
  storedCalls: StoreInput[];
} {
  const storedCalls: StoreInput[] = [];
  const store = vi.fn(async (input: StoreInput): Promise<Memory> => {
    storedCalls.push(input);
    return {
      id: `mem-${storedCalls.length}`,
      content: String(input.content ?? ""),
      type: input.type ?? "contextual_note",
      scope: input.scope ?? "project",
      tags: input.tags ?? [],
      weight: 0.5,
      confidence: input.confidence ?? 0.5,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      accessCount: 0,
      reinforcementCount: 0,
      metadata: (input.metadata ?? {}) as Record<string, unknown>,
      status: "active",
    };
  });
  const recordMetric = vi.fn(async () => {});
  const getBloatRatio = vi.fn(async () => 0);
  return {
    mock: { store, recordMetric, getBloatRatio } as unknown as MemoryStore,
    store,
    recordMetric,
    getBloatRatio,
    storedCalls,
  };
}

/** A minimal BrainLoopState with default "no turn yet" values. */
function makeState(overrides: Partial<BrainLoopState> = {}): BrainLoopState {
  return {
    lastUserText: null,
    lastUserIntent: null,
    lastToolCapture: null,
    lastInjectedMemoryIds: null,
    config: { brainLoop: true, autoRelate: true },
    ...overrides,
  };
}

function capture(tool: string, overrides: Partial<ToolCapture> = {}): ToolCapture {
  return { tool, isError: true, timestamp: 1234567890, ...overrides };
}

/* ------------------------------ classifyIntent ----------------------------- */

describe("classifyIntent", () => {
  it('returns "correction" for "no, use postgres not mysql"', () => {
    expect(classifyIntent("no, use postgres not mysql", "", [], null)).toBe("correction");
  });

  it('returns "preference" for "always run tests before committing"', () => {
    expect(classifyIntent("always run tests before committing", "", [], null)).toBe("preference");
  });

  it('returns "preference" for an "I prefer" sentence', () => {
    expect(classifyIntent("I prefer SQLite over Postgres", "", [], null)).toBe("preference");
  });

  it('returns "repetition" when the text is already in recentUserTexts', () => {
    expect(classifyIntent("run the tests", "", ["run the tests", "other text"], null)).toBe(
      "repetition",
    );
  });

  it('does NOT return "repetition" when recentUserTexts is empty', () => {
    expect(classifyIntent("build the app", "", [], null)).toBe("generic");
  });

  it('returns "generic" for "hello, how are you?"', () => {
    expect(classifyIntent("hello, how are you?", "", [], null)).toBe("generic");
  });

  it('returns "tool_outcome" when lastToolCapture is set and no other keywords match', () => {
    expect(classifyIntent("please continue", "", [], capture("bash"))).toBe("tool_outcome");
  });

  it("is case-insensitive and normalizes trivial spacing", () => {
    expect(classifyIntent("  NO, use MySQL INSTEAD OF Postgres  ", "", [], null)).toBe(
      "correction",
    );
    expect(classifyIntent("Always run tests", "", ["same text"], null)).toBe("preference");
  });
});

/* ------------------------------ isHighSignal ------------------------------ */

describe("isHighSignal", () => {
  it("returns true for correction", () => {
    expect(isHighSignal("correction")).toBe(true);
  });

  it("returns true for repetition", () => {
    expect(isHighSignal("repetition")).toBe(true);
  });

  it("returns true for preference", () => {
    expect(isHighSignal("preference")).toBe(true);
  });

  it("returns true for tool_outcome", () => {
    expect(isHighSignal("tool_outcome")).toBe(true);
  });

  it("returns false for generic", () => {
    expect(isHighSignal("generic")).toBe(false);
  });
});

/* ------------------------------- dynamicLimit ------------------------------ */

describe("dynamicLimit", () => {
  it("returns 5 for correction", () => {
    expect(dynamicLimit("correction")).toBe(5);
  });

  it("returns 5 for preference", () => {
    expect(dynamicLimit("preference")).toBe(5);
  });

  it("returns 5 for repetition", () => {
    expect(dynamicLimit("repetition")).toBe(5);
  });

  it("returns 5 for tool_outcome", () => {
    expect(dynamicLimit("tool_outcome")).toBe(5);
  });

  it("returns 3 for generic", () => {
    expect(dynamicLimit("generic")).toBe(3);
  });
});

/* ------------------------------ evaluateDelta ------------------------------ */

describe("evaluateDelta", () => {
  it("does not call store.store() when userText is null", async () => {
    const { mock, store } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({ lastUserIntent: "correction" }),
      null as unknown as string,
      "",
    );
    expect(store).not.toHaveBeenCalled();
  });

  it("does not call store.store() when userText is empty", async () => {
    const { mock, store } = makeMockStore();
    await evaluateDelta(mock, makeState({ lastUserIntent: "correction" }), "", "");
    expect(store).not.toHaveBeenCalled();
  });

  it("does not call store.store() when lastUserIntent is null", async () => {
    const { mock, store } = makeMockStore();
    await evaluateDelta(mock, makeState({ lastUserIntent: null }), "hello", "");
    expect(store).not.toHaveBeenCalled();
  });

  it("does not call store.store() with a generic intent (records preference_compliance only)", async () => {
    const { mock, store, recordMetric } = makeMockStore();
    await evaluateDelta(mock, makeState({ lastUserIntent: "generic" }), "hello, how are you?", "");
    expect(store).not.toHaveBeenCalled();
    expect(recordMetric).toHaveBeenCalledWith("preference_compliance", 1.0);
  });

  it("with a correction stores the C3 literal content template", async () => {
    const { mock, store, storedCalls } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({ lastUserIntent: "correction" }),
      "no, use postgres not mysql",
      "",
    );
    expect(store).toHaveBeenCalledTimes(1);
    expect(storedCalls[0].content).toBe("User corrected the agent: no, use postgres not mysql");
    expect(storedCalls[0].type).toBe("lesson_learned");
    expect(storedCalls[0].scope).toBe("project");
    expect(storedCalls[0].confidence).toBe(0.6);
    expect(storedCalls[0].tags).toEqual(["correction", "auto-brain-loop"]);
    expect(storedCalls[0].metadata).toEqual({ intent: "correction", source: "evaluateDelta" });
  });

  it("with a preference stores the user_preference literal content template", async () => {
    const { mock, store, storedCalls } = makeMockStore();
    await evaluateDelta(mock, makeState({ lastUserIntent: "preference" }), "always run tests", "");
    expect(store).toHaveBeenCalledTimes(1);
    expect(storedCalls[0].content).toBe("User preference: always run tests");
    expect(storedCalls[0].type).toBe("user_preference");
    expect(storedCalls[0].confidence).toBe(0.6);
  });

  it("with a tool_outcome stores the literal tool template (error branch)", async () => {
    const { mock, store, storedCalls } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({
        lastUserIntent: "tool_outcome",
        lastToolCapture: capture("bash", { command: "npm run build", isError: true }),
      }),
      "please continue",
      "",
    );
    expect(store).toHaveBeenCalledTimes(1);
    expect(storedCalls[0].content).toBe(
      "Tool outcome (bash): error — npm run build",
    );
    expect(storedCalls[0].type).toBe("lesson_learned");
  });

  it("with a repetition stores a task_pattern", async () => {
    const { mock, store, storedCalls } = makeMockStore();
    await evaluateDelta(mock, makeState({ lastUserIntent: "repetition" }), "run the tests again", "");
    expect(store).toHaveBeenCalledTimes(1);
    expect(storedCalls[0].content).toBe("Repeated request: run the tests again");
    expect(storedCalls[0].type).toBe("task_pattern");
  });

  it("records correction_stored for a correction and duplicates_rate when reinforced", async () => {
    const { mock, store, recordMetric } = makeMockStore();
    // A reinforced memory: reinforcementCount > 0 and updatedAt differs.
    store.mockResolvedValueOnce({
      id: "mem-existing",
      content: "User corrected the agent: no, use postgres not mysql",
      type: "lesson_learned",
      scope: "project",
      tags: ["correction", "auto-brain-loop"],
      weight: 0.7,
      confidence: 0.8,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      accessCount: 3,
      reinforcementCount: 2,
      metadata: {},
      status: "active",
    } as Memory);
    await evaluateDelta(
      mock,
      makeState({ lastUserIntent: "correction" }),
      "no, use postgres not mysql",
      "",
    );
    expect(store).toHaveBeenCalledTimes(1);
    expect(recordMetric).toHaveBeenCalledWith("correction_stored", 1.0);
    expect(recordMetric).toHaveBeenCalledWith("duplicate_rate", 1.0);
  });

  it("records recall_miss on session.idle (assistantText empty) when memories were injected this turn", async () => {
    const { mock, store, recordMetric } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({
        lastUserIntent: "preference",
        lastInjectedMemoryIds: ["mem-1", "mem-2"],
      }),
      "always run tests",
      "",
    );
    expect(store).toHaveBeenCalledTimes(1);
    expect(recordMetric).toHaveBeenCalledWith("recall_miss", 1.0);
  });

  it("records recall_hit when assistantText is present and memories were injected", async () => {
    const { mock, recordMetric } = makeMockStore();
    await evaluateDelta(
      mock,
      makeState({
        lastUserIntent: "preference",
        lastInjectedMemoryIds: ["mem-1"],
      }),
      "always run tests",
      "I will run the tests now",
    );
    expect(recordMetric).toHaveBeenCalledWith("recall_hit", 1.0);
  });

  it("does not record recall metrics when nothing was injected this turn", async () => {
    const { mock, recordMetric } = makeMockStore();
    await evaluateDelta(mock, makeState({ lastUserIntent: "preference" }), "always run tests", "");
    const recallCalls = recordMetric.mock.calls.filter(
      (c) => c[0] === "recall_hit" || c[0] === "recall_miss",
    );
    expect(recallCalls.length).toBe(0);
  });
});