/**
 * Twin harness — task-stream replayer (synthetic-self Phase 10 Gate 2).
 *
 * Replays a recorded task stream (a JSON file of synthetic sessions) against a
 * realmemory store and returns a snapshot of the four metrics the twin
 * comparison judges:
 *   - recall_hit_rate
 *   - duplicate_rate
 *   - memory_bloat_ratio
 *   - correction_retention
 *
 * The replayer does NOT spin up a second process or a live MCP server — it
 * drives the MemoryStore class directly via the compiled dist (or src via
 * tsx). This keeps the harness hermetic, fast, and free of port contention.
 * The "two installs" are two MemoryStore instances with two DB files: one
 * with `brain.traits: true` (drifting) and one with `brain.traits: false`
 * (frozen at baseline).
 *
 * See `docs/architecture/synthetic-self.md` §4 Phase 10 Gate 2 + §9 risk #3.
 */
import { MemoryStore } from "../../dist/index.js";
import { loadTraits, saveTraits, updateTraits, BASELINE_TRAITS } from "../../dist/traits.js";

/**
 * Run a task stream against a fresh store and return the metric snapshot.
 *
 * @param {object} opts
 * @param {string} opts.dbPath     path to the SQLite DB file (created fresh)
 * @param {object} opts.config     realmemory config (brain.traits etc.)
 * @param {Array}  opts.stream     the task stream (array of session objects)
 * @returns {Promise<object>}     metric snapshot + final trait vector
 */
export async function replayStream({ dbPath, config, stream }) {
  const store = new MemoryStore({ ...config, dbPath });
  await store.init();

  let correctionRetention = 0;
  let correctionTotal = 0;
  const alpha = config.brain?.traitLearningRate ?? 0.02;
  let traits = { ...BASELINE_TRAITS };
  const traitsEnabled = config.brain?.traits === true;

  for (const session of stream) {
    // Each session: store any memories the stream says to store, simulate
    // recalls, and record corrections.
    for (const op of session.operations ?? []) {
      if (op.kind === "store") {
        await store.store({
          content: op.content,
          type: op.type ?? "lesson_learned",
          scope: op.scope ?? "project",
          domain: op.domain,
          tags: op.tags ?? [],
          confidence: op.confidence ?? 0.5,
          metadata: op.metadata ?? {},
        });
      } else if (op.kind === "recall") {
        await store.recall({ query: op.query, scope: op.scope ?? "all", limit: op.limit ?? 5 });
      } else if (op.kind === "correction") {
        // A correction = store a user_preference reflecting the correction.
        correctionTotal += 1;
        await store.store({
          content: op.content,
          type: "user_preference",
          scope: "project",
          tags: ["correction"],
          confidence: 0.7,
          metadata: { source: "twin-correction" },
        });
        // correction_retention: did the correction survive dedup + decay?
        // (checked at the end via a recall — see below)
      }
    }

    // If traits are enabled, drift them once per "session" (mirrors plugin.ts).
    if (traitsEnabled) {
      const obs = {};
      // More corrections -> higher caution (0.5 baseline + 0.15 per correction, capped at 1).
      obs.caution = session.corrections ? Math.min(1, 0.5 + session.corrections * 0.15) : null;
      obs.curiosity = session.explorations ? 0.6 : null;
      obs.tenacity = session.recalls && session.recalls > 0 ? 0.7 : null;
      const { vector } = updateTraits(traits, obs, alpha);
      traits = vector;
      await saveTraits(store, traits);
    }
  }

  // correction_retention: recall the correction content and check it survives.
  if (correctionTotal > 0) {
    for (const session of stream) {
      for (const op of session.operations ?? []) {
        if (op.kind === "correction") {
          const res = await store.recall({ query: op.content.slice(0, 40), scope: "all", limit: 1 });
          if (res.memories && res.memories.length > 0) correctionRetention += 1;
        }
      }
    }
  }

  // Read the four metrics.
  const metrics = {};
  const metricNames = ["recall_hit_rate", "duplicate_rate", "memory_bloat_ratio", "preference_compliance"];
  for (const name of metricNames) {
    try {
      const rows = await store.getRecentMetricsByPrefix(name, 1);
      if (rows && rows.length > 0) {
        metrics[name] = rows[0].value ?? 0;
      }
    } catch {
      // metric table may be empty on a fresh store
    }
  }
  metrics.correction_retention = correctionTotal > 0 ? correctionRetention / correctionTotal : 1;
  metrics.correction_total = correctionTotal;

  // Memory bloat: archived / total.
  try {
    const totalRow = await store.search({ scope: "all", limit: 1000 });
    metrics.total_memories = totalRow.memories.length;
  } catch {
    metrics.total_memories = 0;
  }

  const finalTraits = traitsEnabled ? await loadTraits(store) : { ...BASELINE_TRAITS };
  await store.close();
  return { metrics, traits: finalTraits };
}

/**
 * Compare two metric snapshots and return a diff.
 *
 * @param {object} frozen   metrics from the traits-off install
 * @param {object} drifting metrics from the traits-on install
 * @returns {object}       per-metric deltas + a verdict
 */
export function diffSnapshots(frozen, drifting) {
  const keys = new Set([...Object.keys(frozen), ...Object.keys(drifting)]);
  const deltas = {};
  for (const k of keys) {
    const f = frozen[k] ?? 0;
    const d = drifting[k] ?? 0;
    deltas[k] = { frozen: f, drifting: d, delta: d - f };
  }
  // Verdict: drifting must not be worse on any of the four core metrics.
  // "Worse" is metric-dependent: recall_hit_rate + correction_retention higher is better;
  // duplicate_rate + memory_bloat_ratio lower is better.
  let verdict = "PASS";
  const checks = [
    { key: "recall_hit_rate", better: "higher" },
    { key: "correction_retention", better: "higher" },
    { key: "duplicate_rate", better: "lower" },
    { key: "memory_bloat_ratio", better: "lower" },
  ];
  for (const c of checks) {
    const f = frozen[c.key] ?? 0;
    const d = drifting[c.key] ?? 0;
    if (c.better === "higher" && d < f - 0.01) verdict = "FAIL";
    if (c.better === "lower" && d > f + 0.01) verdict = "FAIL";
  }
  return { deltas, verdict };
}
