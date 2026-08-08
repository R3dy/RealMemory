/**
 * Runtime dialect detection and unified SQLite connection factory.
 *
 * - In Bun: uses the built-in `bun:sqlite` module.
 * - In Node.js: uses the `better-sqlite3` package.
 *
 * The import of the non-active driver is behind a conditional branch so that
 * the inactive module is never loaded (avoids `bun:sqlite` failing in Node).
 */

import type { DbConnection, Statement } from "./connection";

/* Minimal ambient declaration so the Bun global typechecks in Node-only
 * environments without installing @types/bun. The `bun:sqlite` module is
 * declared in src/db/bun-sqlite.d.ts. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  const Bun: unknown | undefined;
}

export async function openDatabase(path: string): Promise<DbConnection> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new (Database as any)(path);
    return wrapBunDb(db);
  }
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new (BetterSqlite3 as any)(path);
  return wrapBetterSqlite3(db);
}

/* ------------------------------ Bun wrapper ----------------------------- */

type AnyStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
};

type AnyDb = {
  prepare(sql: string): AnyStatement;
  exec(sql: string): void;
  close(): void;
};

function wrapBunStatement(stmt: AnyStatement): Statement {
  return {
    all(...params) {
      return stmt.all(...params) as Record<string, unknown>[];
    },
    get(...params) {
      return stmt.get(...params) as Record<string, unknown> | undefined;
    },
    run(...params) {
      return stmt.run(...params);
    },
  };
}

function wrapBunDb(db: AnyDb): DbConnection {
  return {
    prepare(sql) {
      return wrapBunStatement(db.prepare(sql));
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}

/* --------------------------- better-sqlite3 wrapper ---------------------- */

function wrapBetterSqlite3(db: AnyDb): DbConnection {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        all(...params) {
          return stmt.all(...params) as Record<string, unknown>[];
        },
        get(...params) {
          return stmt.get(...params) as Record<string, unknown> | undefined;
        },
        run(...params) {
          const res = stmt.run(...params);
          return {
            changes: res.changes,
            lastInsertRowid:
              typeof res.lastInsertRowid === "bigint"
                ? Number(res.lastInsertRowid)
                : res.lastInsertRowid,
          };
        },
      };
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}
