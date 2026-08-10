import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, {
  isConfigOrSchemaFile,
  isErrorResult,
  formatRecallResults,
  extractUserText,
  type OpenCodePluginContext,
} from "../src/plugin";
import { MemoryStore } from "../src/store";
import { deriveProjectId } from "../src/project-id";
import { generateUlid } from "../src/db/ulid";
import type { RecallResult, Memory } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `plugin-${generateUlid()}.db`);
}

/** Write a `.realmemory/config.json` into the given project directory. */
function writeProjectConfig(
  projectDir: string,
  config: Record<string, unknown>,
): void {
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(config));
}

/**
 * Build a plugin context whose `directory` points at a temp project dir with a
 * `.realmemory/config.json` forcing keyword-only mode (embeddingModel: null)
 * and a storage path inside the temp dir. This keeps tests fast and offline.
 */
function makeContext(opts?: {
  autoCapture?: boolean;
  autoSummarize?: boolean;
  logSpy?: ReturnType<typeof vi.fn>;
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  writeProjectConfig(projectDir, {
    embeddingModel: null,
    storagePath: dbPath,
    autoCapture: opts?.autoCapture ?? true,
    autoSummarize: opts?.autoSummarize ?? false,
    recallThreshold: 0.0,
    maxRecallResults: 10,
  });

  const logSpy =
    opts?.logSpy ??
    vi.fn().mockResolvedValue(undefined);

  const ctx: OpenCodePluginContext = {
    project: { path: projectDir, name: "test-project" },
    client: {
      app: {
        log: logSpy,
      },
    },
    $: {},
    directory: projectDir,
    worktree: projectDir,
  };

  return { ctx, projectDir, dbPath };
}

/** Construct a minimal Memory object for test fixtures. */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? generateUlid(),
    content: overrides.content ?? "test memory",
    type: overrides.type ?? "codebase_fact",
    scope: overrides.scope ?? "project",
    tags: overrides.tags ?? [],
    weight: overrides.weight ?? 0.5,
    confidence: overrides.confidence ?? 0.5,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    accessCount: overrides.accessCount ?? 0,
    reinforcementCount: overrides.reinforcementCount ?? 0,
    metadata: overrides.metadata ?? {},
    status: overrides.status ?? "active",
  };
}

/**
 * Wait until the plugin's own DB (read through a single fresh connection that
 * stays open for the whole wait) shows `count` memories of the given type.
 * Auto-capture hooks are fire-and-forget: the hook resolves before the detached
 * write lands, so assertions that depend on the capture reaching the DB must
 * poll. The connection is opened once — repeated DDL during concurrent writes
 * would contend for the SQLite write lock.
 */
