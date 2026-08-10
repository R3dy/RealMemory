import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Run all tests on a single thread (the main process) instead of spawning
    // worker_threads. better-sqlite3 (a native module) is flaky in
    // worker_threads on Node 18/20 — "Worker exited unexpectedly" crashes that
    // were latent on CI (main never got past typecheck until this PR fixed the
    // build-before-typecheck ordering). singleThread is marginally slower but
    // robust for native modules across all Node versions, and the suite is
    // small (319 tests, ~18s). It also avoids port-9333 contention between
    // side-channel test files that bind the browser.
    poolOptions: { threads: { singleThread: true } },
  },
});
