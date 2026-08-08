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
    | "recallThreshold"
    | "maxRecallResults"
    | "autoCapture"
    | "autoSummarize"
    | "archiveThreshold"
    | "maxRelatedPerMemory"
  >
> = {
  storagePath: "~/.opencode/realmemory/data.db",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  decayHalfLifeDays: 30,
  recallThreshold: 0.3,
  maxRecallResults: 5,
  autoCapture: true,
  autoSummarize: false,
  archiveThreshold: 0.05,
  maxRelatedPerMemory: 3,
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
    config.recallThreshold !== undefined &&
    (config.recallThreshold < 0 || config.recallThreshold > 1)
  ) {
    throw new Error("recallThreshold must be in [0, 1]");
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
}

function readJsonFile(path: string): Record<string, unknown> {
  const content = readFileSync(path, "utf-8");
  // Strip JSONC comments (// ...) for .json config files.
  const stripped = content.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped) as Record<string, unknown>;
}
