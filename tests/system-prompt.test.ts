import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendToSystemLast } from "../src/system-prompt";

describe("appendToSystemLast (issue #64 — merge, not push)", () => {
  it("appends to the LAST element of a non-empty array, leaving the count unchanged", () => {
    const system = ["You are an agent."];
    appendToSystemLast(system, "## Working memory\n- remember this");
    expect(system).toHaveLength(1);
    expect(system[0]).toContain("You are an agent.");
    expect(system[0]).toContain("## Working memory");
    expect(system[0]).toContain("\n\n");
  });

  it("preserves earlier elements untouched", () => {
    const system = ["first", "second"];
    appendToSystemLast(system, "block");
    expect(system).toHaveLength(2);
    expect(system[0]).toBe("first");
    expect(system[1]).toBe("second\n\nblock");
  });

  it("pushes as the sole element when the array is empty", () => {
    const system: string[] = [];
    appendToSystemLast(system, "the block");
    expect(system).toHaveLength(1);
    expect(system[0]).toBe("the block");
  });

  it("repeated calls accumulate into the same last element", () => {
    const system = ["base"];
    appendToSystemLast(system, "sentinel");
    appendToSystemLast(system, "window");
    expect(system).toHaveLength(1);
    expect(system[0]).toBe("base\n\nsentinel\n\nwindow");
  });

  it("is a no-op for undefined / non-array input and never throws", () => {
    expect(() => appendToSystemLast(undefined, "x")).not.toThrow();
    expect(() => appendToSystemLast(null as unknown as string[], "x")).not.toThrow();
    expect(() => appendToSystemLast("nope" as unknown as string[], "x")).not.toThrow();
    expect(() => appendToSystemLast([], "")).not.toThrow();
  });

  it("does not export system-prompt from the public API (C16 discipline)", async () => {
    const indexContent = await import("node:fs").then((fs) =>
      fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf-8"),
    );
    expect(indexContent).not.toContain("system-prompt");
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    );
    const exportKeys = Object.keys(pkg.exports ?? {});
    expect(exportKeys.some((k) => String(k).includes("system-prompt"))).toBe(false);
  });
});
