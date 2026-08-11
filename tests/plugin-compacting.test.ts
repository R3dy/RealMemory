import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `plugin-compact-${generateUlid()}.db`);
}

function writeProjectConfig(projectDir: string, config: Record<string, unknown>): void {
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(config));
}

/** Plugin context with keyword-only mode + a temp DB. */
function makeContext(opts?: {
  compactingIntervalHours?: number;
  logSpy?: ReturnType<typeof vi.fn>;
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  const config: Record<string, unknown> = {
    embeddingModel: null,
    storagePath: dbPath,
    autoCapture: false,
    autoSummarize: false,
    recallThreshold: 0.0,
    maxRecallResults: 10,
  };
  if (opts?.compactingIntervalHours !== undefined) {
    config.compactingIntervalHours = opts.compactingIntervalHours;
  }
  writeProjectConfig(projectDir, config);

  const logSpy =
    opts?.logSpy ?? vi.fn().mockResolvedValue(undefined);

  const ctx: OpenCodePluginContext = {
    project: { path: projectDir, name: "test-project" },
    client: { app: { log: logSpy } },
    $: {},
    directory: projectDir,
    worktree: projectDir,
  };
  return { ctx, projectDir, dbPath };
}

/* The compacting hook signature per the OpenCode plugin SDK. */
type CompactingArgs = (
  input: { sessionID: string },
  output: { context: string[]; prompt?: string },
) => Promise<void> | void;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-compact-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("experimental.session.compacting hygiene hook", () => {
  it("is registered as a top-level hook handler", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });

  it("runs on a detached promise — a dedupPass failure never rejects the handler", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

const hooks = await realmemoryPlugin(ctx);
    const dedupSpy = vi
      .spyOn(MemoryStore.prototype, "dedupPass")
      .mockRejectedValue(new Error("disk on fire"));
    try {
      // The handler itself returns immediately (fire-and-forget) — the
      // detached hygiene work never rejects the handler or the compaction
      // flow. `await` of the void result is a no-op; the assertion is that
      // the call does not throw synchronously.
      const result = (hooks["experimental.session.compacting"] as CompactingArgs)(
        { sessionID: "s1" },
        { context: [] },
      );
      if (result && typeof result.then === "function") {
        await expect(result).resolves.toBeUndefined();
      }

      // The detached failure is logged, never thrown. The spy must stay
      // installed while the detached promise runs, so wait BEFORE restoring.
      await vi.waitFor(
        () => {
          const errorCalls = logSpy.mock.calls.filter((c) => {
            const body = (c[0] as { body?: { level?: string; message?: string } })?.body;
            return (
              body?.level === "error" &&
              body?.message?.includes("Compacting hygiene failed")
            );
          });
          expect(errorCalls.length).toBe(1);
        },
        { timeout: 3000, interval: 20 },
      );
    } finally {
      dedupSpy.mockRestore();
    }
  });

  it("uses the decay:compacting meta key (separate from session.created's decay:lastRun)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    const decaySpy = vi
      .spyOn(MemoryStore.prototype, "maybeDecay")
      .mockResolvedValue(false);
    try {
      // Fire session.created first — it schedules decay under decay:lastRun.
      await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
        event: { type: "session.created" },
      });
      // Fire the compacting hook.
      await (hooks["experimental.session.compacting"] as CompactingArgs)(
        { sessionID: "s1" },
        { context: [] },
      );

      await vi.waitFor(
        () => {
          expect(decaySpy).toHaveBeenCalledWith("decay:compacting", 4);
          expect(decaySpy).toHaveBeenCalledWith("decay:lastRun", 24);
        },
        { timeout: 3000, interval: 20 },
      );
    } finally {
      decaySpy.mockRestore();
    }
  });

  it("honors a configured compactingIntervalHours knob", async () => {
    const { ctx } = makeContext({ compactingIntervalHours: 2 });

    const hooks = await realmemoryPlugin(ctx);
    const decaySpy = vi
      .spyOn(MemoryStore.prototype, "maybeDecay")
      .mockResolvedValue(false);
    try {
      await (hooks["experimental.session.compacting"] as CompactingArgs)(
        { sessionID: "s1" },
        { context: [] },
      );
      await vi.waitFor(
        () => expect(decaySpy).toHaveBeenCalledWith("decay:compacting", 2),
        { timeout: 3000, interval: 20 },
      );
    } finally {
      decaySpy.mockRestore();
    }
  });

  it("records the memory_bloat_ratio metric after developing hygiene", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    const metricSpy = vi.spyOn(MemoryStore.prototype, "recordMetric");
    const decaySpy = vi
      .spyOn(MemoryStore.prototype, "maybeDecay")
      .mockResolvedValue(false); // Rate-limited → still records bloat ratio.
    try {
      await (hooks["experimental.session.compacting"] as CompactingArgs)(
        { sessionID: "s1" },
        { context: [] },
      );

      await vi.waitFor(
        () =>
          expect(metricSpy).toHaveBeenCalledWith(
            "memory_bloat_ratio",
            expect.any(Number),
          ),
        { timeout: 3000, interval: 20 },
      );
    } finally {
      metricSpy.mockRestore();
      decaySpy.mockRestore();
    }
  });
});