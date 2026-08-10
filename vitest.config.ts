import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Use child-process forks instead of worker_threads. better-sqlite3 (a
    // native module) is flaky in worker_threads on older Node (18/20) —
    // "Worker exited unexpectedly" crashes that were never caught before
    // because main CI never got past the (pre-fix) typecheck step. Forks are
    // marginally slower but robust for native modules across all Node versions.
    pool: "forks",
    // Single fork — the suite is small (319 tests, ~14s) and serial execution
    // avoids port-9333 contention between test files that bind the side channel.
    poolOptions: { forks: { singleFork: true } },
  },
});
