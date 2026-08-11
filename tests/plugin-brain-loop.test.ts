import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { MemoryStore } from "../src/store";
import { deriveProjectId } from "../src/project-id";
import { generateUlid } from "../src/db/ulid";
import type { StoreInput } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `plugin-bl-${generateUlid()}.db`);
}

function writeProjectConfig(projectDir: string, config: Record<string, unknown>): void {
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(config));
}

/** Plugin context with keyword-only mode + a temp DB; brainLoop is on by default. */
function makeContext(opts?: {
  brainLoop?: boolean;
  logSpy?: ReturnType<typeof vi.fn>;
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  const config: Record<string, unknown> = {
    embeddingModel: null,
    storagePath: dbPath,
    autoCapture: true,
    autoSummarize: false,
    recallThreshold: 0.0,
    maxRecallResults: 10,
  };
  if (opts?.brainLoop !== undefined) config.brainLoop = opts.brainLoop;
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

/* Hook call-signatures (mirrors plugin.test.ts casting). */
type EventArgs = (arg: { event: { type: string } }) => Promise<void>;
type ToolAfterArgs = (
  input: { tool: string },
  output: { args?: Record<string, unknown>; output?: unknown },
) => Promise<void>;
type ChatMessageArgs = (
  input: { sessionID?: string },
  output: { message?: { role?: string; id?: string }; parts?: unknown[] },
) => Promise<void>;
type TransformArgs = (input: unknown, output: { system: string[] }) => Promise<void>;

/** Spawn a store on the same DB to seed memories (keyword-only). */
async function withSeedStore(
  dbPath: string,
  projectId: string,
  fn: (store: MemoryStore) => Promise<void>,
): Promise<void> {
  const store = new MemoryStore({ storagePath: dbPath, projectId, embeddingModel: null });
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-brainloop-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* ---------------- session.idle fires evaluateDelta (detached) ---------------- */

describe("session.idle delta evaluation (C1 fix)", () => {
  it("fires evaluateDelta detached and never rejects the handler when store() throws", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);

    // A correction turn sets lastUserIntent so evaluateDelta reaches store().
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "no, use postgres not mysql" }],
      },
    );

    // Make the underlying write explode — the detached delta must absorb it.
    const storeSpy = vi
      .spyOn(MemoryStore.prototype, "store")
      .mockRejectedValue(new Error("disk on fire"));
    try {
      // The handler itself resolves immediately — evaluateDelta is fire-and-forget.
      await expect(
        (hooks.event as EventArgs)({ event: { type: "session.idle" } }),
      ).resolves.toBeUndefined();
    } finally {
      storeSpy.mockRestore();
    }

    // The detached failure is logged, never thrown.
    await vi.waitFor(
      () => {
        const errorCalls = logSpy.mock.calls.filter((c) => {
          const body = (c[0] as { body?: { level?: string; message?: string } })?.body;
          return body?.level === "error" && body?.message?.includes("evaluateDelta failed");
        });
        expect(errorCalls.length).toBe(1);
      },
      { timeout: 3000, interval: 20 },
    );
  });

  it("stores nothing on session.idle when brainLoop:false (master switch)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ brainLoop: false, logSpy });

    const hooks = await realmemoryPlugin(ctx);
    const storeSpy = vi.spyOn(MemoryStore.prototype, "store");

    // Even a strong correction turn does not store a delta.
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "no, use postgres not mysql" }],
      },
    );
    await (hooks.event as EventArgs)({ event: { type: "session.idle" } });

    await new Promise((r) => setTimeout(r, 150));
    expect(storeSpy).not.toHaveBeenCalled();
    storeSpy.mockRestore();
  });
});

/* --------------- tool.execute.after -> classify -> evaluateDelta ------------- */

describe("tool capture -> tool_outcome delta (C2 integration)", () => {
  it("classifies a followup message as tool_outcome, stores it on idle, then clears the capture", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    const storeSpy = vi.spyOn(MemoryStore.prototype, "store");

    // 1. Bash error -> auto-capture store() + lastToolCapture set (detached).
    await (hooks["tool.execute.after"] as ToolAfterArgs)(
      { tool: "bash" },
      { args: { command: "npm run build" }, output: "error: module not found" },
    );
    await vi.waitFor(() => expect(storeSpy).toHaveBeenCalledTimes(1), {
      timeout: 3000,
      interval: 20,
    });

    // 2. Next user message: no keywords, but a tool ran -> tool_outcome.
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "please continue" }],
      },
    );

    // 3. session.idle -> evaluateDelta stores a tool_outcome lesson_learned,
    //    after resolving, the caller clears lastToolCapture.
    await (hooks.event as EventArgs)({ event: { type: "session.idle" } });
    await vi.waitFor(() => expect(storeSpy).toHaveBeenCalledTimes(2), {
      timeout: 3000,
      interval: 20,
    });

    const deltaInput = storeSpy.mock.calls[1][0] as StoreInput;
    expect(deltaInput.type).toBe("lesson_learned");
    expect(deltaInput.content).toContain("Tool outcome (bash): error");
    expect(deltaInput.tags).toContain("tool_outcome");

    // 4. C2: the capture was cleared — a generic followup turn stores nothing.
    await new Promise((r) => setTimeout(r, 50));
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m2" },
        parts: [{ type: "text", text: "hello there" }],
      },
    );
    await (hooks.event as EventArgs)({ event: { type: "session.idle" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(storeSpy).toHaveBeenCalledTimes(2);
    storeSpy.mockRestore();
  });
});

/* ------------- system.transform stashes delivered IDs (C2 fix) ------------- */

describe("system.transform lastInjectedMemoryIds stash (C2 fix)", () => {
  it("stashes the session-delivered IDs before clearing pendingInjection so idle records recall_miss", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    // Seed a memory that matches the session.created query.
    await withSeedStore(dbPath, deriveProjectId(ctx.directory), async (store) => {
      await store.store({
        content: `Project at ${ctx.directory} uses SQLite`,
        type: "codebase_fact",
        tags: ["seed"],
      });
    });

    const hooks = await realmemoryPlugin(ctx);

    // 1. session.created recalls the seed and stages an injection.
    await (hooks.event as EventArgs)({ event: { type: "session.created" } });

    // 2. A correction turn whose recall misses (no FTS token overlap with the
    //    seed) — the chat.message path therefore leaves lastInjectedMemoryIds
    //    null after resetting it at turn start.
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "no, use postgres not mysql" }],
      },
    );

    // 3. system.transform delivers the staged block AND stashes the IDs
    //    delivered this session before clearing pendingInjection.
    const system: string[] = ["You are an agent."];
    await (hooks["experimental.chat.system.transform"] as TransformArgs)({}, { system });
    expect(system.length).toBe(2);
    expect(system[1]).toContain("## Relevant memories from previous sessions");

    // 4. session.idle -> evaluateDelta sees the stashed IDs (recall_miss, since
    //    the idle trigger delivers no assistant response text).
    const recordMetricSpy = vi.spyOn(MemoryStore.prototype, "recordMetric");
    await (hooks.event as EventArgs)({ event: { type: "session.idle" } });
    await vi.waitFor(
      () => expect(recordMetricSpy).toHaveBeenCalledWith("recall_miss", 1.0),
      { timeout: 3000, interval: 20 },
    );
    recordMetricSpy.mockRestore();
  });
});