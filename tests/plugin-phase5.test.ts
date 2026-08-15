import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import {
  computeArousal,
  emptyArousalTracker,
  pushArousalSignal,
  matchTool,
  emptyReflexCache,
  addRule,
  AROUSAL_TEMP_DELTA,
  AROUSAL_THRESHOLD,
  type ArousalTracker,
} from "../src/reflex";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `plugin-phase5-${generateUlid()}.db`);
}

function writeProjectConfig(projectDir: string, config: Record<string, unknown>): void {
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(config));
}

function makeContext(opts?: {
  brain?: Record<string, unknown>;
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  writeProjectConfig(projectDir, {
    embeddingModel: null,
    storagePath: dbPath,
    autoCapture: false,
    autoSummarize: false,
    brainLoop: true,
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "plugin-phase5-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Phase 5: Arousal computation (pure functions)
// ---------------------------------------------------------------------------

describe("Phase 5: computeArousal", () => {
  it("returns 0 for empty tracker", () => {
    expect(computeArousal(emptyArousalTracker())).toBe(0);
  });

  it("returns 1.0 for 3 corrections in 5 turns", () => {
    const t = emptyArousalTracker();
    for (let i = 0; i < 3; i++) pushArousalSignal(t, { correction: true, block: false, highSurprise: false });
    expect(computeArousal(t)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.6 for 1 correction + 1 block", () => {
    const t = emptyArousalTracker();
    pushArousalSignal(t, { correction: true, block: false, highSurprise: false });
    pushArousalSignal(t, { correction: false, block: true, highSurprise: false });
    // (1.0 + 0.8) / 3 = 0.6
    expect(computeArousal(t)).toBeCloseTo(0.6, 5);
  });

  it("clamps at 1.0 (5 corrections would exceed)", () => {
    const t = emptyArousalTracker();
    for (let i = 0; i < 5; i++) pushArousalSignal(t, { correction: true, block: true, highSurprise: true });
    // 5 * (1.0 + 0.8 + 0.6) / 3 = 4.0, clamped to 1.0
    expect(computeArousal(t)).toBe(1);
  });

  it("ring buffer evicts oldest (5 max)", () => {
    const t = emptyArousalTracker();
    for (let i = 0; i < 6; i++) pushArousalSignal(t, { correction: false, block: false, highSurprise: false });
    expect(t.signals).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: matchTool (reflex.ts)
// ---------------------------------------------------------------------------

describe("Phase 5: matchTool", () => {
  it("returns null for empty cache", () => {
    expect(matchTool(emptyReflexCache(), "bash")).toBeNull();
  });

  it("returns null for null cache", () => {
    expect(matchTool(null, "bash")).toBeNull();
  });

  it("returns the top rule matching a tool", () => {
    const cache = emptyReflexCache();
    addRule(cache, {
      memoryId: "r1",
      match: (call) => call.tool === "bash",
      tool: "bash",
      note: "bash rule",
      salience: 0.9,
      confidence: 0.8,
    });
    addRule(cache, {
      memoryId: "r2",
      match: (call) => call.tool === "read",
      tool: "read",
      note: "read rule",
      salience: 0.7,
      confidence: 0.6,
    });
    const rule = matchTool(cache, "bash");
    expect(rule).not.toBeNull();
    expect(rule!.memoryId).toBe("r1");
  });

  it("returns null when no rule matches the tool", () => {
    const cache = emptyReflexCache();
    addRule(cache, {
      memoryId: "r1",
      match: (call) => call.tool === "bash",
      tool: "bash",
      note: "bash rule",
      salience: 0.9,
      confidence: 0.8,
    });
    expect(matchTool(cache, "write")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 5: chat.params handler (plugin integration)
// ---------------------------------------------------------------------------

describe("Phase 5: chat.params handler", () => {
  it("registers the chat.params handler", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    expect(hooks["chat.params"]).toBeDefined();
    expect(typeof hooks["chat.params"]).toBe("function");
  });

  it("default (arousalModulation off) — no temperature change (regression)", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    const handler = hooks["chat.params"] as Function;
    const out = { temperature: 0.7 };
    handler({}, out);
    expect(out.temperature).toBe(0.7);
  });

  it("arousalModulation: true + arousal 0.0 — no change (below threshold)", async () => {
    const { ctx } = makeContext({ brain: { arousalModulation: true } });
    const hooks = await realmemoryPlugin(ctx);
    const handler = hooks["chat.params"] as Function;
    const out = { temperature: 0.7 };
    handler({}, out);
    expect(out.temperature).toBe(0.7); // cold cache → arousal 0 → below threshold
  });

  it("arousalModulation: true + arousal 1.0 + temp 0.7 → temp lowered", async () => {
    const { ctx, dbPath } = makeContext({ brain: { arousalModulation: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "lesson", type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "test" },
    });

    await buildCacheAndWait(hooks);

    // Simulate 3 corrections to build arousal to 1.0.
    const eventHandler = hooks["event"] as Function;
    // Set lastUserIntent to "correction" before each session.idle.
    // We can't easily call chat.message, so we'll directly set the state via
    // the handler's closure... instead, test via 3 idle events with manual intent.
    // The tracker reads state.lastUserIntent — we need to set it via chat.message.
    const chatHandler = hooks["chat.message"] as Function;
    // Simulate 3 correction messages + idle events.
    for (let i = 0; i < 3; i++) {
      chatHandler(
        { sessionID: "test-sess" },
        { message: { role: "user" }, parts: [{ type: "text", text: "actually no, that's wrong" }] },
      );
      await eventHandler({ event: { type: "session.idle", properties: { sessionID: "test-sess" } } });
    }

    // Now arousal should be 1.0 (3 corrections / 3 = 1.0).
    const handler = hooks["chat.params"] as Function;
    const out = { temperature: 0.7 };
    handler({}, out);
    expect(out.temperature).toBeCloseTo(0.7 - AROUSAL_TEMP_DELTA, 5);
  });

  it("arousalModulation: true + temp undefined → no-op", async () => {
    const { ctx, dbPath } = makeContext({ brain: { arousalModulation: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "lesson", type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "test" },
    });
    await buildCacheAndWait(hooks);

    // Build arousal via corrections.
    const eventHandler = hooks["event"] as Function;
    const chatHandler = hooks["chat.message"] as Function;
    for (let i = 0; i < 3; i++) {
      chatHandler(
        { sessionID: "test-sess" },
        { message: { role: "user" }, parts: [{ type: "text", text: "actually no" }] },
      );
      await eventHandler({ event: { type: "session.idle", properties: { sessionID: "test-sess" } } });
    }

    const handler = hooks["chat.params"] as Function;
    const out: { temperature?: number } = {};
    handler({}, out);
    expect(out.temperature).toBeUndefined(); // no temperature set → no-op
  });

  it("never increases temperature above original", async () => {
    const { ctx, dbPath } = makeContext({ brain: { arousalModulation: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "lesson", type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "test" },
    });
    await buildCacheAndWait(hooks);

    // No arousal (fresh session, no corrections).
    const handler = hooks["chat.params"] as Function;
    const out = { temperature: 0.5 };
    handler({}, out);
    expect(out.temperature).toBe(0.5); // unchanged — arousal 0, below threshold
  });
});

// ---------------------------------------------------------------------------
// Phase 5: tool.definition handler (plugin integration)
// ---------------------------------------------------------------------------

describe("Phase 5: tool.definition handler", () => {
  it("registers the tool.definition handler", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    expect(hooks["tool.definition"]).toBeDefined();
    expect(typeof hooks["tool.definition"]).toBe("function");
  });

  it("default (toolDefinitionNotes off) — no description change (regression)", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);
    const handler = hooks["tool.definition"] as Function;
    const out = { description: "Execute a shell command" };
    handler({ toolID: "bash" }, out);
    expect(out.description).toBe("Execute a shell command");
  });

  it("toolDefinitionNotes: true + matching rule → note appended", async () => {
    const { ctx, dbPath } = makeContext({ brain: { toolDefinitionNotes: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install fails lockfile validation",
      type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "npm install" },
    });
    await buildCacheAndWait(hooks);

    const handler = hooks["tool.definition"] as Function;
    const out = { description: "Execute a shell command" };
    handler({ toolID: "bash" }, out);
    expect(out.description).toContain("Project note (realmemory)");
    expect(out.description).toContain("npm install fails");
  });

  it("toolDefinitionNotes: true + no matching rule → no change", async () => {
    const { ctx, dbPath } = makeContext({ brain: { toolDefinitionNotes: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "npm install fails",
      type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "npm install" },
    });
    await buildCacheAndWait(hooks);

    const handler = hooks["tool.definition"] as Function;
    const out = { description: "Write to a file" };
    handler({ toolID: "write" }, out);
    expect(out.description).toBe("Write to a file"); // no bash rule matches "write"
  });

  it("note truncated to 100 chars", async () => {
    const { ctx, dbPath } = makeContext({ brain: { toolDefinitionNotes: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    const longContent = "A".repeat(200) + " specific detail at the end";
    await store.store({
      content: longContent,
      type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "npm install" },
    });
    await buildCacheAndWait(hooks);

    const handler = hooks["tool.definition"] as Function;
    const out = { description: "Execute a shell command" };
    handler({ toolID: "bash" }, out);
    // The note part (after "Project note (realmemory): ") should be <= 100 chars.
    const noteMatch = out.description!.match(/Project note \(realmemory\): (.+?)\*\*/);
    expect(noteMatch).not.toBeNull();
    expect(noteMatch![1].length).toBeLessThanOrEqual(100);
  });

  it("no-op when description is not a string", async () => {
    const { ctx, dbPath } = makeContext({ brain: { toolDefinitionNotes: true } });
    const hooks = await realmemoryPlugin(ctx);

    const store = new MemoryStore({
      projectId: "test", storagePath: dbPath, embeddingMode: "keyword",
    } as Record<string, unknown>);
    await store.init();
    await store.store({
      content: "lesson", type: "lesson_learned", scope: "global",
      confidence: 0.9, tags: [], metadata: { command: "test" },
    });
    await buildCacheAndWait(hooks);

    const handler = hooks["tool.definition"] as Function;
    const out: { description?: string } = {};
    handler({ toolID: "bash" }, out);
    expect(out.description).toBeUndefined();
  });
});
