import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, {
  isConfigOrSchemaFile,
  isErrorResult,
  formatRecallResults,
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
    expect(typeof hooks["message.updated"]).toBe("function");
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

/* ------------------------ message.updated auto-recall ----------------------- */

describe("message.updated hook", () => {
  it("triggers recall for human messages with matching content", async () => {
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
      hooks["message.updated"] as (
        input: { message?: { role?: string; content?: string } },
        output: unknown,
      ) => Promise<void>
    )(
      { message: { role: "human", content: "REST conventions for all endpoints" } },
      {},
    );

    const recallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(recallCalls.length).toBeGreaterThan(0);
  });

  it("does NOT trigger recall for assistant messages", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["message.updated"] as (
        input: { message?: { role?: string; content?: string } },
        output: unknown,
      ) => Promise<void>
    )(
      { message: { role: "assistant", content: "I will help you with that" } },
      {},
    );

    const recallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(recallCalls.length).toBe(0);
  });

  it("does NOT trigger recall when content is empty", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);
    await (
      hooks["message.updated"] as (
        input: { message?: { role?: string; content?: string } },
        output: unknown,
      ) => Promise<void>
    )({ message: { role: "human", content: "" } }, {});

    const recallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(recallCalls.length).toBe(0);
  });
});

/* --------------------------- deduplication --------------------------- */

describe("deduplication", () => {
  it("session.created injects a memory, then message.updated skips it", async () => {
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

    // 2. message.updated with content that would match the same memory.
    //    Dedup should skip it (no new recall log).
    await (
      hooks["message.updated"] as (
        input: { message?: { role?: string; content?: string } },
        output: unknown,
      ) => Promise<void>
    )(
      {
        message: {
          role: "human",
          content: `Project at ${dirKeyword} SQLite REST conventions`,
        },
      },
      {},
    );

    // Still only 1 recall log — the second call was deduped.
    const allRecallCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Auto-recalled");
    });
    expect(allRecallCalls.length).toBe(1);
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

    // First call inits the store.
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/package.json" }, output: "contents" },
    );

    // Second call should reuse the same store (no re-init, no error).
    await (
      hooks["tool.execute.after"] as (
        input: { tool: string },
        output: { args?: Record<string, unknown>; output?: unknown },
      ) => Promise<void>
    )(
      { tool: "read" },
      { args: { filePath: "/repo/tsconfig.json" }, output: "contents" },
    );

    // Both captures should be in the same DB.
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
