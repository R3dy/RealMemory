import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/store";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { deriveProjectId } from "../src/project-id";
import type { MemoryType } from "../src/types";

let testCounter = 0;
function makeContext(dbPath: string, brainConfig?: Record<string, unknown>): {
  ctx: OpenCodePluginContext;
  projectDir: string;
} {
  const projectDir = join("/tmp", `test-rm-wm-${Date.now()}-${testCounter++}`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, ".realmemory"), { recursive: true });
  writeFileSync(
    join(projectDir, ".realmemory", "config.json"),
    JSON.stringify({
      embeddingModel: null,
      storagePath: dbPath,
      recallThreshold: 0.0,
      maxRecallResults: 10,
      ...(brainConfig ? { brain: brainConfig } : {}),
    }),
  );
  return {
    ctx: {
      project: { path: projectDir },
      client: { app: { log: async () => {} } },
      $: {},
      directory: projectDir,
      worktree: projectDir,
    },
    projectDir,
  };
}

async function seedMemory(dbPath: string, projectDir: string, content: string, type: MemoryType, scope?: string) {
  const store = new MemoryStore({
    storagePath: dbPath,
    projectId: deriveProjectId(projectDir),
    embeddingModel: null,
    recallThreshold: 0.0,
  } as never);
  await store.init();
  await store.store({ content, type, scope: (scope as "project" | "global") ?? "project" });
  await store.close();
}

describe("working-memory window integration (Phase 3)", () => {
  let dbPath: string;
  let projectDir: string;

  beforeEach(() => {
    dbPath = join("/tmp", `test-wm-${Date.now()}-${testCounter++}.db`);
  });

  afterEach(() => {
    if (projectDir && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    if (existsSync(dbPath)) rmSync(dbPath);
  });

  it("session.created → transform fires → window appears in output.system", async () => {
    const { ctx, projectDir: pd } = makeContext(dbPath);
    projectDir = pd;
    await seedMemory(dbPath, projectDir, "You prefer concise recommendations.", "user_preference", "global");
    await seedMemory(dbPath, projectDir, "AWS rejects non-ASCII in string params.", "lesson_learned");

    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await new Promise((r) => setTimeout(r, 200));

    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system });

    const windowEntry = system.find((s) => s.includes("## Working memory"));
    expect(windowEntry).toBeDefined();
  });

  it("chat.message → transform fires → window with task frame appears", async () => {
    const { ctx, projectDir: pd } = makeContext(dbPath);
    projectDir = pd;
    await seedMemory(dbPath, projectDir, "Test memory for task frame.", "codebase_fact");

    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await new Promise((r) => setTimeout(r, 200));

    await (
      hooks["chat.message"] as (
        i: { sessionID?: string },
        o: { message?: { role?: string }; parts?: unknown[] },
      ) => void
    )(
      { sessionID: "test" },
      { message: { role: "user" }, parts: [{ type: "text", text: "test memory" }] },
    );
    await new Promise((r) => setTimeout(r, 200));

    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system });

    const windowEntry = system.find((s) => s.includes("## Working memory"));
    expect(windowEntry).toBeDefined();
  });

  it("compaction clears injectedMemoryIds → memories re-injected on next turn", async () => {
    const { ctx, projectDir: pd } = makeContext(dbPath);
    projectDir = pd;
    await seedMemory(dbPath, projectDir, "Test memory for compaction re-injection.", "codebase_fact");

    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await new Promise((r) => setTimeout(r, 200));

    // First chat.message — stages taskFrame
    await (
      hooks["chat.message"] as (
        i: { sessionID?: string },
        o: { message?: { role?: string }; parts?: unknown[] },
      ) => void
    )(
      { sessionID: "test" },
      { message: { role: "user" }, parts: [{ type: "text", text: "test memory" }] },
    );
    await new Promise((r) => setTimeout(r, 200));

    // First transform — delivers window
    const system1: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system: system1 });
    expect(system1.find((s) => s.includes("## Working memory"))).toBeDefined();

    // Fire compaction — clears injectedMemoryIds + stale slots
    (hooks["experimental.session.compacting"] as () => void)();

    // Second chat.message — should re-query and re-stage (injectedMemoryIds cleared)
    await (
      hooks["chat.message"] as (
        i: { sessionID?: string },
        o: { message?: { role?: string }; parts?: unknown[] },
      ) => void
    )(
      { sessionID: "test" },
      { message: { role: "user" }, parts: [{ type: "text", text: "test memory" }] },
    );
    await new Promise((r) => setTimeout(r, 200));

    // Second transform — window should still be produced (memories re-injected)
    const system2: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system: system2 });

    expect(system2.find((s) => s.includes("## Working memory"))).toBeDefined();
  });

  it("brain.workingMemory === false → no window in output.system (C2 fix)", async () => {
    const { ctx, projectDir: pd } = makeContext(dbPath, { workingMemory: false });
    projectDir = pd;

    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await new Promise((r) => setTimeout(r, 200));

    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system });

    // No window should be produced (workingMemory disabled)
    expect(system.find((s) => s.includes("## Working memory"))).toBeUndefined();
  });

  it("no slots staged, no warn note → no window (null formatted)", async () => {
    const { ctx, projectDir: pd } = makeContext(dbPath);
    projectDir = pd;

    const hooks = await realmemoryPlugin(ctx);

    // Don't fire session.created or chat.message — no slots staged
    const system: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system });

    // No window (no slots staged, no warn note)
    expect(system.find((s) => s.includes("## Working memory"))).toBeUndefined();
  });

  it("window persists across transforms (rebuilt every turn)", async () => {
    const { ctx, projectDir: pd } = makeContext(dbPath);
    projectDir = pd;
    await seedMemory(dbPath, projectDir, "Test memory for persistence.", "codebase_fact");

    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await new Promise((r) => setTimeout(r, 200));

    await (
      hooks["chat.message"] as (
        i: { sessionID?: string },
        o: { message?: { role?: string }; parts?: unknown[] },
      ) => void
    )(
      { sessionID: "test" },
      { message: { role: "user" }, parts: [{ type: "text", text: "test memory" }] },
    );
    await new Promise((r) => setTimeout(r, 200));

    // First transform
    const system1: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system: system1 });
    expect(system1.find((s) => s.includes("## Working memory"))).toBeDefined();

    // Second transform — window should still be present (taskFrame persists)
    const system2: string[] = ["You are an agent."];
    await (
      hooks["experimental.chat.system.transform"] as (i: unknown, o: { system: string[] }) => void
    )({}, { system: system2 });
    expect(system2.find((s) => s.includes("## Working memory"))).toBeDefined();
  });
});
