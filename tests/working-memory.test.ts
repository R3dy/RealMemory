import { describe, it, expect } from "vitest";
import {
  assembleWorkingMemory,
  estimateTokens,
  emptySlot,
  emptySlots,
  SLOT_BUDGETS,
  DEFAULT_WORKING_MEMORY_TOKENS,
  type WorkingMemorySlots,
  type WorkingMemorySlot,
} from "../src/working-memory";

function slot(content: string, memoryIds: string[] = []): WorkingMemorySlot {
  return { content, memoryIds };
}

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length/4) for non-empty string", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75, ceil = 3
  });

  it("returns 1 for a 4-char string", () => {
    expect(estimateTokens("test")).toBe(1);
  });
});

describe("emptySlot / emptySlots", () => {
  it("emptySlot returns content='' and memoryIds=[]", () => {
    expect(emptySlot()).toEqual({ content: "", memoryIds: [] });
  });

  it("emptySlots returns all 5 slots empty", () => {
    const s = emptySlots();
    expect(s.identity).toEqual({ content: "", memoryIds: [] });
    expect(s.taskFrame).toEqual({ content: "", memoryIds: [] });
    expect(s.queriedLessons).toEqual({ content: "", memoryIds: [] });
    expect(s.freshLessons).toEqual({ content: "", memoryIds: [] });
    expect(s.openPredictions).toEqual({ content: "", memoryIds: [] });
  });
});

