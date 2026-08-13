import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { MemoryStore } from "../src/store";
import { generateUlid } from "../src/db/ulid";
import {
  ALWAYS_FIRE_HOOKS,
  CONDITIONAL_HOOKS,
  PROBED_HOOKS,
  createProbeState,
  resetProbeForSession,
  resolveHostVersion,
  recordHookFired,
  recordLandsOutcome,
  pushSentinel,
  checkSentinelLanded,
  getDoctorReport,
  printDoctorTable,
  type ProbeState,
  type LandsValue,
} from "../src/hook-probe";

let tempDir: string;

function uniqueDbPath(): string {
  return join(tempDir, `hp-${generateUlid()}.db`);
}

function makeStore(): { store: MemoryStore; dbPath: string } {
  const dbPath = uniqueDbPath();
  const store = new MemoryStore({
    projectId: "test",
    storagePath: dbPath,
    embeddingMode: "keyword",
  } as Record<string, unknown>);
  return { store, dbPath };
}

async function initStore(): Promise<{ store: MemoryStore; dbPath: string }> {
  const { store, dbPath } = makeStore();
  await store.init();
  return { store, dbPath };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "hook-probe-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("hook-probe constants", () => {
  it("ALWAYS_FIRE_HOOKS has 4 entries", () => {
    expect(ALWAYS_FIRE_HOOKS).toHaveLength(4);
    expect([...ALWAYS_FIRE_HOOKS]).toContain("experimental.chat.system.transform");
  });

  it("CONDITIONAL_HOOKS has 2 entries", () => {
    expect(CONDITIONAL_HOOKS).toHaveLength(2);
    expect([...CONDITIONAL_HOOKS]).toContain("tool.execute.after");
    expect([...CONDITIONAL_HOOKS]).toContain("experimental.session.compacting");
  });

  it("PROBED_HOOKS is the concatenation (6 entries)", () => {
    expect(PROBED_HOOKS).toHaveLength(6);
  });
});

describe("createProbeState", () => {
  it("returns a fresh state with all fields null/false", () => {
    const probe = createProbeState();
    expect(probe.sessionId).toBeNull();
    expect(probe.hostVersion).toBeNull();
    expect(probe.sentinelToken).toBeNull();
    expect(probe.sentinelPushedAt).toBeNull();
    expect(probe.sentinelChecked).toBe(false);
    expect(probe.lastLandsValue).toBeNull();
    expect(probe.hostPersistsSystemContent).toBeNull();
  });
});

describe("resetProbeForSession", () => {
  it("clears session-scoped fields and preserves process-lifetime fields", () => {
    const probe = createProbeState();
    probe.hostVersion = "1.18.17";
    probe.hostPersistsSystemContent = true;
    probe.sentinelToken = "<!-- old token -->";
    probe.sentinelPushedAt = 12345;
    probe.sentinelChecked = true;
    probe.lastLandsValue = "found";

    resetProbeForSession(probe, "ses_123");

    expect(probe.sessionId).toBe("ses_123");
    expect(probe.sentinelToken).toBeNull();
    expect(probe.sentinelPushedAt).toBeNull();
    expect(probe.sentinelChecked).toBe(false);
    expect(probe.lastLandsValue).toBeNull();
    // Process-lifetime fields preserved.
    expect(probe.hostVersion).toBe("1.18.17");
    expect(probe.hostPersistsSystemContent).toBe(true);
  });
});

describe("resolveHostVersion", () => {
  it("reads from process.env.OPENCODE_VERSION first", () => {
    const old = process.env.OPENCODE_VERSION;
    process.env.OPENCODE_VERSION = "1.2.3";
    expect(resolveHostVersion()).toBe("1.2.3");
    if (old === undefined) delete process.env.OPENCODE_VERSION;
    else process.env.OPENCODE_VERSION = old;
  });

  it("falls back to ctx.client.app.version", () => {
    const old = process.env.OPENCODE_VERSION;
    delete process.env.OPENCODE_VERSION;
    expect(resolveHostVersion({ client: { app: { version: "2.0.0" } } })).toBe("2.0.0");
    if (old !== undefined) process.env.OPENCODE_VERSION = old;
  });

  it("falls back to 'unknown'", () => {
    const old = process.env.OPENCODE_VERSION;
    delete process.env.OPENCODE_VERSION;
    expect(resolveHostVersion()).toBe("unknown");
    if (old !== undefined) process.env.OPENCODE_VERSION = old;
  });
});

