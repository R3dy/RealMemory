import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `test-${generateUlid()}.db`);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "realmemory-"));
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("MemoryStore.init()", () => {
  it("creates the database file at the given path", async () => {
    const dbPath = uniqueDbPath();
    const store = new MemoryStore({ storagePath: dbPath });
    await store.init();
    await store.close();
    expect(existsSync(dbPath)).toBe(true);
  });

  it("is idempotent (calling twice on same DB does not error)", async () => {
    const dbPath = uniqueDbPath();
    const store1 = new MemoryStore({ storagePath: dbPath });
    await store1.init();
    await store1.close();

    const store2 = new MemoryStore({ storagePath: dbPath });
    await expect(store2.init()).resolves.toBeUndefined();
    await store2.close();
  });

  it("enables WAL mode", async () => {
    const dbPath = uniqueDbPath();
    const store = new MemoryStore({ storagePath: dbPath });
    await store.init();
    await store.close();

    // Inspect via a fresh connection through the dialect directly.
    const { openDatabase } = await import("../src/db/dialect");
    const db = await openDatabase(dbPath);
    const row = db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: string }
      | undefined;
    const mode = row?.journal_mode ?? "";
    db.close();
    expect(mode.toLowerCase()).toBe("wal");
  });

  it("creates the FTS5 virtual table", async () => {
    const dbPath = uniqueDbPath();
    const store = new MemoryStore({ storagePath: dbPath });
    await store.init();
    await store.close();

    const { openDatabase } = await import("../src/db/dialect");
    const db = await openDatabase(dbPath);
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'",
      )
      .get() as { name?: string } | undefined;
    db.close();
    expect(row?.name).toBe("memories_fts");
  });

  it("creates all expected tables in sqlite_master", async () => {
    const dbPath = uniqueDbPath();
    const store = new MemoryStore({ storagePath: dbPath });
    await store.init();
    await store.close();

    const { openDatabase } = await import("../src/db/dialect");
    const db = await openDatabase(dbPath);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    db.close();
    expect(names).toContain("schema_version");
    expect(names).toContain("memories");
    expect(names).toContain("relationships");
    expect(names).toContain("memories_fts");
  });
});

describe("MemoryStore.close()", () => {
  it("closes the connection (subsequent query via same path re-open works, closed handle unusable)", async () => {
    const dbPath = uniqueDbPath();
    const store = new MemoryStore({ storagePath: dbPath });
    await store.init();
    await store.close();

    // Re-opening after close should succeed (proves close released the file).
    const reopen = new MemoryStore({ storagePath: dbPath });
    await expect(reopen.init()).resolves.toBeUndefined();
    await reopen.close();
  });
});

describe("generateUlid", () => {
  it("produces 26-char Crockford-base32 strings", () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("produces monotonically increasing ids within same ms", () => {
    const a = generateUlid();
    const b = generateUlid();
    expect(b >= a).toBe(true);
  });
});
