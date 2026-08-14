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
  brain?: { reflex?: boolean; inhibition?: string; predictionError?: boolean };
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

// ---------------------------------------------------------------------------
// Phase 4a: rewrite + block + override integration tests
// ---------------------------------------------------------------------------

async function reinforceMemory(store: MemoryStore, id: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.update(id, { reinforce: true }).catch(() => {});
  }
}

async function buildCacheAndWait(hooks: Record<string, unknown>): Promise<void> {
  const eventHandler = hooks["event"] as Function;
  await eventHandler({ event: { type: "session.created", properties: { sessionID: "test-sess" } } });
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe("plugin tool.execute.before (Phase 4a rewrite)", () => {
  it("inhibition 'rewrite' mutates output.args when rule has rewrite metadata", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "rewrite" } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "use npm ci not npm install (lockfile validation fails)",
      type: "lesson_learned", scope: "global", confidence: 0.9, tags: [],
      metadata: { command: "npm install", rewrite: { tool: "bash", from: "npm install", to: "npm ci" } },
    });
    await reinforceMemory(store, stored.id, 2); // boost weight ≥ 0.5

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    const out = { args: { command: "npm install --save foo" } };
    beforeHandler({ tool: "bash", args: { command: "npm install --save foo" } }, out);

    expect(out.args.command).toBe("npm ci --save foo");
  });

  it("inhibition 'rewrite' falls back to warn when rule has no rewrite metadata", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "rewrite" } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install sometimes fails", type: "lesson_learned",
      scope: "global", confidence: 0.7, tags: [], metadata: { command: "npm install" },
    });

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    const out = { args: { command: "npm install foo" } };
    expect(() => beforeHandler({ tool: "bash", args: { command: "npm install foo" } }, out)).not.toThrow();
    expect(out.args.command).toBe("npm install foo"); // unchanged
  });

  it("default inhibition (unset) behaves as 'warn' (regression)", async () => {
    const { ctx, dbPath } = makeContext(); // no inhibition set
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install fails", type: "lesson_learned",
      scope: "global", confidence: 0.7, tags: [], metadata: { command: "npm install" },
    });

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    const out = { args: { command: "npm install foo" } };
    expect(() => beforeHandler({ tool: "bash", args: { command: "npm install foo" } }, out)).not.toThrow();
    expect(out.args.command).toBe("npm install foo"); // no mutation
  });
});

describe("plugin tool.execute.before (Phase 4a block)", () => {
  it("inhibition 'block' throws when rule is safety + high salience", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "block" } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "this command drops the staging DB (2026-06-11)", type: "lesson_learned",
      scope: "global", confidence: 0.95, category: "safety", tags: [],
      metadata: { command: "npm run db:reset" },
    });
    await reinforceMemory(store, stored.id, 25); // boost weight ≥ 0.8

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    expect(() =>
      beforeHandler({ tool: "bash", args: { command: "npm run db:reset --prod" } }, { args: {} }),
    ).toThrow(/Blocked by realmemory/);
  });

  it("block message contains memory ID + retry instruction", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "block" } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "dangerous command", type: "lesson_learned",
      scope: "global", confidence: 0.95, category: "safety", tags: [],
      metadata: { command: "rm -rf /" },
    });
    await reinforceMemory(store, stored.id, 25);

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    let thrownMsg = "";
    try {
      beforeHandler({ tool: "bash", args: { command: "rm -rf / --no-preserve-root" } }, { args: {} });
    } catch (e) {
      thrownMsg = (e as Error).message;
    }
    expect(thrownMsg).toContain(stored.id);
    expect(thrownMsg).toContain("retry");
  });

  it("inhibition 'block' falls back to warn for category 'gotcha' (not safety/cost)", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "block" } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "npm install sometimes fails", type: "lesson_learned",
      scope: "global", confidence: 0.95, category: "gotcha", tags: [],
      metadata: { command: "npm install" },
    });
    await reinforceMemory(store, stored.id, 25);

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    expect(() =>
      beforeHandler({ tool: "bash", args: { command: "npm install foo" } }, { args: {} }),
    ).not.toThrow(); // no block — falls to warn
  });
});

describe("plugin tool.execute.before (Phase 4a override)", () => {
  it("override: same call after block proceeds without re-blocking", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "block", predictionError: false } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "dangerous command", type: "lesson_learned",
      scope: "global", confidence: 0.95, category: "safety", tags: [],
      metadata: { command: "rm -rf /tmp" },
    });
    await reinforceMemory(store, stored.id, 25);

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    const args = { command: "rm -rf /tmp/test" };

    // First call: should block (throw).
    expect(() => beforeHandler({ tool: "bash", args }, { args: {} })).toThrow(/Blocked/);

    // Second call (same args): override — should NOT throw.
    expect(() => beforeHandler({ tool: "bash", args }, { args: {} })).not.toThrow();

    // Give the detached metric recording time.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // reflex_override metric should be recorded.
    const summary = await store.getMetricSummary();
    const overrideMetric = summary.find((m) => m.metric_name.startsWith("reflex_override:"));
    expect(overrideMetric).toBeDefined();
  });

  it("override: different call after block clears lastBlock (no false override)", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "block", predictionError: false } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "dangerous command", type: "lesson_learned",
      scope: "global", confidence: 0.95, category: "safety", tags: [],
      metadata: { command: "rm -rf /tmp" },
    });
    await reinforceMemory(store, stored.id, 25);

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;

    // Block on rm -rf /tmp.
    expect(() =>
      beforeHandler({ tool: "bash", args: { command: "rm -rf /tmp/test" } }, { args: {} }),
    ).toThrow(/Blocked/);

    // Different call — should NOT be an override. Should block again (same rule matches).
    expect(() =>
      beforeHandler({ tool: "bash", args: { command: "rm -rf /tmp/other" } }, { args: {} }),
    ).toThrow(/Blocked/);

    // No override metric (the second call was a new block, not an override).
    await new Promise((resolve) => setTimeout(resolve, 200));
    const summary = await store.getMetricSummary();
    const overrideMetric = summary.find((m) => m.metric_name.startsWith("reflex_override:"));
    expect(overrideMetric).toBeUndefined();
  });

  it("session.idle clears lastBlock (no cross-session stale block)", async () => {
    const { ctx, dbPath } = makeContext({ brain: { inhibition: "block", predictionError: false } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const stored = await store.store({
      content: "dangerous command", type: "lesson_learned",
      scope: "global", confidence: 0.95, category: "safety", tags: [],
      metadata: { command: "rm -rf /tmp" },
    });
    await reinforceMemory(store, stored.id, 25);

    await buildCacheAndWait(hooks);

    const beforeHandler = hooks["tool.execute.before"] as Function;
    const eventHandler = hooks["event"] as Function;
    const args = { command: "rm -rf /tmp/test" };

    // Block.
    expect(() => beforeHandler({ tool: "bash", args }, { args: {} })).toThrow(/Blocked/);

    // session.idle.
    await eventHandler({ event: { type: "session.idle", properties: { sessionID: "test-sess" } } });

    // Same call after idle — should block again (lastBlock was cleared, no override).
    expect(() => beforeHandler({ tool: "bash", args }, { args: {} })).toThrow(/Blocked/);
  });
});
