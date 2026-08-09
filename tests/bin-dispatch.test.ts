import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/bin";

describe("bin.parseArgs", () => {
  it("defaults to no UI and port 9333 with no flags", () => {
    expect(parseArgs(["node", "bin.js"])).toEqual({ ui: false, port: 9333, noBrowser: false });
  });

  it("--ui enables UI with default port", () => {
    expect(parseArgs(["node", "bin.js", "--ui"])).toEqual({ ui: true, port: 9333, noBrowser: false });
  });

  it("--ui=PORT sets the port", () => {
    expect(parseArgs(["node", "bin.js", "--ui=9400"])).toEqual({ ui: true, port: 9400, noBrowser: false });
  });

  it("--port=PORT sets the port", () => {
    expect(parseArgs(["node", "bin.js", "--ui", "--port=8080"])).toEqual({ ui: true, port: 8080, noBrowser: false });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["node", "bin.js", "--unknown", "--ui"])).toEqual({ ui: true, port: 9333, noBrowser: false });
  });

  it("ignores --port without --ui (still no UI)", () => {
    expect(parseArgs(["node", "bin.js", "--port=9400"])).toEqual({ ui: false, port: 9400, noBrowser: false });
  });

  it("--no-browser sets noBrowser true", () => {
    expect(parseArgs(["node", "bin.js", "--no-browser"])).toEqual({ ui: false, port: 9333, noBrowser: true });
  });

  it("--no-browser combines with other flags", () => {
    expect(parseArgs(["node", "bin.js", "--port=8080", "--no-browser"])).toEqual({ ui: false, port: 8080, noBrowser: true });
  });

  it("--ui takes precedence over --no-browser", () => {
    expect(parseArgs(["node", "bin.js", "--ui", "--no-browser"])).toEqual({ ui: true, port: 9333, noBrowser: true });
  });
});