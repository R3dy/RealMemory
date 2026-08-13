/**
 * Hook probe — synthetic-brain Phase 0 diagnostics.
 *
 * Instruments every registered plugin hook to record a `hook_fired` metric,
 * pushes + verifies a landing sentinel for `experimental.chat.system.transform`,
 * and provides a `--doctor` report reconstructible entirely from store data.
 *
 * Design contract (see `docs/architecture/synthetic-brain.md` §5 row 0 + §6):
 *   - Phase 0 is a NO-OP until `--doctor` is invoked or `/api/metrics` is read.
 *   - No new hooks, no new config, no new deps, no schema migration.
 *   - Every probe export is fire-safe (never throws, never rejects — INV-017).
 *   - The four landing outcomes are persisted as metric rows so `--doctor` can
 *     reconstruct all states from the store alone (no process-memory dependence).
 */

import { generateUlid } from "./db/ulid";
import type { MemoryStore } from "./store";

// ---------------------------------------------------------------------------
// Hook classification (resolves 2-C2)
// ---------------------------------------------------------------------------

/**
 * Hooks that fire in every real session with ≥1 user turn. Zero fires +
 * evidence of sessions = DEGRADED (the issue-#28 silent-failure mode).
 */
export const ALWAYS_FIRE_HOOKS = [
  "event:session.created",
  "event:session.idle",
  "chat.message",
  "experimental.chat.system.transform",
] as const;

/**
 * Hooks that fire only on a host event / agent action that may not occur in a
 * healthy session. Zero fires = "no-evidence" (NOT degraded — no false positive).
 */
export const CONDITIONAL_HOOKS = [
  "tool.execute.after",
  "experimental.session.compacting",
] as const;

/** All probed hooks (single source of truth — 6 entries). */
export const PROBED_HOOKS = [...ALWAYS_FIRE_HOOKS, ...CONDITIONAL_HOOKS] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Numeric encoding of the four readback outcomes (resolves 2-C1). */
export type LandsValue = 1 | 0 | -1 | -2;
//  1   = found              (sentinel present in transcript → landed)
//  0   = observable-absent  (system content observable, sentinel absent → DEGRADED)
// -1   = unverifiable       (no system-role messages → host doesn't expose system content)
// -2   = fetch-failed       (transcript fetch returned null / too thin)

/** Stashed on plugin state. Reset on every session.created. */
export interface ProbeState {
  sessionId: string | null;
  hostVersion: string | null;
  sentinelToken: string | null;
  sentinelPushedAt: number | null;
  sentinelChecked: boolean;
  lastLandsValue: "found" | "observable-absent" | "unverifiable" | "fetch-failed" | null;
  /** true if any system-role message ever observed; false if a non-null transcript had none; null = no readback completed. */
  hostPersistsSystemContent: boolean | null;
}

/** OpenCode plugin context (minimal shape needed for host-version resolution). */
export interface ProbePluginContext {
  client?: { app?: { version?: string } | unknown } | unknown;
}

// ---------------------------------------------------------------------------
// Probe state lifecycle
// ---------------------------------------------------------------------------

export function createProbeState(): ProbeState {
  return {
    sessionId: null,
    hostVersion: null,
    sentinelToken: null,
    sentinelPushedAt: null,
    sentinelChecked: false,
    lastLandsValue: null,
    hostPersistsSystemContent: null,
  };
}

/**
 * Reset probe state for a new session. Called from session.created BEFORE any
 * config gate. Clears session-scoped fields; preserves process-lifetime fields
 * (hostVersion, hostPersistsSystemContent).
 */
export function resetProbeForSession(probe: ProbeState, sessionId: string): void {
  probe.sessionId = sessionId;
  probe.sentinelToken = null;
  probe.sentinelPushedAt = null;
  probe.sentinelChecked = false;
  probe.lastLandsValue = null;
  // hostVersion and hostPersistsSystemContent are preserved (process-lifetime).
}

/**
 * Resolve the OpenCode host version once. Lookup order:
 *   process.env.OPENCODE_VERSION → ctx.client.app.version → "unknown"
 */
