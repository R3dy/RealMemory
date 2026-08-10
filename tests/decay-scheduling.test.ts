import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { MemoryStore } from "../src/store";
import realmemoryPlugin, { type OpenCodePluginContext } from "../src/plugin";
import { deriveProjectId } from "../src/project-id";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `decay-${generateUlid()}.db`);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Read a memory row directly from the DB regardless of status. */
function readRow(
  store: MemoryStore,
  id: string,
): { weight: number; status: string; created_at: string } {
  const db = (
    store as unknown as {
      db: {
        prepare: (s: string) => {
          get: (...p: unknown[]) => Record<string, unknown> | undefined;
        };
      };
    }
  ).db;
  const row = db.prepare("SELECT weight, status, created_at FROM memories WHERE id = ?").get(id) as
    | { weight: number; status: string; created_at: string }
    | undefined;
  if (!row) throw new Error(`row not found: ${id}`);
  return row;
}

/** Force a memory's created_at back in time to simulate age (drives decay). */
function forceAge(store: MemoryStore, id: string, days: number): void {
  const db = (
    store as unknown as {
      db: { prepare: (s: string) => { run: (...p: unknown[]) => void } };
    }
  ).db;
  db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(daysAgoIso(days), id);
}

/** Build a plugin context pointing at a temp project dir with keyword-only mode. */
function makeContext(opts?: {
  logSpy?: ReturnType<typeof vi.fn>;
}): { ctx: OpenCodePluginContext; projectDir: string; dbPath: string } {
  const dbPath = uniqueDbPath();
  const projectDir = join(tempDir, `proj-${generateUlid()}`);
  mkdirSync(projectDir, { recursive: true });
  const cfgDir = join(projectDir, ".realmemory");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      embeddingModel: null,
      storagePath: dbPath,
      autoCapture: true,
      autoSummarize: false,
      recallThreshold: 0.0,
      maxRecallResults: 10,
    }),
  );
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-decay-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MemoryStore.maybeDecay rate-limiting", () => {
  it("runs decay exactly once when interval elapsed; maybeDecay returns true", async () => {
    const store = new MemoryStore({
      storagePath: uniqueDbPath(),
      embeddingModel: null,
    });
    await store.init();

    const mem = await store.store({
      content: "stale memory due for archival",
      type: "codebase_fact",
      confidence: 0.3,
    });
    forceAge(store, mem.id, 120);

    // First call: no meta row -> due -> runs decay, records timestamp, returns true.
    const ran1 = await store.maybeDecay("decay:lastRun", 24);
    expect(ran1).toBe(true);

    // Decay ran once: the stale memory is archived and the timestamp is durable.
    expect(readRow(store, mem.id).status).toBe("archived");
    expect(await store.getMeta("decay:lastRun")).not.toBeNull();

    // Second call within the interval: skipped.
    const ran2 = await store.maybeDecay("decay:lastRun", 24);
    expect(ran2).toBe(false);

    await store.close();
  });

  it("does not run decay within the interval; maybeDecay returns false", async () => {
    const store = new MemoryStore({
      storagePath: uniqueDbPath(),
      embeddingModel: null,
    });
    await store.init();

    const mem = await store.store({
      content: "stale memory",
      type: "codebase_fact",
      confidence: 0.3,
    });
    forceAge(store, mem.id, 120);

    // Pretend decay already ran "now" (within the 24h interval).
    await store.setMeta("decay:lastRun", new Date().toISOString());

    const ran = await store.maybeDecay("decay:lastRun", 24);
    expect(ran).toBe(false);

    // Decay did NOT run: the stale memory is still active (not archived).
    expect(readRow(store, mem.id).status).toBe("active");

    await store.close();
  });

  it("persists the last-run timestamp across restarts (second store skips)", async () => {
    const dbPath = uniqueDbPath();

    // First process lifetime: runs decay, records timestamp.
    const store1 = new MemoryStore({ storagePath: dbPath, embeddingModel: null });
    await store1.init();
    const ran1 = await store1.maybeDecay("decay:lastRun", 24);
    expect(ran1).toBe(true);
    await store1.close();

    // Second process lifetime against the same DB file: reads the same meta
    // row and skips decay because we're still within the interval.
    const store2 = new MemoryStore({ storagePath: dbPath, embeddingModel: null });
    await store2.init();
    const ran2 = await store2.maybeDecay("decay:lastRun", 24);
    expect(ran2).toBe(false);
    await store2.close();
  });
});