async function waitForCaptured(
  dbPath: string,
  projectId: string,
  type: "codebase_fact" | "lesson_learned",
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  const verifyStore = new MemoryStore({
    storagePath: dbPath,
    projectId,
    embeddingModel: null,
  });
  await verifyStore.init();
  try {
    await vi.waitFor(
      async () => {
        const list = await verifyStore.list({ scope: "all", limit: 50 });
        expect(list.memories.filter((m) => m.type === type).length).toBe(count);
      },
      { timeout: timeoutMs, interval: 20 },
    );
  } finally {
    await verifyStore.close();
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-plugin-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* --------------------------- isConfigOrSchemaFile --------------------------- */

describe("isConfigOrSchemaFile", () => {
  it("detects package.json", () => {
    expect(isConfigOrSchemaFile("/repo/package.json")).toBe(true);
  });

  it("detects tsconfig.json", () => {
    expect(isConfigOrSchemaFile("/repo/tsconfig.json")).toBe(true);
  });

  it("detects .env files", () => {
    expect(isConfigOrSchemaFile("/repo/.env")).toBe(true);
    expect(isConfigOrSchemaFile("/repo/.env.local")).toBe(false);
  });

  it("detects config.{json,js,ts,yaml,yml}", () => {
    expect(isConfigOrSchemaFile("/repo/config.json")).toBe(true);
    expect(isConfigOrSchemaFile("/src/config.ts")).toBe(true);
    expect(isConfigOrSchemaFile("/src/config.yaml")).toBe(true);
  });

  it("detects schema.{ts,js,sql}", () => {
    expect(isConfigOrSchemaFile("/src/schema.ts")).toBe(true);
    expect(isConfigOrSchemaFile("/db/schema.sql")).toBe(true);
  });

  it("detects routes.{ts,js}", () => {
    expect(isConfigOrSchemaFile("/src/routes.ts")).toBe(true);
    expect(isConfigOrSchemaFile("/src/route.js")).toBe(true);
  });

  it("detects migration files", () => {
    expect(isConfigOrSchemaFile("/db/migration_001.ts")).toBe(true);
    expect(isConfigOrSchemaFile("/db/migrations/002_add_users.sql")).toBe(true);
  });

  it("detects Dockerfile and docker-compose", () => {
    expect(isConfigOrSchemaFile("/repo/Dockerfile")).toBe(true);
    expect(isConfigOrSchemaFile("/repo/docker-compose.yml")).toBe(true);
  });

  it("rejects ordinary source files", () => {
    expect(isConfigOrSchemaFile("/src/foo.ts")).toBe(false);
    expect(isConfigOrSchemaFile("/src/bar.js")).toBe(false);
    expect(isConfigOrSchemaFile("/src/index.tsx")).toBe(false);
    expect(isConfigOrSchemaFile("/src/utils/helper.py")).toBe(false);
  });
});

/* ------------------------------ isErrorResult ------------------------------ */

describe("isErrorResult", () => {
  it("detects 'error:' (case insensitive)", () => {
    expect(isErrorResult("error: something went wrong")).toBe(true);
    expect(isErrorResult("ERROR: fatal")).toBe(true);
  });

  it("detects 'Error:' prefix", () => {
    expect(isErrorResult("Error: ENOENT")).toBe(true);
  });

  it("detects 'failed'", () => {
    expect(isErrorResult("Build failed")).toBe(true);
    expect(isErrorResult("failed to connect")).toBe(true);
  });

  it("detects 'FAIL'", () => {
    expect(isErrorResult("FAIL: assertion")).toBe(true);
  });

  it("detects 'cannot find'", () => {
    expect(isErrorResult("cannot find module 'foo'")).toBe(true);
  });

  it("detects 'permission denied'", () => {
    expect(isErrorResult("permission denied: /root")).toBe(true);
  });

  it("detects 'not found'", () => {
    expect(isErrorResult("404 not found")).toBe(true);
  });

  it("detects 'exception' and 'traceback'", () => {
    expect(isErrorResult("Exception in thread main")).toBe(true);
    expect(isErrorResult("Traceback (most recent call last)")).toBe(true);
  });

  it("rejects normal successful output", () => {
    expect(isErrorResult("success")).toBe(false);
    expect(isErrorResult("done")).toBe(false);
    expect(isErrorResult("All tests passed")).toBe(false);
    expect(isErrorResult("")).toBe(false);
  });
});

/* --------------------------- formatRecallResults --------------------------- */

describe("formatRecallResults", () => {
  it("returns empty string for empty array", () => {
    expect(formatRecallResults([])).toBe("");
  });

  it("formats a single result with type and weight", () => {
    const memory = makeMemory({
      content: "The DB uses SQLite",
      type: "codebase_fact",
      weight: 0.75,
    });
    const result: RecallResult = {
      memory,
      score: 0.8,
      matchedBy: "keyword",
      related: [],
    };
    const out = formatRecallResults([result]);
    expect(out).toContain("## Relevant memories from previous sessions");
    expect(out).toContain("[codebase_fact, weight: 0.75]");
    expect(out).toContain("The DB uses SQLite");
    expect(out).toContain("1.");
  });

  it("formats related memories when present", () => {
    const main = makeMemory({ content: "Main memory", weight: 0.6 });
    const rel1 = makeMemory({ content: "Related one" });
    const rel2 = makeMemory({ content: "Related two" });
    const result: RecallResult = {
      memory: main,
      score: 0.5,
      matchedBy: "keyword",
      related: [rel1, rel2],
    };
    const out = formatRecallResults([result]);
    expect(out).toContain('Related: "Related one"; "Related two"');
  });

  it("formats multiple results with incrementing numbers", () => {
    const r1: RecallResult = {
      memory: makeMemory({ content: "First", weight: 0.9 }),
      score: 0.9,
      matchedBy: "keyword",
      related: [],
    };
    const r2: RecallResult = {
      memory: makeMemory({ content: "Second", weight: 0.5 }),
      score: 0.5,
      matchedBy: "semantic",
      related: [],
    };
    const out = formatRecallResults([r1, r2]);
    expect(out).toContain("1. ");
    expect(out).toContain("2. ");
    expect(out).toContain("First");
    expect(out).toContain("Second");
  });
});

/* ------------------------------ plugin shape ------------------------------ */

describe("plugin shape", () => {
  it("returns an object with expected hook keys", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    expect(typeof hooks).toBe("object");
    expect(hooks).not.toBeNull();
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
  });
});

/* ------------------------- session.created auto-recall ------------------------ */

describe("session.created event", () => {
  it("triggers recall on a new session (logs info when results found)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    // Seed the plugin's own DB with a memory that will keyword-match the
    // session query (`Project at ${ctx.directory}`).
    const seedStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
      recallThreshold: 0.0,
    });
    await seedStore.init();
    await seedStore.store({
      content: `Project at ${ctx.directory} uses SQLite`,
      type: "codebase_fact",
      tags: ["seed"],
    });
    await seedStore.close();

    const hooks = await realmemoryPlugin(ctx);
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });

    // Should have logged an info message about auto-recalled memories.
    const infoCalls = logSpy.mock.calls.filter(
      (c) => (c[0] as { body?: { level?: string } })?.body?.level === "info",
    );
    expect(infoCalls.length).toBeGreaterThan(0);
    const infoMsg = (infoCalls[0][0] as { body: { message: string } }).body.message;
    expect(infoMsg).toMatch(/Auto-recalled \d+ memories/);
  });

  it("does not error on an empty database (no injection)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await expect(
      (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
        event: { type: "session.created" },
      }),
    ).resolves.toBeUndefined();

    // No info-level "Auto-recalled" log because DB is empty.
    const recallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(recallCalls.length).toBe(0);
  });
});

