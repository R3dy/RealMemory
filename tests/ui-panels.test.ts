import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(__dirname, "..", "ui", "src");

function readFile(rel: string): string {
  return readFileSync(join(UI_DIR, rel), "utf-8");
}

/**
 * Synthetic-self Phase 8 — honesty assertions (§5.5).
 *
 * The data-driving Math.random must be DELETED from the 6 /brain panels +
 * the Home.tsx event ticker. Visual-effect Math.random (BrainCanvas particle
 * bursts, anim.tsx boot scramble, Home.tsx boot scramble) is RETAINED — those
 * are visual noise, not data. The "Live Telemetry (Simulated)" string must be
 * ABSENT from Brain.tsx.
 */
describe("ui panels — Phase 8 honesty (no data-driving Math.random)", () => {
  const DATA_DRIVING_FILES = [
    "components/brain/BrainLoopPipeline.tsx",
    "components/brain/PredictPanel.tsx",
    "components/brain/ReflexCore.tsx",
    "components/brain/WorkingMemoryWindow.tsx",
    "components/brain/ArousalGauge.tsx",
    "components/brain/ConsolidationPanel.tsx",
    "pages/Home.tsx",
  ];

  for (const file of DATA_DRIVING_FILES) {
    it(`${file} has no data-driving Math.random (only comments mentioning it)`, () => {
      const content = readFile(file);
      // Find all Math.random occurrences.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes("Math.random")) {
          // Must be in a comment (// or *) or a string literal describing the absence.
          const isComment =
            line.trim().startsWith("//") ||
            line.trim().startsWith("*") ||
            line.includes("no Math.random") ||
            line.includes("not Math.random") ||
            line.includes("Visual breathing effect");
          // Home.tsx boot scramble is a visual effect (line ~133).
          const isBootScramble =
            file === "pages/Home.tsx" && line.includes("SCRAMBLE[");
          expect(isComment || isBootScramble).toBe(true);
        }
      }
    });
  }

  it('Brain.tsx does NOT contain "Live Telemetry (Simulated)"', () => {
    const content = readFile("pages/Brain.tsx");
    expect(content).not.toContain("Live Telemetry (Simulated)");
  });

  it("Brain.tsx contains a LIVE/STALE/DEMO badge", () => {
    const content = readFile("pages/Brain.tsx");
    expect(content).toContain("LIVE");
    expect(content).toContain("STALE");
    // The badge uses BADGE_CONFIG keyed by liveness.
    expect(content).toMatch(/BADGE_CONFIG|badge/);
  });

  it("use-brain-stream.ts exports useBrainStream + useBrainEventsByKind", () => {
    const content = readFile("lib/use-brain-stream.ts");
    expect(content).toContain("export function useBrainStream");
    expect(content).toContain("export function useBrainEventsByKind");
  });

  it("Brain.tsx imports useBrainStream", () => {
    const content = readFile("pages/Brain.tsx");
    expect(content).toContain("useBrainStream");
  });
});

describe("visual-effect Math.random RETAINED (not data)", () => {
  it("BrainCanvas.tsx retains Math.random for particle bursts (visual)", () => {
    const content = readFile("components/brain/BrainCanvas.tsx");
    // Particle burst timing uses Math.random — this is visual noise, not data.
    expect(content).toContain("Math.random");
  });

  it("anim.tsx retains Math.random for boot scramble (visual)", () => {
    const content = readFile("components/brain/anim.tsx");
    expect(content).toContain("Math.random");
  });
});