export function resolveHostVersion(ctx?: ProbePluginContext): string {
  if (process.env.OPENCODE_VERSION) return process.env.OPENCODE_VERSION;
  const client = ctx?.client as { app?: { version?: string } } | undefined;
  if (client?.app?.version) return client.app.version;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Metric recording (fire-safe, detached — INV-017)
// ---------------------------------------------------------------------------

/**
 * Detached, non-blocking. Records `hook_fired:<hookName>` = 1 and the
 * `host_version:<v>` row on the first call this session. Threads
 * `probe.sessionId` through to recordMetric's optional sessionId arg so the
 * doctor `session:` header is populatable. Never throws, never awaits into the
 * caller.
 */
export function recordHookFired(
  getStore: () => Promise<MemoryStore>,
  probe: ProbeState,
  hookName: string,
): void {
  void (async () => {
    try {
      const store = await getStore();
      await store.recordMetric(`hook_fired:${hookName}`, 1, probe.sessionId ?? undefined);
      // Record host version once per session (first hook_fired call).
      if (probe.hostVersion && probe.sentinelToken === null && !probe.sentinelChecked) {
        // Sentinel token null + not checked = early in session; record version.
        // Use a guard so we don't record it multiple times — check if a row
        // already exists for this session+version is overkill; the metric is
        // idempotent (multiple rows with the same name are fine, the doctor
        // reads the latest by recorded_at).
        await store.recordMetric(
          `host_version:${probe.hostVersion}`,
          1,
          probe.sessionId ?? undefined,
        );
      }
    } catch {
      // Fire-safe — never throw out of the hook.
    }
  })().catch(() => {});
}

/**
 * Detached, non-blocking. Records a `hook_lands:experimental.chat.system.transform`
 * row with the given outcome value. Used by (a) the transform handler on
 * pushSentinel assertion failure (value=0) and (b) checkSentinelLanded for
 * every readback outcome.
 */
export function recordLandsOutcome(
  getStore: () => Promise<MemoryStore>,
  probe: ProbeState,
  value: LandsValue,
): void {
  void (async () => {
    try {
      const store = await getStore();
      await store.recordMetric(
        "hook_lands:experimental.chat.system.transform",
        value,
        probe.sessionId ?? undefined,
      );
    } catch {
      // Fire-safe.
    }
  })().catch(() => {});
}

// ---------------------------------------------------------------------------
// Sentinel push (pure, synchronous — resolves 2-C3)
// ---------------------------------------------------------------------------

/**
 * Called from inside experimental.chat.system.transform, ONCE per session
 * (guarded by probe.sentinelToken !== null). Pushes an HTML-comment sentinel
 * into output.system: `<!-- realmemory-probe:<ulid> -->`. Stashes the token.
 *
 * PURE synchronous state mutation (no store access, no IO). MUST be called
 * BEFORE the !pendingInjection early return.
 *
 * Returns { pushed, assertionOk }:
 *   pushed = true iff a sentinel was pushed THIS call (false on a second
 *            transform fire in the same session — once-per-session guard).
 *   assertionOk = true iff output.system.includes(token) held immediately
 *            after the push (proves the array contains the token at push time).
 */
export function pushSentinel(
  probe: ProbeState,
  output: { system?: string[] },
): { pushed: boolean; assertionOk: boolean } {
  // Once-per-session guard.
  if (probe.sentinelToken !== null) {
    return { pushed: false, assertionOk: true };
  }
  const token = `<!-- realmemory-probe:${generateUlid()} -->`;
  probe.sentinelToken = token;
  probe.sentinelPushedAt = Date.now();

  const sys = output?.system;
  if (!Array.isArray(sys)) {
    // Can't push — host handed us a non-array. Record as a negative signal
    // via the return value; the handler will call recordLandsOutcome.
    return { pushed: true, assertionOk: false };
  }
  sys.push(token);
  const assertionOk = sys.includes(token);
  return { pushed: true, assertionOk };
}

// ---------------------------------------------------------------------------
// Sentinel landing check (detached, session.idle)
// ---------------------------------------------------------------------------

/**
 * Extract role from a message object (defensive — handles various shapes).
 */
function extractRole(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "unknown";
  const m = msg as { role?: unknown };
  return typeof m.role === "string" ? m.role : "unknown";
}

/**
 * Called from session.idle (detached). Fetches the transcript via the provided
 * fetcher (the existing fetchSessionTranscript) and classifies the result, then
 * PERSISTS A ROW FOR EVERY OUTCOME (resolves 2-C1):
 *
 *   found              → hook_lands = 1  + host_capability = 1
 *   observable-absent  → hook_lands = 0  + host_capability = 1  (DEGRADED)
 *   unverifiable       → hook_lands = -1 + host_capability = 0
 *   fetch-failed       → hook_lands = -2 (no host_capability row)
 */
export async function checkSentinelLanded(
  store: MemoryStore,
  probe: ProbeState,
  fetchTranscript: () => Promise<string | null>,
): Promise<void> {
  const transcript = await fetchTranscript();

  if (transcript === null) {
    // Fetch failed / too thin.
    probe.lastLandsValue = "fetch-failed";
    probe.sentinelChecked = true;
    await store.recordMetric(
      "hook_lands:experimental.chat.system.transform",
      -2,
      probe.sessionId ?? undefined,
    );
    return;
  }

  // Check if the sentinel token is in the transcript text.
  if (probe.sentinelToken && transcript.includes(probe.sentinelToken)) {
    probe.lastLandsValue = "found";
    probe.sentinelChecked = true;
    probe.hostPersistsSystemContent = true;
    await store.recordMetric(
      "hook_lands:experimental.chat.system.transform",
      1,
      probe.sessionId ?? undefined,
    );
    await store.recordMetric(
      "host_capability:persists-system-content",
      1,
      probe.sessionId ?? undefined,
    );
    return;
  }

  // Sentinel not found. Determine if the host persists system content at all.
  // The transcript is a joined string of "role: content" lines. Check if any
  // "system:" role lines exist.
  const hasSystemRole = /^system:/m.test(transcript);

  if (hasSystemRole) {
    // System content is observable but sentinel absent → genuine degradation.
    probe.lastLandsValue = "observable-absent";
    probe.sentinelChecked = true;
    probe.hostPersistsSystemContent = true;
    await store.recordMetric(
      "hook_lands:experimental.chat.system.transform",
      0,
      probe.sessionId ?? undefined,
    );
    await store.recordMetric(
      "host_capability:persists-system-content",
      1,
      probe.sessionId ?? undefined,
    );
    return;
  }

  // No system-role messages → host doesn't expose system content → unverifiable.
  probe.lastLandsValue = "unverifiable";
  probe.sentinelChecked = true;
  if (probe.hostPersistsSystemContent === null) {
    probe.hostPersistsSystemContent = false;
  }
  await store.recordMetric(
    "hook_lands:experimental.chat.system.transform",
    -1,
    probe.sessionId ?? undefined,
  );
  await store.recordMetric(
    "host_capability:persists-system-content",
    0,
    probe.sessionId ?? undefined,
  );
}

// ---------------------------------------------------------------------------
// Doctor report (reconstructible from store data alone — resolves 2-C1 + 2-C4)
// ---------------------------------------------------------------------------

export interface DoctorRow {
  hook: string;
  conditional: boolean;
  fires: "yes" | "no" | "no-evidence";
  fireCount: number;
  lastSeen: string | null;
  lands: "yes" | "no" | "unverified" | "unverifiable" | "fetch-failed" | "na";
  hostVersion: string | null;
  degraded: boolean;
}

export interface DoctorReport {
  rows: DoctorRow[];
  degraded: boolean;
  inconclusive: boolean;
  fallbackNotice: string | null;
  unverifiableNotice: string | null;
  fetchFailedNotice: string | null;
}

/** Constant: the transform hook name. */
const TRANSFORM_HOOK = "experimental.chat.system.transform";

const FALLBACK_NOTICE = `DEGRADED: experimental.chat.system.transform fires and output.system is
observable in the transcript, but the sentinel did not land. The hook's
mutation is being dropped downstream.
Fallback delivery path:
  1. Ensure the realmemory MCP server is registered in your OpenCode config
     (it exposes the \`recall\` and \`store_memory\` tools — the agent can call
     them directly, bypassing the transform hook).
  2. Add this line to your project's AGENTS.md (or the mission-control
     MEMORY.md convention):

       At session start and before any non-trivial task, call the realmemory
       \`recall\` tool with the project path as the query, and act on the
       returned memories.

  3. Re-run \`realmemory-mcp --doctor\` after a host upgrade to re-check.`;

const UNVERIFIABLE_NOTICE = `UNVERIFIABLE: this host does not persist system-prompt content in the session
transcript (only user/assistant messages are stored — recorded as
host_capability:persists-system-content=0). The probe can prove the hook FIRED
and that output.system was MUTATED, but cannot prove the mutation reached the
LLM's context. To verify landing manually: trigger a realmemory recall, then
ask the agent whether it sees the recalled memory in its context. A Phase-1+
mechanism (sentinel-echo: instruct the model to echo the probe token in its
first reply) would make landing observable on this host.`;

const FETCH_FAILED_NOTICE = `FETCH-FAILED: the transform hook fired and a sentinel was pushed, but the
session.idle transcript fetch returned no data (the client was unavailable
or the transcript was too thin). Landing could not be evaluated. Re-run
\`realmemory-mcp --doctor\` after another session.`;

/**
 * Build the doctor report from store data alone. Uses getMetricSummary for fire
 * counts/last-seen and the additive getLatestMetricRow for lands value, session
 * header, and host version.
 */
export async function getDoctorReport(store: MemoryStore): Promise<DoctorReport> {
  const summary = await store.getMetricSummary();

  // Check for completely empty store (inconclusive) — only when BOTH metrics
  // table and memories table are empty. A store with memories but no metrics
  // is NOT inconclusive — it's the zero-fires degraded condition (sessions ran
  // but the probe was never installed).
  if (summary.length === 0) {
    const memCount = await store.count();
    if (memCount === 0) {
      const rows: DoctorRow[] = PROBED_HOOKS.map((hook) => ({
        hook,
        conditional: (CONDITIONAL_HOOKS as readonly string[]).includes(hook),
        fires: "no",
        fireCount: 0,
        lastSeen: null,
        lands: hook === TRANSFORM_HOOK ? "unverified" : "na",
        hostVersion: null,
        degraded: false,
      }));
      return {
        rows,
        degraded: false,
        inconclusive: true,
        fallbackNotice: null,
        unverifiableNotice: null,
        fetchFailedNotice: null,
      };
    }
  }

  // Build a lookup of fire counts by hook name.
  const fireCounts = new Map<string, { count: number; latestAt: string }>();
  for (const row of summary) {
    if (row.metric_name.startsWith("hook_fired:")) {
      fireCounts.set(row.metric_name, { count: row.count, latestAt: row.latest_at });
    }
  }

  // Read the latest hook_lands value (resolves 2-C1).
  const landsRow = await store.getLatestMetricRow("hook_lands:");
  let lands: DoctorRow["lands"] = "unverified";
  if (landsRow) {
    const v = landsRow.metric_value;
    if (v === 1) lands = "yes";
    else if (v === 0) lands = "no";
    else if (v === -1) lands = "unverifiable";
    else if (v === -2) lands = "fetch-failed";
  }

  // Read host version (resolves 2-C4).
  const versionRow = await store.getLatestMetricRow("host_version:");
  const hostVersion = versionRow
    ? versionRow.metric_name.replace("host_version:", "")
    : null;

  // Determine if there's evidence of real sessions (any metric/memory row).
  // We check if any hook_fired row exists for an always-fire hook.
  const hasAlwaysFireEvidence = ALWAYS_FIRE_HOOKS.some(
    (h) => (fireCounts.get(`hook_fired:${h}`)?.count ?? 0) > 0,
  );

  // Build rows.
  const rows: DoctorRow[] = PROBED_HOOKS.map((hook) => {
    const isConditional = (CONDITIONAL_HOOKS as readonly string[]).includes(hook);
    const fc = fireCounts.get(`hook_fired:${hook}`);
    const count = fc?.count ?? 0;
    const lastSeen = fc?.latestAt || null;

    let fires: DoctorRow["fires"];
    if (count > 0) {
      fires = "yes";
    } else if (isConditional) {
      fires = "no-evidence";
    } else {
      fires = "no";
    }

    const hookLands = hook === TRANSFORM_HOOK ? lands : "na";

    // Degraded is true only for the transform hook with lands === "no".
    const degraded = hook === TRANSFORM_HOOK && lands === "no";

    return {
      hook,
      conditional: isConditional,
      fires,
      fireCount: count,
      lastSeen,
      lands: hookLands,
      hostVersion,
      degraded,
    };
  });

  // Report-level degraded: transform lands === "no" OR an always-fire hook has
  // fires === "no" despite evidence of sessions (issue-#28 mode — resolves 2-C2).
  const transformDegraded = lands === "no";
  const alwaysFireSilent =
    !hasAlwaysFireEvidence &&
    summary.some(
      (r) =>
        !r.metric_name.startsWith("hook_fired:") &&
        !r.metric_name.startsWith("host_version:"),
    );
  // Actually: "evidence of real sessions" = any metric/memory row in the store.
  // If there are memory rows or non-hook metrics but no always-fire hook fires,
  // that's the #28 signature. Check if the store has ANY metric row that isn't
  // a hook_fired/host_version row (e.g., brain-loop metrics like
  // preference_compliance) — those indicate sessions ran.
  const sessionEvidenceMetrics = summary.filter(
    (r) =>
      !r.metric_name.startsWith("hook_fired:") &&
      !r.metric_name.startsWith("host_version:") &&
      !r.metric_name.startsWith("hook_lands:") &&
      !r.metric_name.startsWith("host_capability:"),
  );
  // Also check if there are memories in the store.
  const memCount = await store.count();
  const hasSessionEvidence = sessionEvidenceMetrics.length > 0 || memCount > 0;

  const silentAlwaysFire = ALWAYS_FIRE_HOOKS.some(
    (h) => (fireCounts.get(`hook_fired:${h}`)?.count ?? 0) === 0,
  );
  const zeroFiresDegraded = hasSessionEvidence && silentAlwaysFire;

  const degraded = transformDegraded || zeroFiresDegraded;

  return {
    rows,
    degraded,
    inconclusive: false,
    fallbackNotice: transformDegraded ? FALLBACK_NOTICE : null,
    unverifiableNotice: lands === "unverifiable" ? UNVERIFIABLE_NOTICE : null,
    fetchFailedNotice: lands === "fetch-failed" ? FETCH_FAILED_NOTICE : null,
  };
}

// ---------------------------------------------------------------------------
// Doctor table printer (CLI output)
// ---------------------------------------------------------------------------

/**
 * Print the doctor report to stdout as a fixed-width text table.
 * Used by the `--doctor` CLI subcommand.
 */
export async function printDoctorTable(
  store: MemoryStore,
  stdout: { write: (s: string) => void } = process.stdout,
): Promise<number> {
  const report = await getDoctorReport(store);

  // Headers.
  const versionRow = await store.getLatestMetricRow("host_version:");
  const hostVersion = versionRow
    ? versionRow.metric_name.replace("host_version:", "")
    : "unknown";
  const sessionRow = await store.getLatestMetricRow("hook_fired:");
  const sessionId = sessionRow?.session_id ?? "none";

  stdout.write("realmemory doctor — hook probe report\n");
  stdout.write(`host version: ${hostVersion}\n`);
  stdout.write(`session: ${sessionId}\n\n`);

  // Table header.
  stdout.write(
    "hook                                          fires        count   last-seen             lands\n",
  );

  for (const row of report.rows) {
    const hookPad = row.hook.padEnd(44);
    const firesStr = row.fires.padEnd(12);
    const countStr = String(row.fireCount).padEnd(7);
    const lastSeen = row.lastSeen ?? "—";
    const lastSeenPad = lastSeen.padEnd(21);
    const landsStr = row.lands;
    stdout.write(`${hookPad} ${firesStr} ${countStr} ${lastSeenPad} ${landsStr}\n`);
  }

  stdout.write("\n");

  // Verdict lines.
  if (report.inconclusive) {
    stdout.write(
      "NO DATA — no metric rows found. Run at least one real session with the\n",
    );
    stdout.write(
      "realmemory plugin loaded, then re-run `realmemory-mcp --doctor`.\n",
    );
    return 3;
  }

  if (report.fallbackNotice) {
    stdout.write(report.fallbackNotice + "\n");
  }
  if (report.unverifiableNotice) {
    stdout.write(report.unverifiableNotice + "\n");
  }
  if (report.fetchFailedNotice) {
    stdout.write(report.fetchFailedNotice + "\n");
  }

  // Check for zero-fires degraded (issue-#28 mode).
  if (report.degraded && !report.fallbackNotice) {
    // Zero-fires degraded — list all silent always-fire hooks in one message.
    const silentHooks = report.rows
      .filter((r) => r.fires === "no" && !r.conditional)
      .map((r) => r.hook);
    if (silentHooks.length > 0) {
      stdout.write(
        `\nDEGRADED: the following always-fire hooks registered 0 fires despite\n`,
      );
      stdout.write(
        `evidence of real sessions (${silentHooks.length} of ${ALWAYS_FIRE_HOOKS.length}):\n`,
      );
      for (const h of silentHooks) {
        stdout.write(`  - ${h}\n`);
      }
      stdout.write(
        "The host is silently discarding these hook keys — the issue-#28 failure mode.\n",
      );
      stdout.write(
        'Fallback delivery path: "these hooks are not firing — file an issue or\n',
      );
      stdout.write(
        're-run `realmemory-mcp --doctor` after a session with the instrumented plugin."\n',
      );
    }
  }

  if (report.degraded) return 2;
  return 0;
}
