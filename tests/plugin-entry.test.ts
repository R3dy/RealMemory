import { describe, it, expect } from "vitest";

describe("plugin-entry (dist)", () => {
  it("default-exports a PluginModule with a server function", async () => {
    // Import from the built output — verifies the plugin entry point is
    // compiled, declared in package.json exports["./server"], and has the
    // PluginModule = { server: Plugin } shape OpenCode's loader expects.
    // Regression test for issue #28 RC-3 (plugin entry exists and has
    // correct module shape).
    const mod = await import("../dist/plugin-entry.js");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("object");
    expect(typeof mod.default.server).toBe("function");
  });
});
