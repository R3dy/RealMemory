import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../src/store";
import {
  AFFECT_META_KEY,
  clampValence,
  clampArousal,
  emptyAffect,
  isAffectState,
  decayAffect,
  recordAffectOne,
  loadAffect,
  saveAffect,
  resetAffect,
  recordAffect,
  getAffectBias,
  getAffectTemperatureClamp,
  valenceTemperatureReduction,
  isSustainedNegative,
  inferDomainFromPath,
  type DomainAffect,
  type AffectState,
} from "../src/affect";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-affect-"));
  return join(dir, "test.db");
}

describe("affect (synthetic-self Phase 11)", () => {
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = uniqueDbPath();
    store = new MemoryStore({ storagePath: dbPath, projectId: "test" });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  describe("clamp + validation", () => {
    it("clampValence clamps to [-1, 1]", () => {
      expect(clampValence(2)).toBe(1);
      expect(clampValence(-2)).toBe(-1);
      expect(clampValence(0.5)).toBe(0.5);
      expect(clampValence(NaN)).toBe(0);
      expect(clampValence(Infinity)).toBe(0);
    });

    it("clampArousal clamps to [0, 1]", () => {
      expect(clampArousal(2)).toBe(1);
      expect(clampArousal(-1)).toBe(0);
      expect(clampArousal(0.7)).toBe(0.7);
      expect(clampArousal(NaN)).toBe(0);
    });

    it("emptyAffect returns {}", () => {
      expect(emptyAffect()).toEqual({});
    });

    it("isAffectState validates shape", () => {
      expect(isAffectState({})).toBe(true);
      expect(
        isAffectState({
          aws: { valence: -0.5, arousal: 0.8, n: 3, updatedAt: "2026-01-01T00:00:00Z" },
        }),
      ).toBe(true);
      expect(isAffectState({ aws: { valence: "bad" } })).toBe(false);
      expect(isAffectState(null)).toBe(false);
      expect(isAffectState("affect")).toBe(false);
    });
  });

  describe("decayAffect", () => {
    it("decays valence toward 0 over time", () => {
      const now = new Date("2026-08-19T00:00:00Z");
      const affect: DomainAffect = {
        valence: -0.8,
        arousal: 0.6,
        n: 5,
        updatedAt: "2026-08-19T00:00:00Z",
      };
      // Same time -> no decay.
      const sameDay = decayAffect(affect, now);
      expect(sameDay.valence).toBeCloseTo(-0.8, 5);
    });

    it("decays after 30 days (half-life)", () => {
      const now = new Date("2026-09-18T00:00:00Z"); // 30 days later
      const affect: DomainAffect = {
        valence: -1.0,
        arousal: 1.0,
        n: 5,
        updatedAt: "2026-08-19T00:00:00Z",
      };
      const decayed = decayAffect(affect, now);
      // exp(-30/30) = exp(-1) ~= 0.368
      expect(decayed.valence).toBeCloseTo(-0.368, 2);
      expect(decayed.arousal).toBeCloseTo(0.368, 2);
      expect(decayed.n).toBe(5);
    });

    it("decays toward neutral after 90 days", () => {
      const now = new Date("2026-11-17T00:00:00Z"); // 90 days later
      const affect: DomainAffect = {
        valence: 0.9,
        arousal: 0.8,
        n: 10,
        updatedAt: "2026-08-19T00:00:00Z",
      };
      const decayed = decayAffect(affect, now);
      // exp(-90/30) = exp(-3) ~= 0.05
      expect(Math.abs(decayed.valence)).toBeLessThan(0.1);
      expect(decayed.arousal).toBeLessThan(0.1);
    });
  });

  describe("recordAffectOne (EMA)", () => {
    it("creates a new domain affect from an observation", () => {
      const now = new Date("2026-08-19T00:00:00Z");
      const result = recordAffectOne(undefined, "aws", { valence: -0.7, arousal: 0.8 }, 0.1, now);
      expect(result.valence).toBeCloseTo(-0.07, 5); // 0 + 0.1 * -0.7
      expect(result.arousal).toBeCloseTo(0.08, 5); // 0 + 0.1 * 0.8
      expect(result.n).toBe(1);
      expect(result.updatedAt).toBe(now.toISOString());
    });

    it("updates an existing domain affect with EMA", () => {
      const now = new Date("2026-08-19T00:00:00Z");
      const existing: DomainAffect = {
        valence: -0.5,
        arousal: 0.4,
        n: 3,
        updatedAt: now.toISOString(),
      };
      const result = recordAffectOne(existing, "aws", { valence: -0.9, arousal: 0.9 }, 0.2, now);
      // decayed (same time, no decay) + EMA: -0.5 + 0.2 * (-0.9 - -0.5) = -0.5 - 0.08 = -0.58
      expect(result.valence).toBeCloseTo(-0.58, 5);
      expect(result.arousal).toBeCloseTo(0.5, 5); // 0.4 + 0.2 * (0.9 - 0.4) = 0.5
      expect(result.n).toBe(4);
    });
  });

  describe("load + save + reset", () => {
    it("loadAffect returns empty when no row exists", async () => {
      const state = await loadAffect(store);
      expect(state).toEqual({});
    });

    it("saveAffect + loadAffect round-trips", async () => {
      const state: AffectState = {
        aws: { valence: -0.5, arousal: 0.7, n: 3, updatedAt: "2026-08-19T00:00:00Z" },
        testing: { valence: 0.3, arousal: 0.2, n: 5, updatedAt: "2026-08-19T00:00:00Z" },
      };
      await saveAffect(store, state);
      const loaded = await loadAffect(store);
      expect(loaded).toEqual(state);
    });

    it("loadAffect returns empty on corrupt JSON", async () => {
      await store.setMeta(AFFECT_META_KEY, "not json");
      const state = await loadAffect(store);
      expect(state).toEqual({});
    });

    it("loadAffect returns empty on empty string (Phase 10 forward-compat)", async () => {
      await store.setMeta(AFFECT_META_KEY, "");
      const state = await loadAffect(store);
      expect(state).toEqual({});
    });

    it("resetAffect clears the state + persists", async () => {
      await saveAffect(store, {
        aws: { valence: -0.5, arousal: 0.7, n: 3, updatedAt: "2026-08-19T00:00:00Z" },
      });
      const empty = await resetAffect(store);
      expect(empty).toEqual({});
      const loaded = await loadAffect(store);
      expect(loaded).toEqual({});
    });
  });

  describe("recordAffect (store-backed)", () => {
    it("records an observation and persists", async () => {
      const result = await recordAffect(store, "aws", { valence: -0.7, arousal: 0.8 });
      expect(result).not.toBeNull();
      expect(result!.valence).toBeCloseTo(-0.07, 5);
      expect(result!.n).toBe(1);
      const loaded = await loadAffect(store);
      expect(loaded.aws).toBeDefined();
      expect(loaded.aws!.n).toBe(1);
    });

    it("returns null for empty domain", async () => {
      const result = await recordAffect(store, "", { valence: -0.7, arousal: 0.8 });
      expect(result).toBeNull();
    });

    it("accumulates observations across calls", async () => {
      await recordAffect(store, "aws", { valence: -0.5, arousal: 0.5 });
      await recordAffect(store, "aws", { valence: -0.9, arousal: 0.9 });
      await recordAffect(store, "aws", { valence: -0.8, arousal: 0.7 });
      const loaded = await loadAffect(store);
      expect(loaded.aws!.n).toBe(3);
      expect(loaded.aws!.valence).toBeLessThan(-0.1);
    });
  });

  describe("getAffectBias (recall threshold)", () => {
    it("negative valence -> negative bias (lower threshold = more recalls)", () => {
      expect(getAffectBias(-1)).toBeCloseTo(-0.15, 5);
      expect(getAffectBias(-0.5)).toBeCloseTo(-0.075, 5);
    });

    it("positive valence -> positive bias (higher threshold = fewer recalls)", () => {
      expect(getAffectBias(1)).toBeCloseTo(0.15, 5);
      expect(getAffectBias(0.5)).toBeCloseTo(0.075, 5);
    });

    it("neutral valence -> zero bias", () => {
      expect(getAffectBias(0)).toBe(0);
    });

    it("clamps to [-0.15, 0.15]", () => {
      expect(getAffectBias(2)).toBeCloseTo(0.15, 5);
      expect(getAffectBias(-2)).toBeCloseTo(-0.15, 5);
    });
  });

  describe("getAffectTemperatureClamp", () => {
    it("neutral valence + zero arousal -> no clamp", () => {
      expect(getAffectTemperatureClamp(0, 0)).toBe(0);
    });

    it("high arousal -> clamps temperature down", () => {
      const clamp = getAffectTemperatureClamp(0, 1);
      expect(clamp).toBeCloseTo(-0.15, 5);
    });

    it("negative valence -> clamps temperature down further (capped at -0.15)", () => {
      const clamp = getAffectTemperatureClamp(-1, 0.5);
      // arousal: -0.5*0.15 = -0.075; valence: -1*0.15 = -0.15; combined = -0.225 capped at -0.15
      expect(clamp).toBeCloseTo(-0.15, 5);
    });

    it("positive valence -> arousal-only clamp (never raises temperature)", () => {
      const clamp = getAffectTemperatureClamp(1, 0);
      expect(clamp).toBe(0); // positive valence does not raise temperature
    });

    it("never raises above 0", () => {
      expect(getAffectTemperatureClamp(1, 0)).toBeGreaterThanOrEqual(0);
      expect(getAffectTemperatureClamp(0.5, 0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("valenceTemperatureReduction", () => {
    it("returns 0 for neutral/positive valence (never raises temperature)", () => {
      expect(valenceTemperatureReduction(0)).toBe(0);
      expect(valenceTemperatureReduction(0.5)).toBe(0);
      expect(valenceTemperatureReduction(1)).toBe(0);
    });

    it("returns a positive reduction for negative valence", () => {
      expect(valenceTemperatureReduction(-1)).toBeCloseTo(0.15, 5);
      expect(valenceTemperatureReduction(-0.5)).toBeCloseTo(0.075, 5);
    });

    it("is capped at 0.15", () => {
      expect(valenceTemperatureReduction(-2)).toBeCloseTo(0.15, 5);
    });

    it("NaN -> 0", () => {
      expect(valenceTemperatureReduction(NaN)).toBe(0);
    });
  });

  describe("isSustainedNegative", () => {
    it("returns true for n>=3 and valence<=-0.2", () => {
      expect(
        isSustainedNegative({ valence: -0.5, arousal: 0.7, n: 5, updatedAt: "2026-01-01T00:00:00Z" }),
      ).toBe(true);
    });

    it("returns false for n<3", () => {
      expect(
        isSustainedNegative({ valence: -0.9, arousal: 0.9, n: 2, updatedAt: "2026-01-01T00:00:00Z" }),
      ).toBe(false);
    });

    it("returns false for neutral valence", () => {
      expect(
        isSustainedNegative({ valence: 0, arousal: 0, n: 10, updatedAt: "2026-01-01T00:00:00Z" }),
      ).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isSustainedNegative(undefined)).toBe(false);
    });

    it("respects custom thresholds", () => {
      expect(
        isSustainedNegative({ valence: -0.15, arousal: 0.5, n: 5, updatedAt: "2026-01-01T00:00:00Z" }, 2, -0.1),
      ).toBe(true);
    });
  });

  describe("inferDomainFromPath", () => {
    it("maps AWS paths to aws domain", () => {
      expect(inferDomainFromPath("/projects/realhax/terraform/main.tf")).toBe("aws");
      expect(inferDomainFromPath("/src/lambda/index.ts")).toBe("aws");
    });

    it("maps test paths to testing domain", () => {
      expect(inferDomainFromPath("/tests/traits.test.ts")).toBe("testing");
      expect(inferDomainFromPath("/src/__tests__/foo.ts")).toBe("testing");
    });

    it("maps project paths to their domains", () => {
      expect(inferDomainFromPath("/projects/realvol/repo/server.ts")).toBe("realvol");
      expect(inferDomainFromPath("/projects/realhax/repo/lib.ts")).toBe("realhax");
    });

    it("returns null for unknown paths", () => {
      expect(inferDomainFromPath("/some/random/path.txt")).toBeNull();
    });

    it("returns null for empty/null", () => {
      expect(inferDomainFromPath("")).toBeNull();
      expect(inferDomainFromPath(null as unknown as string)).toBeNull();
    });
  });
});
