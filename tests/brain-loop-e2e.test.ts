import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { MemoryStore } from "../src/store";
import { deriveProjectId } from "../src/project-id";
import { generateUlid } from "../src/db/ulid";
import { createMcpTools } from "../src/mcp-server";
import { evaluateDelta, type BrainLoopState } from "../src/brain-loop";
import type { Relationship } from "../src/types";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `e2e-${generateUlid()}.db`);
}

function writeProjectConfig(projectDir: string, config: Record<string, unknown>): void {
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify(config));
}

/** Plugin context with keyword-only mode + a temp DB; brainLoop on. */
function makeContext(opts?: {
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
    brainLoop: true,
    autoRelate: true,
  };
  writeProjectConfig(projectDir, config);

  const logSpy = opts?.logSpy ?? vi.fn().mockResolvedValue(undefined);

  const ctx: OpenCodePluginContext = {
    project: { path: projectDir, name: "test-project" },
    client: { app: { log: logSpy } },
    $: {},
    directory: projectDir,
    worktree: projectDir,
  };
  return { ctx, projectDir, dbPath };
}

/** Open a MemoryStore on the same DB the plugin is using (read/assert side). */
async function openAssertStore(
  dbPath: string,
  projectId: string,
): Promise<MemoryStore> {
  const store = new MemoryStore({ storagePath: dbPath, projectId, embeddingModel: null });
  await store.init();
  return store;
}

/* Hook call-signatures (mirrors plugin.test.ts casting). */
type ChatMessageArgs = (
  input: { sessionID?: string },
  output: { message?: { role?: string; id?: string }; parts?: unknown[] },
) => Promise<void>;
type EventArgs = (arg: { event: { type: string } }) => Promise<void>;
type TransformArgs = (input: unknown, output: { system: string[] }) => Promise<void>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-e2e-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * End-to-end: pre-seeded preference -> correction turn -> session.idle
 * evaluateDelta stores a correction memory, maybeRelate creates a derived_from
 * edge to the preference, metrics are recorded, and get_metrics returns them —
 * both through the store and through the get_metrics MCP tool.
 */
describe("brain-loop E2E — correction turn through get_metrics", () => {
  it("stores the delta + derived_from edge + metrics, queryable via get_metrics", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });
    const projectId = deriveProjectId(ctx.directory);

    // 1. Pre-seed a user_preference memory via a standalone store on the same DB.
    const seed = await (async () => {
      const s = new MemoryStore({ storagePath: dbPath, projectId, embeddingModel: null });
      await s.init();
      try {
        return await s.store({
          content: "The team prefers Postgres over MySQL for production deployments.",
          type: "user_preference",
          tags: ["seed"],
        });
      } finally {
        await s.close();
      }
    })();

    // 2. Construct the plugin (fake OpenCode context) — lazy-opens the same DB.
    const hooks = await realmemoryPlugin(ctx);

    // Watch metric writes so we can wait for the detached evaluateDelta to finish.
    const metricSpy = vi.spyOn(MemoryStore.prototype, "recordMetric");

    // 3. Fire a correction turn (user branch stashes lastUserText + lastUserIntent).
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "no, use postgres not mysql" }],
      },
    );

    // 4. session.idle — PRIMARY trigger runs evaluateDelta (detached).
    await (hooks.event as EventArgs)({ event: { type: "session.idle" } });

    // 5. Wait until the correction metric is recorded: evaluateDelta stores the
    //    memory and runs maybeRelate BEFORE reaching the metrics step, so this
    //    also means the correction memory + derived_from edge are on disk.
    await vi.waitFor(
      () => expect(metricSpy).toHaveBeenCalledWith("correction_stored", 1.0),
      { timeout: 3000, interval: 20 },
    );
    metricSpy.mockRestore();

    // 6. Verify through a fresh store handle on the same DB.
    const assertStore = await openAssertStore(dbPath, projectId);
    try {
      // The correction memory exists.
      const correction = await vi.waitFor(async () => {
        const res = await assertStore.list({ scope: "all", type: "lesson_learned", limit: 20 });
        const hit = res.memories.find((m) =>
          m.content.includes("User corrected the agent: no, use postgres not mysql"),
        );
        expect(hit).toBeDefined();
        return hit!;
      }, { timeout: 3000, interval: 20 });

      expect(correction.type).toBe("lesson_learned");
      expect(correction.tags).toContain("correction");
      expect(correction.tags).toContain("auto-brain-loop");
      expect(correction.confidence).toBe(0.6);

      // A derived_from edge links the correction to the user_preference.
      const rels = await assertStore.getRelationshipsForNodes([correction.id]);
      const derived = rels.find(
        (r: Relationship) => r.type === "derived_from" && r.targetId === seed.id,
      );
      expect(derived).toBeDefined();
      expect(derived!.sourceId).toBe(correction.id);

      // Metrics were recorded — queryable through the store API.
      const allMetrics = await assertStore.getMetricSummary();
      const names = allMetrics.map((m) => m.metric_name);
      expect(names).toContain("correction_stored");

      // 7. The same summary is exposed through the get_metrics MCP tool.
      const tools = createMcpTools(assertStore);
      const metricsTool = tools.find((t) => t.name === "get_metrics");
      expect(metricsTool).toBeDefined();

      const full = (await metricsTool!.handler({})) as Array<{ metric_name: string; count: number }>;
      const correctionRow = full.find((r) => r.metric_name === "correction_stored");
      expect(correctionRow).toBeDefined();
      expect(correctionRow!.count).toBeGreaterThanOrEqual(1);

      const filtered = (await metricsTool!.handler({
        name: "correction_stored",
      })) as Array<{ metric_name: string }>;
      expect(filtered).toHaveLength(1);
      expect(filtered[0].metric_name).toBe("correction_stored");
    } finally {
      await assertStore.close();
    }
  });
});

