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
  if (
    config.brain?.predictionError !== undefined &&
    typeof config.brain.predictionError !== "boolean"
  ) {
    throw new Error("brain.predictionError must be a boolean");
  }
  // Synthetic-brain Phase 4a: brain.inhibition validation.
  if (config.brain?.inhibition !== undefined) {
    const valid = ["off", "warn", "rewrite", "block"];
    if (!valid.includes(config.brain.inhibition)) {
      throw new Error(`brain.inhibition must be one of: ${valid.join(", ")}`);
    }
  }
  // Synthetic-brain Phase 5: brain.arousalModulation validation.
  if (
    config.brain?.arousalModulation !== undefined &&
    typeof config.brain.arousalModulation !== "boolean"
  ) {
    throw new Error("brain.arousalModulation must be a boolean");
  }
  // Synthetic-brain Phase 5: brain.toolDefinitionNotes validation.
  if (
    config.brain?.toolDefinitionNotes !== undefined &&
    typeof config.brain.toolDefinitionNotes !== "boolean"
  ) {
    throw new Error("brain.toolDefinitionNotes must be a boolean");
  }
  // Synthetic-brain Phase 6: brain.schemaFormation validation.
  if (
    config.brain?.schemaFormation !== undefined &&
    typeof config.brain.schemaFormation !== "boolean"
  ) {
    throw new Error("brain.schemaFormation must be a boolean");
  }
  if (
    config.brain?.schemaFormationThreshold !== undefined &&
    (typeof config.brain.schemaFormationThreshold !== "number" ||
      config.brain.schemaFormationThreshold < 0.5 ||
      config.brain.schemaFormationThreshold > 1)
  ) {
    throw new Error("brain.schemaFormationThreshold must be a number in [0.5, 1]");
  }
  if (
    config.brain?.schemaFormationMinCluster !== undefined &&
    (!Number.isInteger(config.brain.schemaFormationMinCluster) ||
      config.brain.schemaFormationMinCluster < 2)
  ) {
    throw new Error("brain.schemaFormationMinCluster must be an integer >= 2");
  }
  // Synthetic-brain Phase 3: brain.workingMemory + workingMemoryTokens validation.
  if (
    config.brain?.workingMemory !== undefined &&
    typeof config.brain.workingMemory !== "boolean"
  ) {
    throw new Error("brain.workingMemory must be a boolean");
  }
  if (config.brain?.workingMemoryTokens !== undefined) {
    if (
      typeof config.brain.workingMemoryTokens !== "number" ||
      config.brain.workingMemoryTokens < 200 ||
      config.brain.workingMemoryTokens > 4000
    ) {
      throw new Error("brain.workingMemoryTokens must be a number in [200, 4000]");
    }
  }
  // Synthetic-self Phase 8: brain.events (event-spine master switch) +
  // brain.eventRetention (telemetry tape cap) validation.
  if (
    config.brain?.events !== undefined &&
    typeof config.brain.events !== "boolean"
  ) {
    throw new Error("brain.events must be a boolean");
  }
  if (config.brain?.eventRetention !== undefined) {
    if (
      !Number.isInteger(config.brain.eventRetention) ||
      config.brain.eventRetention < 1000
    ) {
      throw new Error("brain.eventRetention must be an integer >= 1000");
    }
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  const content = readFileSync(path, "utf-8");
  // Strip JSONC comments (// ...) for .json config files.
  const stripped = content.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped) as Record<string, unknown>;
}
