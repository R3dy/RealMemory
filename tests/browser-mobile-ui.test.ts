import { describe, it, expect } from "vitest";
import { INDEX_HTML } from "../src/browser/assets";

describe("browser mobile UI — CSS (A20.1)", () => {
  it("contains desktop-gate media query (min-width: 1024px)", () => {
    expect(INDEX_HTML).toContain("min-width: 1024px");
  });

  it("contains mobile-only touch-target gate (max-width: 1023px)", () => {
    expect(INDEX_HTML).toContain("max-width: 1023px");
  });

  it("contains bottom-tabs class", () => {
    expect(INDEX_HTML).toContain("bottom-tabs");
  });

  it("contains safe-area-inset-bottom handling", () => {
    expect(INDEX_HTML).toContain("env(safe-area-inset-bottom");
  });

  it("contains bottom-tabs height calc with safe-area", () => {
    expect(INDEX_HTML).toContain("calc(56px + env(safe-area-inset-bottom, 0px))");
  });

  it("contains drawer off-canvas transform", () => {
    expect(INDEX_HTML).toContain("transform: translateX(-100%)");
  });

  it("contains sheet off-canvas transform", () => {
    expect(INDEX_HTML).toContain("transform: translateY(100%)");
  });

  it("contains .drawer.open class", () => {
    expect(INDEX_HTML).toContain(".drawer.open");
  });

  it("contains .sheet.open class", () => {
    expect(INDEX_HTML).toContain(".sheet.open");
  });

  it("contains .scrim class", () => {
    expect(INDEX_HTML).toContain(".scrim");
  });
});

describe("browser mobile UI — JS (A20.2)", () => {
  it("contains getViewportTier function", () => {
    expect(INDEX_HTML).toContain("getViewportTier");
  });

  it("contains matchMedia usage", () => {
    expect(INDEX_HTML).toContain("matchMedia");
  });

  it("contains orientationchange listener", () => {
    expect(INDEX_HTML).toContain("orientationchange");
  });

  it("contains vis-network zoomView: true (touch pinch-zoom)", () => {
    expect(INDEX_HTML).toContain("zoomView: true");
  });

  it("contains vis-network dragView: true (touch pan)", () => {
    expect(INDEX_HTML).toContain("dragView: true");
  });

  it("contains vis-network multiselect: false (explicit disable)", () => {
    expect(INDEX_HTML).toContain("multiselect: false");
  });

  it("contains network.redraw() call (canvas lifecycle)", () => {
    expect(INDEX_HTML).toContain("redraw");
  });

  it("contains network.fit() call (canvas lifecycle)", () => {
    expect(INDEX_HTML).toContain("network.fit");
  });

  it("contains manipulation: { enabled: false }", () => {
    expect(INDEX_HTML).toContain("manipulation: { enabled: false }");
  });
});

describe("browser mobile UI — desktop regression (O1)", () => {
  it("preserves tooltipDelay: 200 after interaction MERGE", () => {
    expect(INDEX_HTML).toContain("tooltipDelay: 200");
  });

  it("preserves navigationButtons: false after interaction MERGE", () => {
    expect(INDEX_HTML).toContain("navigationButtons: false");
  });

  it("preserves keyboard: false after interaction MERGE", () => {
    expect(INDEX_HTML).toContain("keyboard: false");
  });
});

describe("browser mobile UI — touch-target gating (O5)", () => {
  it("has @media (max-width: 1023px) block with 44px min-height rule", () => {
    expect(INDEX_HTML).toMatch(/@media[^{]*max-width:\s*1023px/);
    expect(INDEX_HTML).toMatch(/min-height:\s*44px/);
  });
});
