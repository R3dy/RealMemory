import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `php-${generateUlid()}.db`);
}

function makeContext(opts?: { autoCapture?: boolean }): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      storagePath: dbPath,
      embeddingMode: "keyword",
      autoCapture: opts?.autoCapture ?? true,
    }),
  );
  return {
    ctx: { project: { path: projectDir }, client: {}, $: {}, directory: projectDir, worktree: projectDir },
    projectDir,
    dbPath,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "plugin-hp-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("plugin hook probe instrumentation", () => {
  it("each hook records hook_fired metric on fire", async () => {
    const { ctx, dbPath } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    // Fire session.created.
    await (hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>)({
      event: { type: "session.created", properties: { sessionID: "ses_test" } },
    });
    // Wait for detached recordHookFired.
    await new Promise((r) => setTimeout(r, 50));

    const store = new MemoryStore({ projectId: "test", storagePath: dbPath, embeddingMode: "keyword" } as Record<string, unknown>);
    await store.init();
    const row = await store.getLatestMetricRow("hook_fired:event:session.created");
    expect(row).not.toBeNull();
    expect(row?.metric_value).toBe(1);
    expect(row?.session_id).toBe("ses_test");
    await store.close();
  });

  it("hooks still return normally when store fails to init", async () => {
    // Point at a directory that doesn't exist so store init fails.
    const projectDir = join(tempDir, "broken");
    mkdirSync(projectDir, { recursive: true });
    const cfgDir = join(projectDir, ".realmemory");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({
        storagePath: "/nonexistent/path/that/does/not/exist/db.db",
        embeddingMode: "keyword",
      }),
    );
    const ctx: OpenCodePluginContext = {
      project: { path: projectDir },
      client: {},
      $: {},
      directory: projectDir,
      worktree: projectDir,
    };
    const hooks = await realmemoryPlugin(ctx);

    // These should NOT throw even though the store can't init.
    // The hooks return void (not a Promise), so we await them directly.
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });

    await (hooks["tool.execute.after"] as (
      input: { tool: string },
      output: { output?: unknown },
    ) => void)({ tool: "read" }, { output: "" });

    await (hooks["chat.message"] as (
      input: unknown,
      output: { message?: { role?: string }; parts?: unknown[] },
    ) => void)({}, { message: { role: "user" }, parts: [{ type: "text", text: "hi" }] });

    // If we get here without throwing, the test passes.
    expect(true).toBe(true);
  });

  it("sentinel appears in output.system after transform fires", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    // Fire session.created to reset probe.
    await (hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>)({
      event: { type: "session.created", properties: { sessionID: "ses_sentinel" } },
    });

    const system: string[] = ["You are an agent."];
    await (hooks["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>)({}, { system });

    // The sentinel should be in the system array.
    const sentinel = system.find((s) => s.includes("realmemory-probe:"));
    expect(sentinel).toBeDefined();
    expect(sentinel).toMatch(/^<!-- realmemory-probe:.* -->$/);
  });

  it("sentinel does NOT appear on the second transform fire in the same session", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>)({
      event: { type: "session.created", properties: { sessionID: "ses_once" } },
    });

    const system1: string[] = ["You are an agent."];
    await (hooks["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>)({}, { system: system1 });
    const sentinelCount1 = system1.filter((s) => s.includes("realmemory-probe:")).length;
    expect(sentinelCount1).toBe(1);

    // Second fire — should NOT push another sentinel.
    const system2: string[] = ["You are an agent."];
    await (hooks["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>)({}, { system: system2 });
    const sentinelCount2 = system2.filter((s) => s.includes("realmemory-probe:")).length;
    expect(sentinelCount2).toBe(0);
  });

  it("sentinel DOES appear on a transform fire with pendingInjection === null (zero-recall)", async () => {
    const { ctx } = makeContext();
    const hooks = await realmemoryPlugin(ctx);

    await (hooks.event as (arg: { event: { type: string; properties?: { sessionID?: string } } }) => Promise<void>)({
      event: { type: "session.created", properties: { sessionID: "ses_zero" } },
    });

    // No chat.message fired → pendingInjection is null.
    const system: string[] = ["You are an agent."];
    await (hooks["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system: string[] },
    ) => Promise<void>)({}, { system });

    // Sentinel should still be pushed.
    const sentinel = system.find((s) => s.includes("realmemory-probe:"));
    expect(sentinel).toBeDefined();
  });
});
