#!/usr/bin/env node
import {
  startBrowserServer,
  startMcpServer
} from "./chunk-CO75OJWS.js";
import {
  printDoctorTable
} from "./chunk-5CQTOMYQ.js";
import {
  MemoryStore,
  loadConfig
} from "./chunk-YHOE5GO2.js";
import {
  TRAITS_META_KEY,
  parseResetScope,
  resetTraits
} from "./chunk-5H4UUIRU.js";
import "./chunk-B5S5KXU7.js";

// src/bin.ts
function parseArgs(argv) {
  let ui2 = false;
  let port2 = 9333;
  let noBrowser2 = false;
  let doctor2 = false;
  let resetSelf2 = null;
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
  resetSelf2 = parseResetScope(argv);
  return { ui: ui2, port: port2, noBrowser: noBrowser2, doctor: doctor2, resetSelf: resetSelf2 };
}
var { ui, port, noBrowser, doctor, resetSelf } = parseArgs(process.argv);
if (resetSelf) {
  const config = loadConfig();
  const store = new MemoryStore(config);
  store.init().then(async () => {
    const scope = resetSelf;
    let report = [];
    if (scope === "traits" || scope === "all") {
      const before = await store.getMeta(TRAITS_META_KEY);
      const after = await resetTraits(store);
      report.push(
        `traits: reset to baseline ${JSON.stringify(after)}` + (before ? ` (was ${before})` : " (was baseline \u2014 no-op)")
      );
      try {
        await store.store({
          content: `I reset my trait vector to baseline (${scope}). ${before ? "Previous traits were drifted." : "No prior drift existed."}`,
          type: "self_model",
          scope: "project",
          confidence: 0.7,
          tags: ["self-episode", "reset-self", scope],
          metadata: {
            category: "commitment",
            scope,
            before: before ?? null,
            after,
            source: "reset-self"
          }
        });
      } catch {
      }
    }
    if (scope === "affect" || scope === "all") {
      try {
        await store.setMeta("affect:v1", "");
        report.push("affect: cleared (Phase 11 not yet shipped \u2014 no-op if empty)");
      } catch {
      }
    }
    if (scope === "identity" || scope === "all") {
      try {
        const archived = await store.archiveByType("self_model");
        report.push(
          `identity: archived ${archived} self_model memories`
        );
      } catch {
        report.push("identity: reset attempted (store method missing \u2014 non-fatal)");
      }
    }
    for (const line of report) {
      console.log(`[realmemory reset-self] ${line}`);
    }
    return store.close();
  }).then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(
      `realmemory reset-self: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
} else if (doctor) {
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
