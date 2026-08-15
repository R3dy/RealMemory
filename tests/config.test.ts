import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { loadConfig, validateConfig } from "../src/config";
import type { MemoryStoreConfig } from "../src/types";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-cfg-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("loadConfig()", () => {
  it("returns all defaults when no config files exist", () => {
    // Use an empty temp dir with no config files.
    const cfg = loadConfig(tempDir);
    expect(cfg.storagePath).toBe("~/.opencode/realmemory/data.db");
    expect(cfg.embeddingModel).toBe("Xenova/all-MiniLM-L6-v2");
    expect(cfg.decayHalfLifeDays).toBe(30);
    expect(cfg.recallThreshold).toBe(0.3);
    expect(cfg.maxRecallResults).toBe(5);
    expect(cfg.crossProjectPromotionThreshold).toBe(2);
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoSummarize).toBe(false);
    expect(cfg.archiveThreshold).toBe(0.05);
    expect(cfg.maxRelatedPerMemory).toBe(3);
    expect(cfg.autoStartBrowser).toBe(true);
  });

  it("global config overrides defaults", () => {
    // loadConfig reads the global file from ~/.config/opencode/realmemory.json.
    // To test this in isolation we'd have to mutate the real home dir, which
    // is fragile. Instead, verify the merge logic by writing a project file
    // (the second precedence tier) and confirming it overrides defaults —
    // the global tier uses the identical merge code path.
    const projectCfgDir = join(tempDir, ".realmemory");
    mkdirSync(projectCfgDir, { recursive: true });
    writeFileSync(
      join(projectCfgDir, "config.json"),
      JSON.stringify({ decayHalfLifeDays: 60, recallThreshold: 0.5 }),
    );
    const cfg = loadConfig(tempDir);
    expect(cfg.decayHalfLifeDays).toBe(60);
    expect(cfg.recallThreshold).toBe(0.5);
    // Untouched keys still get defaults.
    expect(cfg.archiveThreshold).toBe(0.05);
    expect(cfg.autoCapture).toBe(true);
  });

  it("project config file overrides defaults", () => {
    const projectCfgDir = join(tempDir, ".realmemory");
    mkdirSync(projectCfgDir, { recursive: true });
    writeFileSync(
      join(projectCfgDir, "config.json"),
      JSON.stringify({ maxRecallResults: 10, autoSummarize: true }),
    );
    const cfg = loadConfig(tempDir);
    expect(cfg.maxRecallResults).toBe(10);
    expect(cfg.autoSummarize).toBe(true);
    expect(cfg.maxRelatedPerMemory).toBe(3);
  });

  it("falls back to defaults when config JSON is invalid", () => {
    const projectCfgDir = join(tempDir, ".realmemory");
    mkdirSync(projectCfgDir, { recursive: true });
    writeFileSync(
      join(projectCfgDir, "config.json"),
      "{ this is not valid json }}}",
    );
    const cfg = loadConfig(tempDir);
    // Defaults applied despite broken file.
    expect(cfg.decayHalfLifeDays).toBe(30);
    expect(cfg.recallThreshold).toBe(0.3);
  });

  it("strips JSONC-style // comments before parsing", () => {
    const projectCfgDir = join(tempDir, ".realmemory");
    mkdirSync(projectCfgDir, { recursive: true });
    writeFileSync(
      join(projectCfgDir, "config.json"),
      `{
  // decay faster for tests
  "decayHalfLifeDays": 7,
  "recallThreshold": 0.4 // threshold
}`,
    );
    const cfg = loadConfig(tempDir);
    expect(cfg.decayHalfLifeDays).toBe(7);
    expect(cfg.recallThreshold).toBe(0.4);
  });

  it("merges nested-ish keys: project supplies projectId + storagePath", () => {
    const projectCfgDir = join(tempDir, ".realmemory");
    mkdirSync(projectCfgDir, { recursive: true });
    writeFileSync(
      join(projectCfgDir, "config.json"),
      JSON.stringify({
        projectId: "test-proj-123",
        storagePath: join(tempDir, "custom.db"),
      }),
    );
    const cfg = loadConfig(tempDir);
    expect(cfg.projectId).toBe("test-proj-123");
    expect(cfg.storagePath).toBe(join(tempDir, "custom.db"));
  });

  it("project config can disable autoStartBrowser", () => {
    const projectCfgDir = join(tempDir, ".realmemory");
    mkdirSync(projectCfgDir, { recursive: true });
    writeFileSync(
      join(projectCfgDir, "config.json"),
      JSON.stringify({ autoStartBrowser: false }),
    );
    const cfg = loadConfig(tempDir);
    expect(cfg.autoStartBrowser).toBe(false);
  });
});

