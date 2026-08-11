import { describe, it, expect } from "vitest";
import { INDEX_HTML } from "../src/browser/assets";

describe("browser assets", () => {
  it("INDEX_HTML contains the required DOM structure", () => {
    expect(INDEX_HTML).toContain('id="network"');
    expect(INDEX_HTML).toContain('id="sidebar"');
    expect(INDEX_HTML).toContain('id="detail"');
    expect(INDEX_HTML).toContain('id="legend"');
  });

  it("INDEX_HTML references the vendored vis-network bundle", () => {
    expect(INDEX_HTML).toContain("/static/vis-network.min.js");
  });

  it("INDEX_HTML is a complete HTML document", () => {
    expect(INDEX_HTML).toContain("<!doctype html>");
    expect(INDEX_HTML).toContain("</html>");
  });

  it("uses the dark-theme palette (ADR-006 / plan §7)", () => {
    expect(INDEX_HTML).toContain("#0d1117");
  });
});
