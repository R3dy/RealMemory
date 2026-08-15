import {
  generateUlid
} from "./chunk-AA3KVJ3T.js";

// src/hook-probe.ts
var ALWAYS_FIRE_HOOKS = [
  "event:session.created",
  "event:session.idle",
  "chat.message",
  "experimental.chat.system.transform",
  "chat.params"
];
var CONDITIONAL_HOOKS = [
  "tool.execute.after",
  "experimental.session.compacting",
  "tool.execute.before",
  "tool.definition"
];
var PROBED_HOOKS = [...ALWAYS_FIRE_HOOKS, ...CONDITIONAL_HOOKS];
function createProbeState() {
  return {
    sessionId: null,
    hostVersion: null,
    sentinelToken: null,
    sentinelPushedAt: null,
    sentinelChecked: false,
    lastLandsValue: null,
    hostPersistsSystemContent: null
  };
}
function resetProbeForSession(probe, sessionId) {
  probe.sessionId = sessionId;
  probe.sentinelToken = null;
  probe.sentinelPushedAt = null;
  probe.sentinelChecked = false;
  probe.lastLandsValue = null;
}
function resolveHostVersion(ctx) {
  if (process.env.OPENCODE_VERSION) return process.env.OPENCODE_VERSION;
  const client = ctx?.client;
  if (client?.app?.version) return client.app.version;
  return "unknown";
}
function recordHookFired(getStore, probe, hookName) {
  void (async () => {
    try {
      const store = await getStore();
      await store.recordMetric(`hook_fired:${hookName}`, 1, probe.sessionId ?? void 0);
      if (probe.hostVersion && probe.sentinelToken === null && !probe.sentinelChecked) {
        await store.recordMetric(
          `host_version:${probe.hostVersion}`,
          1,
          probe.sessionId ?? void 0
        );
      }
    } catch {
    }
  })().catch(() => {
  });
}
function recordLandsOutcome(getStore, probe, value) {
  void (async () => {
    try {
      const store = await getStore();
      await store.recordMetric(
        "hook_lands:experimental.chat.system.transform",
        value,
        probe.sessionId ?? void 0
      );
    } catch {
    }
  })().catch(() => {
  });
}
function pushSentinel(probe, output) {
  if (probe.sentinelToken !== null) {
    return { pushed: false, assertionOk: true };
  }
  const token = `<!-- realmemory-probe:${generateUlid()} -->`;
  probe.sentinelToken = token;
  probe.sentinelPushedAt = Date.now();
  const sys = output?.system;
  if (!Array.isArray(sys)) {
    return { pushed: true, assertionOk: false };
  }
  sys.push(token);
  const assertionOk = sys.includes(token);
  return { pushed: true, assertionOk };
}
async function checkSentinelLanded(store, probe, fetchTranscript) {
  const transcript = await fetchTranscript();
  if (transcript === null) {
    probe.lastLandsValue = "fetch-failed";
    probe.sentinelChecked = true;
    await store.recordMetric(
      "hook_lands:experimental.chat.system.transform",
      -2,
      probe.sessionId ?? void 0
    );
    return;
  }
  if (probe.sentinelToken && transcript.includes(probe.sentinelToken)) {
    probe.lastLandsValue = "found";
    probe.sentinelChecked = true;
    probe.hostPersistsSystemContent = true;
    await store.recordMetric(
      "hook_lands:experimental.chat.system.transform",
      1,
      probe.sessionId ?? void 0
    );
    await store.recordMetric(
      "host_capability:persists-system-content",
      1,
      probe.sessionId ?? void 0
    );
    return;
  }
  const hasSystemRole = /^system:/m.test(transcript);
  if (hasSystemRole) {
    probe.lastLandsValue = "observable-absent";
    probe.sentinelChecked = true;
    probe.hostPersistsSystemContent = true;
    await store.recordMetric(
      "hook_lands:experimental.chat.system.transform",
      0,
      probe.sessionId ?? void 0
    );
    await store.recordMetric(
      "host_capability:persists-system-content",
      1,
      probe.sessionId ?? void 0
    );
    return;
  }
  probe.lastLandsValue = "unverifiable";
  probe.sentinelChecked = true;
  if (probe.hostPersistsSystemContent === null) {
    probe.hostPersistsSystemContent = false;
  }
  await store.recordMetric(
    "hook_lands:experimental.chat.system.transform",
    -1,
    probe.sessionId ?? void 0
  );
  await store.recordMetric(
    "host_capability:persists-system-content",
    0,
    probe.sessionId ?? void 0
  );
}
var TRANSFORM_HOOK = "experimental.chat.system.transform";
var FALLBACK_NOTICE = `DEGRADED: experimental.chat.system.transform fires and output.system is
observable in the transcript, but the sentinel did not land. The hook's
mutation is being dropped downstream.
Fallback delivery path:
  1. Ensure the realmemory MCP server is registered in your OpenCode config
     (it exposes the \`recall\` and \`store_memory\` tools \u2014 the agent can call
     them directly, bypassing the transform hook).
  2. Add this line to your project's AGENTS.md (or the mission-control
     MEMORY.md convention):

       At session start and before any non-trivial task, call the realmemory
       \`recall\` tool with the project path as the query, and act on the
       returned memories.

  3. Re-run \`realmemory-mcp --doctor\` after a host upgrade to re-check.`;