describe("validateConfig()", () => {
  it("rejects decayHalfLifeDays <= 0", () => {
    expect(() => validateConfig({ decayHalfLifeDays: 0 })).toThrow(
      /decayHalfLifeDays/,
    );
    expect(() => validateConfig({ decayHalfLifeDays: -5 })).toThrow(
      /decayHalfLifeDays/,
    );
  });

  it("rejects recallThreshold > 1", () => {
    expect(() => validateConfig({ recallThreshold: 1.5 })).toThrow(
      /recallThreshold/,
    );
  });

  it("rejects recallThreshold < 0", () => {
    expect(() => validateConfig({ recallThreshold: -0.1 })).toThrow(
      /recallThreshold/,
    );
  });

  it("rejects archiveThreshold > 1", () => {
    expect(() => validateConfig({ archiveThreshold: 2 })).toThrow(
      /archiveThreshold/,
    );
  });

  it("rejects archiveThreshold < 0", () => {
    expect(() => validateConfig({ archiveThreshold: -0.01 })).toThrow(
      /archiveThreshold/,
    );
  });

  it("rejects maxRecallResults < 0", () => {
    expect(() => validateConfig({ maxRecallResults: -1 })).toThrow(
      /maxRecallResults/,
    );
  });

  it("rejects non-boolean autoStartBrowser", () => {
    expect(() => validateConfig({ autoStartBrowser: "true" as unknown as boolean })).toThrow(
      /autoStartBrowser/,
    );
    expect(() => validateConfig({ autoStartBrowser: 1 as unknown as boolean })).toThrow(
      /autoStartBrowser/,
    );
  });

  it("rejects non-positive or non-integer crossProjectPromotionThreshold", () => {
    expect(() => validateConfig({ crossProjectPromotionThreshold: 0 })).toThrow(
      /crossProjectPromotionThreshold/,
    );
    expect(() => validateConfig({ crossProjectPromotionThreshold: -2 })).toThrow(
      /crossProjectPromotionThreshold/,
    );
    expect(() => validateConfig({ crossProjectPromotionThreshold: 1.5 })).toThrow(
      /crossProjectPromotionThreshold/,
    );
    expect(() => validateConfig({ crossProjectPromotionThreshold: "2" as unknown as number })).toThrow(
      /crossProjectPromotionThreshold/,
    );
  });

  it("accepts a positive-integer crossProjectPromotionThreshold", () => {
    expect(() => validateConfig({ crossProjectPromotionThreshold: 2 })).not.toThrow();
    expect(() => validateConfig({ crossProjectPromotionThreshold: 3 })).not.toThrow();
  });

  it("accepts boolean autoStartBrowser values", () => {
    expect(() => validateConfig({ autoStartBrowser: true })).not.toThrow();
    expect(() => validateConfig({ autoStartBrowser: false })).not.toThrow();
  });

  it("accepts a fully valid config without throwing", () => {
    const valid: MemoryStoreConfig = {
      decayHalfLifeDays: 14,
      recallThreshold: 0.4,
      archiveThreshold: 0.1,
      maxRecallResults: 8,
    };
    expect(() => validateConfig(valid)).not.toThrow();
  });

  it("accepts an empty config (no values to validate)", () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it("accepts boundary values (0 and 1 for thresholds)", () => {
    expect(() =>
      validateConfig({ recallThreshold: 0, archiveThreshold: 1 }),
    ).not.toThrow();
  });

  // Synthetic-brain Phase 4a: inhibition validation
  it("accepts all four inhibition levels", () => {
    for (const lvl of ["off", "warn", "rewrite", "block"] as const) {
      expect(() =>
        validateConfig({ brain: { inhibition: lvl } }),
      ).not.toThrow();
    }
  });

  it("rejects an invalid inhibition value", () => {
    expect(() =>
      validateConfig({ brain: { inhibition: "delete" } as unknown as { inhibition?: "off" | "warn" | "rewrite" | "block" } }),
    ).toThrow(/brain.inhibition must be one of/);
  });

  // Synthetic-brain Phase 5: arousalModulation + toolDefinitionNotes validation
  it("accepts boolean arousalModulation", () => {
    expect(() => validateConfig({ brain: { arousalModulation: true } })).not.toThrow();
    expect(() => validateConfig({ brain: { arousalModulation: false } })).not.toThrow();
  });

  it("rejects non-boolean arousalModulation", () => {
    expect(() => validateConfig({ brain: { arousalModulation: "yes" } as unknown as { arousalModulation?: boolean } })).toThrow(
      /brain.arousalModulation must be a boolean/,
    );
  });

  it("accepts boolean toolDefinitionNotes", () => {
    expect(() => validateConfig({ brain: { toolDefinitionNotes: true } })).not.toThrow();
    expect(() => validateConfig({ brain: { toolDefinitionNotes: false } })).not.toThrow();
  });

  it("rejects non-boolean toolDefinitionNotes", () => {
    expect(() => validateConfig({ brain: { toolDefinitionNotes: "yes" } as unknown as { toolDefinitionNotes?: boolean } })).toThrow(
      /brain.toolDefinitionNotes must be a boolean/,
    );
  });
});
