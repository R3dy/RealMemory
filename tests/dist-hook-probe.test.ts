import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Verify that the compiled dist/ contains the Phase 0 probe instrumentation.
 * Guards INV-019 (dist committed to git) — a stale dist would ship
 * uninstrumented code to the live OpenCode install.
 */
describe("dist hook-probe instrumentation", () => {
  it("dist/plugin-entry.js contains recordHookFired calls", () => {
    const distPath = join(__dirname, "..", "dist", "plugin-entry.js");
    expect(existsSync(distPath)).toBe(true);
    const content = readFileSync(distPath, "utf-8");
    // The compiled plugin must contain the recordHookFired instrumentation.
    expect(content).toContain("recordHookFired");
  });

  it("dist/bin.js contains the --doctor dispatch", () => {
    const distPath = join(__dirname, "..", "dist", "bin.js");
    expect(existsSync(distPath)).toBe(true);
    const content = readFileSync(distPath, "utf-8");
    // The compiled CLI must contain the --doctor branch.
    expect(content).toContain("doctor");
    expect(content).toContain("printDoctorTable");
  });

  it("dist/plugin-entry.js contains pushSentinel", () => {
    const distPath = join(__dirname, "..", "dist", "plugin-entry.js");
    const content = readFileSync(distPath, "utf-8");
    expect(content).toContain("pushSentinel");
  });
});
