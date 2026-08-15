#!/usr/bin/env node
import {
  startBrowserServer,
  startMcpServer
} from "./chunk-OCQSRZG3.js";
import {
  printDoctorTable
} from "./chunk-5YZ4KHMI.js";
import {
  MemoryStore,
  loadConfig
} from "./chunk-AA3KVJ3T.js";

// src/bin.ts
function parseArgs(argv) {
  let ui2 = false;
  let port2 = 9333;
  let noBrowser2 = false;
  let doctor2 = false;
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
    } else if (a === "--doctor") {
      doctor2 = true;
    }
  }
  return { ui: ui2, port: port2, noBrowser: noBrowser2, doctor: doctor2 };
}
var { ui, port, noBrowser, doctor } = parseArgs(process.argv);
if (doctor) {
  let exitCode = 0;
  const config = loadConfig();
  const store = new MemoryStore(config);
  store.init().then(() => printDoctorTable(store)).then((code) => {
    exitCode = code;
    return store.close();
  }).then(() => {
    process.exit(exitCode);
  }).catch((err) => {
    console.error(
      `realmemory doctor: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
} else if (ui) {
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