/**
 * C2 fix E2E — a real delivery: chat.message recall stages the seed,
 * system.transform delivers it and stashes lastInjectedMemoryIds, then the
 * session.idle delta evaluation with assistant text references the delivered
 * memory — recall_hit is recorded, not recall_miss. The plugin's session.idle
 * hook always passes "" as assistant text, so the same evaluateDelta function
 * is driven directly with the assistant response text (mirroring what the LLM
 * reply would thread through).
 */
describe("brain-loop E2E — recall_hit on delivered memory (C2 fix)", () => {
  it("records recall_hit (not recall_miss) when the assistant references an injected memory", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });
    const projectId = deriveProjectId(ctx.directory);

    // Pre-seed a preference the next turn will recall + deliver.
    const seed = await (async () => {
      const s = new MemoryStore({ storagePath: dbPath, projectId, embeddingModel: null });
      await s.init();
      try {
        return await s.store({
          content: "The team prefers Postgres over MySQL for production deployments.",
          type: "user_preference",
          tags: ["seed"],
        });
      } finally {
        await s.close();
      }
    })();

    const hooks = await realmemoryPlugin(ctx);

    // 1. A user turn whose query recalls + stages the seed.
    await (hooks["chat.message"] as ChatMessageArgs)(
      { sessionID: "s1" },
      {
        message: { role: "user", id: "m1" },
        parts: [{ type: "text", text: "no, use postgres, check the config" }],
      },
    );

    // Wait for the detached recall to stage the injection (logged after staging).
    await vi.waitFor(
      () => {
        const autoRecall = logSpy.mock.calls.some((c) => {
          const body = (c[0] as { body?: { level?: string; message?: string } })?.body;
          return body?.level === "info" && body?.message?.includes("Auto-recalled");
        });
        expect(autoRecall).toBe(true);
      },
      { timeout: 3000, interval: 20 },
    );

    // 2. system.transform delivers the staged block and stashes the delivered IDs.
    const system: string[] = ["You are an agent."];
    await (hooks["experimental.chat.system.transform"] as TransformArgs)({}, { system });
    expect(system.length).toBe(2);
    expect(system[1]).toContain("## Relevant memories from previous sessions");

    // 3. The session.idle delta evaluation runs with assistant text referencing
    //    the delivered memory (the real plugin passes "" on idle; we drive the
    //    same function with the LLM's reply text to exercise the C2 branch).
    const assertStore = await openAssertStore(dbPath, projectId);
    try {
      const state: BrainLoopState = {
        lastUserText: "no, use postgres, check the config",
        lastUserIntent: "correction",
        lastToolCapture: null,
        // Exactly the IDs system.transform stashed for this turn.
        lastInjectedMemoryIds: [seed.id],
        config: { brainLoop: true, autoRelate: true },
      };
      await evaluateDelta(
        assertStore,
        state,
        "no, use postgres, check the config",
        "I will check the Postgres config now.",
      );

      // 4. recall_hit is recorded; recall_miss is not.
      const hit = await assertStore.getMetricSummary("recall_hit");
      expect(hit).toHaveLength(1);
      expect(hit[0].count).toBeGreaterThanOrEqual(1);
      expect(hit[0].latest).toBe(1.0);

      const miss = await assertStore.getMetricSummary("recall_miss");
      expect(miss).toHaveLength(0);
    } finally {
      await assertStore.close();
    }
  });
});