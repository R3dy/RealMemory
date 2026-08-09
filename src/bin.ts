#!/usr/bin/env node
import { startMcpServer } from "./mcp-server";
import { startBrowserServer } from "./browser/server";
import { loadConfig } from "./config";
import { MemoryStore } from "./store";

/**
 * Parse the --ui / --port flags from argv. Returns whether the browser UI mode
 * was requested and the resolved port. Unknown flags are ignored (the CLI has
 * no general-purpose arg parser — hand-rolled parsing adds zero deps, per
 * ADR-003's minimalism).
 */
function parseArgs(argv: string[]): { ui: boolean; port: number } {
  let ui = false;
  let port = 9333;
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
    }
  }
  return { ui, port };
}

export { parseArgs };

const { ui, port } = parseArgs(process.argv);

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
} else {
  // Default mode: the MCP stdio server (today's behaviour, byte-for-byte).
  startMcpServer().catch((err: unknown) => {
    console.error("[realmemory] MCP server failed to start:", err);
    process.exit(1);
  });
}
