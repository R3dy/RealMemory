import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `dedup-pass-${generateUlid()}.db`);
}

async function freshStore(): Promise<{ store: MemoryStore; dbPath: string }> {
  const dbPath = uniqueDbPath();
  const store = new MemoryStore({
    storagePath: dbPath,
    projectId: "test",
    embeddingModel: null,
    recallThreshold: 0.0,
  });
  await store.init();
  return { store, dbPath };
}

async function openRaw(path: string) {
  const { openDatabase } = await import("../src/db/dialect");
  return openDatabase(path);
}

/**
 * Insert a raw memory row (bypassing store()'s dedup-and-reinforce so tests can
 * build true duplicate rows with distinct IDs). Keeps the same column shape the
 * store INSERT uses.
 */
async function insertMemory(
  dbPath: string,
  opts: {
    id: string;
    content: string;
    type?: string;
    weight?: number;
    updatedAt?: string;
    status?: string;
  },
): Promise<void> {
  const raw = await openRaw(dbPath);
  try {
    raw
      .prepare(
        `INSERT INTO memories
          (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, project_id, domain, source, category)
         VALUES
          (?, ?, ?, 'project', '[]', ?, 0.5, ?, ?, 0, 0, '{}', ?, NULL, NULL, '{}', NULL)`,
      )
      .run(
        opts.id,
        opts.content,
        opts.type ?? "codebase_fact",
        opts.weight ?? 0.5,
        opts.updatedAt ?? new Date().toISOString(),
        opts.updatedAt ?? new Date().toISOString(),
        opts.status ?? "active",
      );
  } finally {
    raw.close();
  }
}

/** Count memories matching a status, through a raw connection. */
async function countByStatus(dbPath: string, status: string): Promise<number> {
  const raw = await openRaw(dbPath);
  try {
    const row = raw
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE status = ?")
      .get(status) as { c: number };
    return row.c;
  } finally {
    raw.close();
  }
}

