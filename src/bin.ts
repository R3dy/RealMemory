#!/usr/bin/env node
import { startMcpServer } from "./mcp-server";
import { startBrowserServer } from "./browser/server";
import { loadConfig } from "./config";
import { MemoryStore } from "./store";

/**
 * Parse the --ui / --port / --no-browser flags from argv. Returns whether the
 * browser UI mode was requested, the resolved port, and whether the
 * side-channel auto-start is defeated. Unknown flags are ignored (the CLI has
 * no general-purpose arg parser — hand-rolled parsing adds zero deps, per
 * ADR-003's minimalism).
 *
 * --ui still wins over --no-browser: the combination starts the standalone
 * browser regardless (a nonsensical combo, tolerated without an error because
 * the CLI has no arg-validation surface).
 */
function parseArgs(argv: string[]): { ui: boolean; port: number; noBrowser: boolean } {
  let ui = false;
  let port = 9333;
  let noBrowser = false;
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
    }
  }
  return { ui, port, noBrowser };
}

export { parseArgs };

const { ui, port, noBrowser } = parseArgs(process.argv);

if (ui) {
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