var UNVERIFIABLE_NOTICE = `UNVERIFIABLE: this host does not persist system-prompt content in the session
transcript (only user/assistant messages are stored \u2014 recorded as
host_capability:persists-system-content=0). The probe can prove the hook FIRED
and that output.system was MUTATED, but cannot prove the mutation reached the
LLM's context. To verify landing manually: trigger a realmemory recall, then
ask the agent whether it sees the recalled memory in its context. A Phase-1+
mechanism (sentinel-echo: instruct the model to echo the probe token in its
first reply) would make landing observable on this host.`;
var FETCH_FAILED_NOTICE = `FETCH-FAILED: the transform hook fired and a sentinel was pushed, but the
session.idle transcript fetch returned no data (the client was unavailable
or the transcript was too thin). Landing could not be evaluated. Re-run
\`realmemory-mcp --doctor\` after another session.`;
async function getDoctorReport(store) {
  const summary = await store.getMetricSummary();
  if (summary.length === 0) {
    const memCount2 = await store.count();
    if (memCount2 === 0) {
      const rows2 = PROBED_HOOKS.map((hook) => ({
        hook,
        conditional: CONDITIONAL_HOOKS.includes(hook),
        fires: "no",
        fireCount: 0,
        lastSeen: null,
        lands: hook === TRANSFORM_HOOK ? "unverified" : "na",
        hostVersion: null,
        degraded: false
      }));
      return {
        rows: rows2,
        degraded: false,
        inconclusive: true,
        fallbackNotice: null,
        unverifiableNotice: null,
        fetchFailedNotice: null
      };
    }
  }
  const fireCounts = /* @__PURE__ */ new Map();
  for (const row of summary) {
    if (row.metric_name.startsWith("hook_fired:")) {
      fireCounts.set(row.metric_name, { count: row.count, latestAt: row.latest_at });
    }
  }
  const landsRow = await store.getLatestMetricRow("hook_lands:");
  let lands = "unverified";
  if (landsRow) {
    const v = landsRow.metric_value;
    if (v === 1) lands = "yes";
    else if (v === 0) lands = "no";
    else if (v === -1) lands = "unverifiable";
    else if (v === -2) lands = "fetch-failed";
  }
  const versionRow = await store.getLatestMetricRow("host_version:");
  const hostVersion = versionRow ? versionRow.metric_name.replace("host_version:", "") : null;
  const hasAlwaysFireEvidence = ALWAYS_FIRE_HOOKS.some(
    (h) => (fireCounts.get(`hook_fired:${h}`)?.count ?? 0) > 0
  );
  const rows = PROBED_HOOKS.map((hook) => {
    const isConditional = CONDITIONAL_HOOKS.includes(hook);
    const fc = fireCounts.get(`hook_fired:${hook}`);
    const count = fc?.count ?? 0;
    const lastSeen = fc?.latestAt || null;
    let fires;
    if (count > 0) {
      fires = "yes";
    } else if (isConditional) {
      fires = "no-evidence";
    } else {
      fires = "no";
    }
    const hookLands = hook === TRANSFORM_HOOK ? lands : "na";
    const degraded2 = hook === TRANSFORM_HOOK && lands === "no";
    return {
      hook,
      conditional: isConditional,
      fires,
      fireCount: count,
      lastSeen,
      lands: hookLands,
      hostVersion,
      degraded: degraded2
    };
  });
  const transformDegraded = lands === "no";
  const alwaysFireSilent = !hasAlwaysFireEvidence && summary.some(
    (r) => !r.metric_name.startsWith("hook_fired:") && !r.metric_name.startsWith("host_version:")
  );
  const sessionEvidenceMetrics = summary.filter(
    (r) => !r.metric_name.startsWith("hook_fired:") && !r.metric_name.startsWith("host_version:") && !r.metric_name.startsWith("hook_lands:") && !r.metric_name.startsWith("host_capability:")
  );
  const memCount = await store.count();
  const hasSessionEvidence = sessionEvidenceMetrics.length > 0 || memCount > 0;
  const silentAlwaysFire = ALWAYS_FIRE_HOOKS.some(
    (h) => (fireCounts.get(`hook_fired:${h}`)?.count ?? 0) === 0
  );
  const zeroFiresDegraded = hasSessionEvidence && silentAlwaysFire;
  const degraded = transformDegraded || zeroFiresDegraded;
  return {
    rows,
    degraded,
    inconclusive: false,
    fallbackNotice: transformDegraded ? FALLBACK_NOTICE : null,
    unverifiableNotice: lands === "unverifiable" ? UNVERIFIABLE_NOTICE : null,
    fetchFailedNotice: lands === "fetch-failed" ? FETCH_FAILED_NOTICE : null
  };
}
async function printDoctorTable(store, stdout = process.stdout) {
  const report = await getDoctorReport(store);
  const versionRow = await store.getLatestMetricRow("host_version:");
  const hostVersion = versionRow ? versionRow.metric_name.replace("host_version:", "") : "unknown";
  const sessionRow = await store.getLatestMetricRow("hook_fired:");
  const sessionId = sessionRow?.session_id ?? "none";
  stdout.write("realmemory doctor \u2014 hook probe report\n");
  stdout.write(`host version: ${hostVersion}
`);
  stdout.write(`session: ${sessionId}

`);
  stdout.write(
    "hook                                          fires        count   last-seen             lands\n"
  );
  for (const row of report.rows) {
    const hookPad = row.hook.padEnd(44);
    const firesStr = row.fires.padEnd(12);
    const countStr = String(row.fireCount).padEnd(7);
    const lastSeen = row.lastSeen ?? "\u2014";
    const lastSeenPad = lastSeen.padEnd(21);
    const landsStr = row.lands;
    stdout.write(`${hookPad} ${firesStr} ${countStr} ${lastSeenPad} ${landsStr}
`);
  }
  stdout.write("\n");
  if (report.inconclusive) {
    stdout.write(
      "NO DATA \u2014 no metric rows found. Run at least one real session with the\n"
    );
    stdout.write(
      "realmemory plugin loaded, then re-run `realmemory-mcp --doctor`.\n"
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
  if (report.degraded && !report.fallbackNotice) {
    const silentHooks = report.rows.filter((r) => r.fires === "no" && !r.conditional).map((r) => r.hook);
    if (silentHooks.length > 0) {
      stdout.write(
        `
DEGRADED: the following always-fire hooks registered 0 fires despite
`
      );
      stdout.write(
        `evidence of real sessions (${silentHooks.length} of ${ALWAYS_FIRE_HOOKS.length}):
`
      );
      for (const h of silentHooks) {
        stdout.write(`  - ${h}
`);
      }
      stdout.write(
        "The host is silently discarding these hook keys \u2014 the issue-#28 failure mode.\n"
      );
      stdout.write(
        'Fallback delivery path: "these hooks are not firing \u2014 file an issue or\n'
      );
      stdout.write(
        're-run `realmemory-mcp --doctor` after a session with the instrumented plugin."\n'
      );
    }
  }
  if (report.degraded) return 2;
  return 0;
}

export {
  createProbeState,
  resetProbeForSession,
  resolveHostVersion,
  recordHookFired,
  recordLandsOutcome,
  pushSentinel,
  checkSentinelLanded,
  printDoctorTable
};
