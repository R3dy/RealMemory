import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function dirname(p: string): string {
  return p.substring(0, p.lastIndexOf("/")) || ".";
}
const here = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("dependency cap (INV-014)", () => {
  it("package.json runtime dependencies are exactly the v0.1.0 set", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(new Set(deps)).toEqual(
      new Set([
        "@huggingface/transformers",
        "@modelcontextprotocol/sdk",
        "better-sqlite3",
        "zod",
      ]),
    );
  });

  it("vis-network is NOT a runtime dependency (vendored browser asset)", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("vis-network");
  });
});
