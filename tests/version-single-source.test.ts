import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version";

/**
 * Drift guard for the version string (issue #60).
 *
 * The package version has ONE literal: src/version.ts. package.json and
 * ui/package.json must agree with it. If a release bumps any one file alone,
 * this test fails — no more surfaces showing four different numbers.
 */
describe("version single-source drift guard", () => {
  const repoRoot = process.cwd();

  it("package.json version matches src/version.ts", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.version).toBe(VERSION);
  });

  it("ui/package.json version matches src/version.ts", () => {
    const uiPkg = JSON.parse(readFileSync(join(repoRoot, "ui", "package.json"), "utf8"));
    expect(uiPkg.version).toBe(VERSION);
  });
});
