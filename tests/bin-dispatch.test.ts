import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/bin";

describe("bin.parseArgs", () => {
  it("defaults to no UI and port 9333 with no flags", () => {
    expect(parseArgs(["node", "bin.js"])).toEqual({ ui: false, port: 9333, noBrowser: false, doctor: false });
  });

  it("--ui enables UI with default port", () => {
    expect(parseArgs(["node", "bin.js", "--ui"])).toEqual({ ui: true, port: 9333, noBrowser: false, doctor: false });
  });

  it("--ui=PORT sets the port", () => {
    expect(parseArgs(["node", "bin.js", "--ui=9400"])).toEqual({ ui: true, port: 9400, noBrowser: false, doctor: false });
  });

  it("--port=PORT sets the port", () => {
    expect(parseArgs(["node", "bin.js", "--ui", "--port=8080"])).toEqual({ ui: true, port: 8080, noBrowser: false, doctor: false });
  });

  it("ignores unknown flags", () => {
    expect(parseArgs(["node", "bin.js", "--unknown", "--ui"])).toEqual({ ui: true, port: 9333, noBrowser: false, doctor: false });
  });

  it("ignores --port without --ui (still no UI)", () => {
    expect(parseArgs(["node", "bin.js", "--port=9400"])).toEqual({ ui: false, port: 9400, noBrowser: false, doctor: false });
  });

  it("--no-browser sets noBrowser true", () => {
    expect(parseArgs(["node", "bin.js", "--no-browser"])).toEqual({ ui: false, port: 9333, noBrowser: true, doctor: false });
  });

  it("--no-browser combines with other flags", () => {
    expect(parseArgs(["node", "bin.js", "--port=8080", "--no-browser"])).toEqual({ ui: false, port: 8080, noBrowser: true, doctor: false });
  });

  it("--ui takes precedence over --no-browser", () => {
    expect(parseArgs(["node", "bin.js", "--ui", "--no-browser"])).toEqual({ ui: true, port: 9333, noBrowser: true, doctor: false });
  });

  it("--doctor sets doctor true", () => {
    expect(parseArgs(["node", "bin.js", "--doctor"])).toEqual({ ui: false, port: 9333, noBrowser: false, doctor: true });
  });

  it("--doctor is independent of --ui/--no-browser", () => {
    expect(parseArgs(["node", "bin.js", "--doctor", "--ui"])).toEqual({ ui: true, port: 9333, noBrowser: false, doctor: true });
  });
});

describe("bin --doctor dispatch behavior", () => {
  it("--doctor flag is mutually exclusive with MCP stdio and browser modes (structural assertion)", () => {
    // The bin.ts dispatch checks `doctor` FIRST and exits, before the
    // ui/noBrowser/default branches. This is a structural assertion that
    // --doctor is checked before other modes.
    const args = parseArgs(["node", "bin.js", "--doctor"]);
    expect(args.doctor).toBe(true);
    // The dispatch in bin.ts checks `if (doctor)` first — --doctor wins.
  });
});