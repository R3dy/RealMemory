import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");

function dirname(p: string): string {
  return p.substring(0, p.lastIndexOf("/")) || ".";
}

describe("vendored vis-network static asset", () => {
  it("src/browser/static/vis-network.min.js exists and is non-empty", () => {
    const p = join(here, "src", "browser", "static", "vis-network.min.js");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content.length).toBeGreaterThan(10000);
  });

  it("SHA256 matches the recorded version file", () => {
    const assetPath = join(here, "src", "browser", "static", "vis-network.min.js");
    const versionPath = join(here, "src", "browser", "static", "vis-network.VERSION.txt");
    const content = readFileSync(assetPath);
    const hash = createHash("sha256").update(content).digest("hex");
    const version = readFileSync(versionPath, "utf-8").trim();
    expect(version).toBe("9.1.9");
    expect(hash).toBe("f53f833ddb9bf97efe856bb0637d4fe88f39e39999c7e94a4b8afc8de8a1a2e5");
  });

  it("LICENSE file exists", () => {
    const p = join(here, "src", "browser", "static", "vis-network.LICENSE.txt");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("MIT");
  });
});
