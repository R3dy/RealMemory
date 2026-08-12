#!/usr/bin/env node
import {
  startBrowserServer,
  startMcpServer
} from "./chunk-UZMN3IDA.js";
import {
  MemoryStore,
  loadConfig
} from "./chunk-YZZXWFGR.js";

// src/bin.ts
function parseArgs(argv) {
  let ui2 = false;
  let port2 = 9333;
  let noBrowser2 = false;
  for (const a of argv.slice(2)) {
    if (a === "--ui") {
      ui2 = true;
    } else if (a.startsWith("--ui=")) {
      ui2 = true;
      const p = Number.parseInt(a.slice(5), 10);
      if (!Number.isNaN(p)) port2 = p;
    } else if (a.startsWith("--port=")) {
      const p = Number.parseInt(a.slice(7), 10);
      if (!Number.isNaN(p)) port2 = p;
    } else if (a === "--no-browser") {
      noBrowser2 = true;
    }
  }
  return { ui: ui2, port: port2, noBrowser: noBrowser2 };
}
var { ui, port, noBrowser } = parseArgs(process.argv);
if (ui) {
  const config = loadConfig();
  const store = new MemoryStore(config);
  store.init().then(() => startBrowserServer(store, { port })).catch((err) => {
    console.error("[realmemory] UI server failed to start:", err);
    process.exit(1);
  });
} else if (noBrowser) {
  startMcpServer(
    { ...loadConfig(), autoStartBrowser: false },
    { ownLifecycle: true }
  ).catch((err) => {
    console.error("[realmemory] MCP server failed to start:", err);
    process.exit(1);
  });
} else {
  startMcpServer(void 0, { ownLifecycle: true }).catch((err) => {
    console.error("[realmemory] MCP server failed to start:", err);
    process.exit(1);
  });
}
export {
  parseArgs
};