/* ----------------------- session.idle auto-summarize ----------------------- */

describe("session.idle event", () => {
  it("skips summarization when no provider configured (logs skip)", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ autoSummarize: false, logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.idle" },
    });

    const skipCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("summarization skipped");
    });
    expect(skipCalls.length).toBe(1);
  });
});

/* --------------------- tool.execute.after auto-capture -------------------- */

describe("tool.execute.after hook", () => {
  it("captures codebase_fact when read tool targets a config file", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/package.json" }, output: "file contents" },
    );

    // The hook resolves before the detached write lands — poll for the capture.
    await waitForCaptured(dbPath, deriveProjectId(ctx.directory), "codebase_fact", 1);

    // Verify the memory was stored in the DB.
    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    const facts = list.memories.filter((m) => m.type === "codebase_fact");
    expect(facts.length).toBe(1);
    expect(facts[0].content).toContain("package.json");
    expect(facts[0].tags).toContain("auto-captured");
    expect(facts[0].tags).toContain("file-read");
  });

  it("does NOT capture when read tool targets a non-config file", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/src/foo.ts" }, output: "source code" },
    );

    await waitForCaptured(dbPath, deriveProjectId(ctx.directory), "codebase_fact", 0);

    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    expect(list.memories.length).toBe(0);
  });

  it("captures lesson_learned when bash tool produces an error", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "bash" },
      {
        args: { command: "npm run build" },
        output: "error: module not found",
      },
    );

    await waitForCaptured(dbPath, deriveProjectId(ctx.directory), "lesson_learned", 1);

    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    const lessons = list.memories.filter((m) => m.type === "lesson_learned");
    expect(lessons.length).toBe(1);
    expect(lessons[0].content).toContain("Command failed");
    expect(lessons[0].content).toContain("npm run build");
    expect(lessons[0].tags).toContain("bash-error");
  });

  it("does NOT capture when bash tool succeeds", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "bash" },
      { args: { command: "echo hello" }, output: "hello\n" },
    );

    await waitForCaptured(dbPath, deriveProjectId(ctx.directory), "lesson_learned", 0);

    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    expect(list.memories.length).toBe(0);
  });

  it("does NOT capture when autoCapture is false", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ autoCapture: false, logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/package.json" }, output: "contents" },
    );

    await waitForCaptured(dbPath, deriveProjectId(ctx.directory), "codebase_fact", 0);

    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    expect(list.memories.length).toBe(0);
  });
});