/** Read a memory's status + reinforcement_count through a raw connection. */
async function readMemory(
  dbPath: string,
  id: string,
): Promise<{ status: string; reinforcement_count: number } | undefined> {
  const raw = await openRaw(dbPath);
  try {
    return raw
      .prepare(
        "SELECT status, reinforcement_count FROM memories WHERE id = ?",
      )
      .get(id) as { status: string; reinforcement_count: number } | undefined;
  } finally {
    raw.close();
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-dedup-pass-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MemoryStore.dedupPass", () => {
  it("merges a pair of near-duplicate active memories (reinforce higher, archive lower)", async () => {
    const { store, dbPath } = await freshStore();
    const content =
      "The staging deploy uses blue-green with a two-minute health-check drain window.";
    await insertMemory(dbPath, { id: "dup-a", content, weight: 0.9 });
    await insertMemory(dbPath, { id: "dup-b", content, weight: 0.3 });

    const merges = await store.dedupPass();

    expect(merges).toBe(1);
    // Higher-weight survivor stays active and got reinforced.
    expect(await readMemory(dbPath, "dup-a")).toMatchObject({
      status: "active",
      reinforcement_count: 1,
    });
    // Lower-weight duplicate is archived.
    expect(await readMemory(dbPath, "dup-b")).toMatchObject({
      status: "archived",
    });
    await store.close();
  });

  it("returns 0 and archives nothing when no duplicates exist", async () => {
    const { store, dbPath } = await freshStore();
    await store.store({
      content: "Tabs are the only acceptable indentation for Python.",
      type: "user_preference",
    });
    await store.store({
      content: "The metrics endpoint is GET-only on localhost.",
      type: "codebase_fact",
    });

    const merges = await store.dedupPass();

    expect(merges).toBe(0);
    expect(await countByStatus(dbPath, "archived")).toBe(0);
    expect(await countByStatus(dbPath, "active")).toBe(2);
    await store.close();
  });

  it("treats a substring-overlap long pair as near-duplicate", async () => {
    const { store, dbPath } = await freshStore();
    const base =
      "Deploy checklist: run migrations, wait for health check, then flip the load balancer.";
    await insertMemory(dbPath, {
      id: "sub-a",
      content: `${base} Never roll back before verifying the drain window.`,
      weight: 0.8,
    });
    await insertMemory(dbPath, { id: "sub-b", content: base, weight: 0.2 });

    const merges = await store.dedupPass();

    expect(merges).toBe(1);
    expect(await readMemory(dbPath, "sub-a")).toMatchObject({
      status: "active",
      reinforcement_count: 1,
    });
    expect(await readMemory(dbPath, "sub-b")).toMatchObject({
      status: "archived",
    });
    await store.close();
  });

  it("scans at most 1000 memories — duplicates in the oldest 500 are not merged", async () => {
    const { store, dbPath } = await freshStore();
    const count = 1500;
    const base = Date.UTC(2025, 0, 1, 0, 0, 0);
    const dupContentOld =
      "oldest duplicate pair that lives beyond the 1000-row scan window";

    const raw = await openRaw(dbPath);
    try {
      const stmt = raw.prepare(
        `INSERT INTO memories
          (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, project_id, domain, source, category)
         VALUES
          (?, ?, 'codebase_fact', 'project', '[]', 0.5, 0.5, ?, ?, 0, 0, '{}', 'active', NULL, NULL, '{}', NULL)`,
      );
      for (let i = 0; i < count; i++) {
        const ts = new Date(base + i * 1000).toISOString();
        const isOldDup = i === 0 || i === 1;
        const content = isOldDup
          ? dupContentOld
          : `unique memory number ${String(i).padStart(4, "0")} with fully distinct payload text`;
        stmt.run(`mem-${i}`, content, ts, ts);
      }
    } finally {
      raw.close();
    }

    // The two oldest rows (i=0, i=1) hold identical content but fall outside the
    // 1000 most-recently-touched scan window.
    const merges = await store.dedupPass();

    expect(merges).toBe(0);
    expect(await readMemory(dbPath, "mem-0")).toMatchObject({ status: "active" });
    expect(await readMemory(dbPath, "mem-1")).toMatchObject({ status: "active" });
    expect(await countByStatus(dbPath, "archived")).toBe(0);
    await store.close();
  });

  it("merges a duplicate pair inside the scanned 1000 rows", async () => {
    const { store, dbPath } = await freshStore();
    const count = 1500;
    const base = Date.UTC(2025, 1, 1, 0, 0, 0);
    const dupContentNew =
      "recent duplicate pair that sits inside the 1000-row scan window";

    const raw = await openRaw(dbPath);
    try {
      const stmt = raw.prepare(
        `INSERT INTO memories
          (id, content, type, scope, tags, weight, confidence, created_at, updated_at, access_count, reinforcement_count, metadata, status, project_id, domain, source, category)
         VALUES
          (?, ?, 'codebase_fact', 'project', '[]', 0.5, 0.5, ?, ?, 0, 0, '{}', 'active', NULL, NULL, '{}', NULL)`,
      );
      for (let i = 0; i < count; i++) {
        const ts = new Date(base + i * 1000).toISOString();
        const isNewDup = i === count - 2 || i === count - 1;
        const content = isNewDup
          ? dupContentNew
          : `unique memory number ${String(i).padStart(4, "0")} with fully distinct payload text`;
        stmt.run(`mem-${i}`, content, ts, ts);
      }
    } finally {
      raw.close();
    }

    const merges = await store.dedupPass();

    expect(merges).toBe(1);
    expect(await countByStatus(dbPath, "archived")).toBe(1);
    await store.close();
  });

  it("is fire-safe: a broken db returns 0 and never throws", async () => {
    const { store, dbPath } = await freshStore();
    await insertMemory(dbPath, { id: "a", content: "content one" });
    await insertMemory(dbPath, { id: "b", content: "content two" });

    // Replace the connection with one whose prepare() explodes. Keep a handle
    // on the real connection so close() can restore it after the test.
    const storeWithDb = store as unknown as { db: unknown };
    const realDb = storeWithDb.db;
    storeWithDb.db = {
      prepare: () => {
        throw new Error("disk on fire");
      },
    };

    try {
      await expect(store.dedupPass()).resolves.toBe(0);
    } finally {
      storeWithDb.db = realDb;
    }
    await store.close();
  });

  it("returns 0 when the store is not initialized (db is null)", async () => {
    const store = new MemoryStore({
      storagePath: uniqueDbPath(),
      projectId: "test",
      embeddingModel: null,
    });
    // No init() call — db is null.
    await expect(store.dedupPass()).resolves.toBe(0);
  });
});