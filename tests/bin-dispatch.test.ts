import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/bin";

describe("bin.parseArgs", () => {
  it("defaults to no UI and port 9333 with no flags", () => {
    expect(parseArgs(["node", "bin.js"])).toEqual({ ui: false, port: 9333 });
  });

  it("--ui enables UI with default port", () => {
    expect(parseArgs(["node", "bin.js", "--ui"])).toEqual({ ui: true, port: 9333 });
  });

  it("--ui=PORT sets the port", () => {
    expect(parseArgs(["node", "bin.js", "--ui=9400"])).toEqual({ ui: true, port: 9400 });
  });

  it("--port=PORT sets the port", () => {
    expect(parseArgs(["node", "bin.js", "--ui", "--port=8080"])).toEqual({ ui: true, port: 8080 });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["node", "bin.js", "--unknown", "--ui"])).toEqual({ ui: true, port: 9333 });
  });

  it("ignores --port without --ui (still no UI)", () => {
    expect(parseArgs(["node", "bin.js", "--port=9400"])).toEqual({ ui: false, port: 9400 });
  });
});
