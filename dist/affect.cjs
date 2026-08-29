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

// src/affect.ts
var affect_exports = {};
__export(affect_exports, {
  AFFECT_META_KEY: () => AFFECT_META_KEY,
  clampArousal: () => clampArousal,
  clampValence: () => clampValence,
  decayAffect: () => decayAffect,
  emptyAffect: () => emptyAffect,
  getAffectBias: () => getAffectBias,
  getAffectTemperatureClamp: () => getAffectTemperatureClamp,
  inferDomainFromPath: () => inferDomainFromPath,
  isAffectState: () => isAffectState,
  isSustainedNegative: () => isSustainedNegative,
  loadAffect: () => loadAffect,
  recordAffect: () => recordAffect,
  recordAffectOne: () => recordAffectOne,
  resetAffect: () => resetAffect,
  saveAffect: () => saveAffect,
  valenceTemperatureReduction: () => valenceTemperatureReduction
});
module.exports = __toCommonJS(affect_exports);

// src/weighting.ts
function computeRecencyFactor(createdAt, halfLifeDays, now = /* @__PURE__ */ new Date()) {
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1e3 * 60 * 60 * 24);
  return Math.exp(-ageDays / halfLifeDays);
}

// src/affect.ts
var AFFECT_META_KEY = "affect:v1";
var AFFECT_DECAY_HALFLIFE_DAYS = 30;
function clampValence(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(-1, v));
}
function clampArousal(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
function emptyAffect() {
  return {};
}
function isAffectState(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = v;
  for (const values of Object.values(o)) {
    if (typeof values !== "object" || values === null) return false;
    const d = values;
    if (typeof d.valence !== "number" || !Number.isFinite(d.valence)) return false;
    if (typeof d.arousal !== "number" || !Number.isFinite(d.arousal)) return false;
    if (typeof d.n !== "number" || !Number.isFinite(d.n)) return false;
    if (typeof d.updatedAt !== "string") return false;
  }
  return true;
}
function decayAffect(affect, now = /* @__PURE__ */ new Date(), halfLifeDays = AFFECT_DECAY_HALFLIFE_DAYS) {
  const factor = computeRecencyFactor(affect.updatedAt, halfLifeDays, now);
  return {
    valence: clampValence(affect.valence * factor),
    arousal: clampArousal(affect.arousal * factor),
    n: affect.n,
    updatedAt: affect.updatedAt
  };
}
function recordAffectOne(current, domain, observed, alpha = 0.1, now = /* @__PURE__ */ new Date()) {
  const prev = current ?? {
    valence: 0,
    arousal: 0,
    n: 0,
    updatedAt: now.toISOString()
  };
  const decayed = decayAffect(prev, now);
  const newValence = clampValence(
    decayed.valence + alpha * (clampValence(observed.valence) - decayed.valence)
  );
  const newArousal = clampArousal(
    decayed.arousal + alpha * (clampArousal(observed.arousal) - decayed.arousal)
  );
  return {
    valence: newValence,
    arousal: newArousal,
    n: prev.n + 1,
    updatedAt: now.toISOString()
  };
}
async function loadAffect(store) {
  try {
    const raw = await store.getMeta(AFFECT_META_KEY);
    if (!raw || raw === "") return emptyAffect();
    const parsed = JSON.parse(raw);
    if (!isAffectState(parsed)) return emptyAffect();
    return parsed;
  } catch {
    return emptyAffect();
  }
}
async function saveAffect(store, state) {
  try {
    await store.setMeta(AFFECT_META_KEY, JSON.stringify(state));
  } catch {
  }
}
async function resetAffect(store) {
  const empty = emptyAffect();
  await saveAffect(store, empty);
  return empty;
}
async function recordAffect(store, domain, observed, alpha = 0.1) {
  if (!domain || typeof domain !== "string") return null;
  const state = await loadAffect(store);
  const updated = recordAffectOne(state[domain], domain, observed, alpha);
  state[domain] = updated;
  await saveAffect(store, state);
  return updated;
}
function getAffectBias(valence) {
  const v = clampValence(valence);
  return v * 0.15;
}
function getAffectTemperatureClamp(valence, arousal) {
  const v = clampValence(valence);
  const a = clampArousal(arousal);
  const arousalClamp = -a * 0.15;
  const valenceClamp = v < 0 ? v * 0.15 : 0;
  const combined = Math.max(-0.15, arousalClamp + valenceClamp);
  return combined;
}
function valenceTemperatureReduction(valence) {
  const v = clampValence(valence);
  if (v >= 0) return 0;
  return Math.min(0.15, -v * 0.15);
}
function isSustainedNegative(affect, minN = 3, threshold = -0.2) {
  if (!affect || affect.n < minN) return false;
  return affect.valence <= threshold;
}
function inferDomainFromPath(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const lower = filePath.toLowerCase();
  const map = {
    aws: "aws",
    terraform: "aws",
    ".tf": "aws",
    ec2: "aws",
    s3: "aws",
    lambda: "aws",
    realhax: "realhax",
    realvol: "realvol",
    realcode: "realcode",
    basecamp: "basecamp",
    realmemory: "realmemory",
    ".test.": "testing",
    "tests/": "testing",
    "test/": "testing",
    "__tests__": "testing",
    spec: "testing",
    vitest: "testing",
    playwright: "testing",
    opencode: "opencode",
    ".opencode": "opencode",
    "opencode.json": "opencode",
    docker: "tooling",
    dockerfile: "tooling",
    ".sh": "tooling",
    nginx: "tooling",
    guacamole: "realhax",
    supabase: "testing",
    prisma: "testing",
    stripe: "realvol",
    trpc: "realvol",
    hono: "realvol"
  };
  for (const [seg, domain] of Object.entries(map)) {
    if (lower.includes(seg)) return domain;
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AFFECT_META_KEY,
  clampArousal,
  clampValence,
  decayAffect,
  emptyAffect,
  getAffectBias,
  getAffectTemperatureClamp,
  inferDomainFromPath,
  isAffectState,
  isSustainedNegative,
  loadAffect,
  recordAffect,
  recordAffectOne,
  resetAffect,
  saveAffect,
  valenceTemperatureReduction
});