/* ------------------------ chat.message auto-recall ----------------------- */

describe("chat.message hook", () => {
  it("triggers recall for user messages with matching content", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    // Seed the plugin's own DB with a memory that matches a user message.
    const seedStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
      recallThreshold: 0.0,
    });
    await seedStore.init();
    await seedStore.store({
      content: "The API uses REST conventions for all endpoints",
      type: "codebase_fact",
      tags: ["seed"],
    });
    await seedStore.close();

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["chat.message"] as (
        input: { sessionID?: string },
        output: { message?: { role?: string; id?: string }; parts?: unknown[] },
      ) => Promise<void>
    )(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "REST conventions for all endpoints" }],
      },
    );

    // Recall runs on a detached promise — wait for the background log call.
    await vi.waitFor(() => {
      const recallCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("Auto-recalled");
      });
      expect(recallCalls.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it("does NOT trigger recall for assistant messages", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["chat.message"] as (
        input: { sessionID?: string },
        output: { message?: { role?: string; id?: string }; parts?: unknown[] },
      ) => Promise<void>
    )(
      { sessionID: "s1" },
      {
        message: { role: "assistant", id: "a1" },
        parts: [{ type: "text", text: "I will help you with that" }],
      },
    );

    const recallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(recallCalls.length).toBe(0);
  });

  it("does NOT trigger recall when the message text is empty", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["chat.message"] as (
        input: { sessionID?: string },
        output: { message?: { role?: string; id?: string }; parts?: unknown[] },
      ) => Promise<void>
    )(
      { sessionID: "s1" },
      { message: { role: "user", id: "m1" }, parts: [] },
    );

    const recallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(recallCalls.length).toBe(0);
  });
});

/* --------------------------- deduplication --------------------------- */

describe("deduplication", () => {
  it("session.created injects a memory, then chat.message skips it", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    // Seed the plugin's own DB with a memory that matches both the session
    // query and a later user message.
    const dirKeyword = ctx.directory;
    const seedStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
      recallThreshold: 0.0,
    });
    await seedStore.init();
    await seedStore.store({
      content: `Project at ${dirKeyword} uses SQLite and REST conventions`,
      type: "codebase_fact",
      tags: ["seed"],
    });
    await seedStore.close();

    const hooks = await realmemoryPlugin(ctx);

    // 1. session.created recalls and injects the seed memory.
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    const firstRecallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(firstRecallCalls.length).toBe(1);

    // 2. chat.message with content that would match the same memory. Dedup
    //    should skip it (no new stage, no new recall log). The hook is
    //    fire-and-forget, so wait long enough for the detached recall to run.
    await (
      hooks["chat.message"] as (
        input: { sessionID?: string },
        output: { message?: { role?: string; id?: string }; parts?: unknown[] },
      ) => Promise<void>
    )(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [
          {
            type: "text",
            text: `Project at ${dirKeyword} SQLite REST conventions`,
          },
        ],
      },
    );
    await new Promise((r) => setTimeout(r, 200));

    // Still only 1 recall log — the second call was deduped.
    const allRecallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(allRecallCalls.length).toBe(1);

    // Delivering via system.transform after the deduped call injects nothing
    // new on top of the session-start block.
    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>
    )({}, { system });
    expect(system.length).toBe(2);
    expect(system[1]).toContain("## Relevant memories from previous sessions");

    const system2: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>
    )({}, { system: system2 });
    expect(system2.length).toBe(1);
  });
});

