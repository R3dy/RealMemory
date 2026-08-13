import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryStoreConfig } from "./types";

const DEFAULTS: Required<
  Pick<
    MemoryStoreConfig,
    | "storagePath"
    | "embeddingModel"
    | "decayHalfLifeDays"
    | "decayIntervalHours"
    | "recallThreshold"
    | "duplicateSimilarityThreshold"
    | "crossProjectPromotionThreshold"
    | "maxRecallResults"
    | "autoCapture"
    | "autoSummarize"
    | "archiveThreshold"
    | "maxRelatedPerMemory"
    | "autoStartBrowser"
    | "concisenessCap"
    | "autoRelate"
    | "brainLoop"
    | "compactingIntervalHours"
  >
> = {
  storagePath: "~/.opencode/realmemory/data.db",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  decayHalfLifeDays: 30,
  decayIntervalHours: 24,
  recallThreshold: 0.3,
  duplicateSimilarityThreshold: 0.92,
  crossProjectPromotionThreshold: 2,
  maxRecallResults: 5,
  autoCapture: true,
  autoSummarize: false,
  archiveThreshold: 0.05,
  maxRelatedPerMemory: 3,
  autoStartBrowser: true,
  concisenessCap: 280,
  autoRelate: true,
  brainLoop: true,
  compactingIntervalHours: 4,
};

/**
 * Load config from files, merged with defaults.
 *
 * Checks (in order, later overrides earlier):
 * 1. ~/.config/opencode/realmemory.json (global)
 * 2. .realmemory/config.json (project — relative to cwd or `projectDir`)
 *
 * Returns merged config with defaults applied. Missing files and invalid
 * JSON are silently ignored so a broken config never crashes the store.
 */
export function loadConfig(projectDir?: string): MemoryStoreConfig {
  let config: MemoryStoreConfig = {};

  // 1. Global config.
  const globalPath = join(homedir(), ".config", "opencode", "realmemory.json");
  if (existsSync(globalPath)) {
    try {
      config = { ...config, ...readJsonFile(globalPath) };
    } catch {
      // Ignore invalid JSON — fall back to defaults.
    }
  }

  // 2. Project config (overrides global).
  const projectPath = join(
    projectDir || process.cwd(),
    ".realmemory",
    "config.json",
  );
  if (existsSync(projectPath)) {
    try {
      config = { ...config, ...readJsonFile(projectPath) };
    } catch {
      // Ignore invalid JSON.
    }
  }

  // 3. Merge with defaults.
  return { ...DEFAULTS, ...config };
}

/**
 * Validate a config object. Throws if any value is out of range.
 */
export function validateConfig(config: MemoryStoreConfig): void {
  if (config.decayHalfLifeDays !== undefined && config.decayHalfLifeDays <= 0) {
    throw new Error("decayHalfLifeDays must be > 0");
  }
  if (
    config.decayIntervalHours !== undefined &&
    (config.decayIntervalHours <= 0 || Number.isNaN(config.decayIntervalHours))
  ) {
    throw new Error("decayIntervalHours must be > 0");
  }
  if (
    config.recallThreshold !== undefined &&
    (config.recallThreshold < 0 || config.recallThreshold > 1)
  ) {
    throw new Error("recallThreshold must be in [0, 1]");
  }
  if (
    config.duplicateSimilarityThreshold !== undefined &&
    (config.duplicateSimilarityThreshold < 0 || config.duplicateSimilarityThreshold > 1)
  ) {
    throw new Error("duplicateSimilarityThreshold must be in [0, 1]");
  }
  if (
    config.crossProjectPromotionThreshold !== undefined &&
    (!Number.isInteger(config.crossProjectPromotionThreshold) ||
      config.crossProjectPromotionThreshold < 1)
  ) {
    throw new Error("crossProjectPromotionThreshold must be a positive integer");
  }
  if (
    config.archiveThreshold !== undefined &&
    (config.archiveThreshold < 0 || config.archiveThreshold > 1)
  ) {
    throw new Error("archiveThreshold must be in [0, 1]");
  }
  if (config.maxRecallResults !== undefined && config.maxRecallResults < 0) {
    throw new Error("maxRecallResults must be >= 0");
  }
  if (
    config.autoStartBrowser !== undefined &&
    typeof config.autoStartBrowser !== "boolean"
  ) {
    throw new Error("autoStartBrowser must be a boolean");
  }
  if (
    config.concisenessCap !== undefined &&
    (config.concisenessCap <= 0 || !Number.isFinite(config.concisenessCap))
  ) {
    throw new Error("concisenessCap must be > 0");
  }
  if (
    config.compactingIntervalHours !== undefined &&
    (config.compactingIntervalHours <= 0 || Number.isNaN(config.compactingIntervalHours))
  ) {
    throw new Error("compactingIntervalHours must be > 0");
  }
  if (
    config.autoRelate !== undefined &&
    typeof config.autoRelate !== "boolean"
  ) {
    throw new Error("autoRelate must be a boolean");
  }
  if (
    config.brainLoop !== undefined &&
    typeof config.brainLoop !== "boolean"
  ) {
    throw new Error("brainLoop must be a boolean");
  }
  // Synthetic-brain Phase 2: brain.predictionError validation.
  // Mirrors the brain.reflex pattern — no nested default in DEFAULTS; gated on
  // `!== false` in the plugin. Validation rejects non-boolean when present.
  if (
    config.brain?.predictionError !== undefined &&
    typeof config.brain.predictionError !== "boolean"
  ) {
    throw new Error("brain.predictionError must be a boolean");
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  const content = readFileSync(path, "utf-8");
  // Strip JSONC comments (// ...) for .json config files.
  const stripped = content.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped) as Record<string, unknown>;
}
