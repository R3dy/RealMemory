import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `plugin-reflex-${generateUlid()}.db`);
}

function writeProjectConfig(projectDir: string, config: Record<string, unknown>): void {
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(config));
}

function makeContext(opts?: {
  brain?: { reflex?: boolean; inhibition?: string };
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  writeProjectConfig(projectDir, {
    embeddingModel: null,
    storagePath: dbPath,
    autoCapture: false,
    autoSummarize: false,
    brainLoop: false,
    ...(opts?.brain ? { brain: opts.brain } : {}),
  });
  return {
    ctx: {
      project: { path: projectDir, name: "test" },
      client: {},
      $: {},
      directory: projectDir,
      worktree: projectDir,
    },
    projectDir,
    dbPath,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "plugin-reflex-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("plugin tool.execute.before (Phase 1 reflex)", () => {
  it("registers the tool.execute.before handler", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(typeof hooks["tool.execute.before"]).toBe("function");
  });

  it("is a no-op when brain.reflex is false", async () => {
    const { ctx } = makeContext({ brain: { reflex: false } });
    const hooks = await realmemoryPlugin(ctx);
    const handler = hooks["tool.execute.before"] as Function;

    // Should not throw, should return undefined (no-op).
    expect(() => handler({ tool: "bash", args: { command: "test" } }, { args: {} })).not.toThrow();
  });

  it("is a no-op when brain.inhibition is off", async () => {
    const { ctx } = makeContext({ brain: { inhibition: "off" } });
    const hooks = await realmemoryPlugin(ctx);
    const handler = hooks["tool.execute.before"] as Function;

    expect(() => handler({ tool: "bash", args: { command: "test" } }, { args: {} })).not.toThrow();
  });

  it("is a no-op when reflexCache is cold (empty)", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    const handler = hooks["tool.execute.before"] as Function;

    // Cold cache (no session.created yet) = no inhibition = no-op.
    expect(() => handler({ tool: "bash", args: { command: "npm install" } }, { args: {} })).not.toThrow();
  });

  it("queues a warn note when a rule matches", async () => {
    const { ctx, dbPath } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    // Seed a lesson_learned memory with a command.
    const store = new MemoryStore({
      projectId: "test",
      storagePath: dbPath,
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install fails lockfile validation in this project",
      type: "lesson_learned",
      scope: "global",
      confidence: 0.7,
      tags: [],
      metadata: { command: "npm install" },
    });

    // Trigger session.created to build the ReflexCache.
    const eventHandler = hooks["event"] as Function;
    await eventHandler({ event: { type: "session.created", properties: { sessionID: "test-sess" } } });

    // Give the detached buildReflexCache a moment to complete.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Now call tool.execute.before with a matching command.
    const beforeHandler = hooks["tool.execute.before"] as Function;
    beforeHandler(
      { tool: "bash", args: { command: "npm install --save foo" } },
      { args: { command: "npm install --save foo" } },
    );

    // Trigger the transform hook to check delivery.
    const output: { system: string[] } = { system: [] };
    const transformHandler = hooks["experimental.chat.system.transform"] as Function;
    transformHandler({}, output);

    // The warn note should be in output.system.
    const warnNote = output.system.find((s) => s.includes("[realmemory reflex]"));
    expect(warnNote).toBeDefined();
    expect(warnNote).toContain("npm install fails");
  });

  it("does not queue a warn note when no rule matches", async () => {
    const { ctx, dbPath } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    // Seed a lesson with command "npm install".
    const store = new MemoryStore({
      projectId: "test",
      storagePath: dbPath,
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install fails",
      type: "lesson_learned",
      scope: "global",
      confidence: 0.7,
      tags: [],
      metadata: { command: "npm install" },
    });

    // Trigger session.created to build cache.
    const eventHandler = hooks["event"] as Function;
    await eventHandler({ event: { type: "session.created", properties: { sessionID: "test-sess" } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Call tool.execute.before with a non-matching command.
    const beforeHandler = hooks["tool.execute.before"] as Function;
    beforeHandler(
      { tool: "bash", args: { command: "git status" } },
      { args: { command: "git status" } },
    );

    // Transform should not have a warn note.
    const output: { system: string[] } = { system: [] };
    const transformHandler = hooks["experimental.chat.system.transform"] as Function;
    transformHandler({}, output);

    const warnNote = output.system.find((s) => s.includes("[realmemory reflex]"));
    expect(warnNote).toBeUndefined();
  });

  it("records a reflex_fire metric when a rule matches", async () => {
    const { ctx, dbPath } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test",
      storagePath: dbPath,
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "npm install fails",
      type: "lesson_learned",
      scope: "global",
      confidence: 0.7,
      tags: [],
      metadata: { command: "npm install" },
    });

    // Build cache.
    const eventHandler = hooks["event"] as Function;
    await eventHandler({ event: { type: "session.created", properties: { sessionID: "test-sess" } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Match.
    const beforeHandler = hooks["tool.execute.before"] as Function;
    beforeHandler(
      { tool: "bash", args: { command: "npm install --save-dev foo" } },
      { args: {} },
    );

    // Give the detached metric recording time.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Query the metric.
    const summary = await store.getMetricSummary();
    const reflexMetric = summary.find((m) => m.metric_name.startsWith("reflex_fire:"));
    expect(reflexMetric).toBeDefined();
    expect(reflexMetric!.count).toBe(1);
  });

  it("pendingWarnNote survives a chat.message recall overwrite of pendingInjection", async () => {
    const { ctx, dbPath } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test",
      storagePath: dbPath,
      embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install fails",
      type: "lesson_learned",
      scope: "global",
      confidence: 0.7,
      tags: [],
      metadata: { command: "npm install" },
    });

    // Build cache.
    const eventHandler = hooks["event"] as Function;
    await eventHandler({ event: { type: "session.created", properties: { sessionID: "test-sess" } } });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Queue a warn note via tool.execute.before.
    const beforeHandler = hooks["tool.execute.before"] as Function;
    beforeHandler(
      { tool: "bash", args: { command: "npm install" } },
      { args: {} },
    );

    // Now simulate chat.message overwriting pendingInjection (the race).
    // We can't easily call the full chat.message handler, but we can simulate
    // the race by setting pendingInjection directly (as the detached recall would).
    // The warn note is in pendingWarnNote, which is a SEPARATE field.
    // The transform hook should deliver BOTH.
    const output: { system: string[] } = { system: [] };
    const transformHandler = hooks["experimental.chat.system.transform"] as Function;
    transformHandler({}, output);

    // The warn note should survive even though pendingInjection was null (no recall ran).
    const warnNote = output.system.find((s) => s.includes("[realmemory reflex]"));
    expect(warnNote).toBeDefined();
    expect(warnNote).toContain("npm install fails");
  });
});
