import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../src/store";
import {
  TRAIT_NAMES,
  BASELINE_TRAITS,
  TRAIT_MIN,
  TRAIT_MAX,
  DEFAULT_TRAIT_LEARNING_RATE,
  TRAITS_META_KEY,
  clampTrait,
  isTraitVector,
  baselineTraits,
  loadTraits,
  saveTraits,
  resetTraits,
  shiftInBand,
  TRAIT_BANDS,
  applyTraits,
  updateOneTrait,
  crossedBoundaryBucket,
  updateTraits,
  parseResetScope,
  RESET_SCOPES,
  type TraitVector,
  type TraitObservations,
} from "../src/traits";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function uniqueDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-traits-"));
  return join(dir, "test.db");
}

describe("traits (synthetic-self Phase 10)", () => {
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

  describe("constants + validation", () => {
    it("has exactly six traits", () => {
      expect(TRAIT_NAMES).toHaveLength(6);
      expect([...TRAIT_NAMES]).toEqual([
        "caution",
        "curiosity",
        "skepticism",
        "tenacity",
        "thoroughness",
        "tempo",
      ]);
    });

    it("baseline is 0.5 for every trait", () => {
      const b = baselineTraits();
      for (const name of TRAIT_NAMES) {
        expect(b[name]).toBe(0.5);
      }
      expect(BASELINE_TRAITS).toEqual(b);
    });

    it("clamp range is [0.15, 0.85]", () => {
      expect(TRAIT_MIN).toBe(0.15);
      expect(TRAIT_MAX).toBe(0.85);
    });

    it("default learning rate is 0.02", () => {
      expect(DEFAULT_TRAIT_LEARNING_RATE).toBe(0.02);
    });

    it("clampTrait clamps to [0.15, 0.85]", () => {
      expect(clampTrait(0.0)).toBe(0.15);
      expect(clampTrait(1.0)).toBe(0.85);
      expect(clampTrait(0.5)).toBe(0.5);
      expect(clampTrait(0.7)).toBe(0.7);
    });

    it("clampTrait returns 0.5 for non-finite", () => {
      expect(clampTrait(NaN)).toBe(0.5);
      expect(clampTrait(Infinity)).toBe(0.5);
      expect(clampTrait(-Infinity)).toBe(0.5);
    });

    it("isTraitVector validates shape + finiteness", () => {
      expect(isTraitVector(BASELINE_TRAITS)).toBe(true);
      expect(isTraitVector({})).toBe(false);
      expect(isTraitVector({ caution: 0.5 })).toBe(false);
      expect(isTraitVector({ ...BASELINE_TRAITS, caution: NaN })).toBe(false);
      expect(isTraitVector(null)).toBe(false);
      expect(isTraitVector("traits")).toBe(false);
    });
  });

  describe("load + save", () => {
    it("loadTraits returns baseline when no row exists", async () => {
      const t = await loadTraits(store);
      expect(t).toEqual(BASELINE_TRAITS);
    });

    it("saveTraits + loadTraits round-trips", async () => {
      const drifted: TraitVector = {
        caution: 0.72,
        curiosity: 0.4,
        skepticism: 0.6,
        tenacity: 0.55,
        thoroughness: 0.5,
        tempo: 0.3,
      };
      await saveTraits(store, drifted);
      const loaded = await loadTraits(store);
      expect(loaded).toEqual(drifted);
    });

    it("loadTraits clamps out-of-range loaded values", async () => {
      // Manually write an out-of-range vector to simulate a legacy/manual edit.
      await store.setMeta(
        TRAITS_META_KEY,
        JSON.stringify({ caution: 0.99, curiosity: 0.01, skepticism: 0.5, tenacity: 0.5, thoroughness: 0.5, tempo: 0.5 }),
      );
      const loaded = await loadTraits(store);
      expect(loaded.caution).toBe(0.85);
      expect(loaded.curiosity).toBe(0.15);
    });

    it("loadTraits returns baseline on corrupt JSON", async () => {
      await store.setMeta(TRAITS_META_KEY, "not json");
      const loaded = await loadTraits(store);
      expect(loaded).toEqual(BASELINE_TRAITS);
    });

    it("saveTraits never throws on store error", async () => {
      // Close the store so the write fails — should not throw.
      await store.close();
      await expect(saveTraits(store, BASELINE_TRAITS)).resolves.toBeUndefined();
    });
  });

  describe("resetTraits", () => {
    it("resets a drifted vector to baseline + persists", async () => {
      const drifted: TraitVector = {
        caution: 0.8,
        curiosity: 0.2,
        skepticism: 0.7,
        tenacity: 0.6,
        thoroughness: 0.4,
        tempo: 0.3,
      };
      await saveTraits(store, drifted);
      const reset = await resetTraits(store);
      expect(reset).toEqual(BASELINE_TRAITS);
      const loaded = await loadTraits(store);
      expect(loaded).toEqual(BASELINE_TRAITS);
    });
  });

  describe("shiftInBand + applyTraits", () => {
    it("trait=0.5 leaves constant at center", () => {
      const band = TRAIT_BANDS.caution!.BLOCK_SALIENCE_FLOOR;
      expect(shiftInBand(0.5, band)).toBeCloseTo(band.center, 5);
    });

    it("trait=0.85 pushes constant to center + band (clamped to max)", () => {
      const band = TRAIT_BANDS.caution!.BLOCK_SALIENCE_FLOOR;
      const expected = band.center + band.band;
      expect(shiftInBand(0.85, band)).toBeCloseTo(expected, 5);
    });

    it("trait=0.15 pushes constant to center - band (clamped to min)", () => {
      const band = TRAIT_BANDS.caution!.BLOCK_SALIENCE_FLOOR;
      const expected = band.center - band.band;
      expect(shiftInBand(0.15, band)).toBeCloseTo(expected, 5);
    });

    it("tenacity shifts decayHalfLifeDays within [20, 40]", () => {
      const band = TRAIT_BANDS.tenacity!.decayHalfLifeDays;
      expect(shiftInBand(0.5, band)).toBe(30);
      expect(shiftInBand(0.85, band)).toBe(40);
      expect(shiftInBand(0.15, band)).toBe(20);
    });

    it("applyTraits shifts defaults for known constants", () => {
      const traits: TraitVector = { ...BASELINE_TRAITS, caution: 0.85 };
      const out = applyTraits(traits, { BLOCK_SALIENCE_FLOOR: 0.8, decayHalfLifeDays: 30 });
      expect(out.BLOCK_SALIENCE_FLOOR).toBeCloseTo(0.9, 5); // 0.8 + 0.1
      expect(out.decayHalfLifeDays).toBe(30); // tenacity at baseline
    });

    it("applyTraits never moves user-overridden values", () => {
      const traits: TraitVector = { ...BASELINE_TRAITS, caution: 0.85 };
      const out = applyTraits(
        traits,
        { BLOCK_SALIENCE_FLOOR: 0.8 },
        { BLOCK_SALIENCE_FLOOR: 0.75 }, // user set
      );
      expect(out.BLOCK_SALIENCE_FLOOR).toBe(0.75); // user wins
    });

    it("applyTraits ignores constants not in defaults", () => {
      const traits: TraitVector = { ...BASELINE_TRAITS, caution: 0.85 };
      const out = applyTraits(traits, { decayHalfLifeDays: 30 });
      expect(out).not.toHaveProperty("BLOCK_SALIENCE_FLOOR");
    });
  });

  describe("updateOneTrait (EMA)", () => {
    it("observed=0.5 on baseline leaves trait unchanged", () => {
      const { after, delta } = updateOneTrait(0.5, 0.5, 0.02);
      expect(after).toBeCloseTo(0.5, 6);
      expect(delta).toBe(0);
    });

    it("observed high moves trait up by alpha*(obs-before)", () => {
      const { after, delta } = updateOneTrait(0.5, 0.9, 0.02);
      expect(after).toBeCloseTo(0.5 + 0.02 * 0.4, 6); // 0.508
      expect(delta).toBeGreaterThan(0);
    });

    it("observed low moves trait down", () => {
      const { after, delta } = updateOneTrait(0.5, 0.1, 0.02);
      expect(after).toBeCloseTo(0.5 + 0.02 * -0.4, 6); // 0.492
      expect(delta).toBeLessThan(0);
    });

    it("clamps to [0.15, 0.85] even with extreme observed + high alpha", () => {
      const { after } = updateOneTrait(0.85, 1.0, 0.05);
      expect(after).toBe(0.85);
      const { after: low } = updateOneTrait(0.15, 0.0, 0.05);
      expect(low).toBe(0.15);
    });

    it("alpha is clamped to MAX_TRAIT_LEARNING_RATE", () => {
      const { after } = updateOneTrait(0.5, 1.0, 0.5); // absurd alpha
      // alpha clamped to 0.05: 0.5 + 0.05*0.5 = 0.525
      expect(after).toBeCloseTo(0.525, 5);
    });

    it("null observed pulls toward 0.5 by a tiny amount", () => {
      const { after, delta } = updateOneTrait(0.7, null, 0.02);
      expect(after).toBeLessThan(0.7);
      expect(after).toBeGreaterThan(0.69); // small pull (0.002 * (0.5-0.7) = -0.0004)
      expect(delta).toBeLessThan(0);
    });

    it("null observed at 0.5 is a no-op", () => {
      const { after, delta } = updateOneTrait(0.5, null, 0.02);
      expect(after).toBeCloseTo(0.5, 6);
      expect(delta).toBe(0);
    });
  });

  describe("crossedBoundaryBucket", () => {
    it("returns false when no 0.1 bucket is crossed", () => {
      expect(crossedBoundaryBucket(0.51, 0.54)).toBe(false);
      expect(crossedBoundaryBucket(0.5, 0.5)).toBe(false);
      expect(crossedBoundaryBucket(0.32, 0.38)).toBe(false);
    });

    it("returns true when a 0.1 bucket is crossed", () => {
      expect(crossedBoundaryBucket(0.49, 0.51)).toBe(true); // crosses 0.5
      expect(crossedBoundaryBucket(0.29, 0.31)).toBe(true); // crosses 0.3
      expect(crossedBoundaryBucket(0.79, 0.81)).toBe(true); // crosses 0.8
    });

    it("handles non-finite gracefully", () => {
      expect(crossedBoundaryBucket(NaN, 0.5)).toBe(false);
      expect(crossedBoundaryBucket(0.5, Infinity)).toBe(false);
    });
  });

  describe("updateTraits (full vector)", () => {
    it("updates every trait and returns per-trait results", () => {
      const traits = baselineTraits();
      const obs: TraitObservations = {
        caution: 0.9,
        curiosity: null,
        tenacity: 0.7,
      };
      const { vector, results } = updateTraits(traits, obs, 0.02);
      expect(results).toHaveLength(6);
      expect(vector.caution).toBeGreaterThan(0.5);
      // curiosity at 0.5 with null observed is a no-op (stays 0.5).
      expect(vector.curiosity).toBe(0.5);
      expect(vector.tenacity).toBeGreaterThan(0.5);
      // results have deltas
      const cautionResult = results.find((r) => r.name === "caution");
      expect(cautionResult!.observed).toBe(0.9);
      expect(cautionResult!.delta).toBeGreaterThan(0);
    });

    it("a large consistent observation crosses a boundary over many updates", () => {
      let traits = baselineTraits();
      // Simulate 60 sessions of caution=0.9, alpha=0.05 (max) — should cross 0.5->0.6 boundary.
      let crossed = false;
      for (let i = 0; i < 60; i++) {
        const { vector, results } = updateTraits(traits, { caution: 0.9 }, 0.05);
        if (results.find((r) => r.name === "caution")!.crossedBoundary) crossed = true;
        traits = vector;
      }
      expect(crossed).toBe(true);
      expect(traits.caution).toBeGreaterThan(0.6);
    });

    it("no observations pulls everything toward 0.5 (slow)", () => {
      const traits: TraitVector = {
        caution: 0.7,
        curiosity: 0.3,
        skepticism: 0.8,
        tenacity: 0.2,
        thoroughness: 0.6,
        tempo: 0.4,
      };
      const { vector, results } = updateTraits(traits, {}, 0.02);
      // Every trait moves toward 0.5 by a tiny amount.
      for (const r of results) {
        expect(r.observed).toBeNull();
        if (r.before > 0.5) expect(r.after).toBeLessThan(r.before);
        if (r.before < 0.5) expect(r.after).toBeGreaterThan(r.before);
      }
    });
  });

  describe("parseResetScope (CLI parsing)", () => {
    it("parses --reset-self (defaults to all)", () => {
      expect(parseResetScope(["node", "bin", "--reset-self"])).toBe("all");
    });

    it("parses --reset-self=traits", () => {
      expect(parseResetScope(["--reset-self=traits"])).toBe("traits");
    });

    it("parses --reset-self=affect", () => {
      expect(parseResetScope(["--reset-self=affect"])).toBe("affect");
    });

    it("parses --reset-self=identity", () => {
      expect(parseResetScope(["--reset-self=identity"])).toBe("identity");
    });

    it("parses bare --traits / --affect / --identity", () => {
      expect(parseResetScope(["--traits"])).toBe("traits");
      expect(parseResetScope(["--affect"])).toBe("affect");
      expect(parseResetScope(["--identity"])).toBe("identity");
    });

    it("returns null when no reset flag present", () => {
      expect(parseResetScope(["--ui", "--port=9333"])).toBeNull();
      expect(parseResetScope([])).toBeNull();
    });

    it("RESET_SCOPES has all four", () => {
      expect(RESET_SCOPES).toEqual(["traits", "affect", "identity", "all"]);
    });
  });
});
