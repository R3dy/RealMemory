#!/usr/bin/env node
/**
 * Twin harness orchestrator (synthetic-self Phase 10 Gate 2).
 *
 * Runs the same task stream against two stores — one with `brain.traits: true`
 * (drifting) and one with `brain.traits: false` (frozen at baseline) — and
 * prints the metric diff. The honest instrument for judging whether the trait
 * drift helps or hurts (§9 risk #3).
 *
 * Usage:
 *   node scripts/twin/run-twin.mjs [task-stream.json] [--out result.json]
 *
 * Defaults to scripts/twin/sample-stream.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { replayStream, diffSnapshots } from "./replay.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const rest = [];
  let out = null;
  for (const a of argv.slice(2)) {
    if (a === "--out") {
      out = "NEXT";
    } else if (out === "NEXT") {
      out = a;
    } else {
      rest.push(a);
    }
  }
  return { streamPath: rest[0], out };
}

const { streamPath, out } = parseArgs(process.argv);
const resolvedStream = streamPath ?? join(__dirname, "sample-stream.json");

if (!existsSync(resolvedStream)) {
  console.error(`twin: task stream not found: ${resolvedStream}`);
  process.exit(1);
}

const stream = JSON.parse(readFileSync(resolvedStream, "utf-8"));
const tmpDir = join(__dirname, ".tmp");
if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

const frozenDb = join(tmpDir, "frozen.db");
const driftingDb = join(tmpDir, "drifting.db");

// Clean any prior DBs.
for (const db of [frozenDb, driftingDb]) {
  try {
    // rmSync is Node 14.14+. Use unlinkSync with a guard.
    const fs = await import("node:fs");
    fs.unlinkSync(db);
  } catch {
    // ignore (file may not exist)
  }
}

console.log(`[twin] replaying ${stream.length} sessions against frozen + drifting installs...`);

const [frozen, drifting] = await Promise.all([
  replayStream({
    dbPath: frozenDb,
    config: { brain: { traits: false } },
    stream,
  }),
  replayStream({
    dbPath: driftingDb,
    config: { brain: { traits: true, traitLearningRate: 0.02 } },
    stream,
  }),
]);

const diff = diffSnapshots(frozen.metrics, drifting.metrics);

const result = {
  streamPath: resolvedStream,
  sessionCount: stream.length,
  frozen: { metrics: frozen.metrics, traits: frozen.traits },
  drifting: { metrics: drifting.metrics, traits: drifting.traits },
  diff,
  timestamp: new Date().toISOString(),
};

const report = [
  `[twin] verdict: ${diff.verdict}`,
  ``,
  `frozen traits:   ${JSON.stringify(frozen.traits)}`,
  `drifting traits: ${JSON.stringify(drifting.traits)}`,
  ``,
  `metric deltas (drifting - frozen):`,
  ...Object.entries(diff.deltas).map(
    ([k, v]) => `  ${k.padEnd(24)} frozen=${v.frozen}  drifting=${v.drifting}  delta=${v.delta >= 0 ? "+" : ""}${v.delta}`,
  ),
].join("\n");
console.log(report);

if (out) {
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(`[twin] wrote ${out}`);
}

// Cleanup tmp DBs (leave on failure for inspection).
if (diff.verdict === "PASS") {
  for (const db of [frozenDb, driftingDb]) {
    try {
      const fs = await import("node:fs");
      fs.unlinkSync(db);
    } catch {
      // ignore
    }
  }
}
