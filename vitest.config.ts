import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Use child-process forks (single fork, serial) instead of worker_threads.
    // better-sqlite3 (a native module) crashes vitest worker_threads on Node
    // 18/20 ("Worker exited unexpectedly" — 15 test files that load the store
    // all crash). This was latent on CI because main never got past the
    // typecheck step before this PR fixed build-before-typecheck ordering.
    // Forks run native modules in a child process, where they're stable across
    // all Node versions. singleFork serializes the suite (319 tests, ~18s) and
    // avoids port-9333 contention between side-channel test files that bind
    // the browser. Node 22 passes under worker_threads; this keeps it green
    // and fixes 18/20.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