/* ---------------------- lazy store initialization ---------------------- */

describe("lazy initialization", () => {
  it("getStore lazily initializes the MemoryStore on first hook call", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    // Before any hook call, the DB file should not exist yet.
    expect(existsSync(dbPath)).toBe(false);

    const hooks = await realmemoryPlugin(ctx);

    // Still not initialized — just returning hooks doesn't init the store.
    expect(existsSync(dbPath)).toBe(false);

    // Triggering a hook initializes the store.
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });

    expect(existsSync(dbPath)).toBe(true);
  });

  it("reuses the same store instance across multiple hook calls", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);

    // Both hook calls resolve immediately (fire-and-forget); the detached
    // writes land after. Poll until both captures are present.
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/package.json" }, output: "contents" },
    );
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/tsconfig.json" }, output: "contents" },
    );

    // Both captures should land in the same DB.
    await waitForCaptured(dbPath, deriveProjectId(ctx.directory), "codebase_fact", 2);

    const verifyStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verifyStore.init();
    const list = await verifyStore.list({ scope: "all", limit: 50 });
    await verifyStore.close();

    const facts = list.memories.filter((m) => m.type === "codebase_fact");
    expect(facts.length).toBe(2);
  });
});

/* ------------------- extractUserText ------------------- */

describe("extractUserText", () => {
  it("joins text parts into a single string", () => {
    expect(
      extractUserText([
        { type: "text", text: "Remember" },
        { type: "text", text: "the deployment steps" },
      ]),
    ).toBe("Remember\nthe deployment steps");
  });

  it("ignores non-text parts, synthetic parts, and empty text", () => {
    expect(
      extractUserText([
        { type: "tool", text: "ignored" },
        { type: "text", text: "" },
        { type: "text", text: "real text", synthetic: true },
        { type: "text", text: "agent filler", ignored: true },
        { type: "text", text: "keep me" },
      ]),
    ).toBe("keep me");
  });

  it("returns empty string for no / non-array parts", () => {
    expect(extractUserText([])).toBe("");
    expect(extractUserText(undefined as unknown as unknown[])).toBe("");
    expect(extractUserText("nope" as unknown as unknown[])).toBe("");
  });
});

/* ------------------ system prompt injection (issue #4) ------------------ */

describe("system prompt injection", () => {
  it("delivers session.created recall results into output.system and clears them", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    // Seed a memory that keyword-matches the session query.
    const seedStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
      recallThreshold: 0.0,
    });
    await seedStore.init();
    await seedStore.store({
      content: `Project at ${ctx.directory} uses SQLite`,
      type: "codebase_fact",
      tags: ["seed"],
    });
    await seedStore.close();

    const hooks = await realmemoryPlugin(ctx);
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });

    // The recalled memory must appear in the built system prompt.
    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>
    )({}, { system });
    expect(system.length).toBe(2);
    expect(system[1]).toContain("## Relevant memories from previous sessions");
    expect(system[1]).toContain("uses SQLite");

    // The staged block is cleared after delivery — nothing is injected again.
    const system2: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>
    )({}, { system: system2 });
    expect(system2.length).toBe(1);
  });

  it("delivers chat.message recall results into output.system", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const seedStore = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
      recallThreshold: 0.0,
    });
    await seedStore.init();
    await seedStore.store({
      content: "The API uses REST conventions for all endpoints",
      type: "codebase_fact",
      tags: ["seed"],
    });
    await seedStore.close();

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["chat.message"] as (
        input: { sessionID?: string },
        output: { message?: { role?: string; id?: string }; parts?: unknown[] },
      ) => Promise<void>
    )(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "REST conventions for all endpoints" }],
      },
    );

    // Recall is detached — the stage is set right before the log call lands.
    await vi.waitFor(() => {
      const recallCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("Auto-recalled");
      });
      expect(recallCalls.length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (
        input: unknown,
        output: { system: string[] },
      ) => Promise<void>
    )({}, { system });
    expect(system.length).toBe(2);
    expect(system[1]).toContain("REST conventions");
  });
});