describe("decay archival effect", () => {
  it("archives a low-weight memory after decay and excludes it from list/search/recall", async () => {
    const store = new MemoryStore({
      storagePath: uniqueDbPath(),
      embeddingModel: null,
      recallThreshold: 0.0,
    });
    await store.init();

    const stale = await store.store({
      content: "old unused memory to archive",
      type: "codebase_fact",
      confidence: 0.3,
    });
    const keep = await store.store({
      content: "active fresh memory",
      type: "codebase_fact",
      confidence: 0.9,
    });
    forceAge(store, stale.id, 120);

    // Before decay both are present.
    const before = await store.list({ scope: "all", limit: 50 });
    expect(before.memories.some((m) => m.id === stale.id)).toBe(true);
    expect(before.memories.some((m) => m.id === keep.id)).toBe(true);

    // Trigger decay (rate-limited) — runs because no prior timestamp.
    const ran = await store.maybeDecay("decay:lastRun", 24);
    expect(ran).toBe(true);

    // Archived low-weight memory no longer appears anywhere.
    const list = await store.list({ scope: "all", limit: 50 });
    expect(list.memories.some((m) => m.id === stale.id)).toBe(false);
    expect(list.memories.some((m) => m.id === keep.id)).toBe(true);

    const search = await store.search({ scope: "all", limit: 50 });
    expect(search.memories.some((m) => m.id === stale.id)).toBe(false);
    expect(search.memories.some((m) => m.id === keep.id)).toBe(true);

    const recallRes = await store.recall({
      query: "old unused memory to archive",
      scope: "all",
      limit: 50,
      threshold: 0.0,
      traverse: false,
    });
    expect(recallRes.some((r) => r.memory.id === stale.id)).toBe(false);

    await store.close();
  });
});

describe("plugin decay scheduling on session.created", () => {
  it("logs a decay failure without throwing out of session.created", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    // Force the store's maybeDecay to reject so the fire-and-forget decay
    // block errors — session startup must not crash.
    const original = MemoryStore.prototype.maybeDecay;
    MemoryStore.prototype.maybeDecay = async () => {
      throw new Error("simulated decay failure");
    };
    try {
      const hooks = await realmemoryPlugin(ctx);
      await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
        event: { type: "session.created" },
      });

      // The detached promise's .catch() logs an error level entry.
      await vi.waitFor(() => {
        const errorCalls = logSpy.mock.calls.filter(
          (c) => (c[0] as { body?: { level?: string } })?.body?.level === "error",
        );
        expect(errorCalls.length).toBeGreaterThan(0);
      });
    } finally {
      MemoryStore.prototype.maybeDecay = original;
    }
  });

  it("completes decay (logs info) via session.created, then skips on a second session", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeContext({ logSpy });

    const hooks = await realmemoryPlugin(ctx);

    // First session.created: decay due -> runs -> logs info.
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await vi.waitFor(() => {
      const doneCalls = logSpy.mock.calls.filter((c) => {
        const body = (c[0] as { body?: { message?: string } })?.body;
        return body?.message?.includes("Memory decay completed");
      });
      expect(doneCalls.length).toBe(1);
    });

    // Second session.created within the interval: decay skipped -> no new
    // "completed" log.
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    await new Promise((r) => setTimeout(r, 20));
    const doneCalls = logSpy.mock.calls.filter((c) => {
      const body = (c[0] as { body?: { message?: string } })?.body;
      return body?.message?.includes("Memory decay completed");
    });
    expect(doneCalls.length).toBe(1);
  });

  it("uses project-derived store and remains compatible with lazy init", async () => {
    const logSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx, dbPath } = makeContext({ logSpy });
    expect(existsSync(dbPath)).toBe(false);

    const hooks = await realmemoryPlugin(ctx);
    await (hooks.event as (arg: { event: { type: string } }) => Promise<void>)({
      event: { type: "session.created" },
    });
    // The DB is created (store initialized) and the declay timestamp recorded.
    await vi.waitFor(() => expect(existsSync(dbPath)).toBe(true));

    const verify = new MemoryStore({
      storagePath: dbPath,
      projectId: deriveProjectId(ctx.directory),
      embeddingModel: null,
    });
    await verify.init();
    expect(await verify.getMeta("decay:lastRun")).not.toBeNull();
    await verify.close();
  });
});
