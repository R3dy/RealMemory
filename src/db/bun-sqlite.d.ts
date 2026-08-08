/**
 * Ambient declaration for Bun's built-in `bun:sqlite` module so the
 * codebase typechecks in Node-only environments (where the module does
 * not exist). The real module is only imported at runtime when Bun is
 * detected — this file makes the types available to the compiler.
 */

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    };
    exec(sql: string): void;
    close(): void;
  }
}