/* ------------------- non-blocking hooks (issue #9) ------------------- */

describe("non-blocking hooks", () => {
  it("tool.execute.after resolves well before the store write finishes", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);

    // Make the underlying store write take 250ms while the hook itself must
    // resolve in a tiny fraction of that (fire-and-forget).
    const slowWrite = vi
      .spyOn(MemoryStore.prototype, "store")
      .mockImplementation(async function slowStore(): Promise<Memory> {
        await new Promise((r) => setTimeout(r, 250));
        return makeMemory({ id: "slow-memory" });
      });

    try {
      const start = Date.now();
      await (
        hooks["tool.execute.after"] as (
          input: { tool: string },
          output: { args?: Record<string, unknown>; output?: unknown },
        ) => Promise<void>
      )(
        { tool: "read" },
        { args: { filePath: "/repo/package.json" }, output: "contents" },
      );
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(150);
    } finally {
      slowWrite.mockRestore();
    }
  });

  it("the message recall hook resolves well before the recall finishes", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);

    // Make the underlying recall take 250ms while the hook itself must resolve
    // in a tiny fraction of that.
    const slowRecall = vi
      .spyOn(MemoryStore.prototype, "recall")
      .mockImplementation(async function slowRecall(): Promise<RecallResult[]> {
        await new Promise((r) => setTimeout(r, 250));
        return [];
      });

    try {
      const start = Date.now();
      await (
        hooks["chat.message"] as (
          input: { sessionID?: string },
          output: { message?: { role?: string; id?: string }; parts?: unknown[] },
        ) => Promise<void>
      )(
        { sessionID: "s1" },
        { message: { role: "user", id: "m1" }, parts: [{ type: "text", text: "some query" }] },
      );
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(150);
    } finally {
      slowRecall.mockRestore();
    }
  });

  it("autoCapture:false is a true fast no-op — never initializes the DB", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ autoCapture: false, logSpy });

    const hooks = await realmemoryPlugin(ctx);

    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/package.json" }, output: "contents" },
    );

    // Give any accidental initialization time to surface — the store must
    // never have been created.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(dbPath)).toBe(false);
  });

  it("concurrent rapid tool calls don't throw or drop memories", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);

    // Fire 10 captures concurrently without awaiting each write.
    const calls: Array<Promise<void>> = [];
    for (let i = 0; i < 10; i++) {
      calls.push(
        (
          hooks["tool.execute.after"] as (
            input: { tool: string },
            output: { args?: Record<string, unknown>; output?: unknown },
          ) => Promise<void>
        )(
          { tool: "read" },
          { args: { filePath: `/repo/db/migration_${i}.sql` }, output: "contents" },
        ),
      );
    }
    await Promise.all(calls);

    // Distinct config files -> 10 distinct codebase_fact rows, none dropped.
    await waitForCaptured(
      dbPath,
      deriveProjectId(ctx.directory),
      "codebase_fact",
      10,
      5000,
    );
  });
});

/* ----------------------- error handling (graceful) ----------------------- */

describe("error handling", () => {
  it("hooks do not throw on errors (log instead of crashing)", async () => {
    // Use a bad storage path to trigger an error during init.
    const projectDir = join(tempDir, `badproj-${generateUlid()}`);
    mkdirSync(projectDir, { recursive: true });
    writeProjectConfig(projectDir, {
      embeddingModel: null,
      storagePath: "/nonexistent/path/that/does/not/exist/db.sqlite",
      autoCapture: true,
      recallThreshold: 0.0,
    });
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const ctx: OpenCodePluginContext = {
      project: {},
      client: { app: { log: logSpy } },
      $: {},
      directory: projectDir,
      worktree: projectDir,
    };

    const hooks = await realmemoryPlugin(ctx);

    // The event hook should catch the init error and log it, not throw.
    await expect(
      (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
        event: { type: "session.created" },
      }),
    ).resolves.toBeUndefined();

    const errorCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { level?: string } })?.body;
      return body?.level === "error";
    });
    expect(errorCalls.length).toBeGreaterThan(0);
  });
});