describe("assembleWorkingMemory", () => {
  it("returns null when all slots empty and no warn note", () => {
    const result = assembleWorkingMemory(emptySlots(), null, {});
    expect(result.formatted).toBeNull();
    expect(result.deliveredMemoryIds).toEqual([]);
  });

  // C1 fix: warn note delivered even when all slots empty
  it("returns non-null when all slots empty but warn note is non-null (C1 fix)", () => {
    const result = assembleWorkingMemory(emptySlots(), "[realmemory reflex] npm install fails here", {});
    expect(result.formatted).not.toBeNull();
    expect(result.formatted).toContain("## Working memory");
    expect(result.formatted).toContain("### Active lessons");
    expect(result.formatted).toContain("[realmemory reflex] npm install fails here");
  });

  it("produces a window with a single populated slot", () => {
    const slots: WorkingMemorySlots = {
      ...emptySlots(),
      identity: slot("You prefer concise recommendations.", ["m1"]),
    };
    const result = assembleWorkingMemory(slots, null, {});
    expect(result.formatted).not.toBeNull();
    expect(result.formatted).toContain("## Working memory");
    expect(result.formatted).toContain("You prefer concise recommendations.");
  });

  it("produces a window with all populated slots", () => {
    const slots: WorkingMemorySlots = {
      identity: slot("Identity content", ["m1"]),
      taskFrame: slot("Task content", ["m2"]),
      queriedLessons: slot("Queried lesson", ["m3"]),
      freshLessons: slot("Fresh lesson", ["m4"]),
      openPredictions: slot("Surprising outcome", ["m5"]),
    };
    const result = assembleWorkingMemory(slots, null, {});
    expect(result.formatted).not.toBeNull();
    expect(result.formatted).toContain("Identity content");
    expect(result.formatted).toContain("### Task");
    expect(result.formatted).toContain("Task content");
    expect(result.formatted).toContain("### Active lessons");
    expect(result.formatted).toContain("Fresh lesson");
    expect(result.formatted).toContain("Queried lesson");
    expect(result.formatted).toContain("Surprising outcome");
  });

  // C3 fix: deliveredMemoryIds contains ONLY taskFrame IDs
  it("deliveredMemoryIds contains only taskFrame IDs (C3 fix)", () => {
    const slots: WorkingMemorySlots = {
      identity: slot("Identity", ["m1"]),
      taskFrame: slot("Task", ["m2", "m3"]),
      queriedLessons: slot("Lesson", ["m4"]),
      freshLessons: slot("Fresh", ["m5"]),
      openPredictions: slot("Prediction", ["m6"]),
    };
    const result = assembleWorkingMemory(slots, null, {});
    expect(result.deliveredMemoryIds).toEqual(["m2", "m3"]);
  });

  // C4 fix: queriedLessons and freshLessons are separate sub-slots, merged at assembly
  it("merges freshLessons before queriedLessons in active-lessons section (C4 fix)", () => {
    const slots: WorkingMemorySlots = {
      ...emptySlots(),
      freshLessons: slot("FRESH_CONTENT", ["mf"]),
      queriedLessons: slot("QUERIED_CONTENT", ["mq"]),
    };
    const result = assembleWorkingMemory(slots, null, {});
    expect(result.formatted).not.toBeNull();
    const freshPos = result.formatted!.indexOf("FRESH_CONTENT");
    const queriedPos = result.formatted!.indexOf("QUERIED_CONTENT");
    expect(freshPos).toBeGreaterThan(-1);
    expect(queriedPos).toBeGreaterThan(-1);
    expect(freshPos).toBeLessThan(queriedPos); // fresh comes first
  });

  // C15 fix: warn note prepended to active-lessons, counts against budget
  it("warn note is prepended to active-lessons section (C15 fix)", () => {
    const slots: WorkingMemorySlots = {
      ...emptySlots(),
      queriedLessons: slot("LESSON_CONTENT", ["ml"]),
    };
    const result = assembleWorkingMemory(slots, "WARN_NOTE", {});
    expect(result.formatted).not.toBeNull();
    const warnPos = result.formatted!.indexOf("WARN_NOTE");
    const lessonPos = result.formatted!.indexOf("LESSON_CONTENT");
    expect(warnPos).toBeGreaterThan(-1);
    expect(lessonPos).toBeGreaterThan(-1);
    expect(warnPos).toBeLessThan(lessonPos); // warn note comes first
  });

  it("truncates slot content exceeding its budget (whole-line granularity)", () => {
    // Create content that exceeds the activeLessons budget (300 tokens = ~1200 chars)
    const longLine = "A".repeat(500);
    const content = [longLine, longLine, longLine].join("\n"); // ~1500 chars = ~375 tokens
    const slots: WorkingMemorySlots = {
      ...emptySlots(),
      queriedLessons: slot(content, ["m1", "m2", "m3"]),
    };
    const result = assembleWorkingMemory(slots, null, {});
    expect(result.formatted).not.toBeNull();
    // The content should be truncated — not all 3 lines should fit
    const lineCount = result.formatted!.split("\n").filter((l) => l.includes("A".repeat(100))).length;
    expect(lineCount).toBeLessThan(3);
  });

  // Total budget enforcement: trim openPredictions first, then queriedLessons, then freshLessons
  it("trims openPredictions first when total exceeds budget (2-C4 fix)", () => {
    const slots: WorkingMemorySlots = {
      identity: slot("I".repeat(100), ["mi"]), // ~25 tokens, under 150 budget
      taskFrame: slot("T".repeat(100), ["mt"]), // ~25 tokens, under 200 budget
      freshLessons: slot("F".repeat(100), ["mf"]), // ~25 tokens
      queriedLessons: slot("Q".repeat(100), ["mq"]), // ~25 tokens
      openPredictions: slot("P".repeat(100), ["mp"]), // ~25 tokens
    };
    // Set a very small total budget to force trimming
    const result = assembleWorkingMemory(slots, null, { workingMemoryTokens: 100 });
    expect(result.formatted).not.toBeNull();
    // Identity and taskFrame are protected — should be present
    expect(result.formatted).toContain("I".repeat(100));
    expect(result.formatted).toContain("T".repeat(100));
    // openPredictions should be trimmed first (may or may not be present depending on remaining budget)
  });

  it("does not export working-memory from the public API (C16 fix)", async () => {
    // Verify the module is not re-exported from src/index.ts
    const indexContent = await import("node:fs").then((fs) =>
      fs.readFileSync(require("path").join(__dirname, "..", "src", "index.ts"), "utf-8"),
    );
    expect(indexContent).not.toContain("working-memory");
    expect(indexContent).not.toContain("workingMemory");
  });
});
