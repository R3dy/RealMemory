import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const twinScript = join(repoRoot, "scripts", "twin", "run-twin.mjs");
const sampleStream = join(repoRoot, "scripts", "twin", "sample-stream.json");

describe("twin harness (synthetic-self Phase 10 Gate 2)", () => {
  it("the harness script exists", () => {
    expect(existsSync(twinScript)).toBe(true);
  });

  it("the sample task stream exists and is valid JSON", () => {
    expect(existsSync(sampleStream)).toBe(true);
    const parsed: unknown = JSON.parse(readFileSync(sampleStream, "utf-8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeGreaterThan(0);
  });

  it("runs end-to-end and returns a PASS verdict (drifting not worse than frozen)", () => {
    // Run the harness against the sample stream. Use the built dist (the
    // harness imports from dist/). This is a smoke test — it proves the
    // plumbing exists and the comparison is reproducible.
    const output = execFileSync("node", [twinScript], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(output).toContain("verdict: PASS");
    expect(output).toContain("frozen traits:");
    expect(output).toContain("drifting traits:");
    // The drifting install should show at least one trait moved off baseline.
    expect(output).toContain('"caution":0.5');
    // drifting caution should differ from 0.5 (corrections in sample stream).
    const driftingLine = output
      .split("\n")
      .find((l) => l.startsWith("drifting traits:"));
    expect(driftingLine).toBeTruthy();
    expect(driftingLine).not.toContain('"caution":0.5,');
  }, 35000);
});