describe("recordHookFired", () => {
  it("writes a hook_fired:<name> row with session_id", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    probe.hostVersion = "1.18.17";
    resetProbeForSession(probe, "ses_abc");

    recordHookFired(async () => store, probe, "event:session.created");
    // Detached — wait a tick for the promise to resolve.
    await new Promise((r) => setTimeout(r, 50));

    const summary = await store.getMetricSummary("hook_fired:event:session.created");
    expect(summary).toHaveLength(1);
    expect(summary[0].count).toBe(1);

    // Verify session_id was written.
    const row = await store.getLatestMetricRow("hook_fired:");
    expect(row?.session_id).toBe("ses_abc");
  });

  it("records host_version on first call", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    probe.hostVersion = "1.18.17";
    resetProbeForSession(probe, "ses_def");

    recordHookFired(async () => store, probe, "chat.message");
    await new Promise((r) => setTimeout(r, 50));

    const row = await store.getLatestMetricRow("host_version:");
    expect(row?.metric_name).toBe("host_version:1.18.17");
  });

  it("never throws when store is unavailable", async () => {
    const probe = createProbeState();
    const failingStore = async (): Promise<MemoryStore> => {
      throw new Error("store unavailable");
    };
    // Should not throw.
    recordHookFired(failingStore, probe, "event:session.created");
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("pushSentinel", () => {
  it("pushes a sentinel token once per session", () => {
    const probe = createProbeState();
    const output = { system: [] as string[] };

    const r1 = pushSentinel(probe, output);
    expect(r1.pushed).toBe(true);
    expect(r1.assertionOk).toBe(true);
    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toMatch(/^<!-- realmemory-probe:.* -->$/);
    expect(probe.sentinelToken).not.toBeNull();

    // Second call in the same session — should not push again.
    const r2 = pushSentinel(probe, output);
    expect(r2.pushed).toBe(false);
    expect(r2.assertionOk).toBe(true);
    expect(output.system).toHaveLength(1);
  });

  it("pushes even when pendingInjection is null (zero-recall session)", () => {
    const probe = createProbeState();
    const output = { system: [] as string[] };
    // pendingInjection is irrelevant to pushSentinel — it pushes regardless.
    const r = pushSentinel(probe, output);
    expect(r.pushed).toBe(true);
    expect(r.assertionOk).toBe(true);
  });

  it("returns assertionOk=false when output.system silently drops the push (non-array)", () => {
    const probe = createProbeState();
    // Simulate a host that hands us a non-array (silently drops the push).
    const output = { system: "not-an-array" as unknown as string[] };
    const r = pushSentinel(probe, output);
    expect(r.pushed).toBe(true);
    expect(r.assertionOk).toBe(false);
  });
});

describe("recordLandsOutcome", () => {
  it("writes a hook_lands row with the given value", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    resetProbeForSession(probe, "ses_xyz");

    recordLandsOutcome(async () => store, probe, 0);
    await new Promise((r) => setTimeout(r, 50));

    const row = await store.getLatestMetricRow("hook_lands:");
    expect(row?.metric_value).toBe(0);
    expect(row?.session_id).toBe("ses_xyz");
  });

  it("never throws when store is unavailable", async () => {
    const probe = createProbeState();
    recordLandsOutcome(async () => {
      throw new Error("nope");
    }, probe, -1);
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("checkSentinelLanded", () => {
  it("records hook_lands=1 (found) when sentinel is in transcript", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    resetProbeForSession(probe, "ses_found");
    // Push a sentinel first.
    const output = { system: [] as string[] };
    pushSentinel(probe, output);
    const token = probe.sentinelToken!;

    // Transcript includes the sentinel.
    await checkSentinelLanded(store, probe, async () => `user: hi\nsystem: ${token}\nassistant: hello`);

    expect(probe.lastLandsValue).toBe("found");
    expect(probe.sentinelChecked).toBe(true);
    expect(probe.hostPersistsSystemContent).toBe(true);

    const row = await store.getLatestMetricRow("hook_lands:");
    expect(row?.metric_value).toBe(1);
  });

  it("records hook_lands=0 (observable-absent) when system content present but sentinel missing", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    resetProbeForSession(probe, "ses_absent");
    pushSentinel(probe, { system: [] });

    // Transcript has system content but no sentinel.
    await checkSentinelLanded(store, probe, async () => "user: hi\nsystem: some system prompt\nassistant: hello");

    expect(probe.lastLandsValue).toBe("observable-absent");
    expect(probe.hostPersistsSystemContent).toBe(true);

    const row = await store.getLatestMetricRow("hook_lands:");
    expect(row?.metric_value).toBe(0);
  });

  it("records hook_lands=-1 (unverifiable) when no system-role messages (1.18.17 host shape)", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    resetProbeForSession(probe, "ses_unverifiable");
    pushSentinel(probe, { system: [] });

    // Transcript with only user/assistant roles (the real 1.18.17 host shape).
    await checkSentinelLanded(store, probe, async () => "user: hello\nassistant: hi there\nuser: what is 2+2\nassistant: 4");

    expect(probe.lastLandsValue).toBe("unverifiable");
    expect(probe.hostPersistsSystemContent).toBe(false);

    const row = await store.getLatestMetricRow("hook_lands:");
    expect(row?.metric_value).toBe(-1);

    const capRow = await store.getLatestMetricRow("host_capability:");
    expect(capRow?.metric_value).toBe(0);
  });

  it("records hook_lands=-2 (fetch-failed) when transcript is null", async () => {
    const { store } = await initStore();
    const probe = createProbeState();
    resetProbeForSession(probe, "ses_fetch_fail");
    pushSentinel(probe, { system: [] });

    await checkSentinelLanded(store, probe, async () => null);

    expect(probe.lastLandsValue).toBe("fetch-failed");

    const row = await store.getLatestMetricRow("hook_lands:");
    expect(row?.metric_value).toBe(-2);
  });
});

describe("getLatestMetricRow (additive store accessor)", () => {
  it("returns the most-recent row by recorded_at matching the prefix", async () => {
    const { store } = await initStore();
    await store.recordMetric("hook_lands:experimental.chat.system.transform", 1, "ses_1");
    // Small delay so the second row has a later timestamp.
    await new Promise((r) => setTimeout(r, 10));
    await store.recordMetric("hook_lands:experimental.chat.system.transform", -1, "ses_2");

    const row = await store.getLatestMetricRow("hook_lands:");
    expect(row?.metric_value).toBe(-1);
    expect(row?.session_id).toBe("ses_2");
  });

  it("returns null when no row matches", async () => {
    const { store } = await initStore();
    const row = await store.getLatestMetricRow("nonexistent:");
    expect(row).toBeNull();
  });
});

describe("getDoctorReport", () => {
  it("returns inconclusive when store is empty", async () => {
    const { store } = await initStore();
    const report = await getDoctorReport(store);
    expect(report.inconclusive).toBe(true);
    expect(report.degraded).toBe(false);
    expect(report.rows).toHaveLength(6);
  });

  it("returns degraded=true when transform lands=0 (observable-absent)", async () => {
    const { store } = await initStore();
    // Seed: always-fire hooks fired + transform lands=0.
    await store.recordMetric("hook_fired:event:session.created", 1, "ses_1");
    await store.recordMetric("hook_fired:event:session.idle", 1, "ses_1");
    await store.recordMetric("hook_fired:chat.message", 1, "ses_1");
    await store.recordMetric("hook_fired:experimental.chat.system.transform", 1, "ses_1");
    await store.recordMetric("hook_lands:experimental.chat.system.transform", 0, "ses_1");

    const report = await getDoctorReport(store);
    expect(report.degraded).toBe(true);
    expect(report.fallbackNotice).not.toBeNull();
  });

  it("returns degraded=false when transform lands=-1 (unverifiable)", async () => {
    const { store } = await initStore();
    await store.recordMetric("hook_fired:event:session.created", 1, "ses_1");
    await store.recordMetric("hook_fired:experimental.chat.system.transform", 1, "ses_1");
    await store.recordMetric("hook_lands:experimental.chat.system.transform", -1, "ses_1");

    const report = await getDoctorReport(store);
    expect(report.degraded).toBe(false);
    expect(report.unverifiableNotice).not.toBeNull();
  });

  it("returns degraded=true when always-fire hook has zero fires but sessions ran (issue-#28 mode)", async () => {
    const { store } = await initStore();
    // Seed: some non-hook metric exists (brain-loop ran) but no hook_fired rows.
    await store.recordMetric("preference_compliance", 1, "ses_1");
    // Also add a memory so count() > 0.
    await store.store({
      content: "test memory",
      type: "codebase_fact",
      scope: "project",
      confidence: 0.5,
    });

    const report = await getDoctorReport(store);
    expect(report.degraded).toBe(true);
  });

  it("conditional hooks at zero fires do NOT trigger degraded", async () => {
    const { store } = await initStore();
    // Seed: always-fire hooks fired but conditional hooks did not.
    await store.recordMetric("hook_fired:event:session.created", 1, "ses_1");
    await store.recordMetric("hook_fired:event:session.idle", 1, "ses_1");
    await store.recordMetric("hook_fired:chat.message", 1, "ses_1");
    await store.recordMetric("hook_fired:experimental.chat.system.transform", 1, "ses_1");
    await store.recordMetric("hook_lands:experimental.chat.system.transform", -1, "ses_1");
    // No hook_fired:tool.execute.after or hook_fired:experimental.session.compacting

    const report = await getDoctorReport(store);
    expect(report.degraded).toBe(false);

    // Check the conditional hooks show no-evidence.
    const compactingRow = report.rows.find((r) => r.hook === "experimental.session.compacting");
    expect(compactingRow?.fires).toBe("no-evidence");
  });
});

describe("printDoctorTable", () => {
  it("prints the table header and 6 rows, exits 3 for empty store", async () => {
    const { store } = await initStore();
    const lines: string[] = [];
    const stdout = { write: (s: string) => { lines.push(s); return true; } };

    const code = await printDoctorTable(store, stdout as unknown as typeof process.stdout);
    const output = lines.join("");

    expect(code).toBe(3);
    expect(output).toContain("realmemory doctor — hook probe report");
    expect(output).toContain("NO DATA");
    // 6 hook rows.
    expect(output).toContain("event:session.created");
    expect(output).toContain("experimental.chat.system.transform");
    expect(output).toContain("experimental.session.compacting");
  });

  it("prints UNVERIFIABLE notice and exits 0 for unverifiable lands", async () => {
    const { store } = await initStore();
    await store.recordMetric("hook_fired:event:session.created", 1, "ses_1");
    await store.recordMetric("hook_fired:experimental.chat.system.transform", 1, "ses_1");
    await store.recordMetric("hook_lands:experimental.chat.system.transform", -1, "ses_1");

    const lines: string[] = [];
    const stdout = { write: (s: string) => { lines.push(s); return true; } };

    const code = await printDoctorTable(store, stdout as unknown as typeof process.stdout);
    const output = lines.join("");

    expect(code).toBe(0);
    expect(output).toContain("UNVERIFIABLE");
    expect(output).not.toContain("DEGRADED");
  });

  it("prints DEGRADED + fallback notice and exits 2 for lands=0", async () => {
    const { store } = await initStore();
    await store.recordMetric("hook_fired:event:session.created", 1, "ses_1");
    await store.recordMetric("hook_fired:experimental.chat.system.transform", 1, "ses_1");
    await store.recordMetric("hook_lands:experimental.chat.system.transform", 0, "ses_1");

    const lines: string[] = [];
    const stdout = { write: (s: string) => { lines.push(s); return true; } };

    const code = await printDoctorTable(store, stdout as unknown as typeof process.stdout);
    const output = lines.join("");

    expect(code).toBe(2);
    expect(output).toContain("DEGRADED");
    expect(output).toContain("AGENTS.md");
  });
});
