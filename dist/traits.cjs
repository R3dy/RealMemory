"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/traits.ts
var traits_exports = {};
__export(traits_exports, {
  BASELINE_TRAITS: () => BASELINE_TRAITS,
  DEFAULT_TRAIT_LEARNING_RATE: () => DEFAULT_TRAIT_LEARNING_RATE,
  MAX_TRAIT_LEARNING_RATE: () => MAX_TRAIT_LEARNING_RATE,
  RESET_META_KEYS: () => RESET_META_KEYS,
  RESET_SCOPES: () => RESET_SCOPES,
  TRAITS_META_KEY: () => TRAITS_META_KEY,
  TRAIT_BANDS: () => TRAIT_BANDS,
  TRAIT_MAX: () => TRAIT_MAX,
  TRAIT_MIN: () => TRAIT_MIN,
  TRAIT_NAMES: () => TRAIT_NAMES,
  applyTraits: () => applyTraits,
  baselineTraits: () => baselineTraits,
  clampTrait: () => clampTrait,
  crossedBoundaryBucket: () => crossedBoundaryBucket,
  isTraitVector: () => isTraitVector,
  loadTraits: () => loadTraits,
  parseResetScope: () => parseResetScope,
  resetTraits: () => resetTraits,
  saveTraits: () => saveTraits,
  shiftInBand: () => shiftInBand,
  updateOneTrait: () => updateOneTrait,
  updateTraits: () => updateTraits
});
module.exports = __toCommonJS(traits_exports);
var TRAIT_NAMES = [
  "caution",
  "curiosity",
  "skepticism",
  "tenacity",
  "thoroughness",
  "tempo"
];
var BASELINE_TRAITS = {
  caution: 0.5,
  curiosity: 0.5,
  skepticism: 0.5,
  tenacity: 0.5,
  thoroughness: 0.5,
  tempo: 0.5
};
var TRAITS_META_KEY = "traits:v1";
var TRAIT_MIN = 0.15;
var TRAIT_MAX = 0.85;
var DEFAULT_TRAIT_LEARNING_RATE = 0.02;
var MAX_TRAIT_LEARNING_RATE = 0.05;
var DECAY_TOWARD_BASELINE = 2e-3;
var BOUNDARY_BUCKET = 0.1;
function clampTrait(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, value));
}
function isTraitVector(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = v;
  for (const name of TRAIT_NAMES) {
    const val = o[name];
    if (typeof val !== "number" || !Number.isFinite(val)) return false;
  }
  return true;
}
function baselineTraits() {
  return { ...BASELINE_TRAITS };
}
async function loadTraits(store) {
  try {
    const raw = await store.getMeta(TRAITS_META_KEY);
    if (!raw) return baselineTraits();
    const parsed = JSON.parse(raw);
    if (!isTraitVector(parsed)) return baselineTraits();
    const out = baselineTraits();
    for (const name of TRAIT_NAMES) {
      out[name] = clampTrait(parsed[name]);
    }
    return out;
  } catch {
    return baselineTraits();
  }
}
async function saveTraits(store, traits) {
  try {
    await store.setMeta(TRAITS_META_KEY, JSON.stringify(traits));
  } catch {
  }
}
async function resetTraits(store) {
  const baseline = baselineTraits();
  await saveTraits(store, baseline);
  return baseline;
}
var TRAIT_BANDS = {
  caution: {
    BLOCK_SALIENCE_FLOOR: { center: 0.8, band: 0.1, min: 0.5, max: 0.95 }
  },
  tenacity: {
    decayHalfLifeDays: { center: 30, band: 10, min: 5, max: 90 }
  }
};
function shiftInBand(traitValue, band) {
  const clampedTrait = clampTrait(traitValue);
  const normalized = (clampedTrait - 0.5) / (TRAIT_MAX - 0.5);
  const shifted = band.center + normalized * band.band;
  return Math.min(band.max, Math.max(band.min, shifted));
}
function applyTraits(traits, defaults, userOverrides = {}) {
  const out = { ...defaults };
  for (const traitName of TRAIT_NAMES) {
    const bands = TRAIT_BANDS[traitName];
    if (!bands) continue;
    for (const [constName, band] of Object.entries(bands)) {
      if (constName in userOverrides) {
        out[constName] = userOverrides[constName];
        continue;
      }
      if (constName in out) {
        out[constName] = shiftInBand(traits[traitName], band);
      }
    }
  }
  return out;
}
function updateOneTrait(before, observed, alpha) {
  const a = Math.min(MAX_TRAIT_LEARNING_RATE, Math.max(0, alpha));
  if (observed === null || !Number.isFinite(observed)) {
    const towardBaseline = before + DECAY_TOWARD_BASELINE * (0.5 - before);
    const after2 = clampTrait(towardBaseline);
    return { after: after2, delta: after2 - before };
  }
  const clampedObs = Math.min(1, Math.max(0, observed));
  const updated = before + a * (clampedObs - before);
  const after = clampTrait(updated);
  return { after, delta: after - before };
}
function crossedBoundaryBucket(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
  const b = Math.floor(before / BOUNDARY_BUCKET);
  const a = Math.floor(after / BOUNDARY_BUCKET);
  return b !== a;
}
function updateTraits(traits, obs, alpha = DEFAULT_TRAIT_LEARNING_RATE) {
  const vector = { ...traits };
  const results = [];
  for (const name of TRAIT_NAMES) {
    const before = vector[name];
    const observed = obs[name] ?? null;
    const { after, delta } = updateOneTrait(before, observed, alpha);
    vector[name] = after;
    results.push({
      name,
      before,
      after,
      observed,
      delta,
      crossedBoundary: crossedBoundaryBucket(before, after)
    });
  }
  return { vector, results };
}
var RESET_SCOPES = [
  "traits",
  "affect",
  "identity",
  "all"
];
var RESET_META_KEYS = {
  traits: TRAITS_META_KEY,
  // Phase 11 will add `affect:v1`. Declared here so the CLI is forward-compatible.
  affect: "affect:v1"
};
function parseResetScope(args) {
  for (const a of args) {
    if (a === "--reset-self" || a === "--reset-self=all") return "all";
    if (a === "--reset-self=traits" || a === "--traits") return "traits";
    if (a === "--reset-self=affect" || a === "--affect") return "affect";
    if (a === "--reset-self=identity" || a === "--identity") return "identity";
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BASELINE_TRAITS,
  DEFAULT_TRAIT_LEARNING_RATE,
  MAX_TRAIT_LEARNING_RATE,
  RESET_META_KEYS,
  RESET_SCOPES,
  TRAITS_META_KEY,
  TRAIT_BANDS,
  TRAIT_MAX,
  TRAIT_MIN,
  TRAIT_NAMES,
  applyTraits,
  baselineTraits,
  clampTrait,
  crossedBoundaryBucket,
  isTraitVector,
  loadTraits,
  parseResetScope,
  resetTraits,
  saveTraits,
  shiftInBand,
  updateOneTrait,
  updateTraits
});
