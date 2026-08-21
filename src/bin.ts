#!/usr/bin/env node
import { startMcpServer } from "./mcp-server";
import { startBrowserServer } from "./browser/server";
import { loadConfig } from "./config";
import { MemoryStore } from "./store";
import { printDoctorTable } from "./hook-probe";
import { parseResetScope, resetTraits, TRAITS_META_KEY } from "./traits";

/**
 * Parse the --ui / --port / --no-browser / --doctor / --reset-self flags from
 * argv. Returns whether the browser UI mode was requested, the resolved port,
 * whether the side-channel auto-start is defeated, whether the doctor
 * diagnostic mode was requested, and whether the --reset-self one-shot was
 * requested (and with which scope). Unknown flags are ignored (the CLI has no
 * general-purpose arg parser — hand-rolled parsing adds zero deps, per
 * ADR-003's minimalism).
 *
 * --ui still wins over --no-browser: the combination starts the standalone
 * browser regardless (a nonsensical combo, tolerated without an error because
 * the CLI has no arg-validation surface). --doctor and --reset-self are each
 * mutually exclusive with all other modes (one-shots that load the store,
 * act, and exit).
 */
function parseArgs(argv: string[]): {
  ui: boolean;
  port: number;
  noBrowser: boolean;
  doctor: boolean;
  resetSelf: ReturnType<typeof parseResetScope>;
} {
  let ui = false;
  let port = 9333;
  let noBrowser = false;
  let doctor = false;
  let resetSelf: ReturnType<typeof parseResetScope> = null;
  for (const a of argv.slice(2)) {
    if (a === "--ui") {
      ui = true;
    } else if (a.startsWith("--ui=")) {
      ui = true;
      const p = Number.parseInt(a.slice(5), 10);
      if (!Number.isNaN(p)) port = p;
    } else if (a.startsWith("--port=")) {
      const p = Number.parseInt(a.slice(7), 10);
      if (!Number.isNaN(p)) port = p;
    } else if (a === "--no-browser") {
      noBrowser = true;
    } else if (a === "--doctor") {
      doctor = true;
    }
  }
  // --reset-self is parsed separately (it understands scoped sub-flags).
  resetSelf = parseResetScope(argv);
  return { ui, port, noBrowser, doctor, resetSelf };
}

export { parseArgs };

const { ui, port, noBrowser, doctor, resetSelf } = parseArgs(process.argv);

// --reset-self: one-shot reset of synthetic-self state to baseline. Gate 1 of
// Phase 10 — lands BEFORE the drift rule. Mutually exclusive with all other
// modes. Restores the affected state and records the reset as a self_model
// row so the action is auditable.
if (resetSelf) {
  const config = loadConfig();
  const store = new MemoryStore(config);
  store
    .init()
    .then(async () => {
      const scope = resetSelf;
      let report: string[] = [];
      if (scope === "traits" || scope === "all") {
        const before = await store.getMeta(TRAITS_META_KEY);
        const after = await resetTraits(store);
        report.push(
          `traits: reset to baseline ${JSON.stringify(after)}` +
            (before ? ` (was ${before})` : " (was baseline — no-op)"),
        );
        // Record the reset as a self_model row (auditable).
        try {
          await store.store({
            content: `I reset my trait vector to baseline (${scope}). ${
              before ? "Previous traits were drifted." : "No prior drift existed."
            }`,
            type: "self_model",
            scope: "project",
            confidence: 0.7,
            tags: ["self-episode", "reset-self", scope],
            metadata: {
              category: "commitment",
              scope,
              before: before ?? null,
              after,
              source: "reset-self",
            } as Record<string, unknown>,
          });
        } catch {
          // Fire-safe — recording the reset must never block it.
        }
      }
      if (scope === "affect" || scope === "all") {
        // Phase 11 will own `affect:v1`. For now, clear the meta key if present
        // (forward-compatible no-op when the key does not exist).
        try {
          await store.setMeta("affect:v1", "");
          report.push("affect: cleared (Phase 11 not yet shipped — no-op if empty)");
        } catch {
          // Fire-safe.
        }
      }
      if (scope === "identity" || scope === "all") {
        // Identity reset = archive all self_model memories (Phase 9 rows).
        // This is the most invasive scope — the agent forgets its dispositions.
        try {
          const archived = await store.archiveByType("self_model");
          report.push(
            `identity: archived ${archived} self_model memories`,
          );
        } catch {
          report.push("identity: reset attempted (store method missing — non-fatal)");
        }
      }
      for (const line of report) {
        console.log(`[realmemory reset-self] ${line}`);
      }
      return store.close();
    })
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(
        `realmemory reset-self: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
} else if (doctor) {
  // --doctor: one-shot diagnostic. Mutually exclusive with all other modes.
  // Loads the store, prints the hook probe report, and exits per the
  // four-state matrix (0 healthy / 2 degraded / 3 inconclusive / 1 crashed).
  let exitCode = 0;
  const config = loadConfig();
  const store = new MemoryStore(config);
  store
    .init()
    .then(() => printDoctorTable(store))
    .then((code) => {
      exitCode = code;
      return store.close();
    })
    .then(() => {
      process.exit(exitCode);
    })
    .catch((err: unknown) => {
      console.error(
        `realmemory doctor: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
} else if (ui) {
  // Browser UI mode: start a localhost-only, read-only HTTP graph browser.
  // Mutually exclusive with the MCP stdio server (they contend for the process
  // lifecycle / stdio channel).
  const config = loadConfig();
  const store = new MemoryStore(config);
  store
    .init()
    .then(() => startBrowserServer(store, { port }))
    .catch((err: unknown) => {
      console.error("[realmemory] UI server failed to start:", err);
      process.exit(1);
    });
} else if (noBrowser) {
  // MCP stdio server with the side-channel browser defeated. The file-merge
  // happens HERE (in bin.ts), NOT inside startMcpServer: the explicit config
  // (`{ ...loadConfig(), autoStartBrowser: false }`) carries the user's
  // file-merged config plus the defeat flag, and startMcpServer's
  // `config ?? loadConfig()` uses it verbatim (no second file read).
  startMcpServer(
    { ...loadConfig(), autoStartBrowser: false },
    { ownLifecycle: true },
  ).catch((err: unknown) => {
    console.error("[realmemory] MCP server failed to start:", err);
    process.exit(1);
  });
} else {
  // Default mode: the MCP stdio server (which now also auto-starts the
  // read-only graph browser as a side channel at 127.0.0.1:9333 by default).
  // ownLifecycle: true — the CLI entry owns the process and installs the
  // SIGINT/SIGTERM shutdown handler that closes both servers + the store and
  // exits 0 (a library caller would pass false and manage cleanup itself).
  startMcpServer(undefined, { ownLifecycle: true }).catch((err: unknown) => {
    console.error("[realmemory] MCP server failed to start:", err);
    process.exit(1);
  });
}
