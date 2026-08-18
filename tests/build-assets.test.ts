import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");

function dirname(p: string): string {
  return p.substring(0, p.lastIndexOf("/")) || ".";
}

describe("built UI static assets (issue #46)", () => {
  it("src/browser/static/ui/index.html exists and is a valid SPA shell", () => {
    const p = join(here, "src", "browser", "static", "ui", "index.html");
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, "utf-8");
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain("<!doctype html>");
    expect(content).toContain('id="root"');
  });

  it("built JS + CSS assets exist in src/browser/static/ui/assets/", () => {
    const assetsDir = join(here, "src", "browser", "static", "ui", "assets");
    expect(existsSync(assetsDir)).toBe(true);
    const files = readdirSync(assetsDir);
    const jsFiles = files.filter((f: string) => f.endsWith(".js"));
    const cssFiles = files.filter((f: string) => f.endsWith(".css"));
    expect(jsFiles.length).toBeGreaterThanOrEqual(1);
    expect(cssFiles.length).toBeGreaterThanOrEqual(1);
  });
});
