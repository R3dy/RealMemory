/**
 * Unified database connection interface — the common shape returned by
 * `openDatabase()` regardless of whether the underlying driver is `bun:sqlite`
 * or `better-sqlite3`.
 */

export interface Statement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
}

export interface DbConnection {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
