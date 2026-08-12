# Development Plan — Issue #30: Hook probe (synthetic-brain Phase 0)

**Author:** Anymake Solution Architect
**Project:** realmemory — `project_type: library`
**Issue:** https://github.com/R3dy/RealMemory/issues/30 — `type:feature`
**Code state analyzed:** `103effe` (v0.5.0, post issue #28 merge)
**Host ground truth checked:** OpenCode 1.18.17 install at `~/.local/share/opencode/`
**Status:** In Review (round 3)
**Location:** `PROJECTS/realmemory/repo/docs/06-agile/issue-30/plan.md`

---

## 1. Problem Statement

realmemory's entire delivery path — recalled memories reaching the LLM's system
prompt — depends on a single OpenCode hook: `experimental.chat.system.transform`.
That hook (and `experimental.session.compacting`) is **absent from the published
`@opencode-ai/plugin` `Hooks` type** at the time of this design's motivation
(the installed 1.18.17 host now *does* type them — see §2 — but the
runtime-recognition risk the probe addresses is real and unversioned), and
OpenCode **silently discards hook keys it does not recognize**. A plugin can
therefore be fully "working" (no errors, tests green, memories written via the
MCP surface) while injecting nothing into any prompt. This repo has been burned
by exactly this class of bug once already (Epic #3: `message.updated` was an
event, not a hook, and never fired; issue #28: the plugin entry point was
mis-shaped and no hook fired in the live host).

Issue #30 asks for **Phase 0 of the synthetic-brain design** (`docs/architecture/
synthetic-brain.md` §5 row 0, §6, §4.2 delivery-risk note): a non-blocking
diagnostics subsystem that proves, with ground truth, that every registered hook
**fires** AND that the transform hook's `output.system` mutation actually
**lands** — defined honestly below, after round-1 review established that the
strongest landing claim ("reaches the model and is observable in the session
transcript") is **structurally unobservable from inside the plugin on this
host**. Firing is observable; the mutation reaching the model is not. Phase 0
reports what is observable and is explicit about what is not, rather than
false-alarming. Results surface in `GET /api/metrics`, in the graph browser
(via the existing generic metrics endpoint), and via a new
`realmemory-mcp --doctor` CLI command. Phases 1–7 of the synthetic-brain design
are explicitly out of scope — they are future issues gated on Phase 0 going
green (or, for the landing question, on a Phase-1+ mechanism that can observe
the model's actual context, e.g. a sentinel the model is instructed to echo).

Phase 0 is a **NO-OP until `--doctor` is invoked or `/api/metrics` is read.** No
behavior change to gate; no new config block (the `brain` config from doc §5 is
NOT introduced here). Additive metrics rows only — no schema migration.

### 1.1 Deviation note — issue requirement #4 ("falls back automatically")

The issue's Requested behavior #4 and its confirmed Restated Understanding
("define an automatic fallback if delivery is broken") describe **automatic**
degradation: when the transform hook does not land, the plugin should switch
delivery to a known-working path (a native tool the agent is instructed to
call, plus `AGENTS.md`-adjacent instruction injection) without operator action.

**This plan narrows requirement #4 for Phase 0.** Phase 0 delivers
**declaration only** — `--doctor` prints the fallback instructions when
degraded. Auto-activation (writing to `AGENTS.md` programmatically, registering
a native `tool:` in the plugin return value per doc §4.7, or setting a
`deliveryDegraded` flag that the `chat.message` recall path checks) is
deferred to Phase 1+.

**Justification:** the issue's own hard constraint says "Phase 0 is a NO-OP
until `--doctor` is invoked." Any auto-fallback that changes what the plugin
injects or does on the delivery path when `--doctor` has not been invoked
violates that constraint. A `deliveryDegraded` flag checked inside
`chat.message` is a behavior change that fires before any `--doctor` run —
ruled out. Auto-writing `AGENTS.md` is a filesystem side effect on a path the
plugin does not own — ruled out for Phase 0. The honest Phase-0 scope of
"automatic" is: `--doctor` automatically *declares* the fallback the moment it
detects degradation (no operator diagnosis needed); Phase 1+ *activates* it.

**Reporter sign-off required.** §10's Verify step includes a named criterion
requiring Royce (the reporter) to confirm this narrowing before build, or to
request option (a) — a minimal auto-fallback — which would re-open the
hard-constraint tradeoff.

---

## 2. Root Cause / Motivation

**This is a feature (diagnostics), not a bug fix.** Motivation, not root cause.

**Motivation.** The synthetic-brain design (Phases 1–7) bets the entire delivery
path on two `experimental.*` hooks that are unversioned, untyped, and silently
ignored by the host when unrecognized. Building Phases 1–7 on top of an
unverified delivery path would compound the existing risk: a future "working"
brain loop could be silently injecting nothing, exactly as happened in Epic #3
and issue #28. Phase 0 is the **blocking prerequisite** (doc §6: "Phase 0 is not
optional") that turns "we assume the hook fires" into "we have a metric row that
proves it fired in the last session," and "we assume the mutation lands" into
"we have an honest answer — landed / not-landed / unverifiable on this host."

**Success model (library, `PROJECT_TYPES/library/manifest.md`):** adoption
depends on the library actually delivering memory to the agent. A memory library
that silently fails to deliver is worse than no memory library — it erodes trust
in every downstream feature. Phase 0 makes silent failure observable, which is
the precondition for trusting any later brain-loop work.

**Host ground truth (decisive for the landing-question design — established
during round-1 review by the Plan Reviewer against the live host, and
re-confirmed by the architect):**

- **OpenCode 1.18.17**, `~/.local/share/opencode/opencode.db`, `message` table:
  **only** `role:"user"` (4,786 rows) and `role:"assistant"` (88,174 rows) —
  **zero** `role:"system"` rows. The assembled system prompt is **not persisted
  as a session message.**
- The installed SDK types (`@opencode-ai/sdk/dist/gen/types.d.ts`) define message
  roles as `"user"` and `"assistant"` only.
- Therefore the sentinel pushed into `output.system` can **never** be observed
  via `client.messages()` on this host — the surface `fetchSessionTranscript`
  (`plugin.ts:154`) reads does not carry system-prompt content.
- **Side observation (does not affect the design):** the installed 1.18.17
  `@opencode-ai/plugin` *does* type the `experimental.*` hooks (the plan's
  "absent from the published Hooks type" framing is stale for 1.18.17). The
  runtime-recognition risk the probe addresses is real and unversioned — a future
  host can still silently drop the keys — so the probe remains warranted.

**Specific failure class being probed** (doc §4.2):
- `experimental.chat.system.transform` handler at [`src/plugin.ts:580`] pushes
  into `output.system`, but if the host drops the mutation, the push is a no-op
  and nothing observable changes downstream.
- There is currently **no instrumentation** recording whether any of the 5
  registered hooks (`event`, `tool.execute.after`, `chat.message`,
  `experimental.chat.system.transform`, `experimental.session.compacting`) has
  ever fired in a real host session. Issue #28 proved all 5 were silent for
  weeks before discovery.

**What Phase 0 can and cannot prove (the honest claim after round-1 review):**
- ✅ **Can prove:** a hook **fired** (instrumentation at handler entry records a
  `hook_fired` row — ground truth from inside the handler).
- ✅ **Can prove:** `output.system` was **mutated** by our push (in-handler
  assertion: immediately after `pushSentinel`, verify the sentinel string is
  present in `output.system` — proves the array we were handed contains it).
- ❌ **Cannot prove (on this host):** the mutation **reached the LLM's actual
  context.** The host does not persist the system prompt in any surface the
  plugin can read (`client.messages()` returns user/assistant only). This is
  structurally unobservable from inside the plugin. Phase 0 reports this as
  `lands: "unverifiable"` with an explanation — **not** as a false `DEGRADED`.
- ✅ **Can prove on a host that DOES persist system content:** if a future host
  (or a Phase-1+ sentinel-echo mechanism where the model is instructed to echo
  the token in its first reply) makes the sentinel observable in a
  user/assistant message, `checkSentinelLanded` records `lands=1` (found) or
  `lands=0` (system content present, sentinel absent — genuinely degraded).

---

## 3. Current-State Review

| Touched | Details |
|---------|---------|
| Modules | `src/plugin.ts` (5 hook handlers — instrument each; `PluginState` gains `probe` + `sessionId`; `session.created` resets probe state); `src/store.ts` (`recordMetric`/`getMetricSummary` — reuse, no change; **additive new method `getLatestMetricRow(prefix)`** for the doctor's latest-value/session_id/host-version reads — resolves 2-C1 + 2-C4; `recordHookFired` threads `sessionId` through to the existing optional `recordMetric` `sessionId` arg at `store.ts:1710`); `src/bin.ts` (add `--doctor` branch); `src/browser/server.ts` (confirm `/api/metrics` is generic — no change); NEW `src/hook-probe.ts` (probe module + doctor report) |
| Data model | `metrics` table (SCHEMA_V4, `id ULID, metric_name, metric_value REAL, session_id, recorded_at`). **No schema change.** New metric_name rows only: `hook_fired:<hookName>` (value=1), `hook_lands:experimental.chat.system.transform` (value encoded by outcome: **1** found / **0** observable-absent / **-1** unverifiable / **-2** fetch-failed — a row is written for EVERY readback outcome, resolves 2-C1), `host_capability:persists-system-content` (value 1/0), `host_version:<version>` (value=1). |
| Flows | (A) Each of the 5 plugin hook handlers gains a one-line detached `recordHookFired` call at entry. (B) `session.created` resets `ProbeState` and captures `sessionId`. (C) `experimental.chat.system.transform` calls `pushSentinel` (pure, returns `{pushed, assertionOk}`) **before** the `!pendingInjection` early return; the handler calls `recordLandsOutcome(getStore, probe, 0)` if the post-push assertion failed (resolves 2-C3). (D) `session.idle` additionally calls `checkSentinelLanded` (detached) which reads the transcript via `fetchSessionTranscript` (`plugin.ts:154`), classifies into `found` / `observable-absent` / `unverifiable` / `fetch-failed`, and **records a `hook_lands` row for EVERY outcome** (value 1/0/-1/-2) + a `host_capability` row (resolves 2-C1). (E) `bin.ts --doctor` loads a store, reads `getMetricSummary` (fire counts) + the new additive `getLatestMetricRow` (lands value, session header, host version — resolves 2-C1 + 2-C4), prints a table + fallback notice, exits per the 4-state matrix (zero-fires degraded scoped to ALWAYS-fire hooks — resolves 2-C2). |
| Integrations | None new. Reuses `better-sqlite3`/`bun:sqlite` (sync INSERT), `node:http` (existing browser), Node `process.stdout` (doctor). Zero new runtime deps (ADR-003/INV-014). |

**Intent-layer freshness:** SYSTEM_MAP / DECISIONS / INVARIANTS last mapped
**2026-08-12 at HEAD `issue/28-plugin-hooks-broken`** — fresh (post-issue-28,
post-ADR-009). No Cartographer run required.

---

## 4. Solution Design

### 4.1 New module: `src/hook-probe.ts`

Exports (all fire-safe, never throw — INV-017):

```ts
// The 6 registered hook instrumentation points (the `event` hook splits into
// created+idle branches → 6 points). Single source of truth — plugin.ts imports
// this for both the handler keys and the metric names, so a new hook can never
// be added without the probe noticing.
//
// Hooks are classified by firing discipline (resolves 2-C2):
//   ALWAYS-fire   = fires in every real session that has ≥1 user turn. Zero
//                   fires + evidence of sessions = DEGRADED (#28 signature).
//   CONDITIONAL   = fires only on a host event / agent action that may not
//                   occur in a healthy session. Zero fires = "no-evidence"
//                   (NOT degraded — no false positive on a healthy install).
export const ALWAYS_FIRE_HOOKS = [
  "event:session.created",
  "event:session.idle",
  "chat.message",
  "experimental.chat.system.transform",
] as const;

export const CONDITIONAL_HOOKS = [
  "tool.execute.after",          // fires per tool call; a chat-only session has none
  "experimental.session.compacting",  // fires only when the host compacts
] as const;

export const PROBED_HOOKS = [
  ...ALWAYS_FIRE_HOOKS,
  ...CONDITIONAL_HOOKS,
] as const;

// Stashed on plugin state. Reset on every session.created (see §4.2).
export interface ProbeState {
  sessionId: string | null;            // captured from session.created event properties
  hostVersion: string | null;          // resolved once at plugin init
  sentinelToken: string | null;        // ULID token pushed into output.system this session
  sentinelPushedAt: number | null;     // Date.now() when pushed
  sentinelChecked: boolean;            // session.idle has attempted a readback this session
  lastLandsValue: "found" | "observable-absent" | "unverifiable" | "fetch-failed" | null;
  // host capability: set true/false the first time checkSentinelLanded observes
  // (or fails to observe) a system-role message in a non-null transcript. Stays
  // set for the process lifetime. null = no readback has completed yet.
  hostPersistsSystemContent: boolean | null;
}

export function createProbeState(): ProbeState;

// Reset probe state for a new session. Called from session.created.
export function resetProbeForSession(probe: ProbeState, sessionId: string): void;

// Resolve the OpenCode host version once. Lookup order:
//   process.env.OPENCODE_VERSION → (ctx.client as any)?.app?.version → "unknown"
// Stored as a metric row `host_version:<resolved>` (value=1) once per session,
// recorded alongside the first hook_fired.
export function resolveHostVersion(ctx: OpenCodePluginContext): string | null;

// Detached, non-blocking. Records `hook_fired:<hookName>` = 1 (and the
// host_version row on first call this session). Threads `probe.sessionId`
// through to recordMetric's optional sessionId arg (store.ts:1710) so the
// doctor `session:` header is populatable. Never throws, never awaits
// into the caller. INV-017-safe: recordMetric is sync-sqlite internally and
// fire-safe; this wraps it in `void (async () => { const s = await getStore();
// await s.recordMetric(...); })().catch(() => {})`.
export function recordHookFired(
  getStore: () => Promise<MemoryStore>,
  probe: ProbeState,
  hookName: string,
): void;

// Called from inside experimental.chat.system.transform, ONCE per session
// (guarded by probe.sentinelToken !== null). Pushes an HTML-comment sentinel
// into output.system: `<!-- realmemory-probe:<ulid> -->`. Stashes the token.
// PURE synchronous state mutation (no store access, no IO — the existing hook
// contract). MUST be called BEFORE the !pendingInjection early return (see §4.2).
//
// Returns { pushed, assertionOk }:
//   pushed       = true iff a sentinel was pushed THIS call (false on a second
//                  transform fire in the same session — once-per-session guard).
//   assertionOk  = true iff `output.system.includes(token)` held immediately
//                  after the push (proves the array we were handed contains
//                  the token at push time). A false assertionOk means the host
//                  handed us a frozen/replace array that silently dropped the
//                  push — the strongest negative signal available from inside
//                  the plugin.
//
// (Resolves 2-C3.) pushSentinel does NOT record anything — it is pure. The
// HANDLER inspects the return value and, on `pushed && !assertionOk`, calls
// recordLandsOutcome(getStore, probe, 0) to persist the negative signal. This
// keeps the recording on the side that has store access.
export function pushSentinel(
  probe: ProbeState,
  output: { system?: string[] },
): { pushed: boolean; assertionOk: boolean };

// Detached, non-blocking. Records a `hook_lands:experimental.chat.system.transform`
// row with the given numeric outcome (see VALUE_ENCODING below) and threads
// probe.sessionId. Used by (a) the transform handler on pushSentinel assertion
// failure (value=0) and (b) checkSentinelLanded for every readback outcome
// (value ∈ {1, 0, -1, -2}). INV-017-safe: void-wrapped detached promise,
// never throws, never awaits into the caller. (checkSentinelLanded already
// holds the store and calls store.recordMetric directly — this helper exists
// for the handler, which has only getStore.)
export function recordLandsOutcome(
  getStore: () => Promise<MemoryStore>,
  probe: ProbeState,
  value: LandsValue,
): void;

// Numeric encoding of the four readback outcomes (resolves 2-C1 — every
// outcome is persisted so the doctor can reconstruct all four states from
// store data alone, no process-memory dependence):
//    1   = found              (sentinel present in transcript → landed)
//    0   = observable-absent  (system content observable, sentinel absent → DEGRADED)
//   -1   = unverifiable       (no system-role messages → host doesn't expose system content)
//   -2   = fetch-failed       (transcript fetch returned null / too thin)
// The SAME metric_name `hook_lands:experimental.chat.system.transform` is used
// for all four; the value distinguishes them. The doctor reads the LATEST row
// by recorded_at (via getLatestMetricRow — see §4.1b) to determine the
// current state. getMetricSummary CANNOT be used here (its `latest` field is
// MAX(metric_value), not the most-recent row's value — see §4.1b).
export type LandsValue = 1 | 0 | -1 | -2;

// Called from session.idle (detached). Fetches the transcript via the existing
// fetchSessionTranscript (plugin.ts:154) and classifies the result, then
// PERSISTS A ROW FOR EVERY OUTCOME (resolves 2-C1):
//
//   - transcript contains probe.sentinelToken           → "found"             → record hook_lands = 1
//   - transcript non-null, ≥1 system-role msg,          → "observable-absent" → record hook_lands = 0
//     sentinel not found                                                       (DEGRADED — genuine)
//   - transcript non-null, ZERO system-role messages,   → "unverifiable"      → record hook_lands = -1
//     sentinel not found                                                       (host doesn't expose system
//                                                                               content; NOT degraded)
//   - transcript is null (fetch failed / too thin)      → "fetch-failed"      → record hook_lands = -2
//
// ALSO records a `host_capability:persists-system-content` row (value=1 if any
// system-role message was seen in this transcript, value=0 if a non-null
// transcript had zero system-role messages) — once per readback. This gives
// the doctor a second, human-readable signal for the UNVERIFIABLE notice
// ("verified against host_version — host does not persist system content").
//
// Sets probe.lastLandsValue + probe.sentinelChecked. Updates
// probe.hostPersistsSystemContent (true if any system-role message seen;
// false if a non-null transcript had none; stays null only if fetch failed).
// Does NOT clear the sentinel (session.created resets probe state; idle may
// fire multiple times per session and the first successful check wins).
//
// Host-capability detection: the function scans every message's `role` field.
// If ANY message has role "system", hostPersistsSystemContent is set true for
// the process lifetime. Once true, subsequent zero-sentinel findings are
// "observable-absent" (genuine degradation). Until true AND a non-null
// transcript was seen, zero-sentinel findings are "unverifiable."
export async function checkSentinelLanded(
  store: MemoryStore,
  probe: ProbeState,
  fetchTranscript: () => Promise<string | null>,
): Promise<void>;

// Structured doctor report — one row per probed hook. Used by both --doctor
// (bin.ts) and testable in isolation.
export interface DoctorRow {
  hook: string;
  conditional: boolean;                  // true for CONDITIONAL_HOOKS members
  fires: "yes" | "no" | "no-evidence";   // no-evidence = conditional hook at zero fires (NOT degraded)
  fireCount: number;
  lastSeen: string | null;               // recorded_at of latest hook_fired row
  lands: "yes" | "no" | "unverified" | "unverifiable" | "fetch-failed" | "na";
  //   yes          = sentinel found in transcript (landed)
  //   no           = system content observable but sentinel absent (DEGRADED)
  //   unverified   = sentinel pushed but no readback completed (no hook_lands row, transform fired)
  //   unverifiable = host does not persist system content (latest hook_lands value = -1)
  //   fetch-failed = readback fetch returned null (latest hook_lands value = -2)
  //   na           = not the transform hook
  hostVersion: string | null;            // latest host_version:* by recorded_at
  degraded: boolean;                     // true iff transform lands === "no" (positive evidence of non-landing)
}

export interface DoctorReport {
  rows: DoctorRow[];
  degraded: boolean;
  inconclusive: boolean;               // true iff zero metric rows total (fresh install / no sessions ran)
  fallbackNotice: string | null;       // non-null iff degraded
  unverifiableNotice: string | null;   // non-null iff transform lands === "unverifiable"
  fetchFailedNotice: string | null;    // non-null iff transform lands === "fetch-failed"
}

export async function getDoctorReport(store: MemoryStore): Promise<DoctorReport>;
```

### 4.1b Additive store accessor — `MemoryStore.getLatestMetricRow` (resolves 2-C1 + 2-C4)

`getMetricSummary` (`store.ts:1731-1784`) returns per-name aggregates only —
its `latest` field is `MAX(metric_value)`, **not** the most-recent row's value,
and it returns **no `session_id`**. The doctor needs (a) the most-recent
`hook_lands` *value* (to distinguish 1/0/-1/-2) and (b) the most-recent
`session_id` among `hook_fired:*` rows (for the `session:` header). Neither is
available from `getMetricSummary`. Add ONE small additive method to
`MemoryStore` (`src/store.ts`, after `getMetricSummary` at line 1784):

```ts
/**
 * Return the single most-recent metrics row (by recorded_at) whose
 * metric_name matches the given prefix (LIKE 'prefix%'). Returns null if no
 * row matches. Additive: no schema change, no existing method signature
 * change. Used by --doctor to read the latest hook_lands outcome value and
 * the latest session_id (both unreachable via getMetricSummary).
 */
async getLatestMetricRow(
  prefix: string,
): Promise<{
  metric_name: string;
  metric_value: number;
  session_id: string | null;
  recorded_at: string;
} | null> {
  if (!this.db) return null;
  return (this.db
    .prepare(
      "SELECT metric_name, metric_value, session_id, recorded_at FROM metrics " +
      "WHERE metric_name LIKE ? ORDER BY recorded_at DESC LIMIT 1",
    )
    .get(`${prefix}%`)) as
    | { metric_name: string; metric_value: number; session_id: string | null; recorded_at: string }
    | undefined
    ?? null;
}
```

**Additivity confirmation (INV-005 / ADR-008):** new method only; the metrics
table schema (SCHEMA_V4) is unchanged; no existing method's signature, return
type, or behavior is altered. `getMetricSummary` is still used by `getDoctorReport`
for per-`hook_fired:*` fire counts and last-seen timestamps (its aggregates are
correct for those); `getLatestMetricRow` is used for the three "latest value"
reads that the summary cannot provide.

**`getDoctorReport` read paths (after the additive accessor):**
- fire count + last-seen per hook: `getMetricSummary()` → filter `hook_fired:<name>` rows (existing, correct).
- transform `lands`: `getLatestMetricRow("hook_lands:experimental.chat.system.transform")` → read `metric_value` (1/0/-1/-2). No row + transform fired → `unverified`.
- `session:` header: `getLatestMetricRow("hook_fired:")` → read `session_id`.
- host version: `getLatestMetricRow("host_version:")` → parse version from `metric_name` (everything after `host_version:`).

**`degraded` vs `inconclusive` vs `unverifiable` vs `fetch-failed` — the four
honest states (resolves 2-C1):**
- `degraded = true` ONLY when the transform hook has `fires=yes` AND
  `lands === "no"` (positive evidence: system content is observable in the
  transcript, the sentinel was pushed, and it was not found). This is the only
  state that prints the fallback notice and exits 2.
- `inconclusive = true` when the metrics table has zero rows total (no
  `hook_fired:*`, no `hook_lands:*`, no other metric rows) — a fresh install
  where no session has run, OR a broken plugin that never fired (the store has
  memories but zero hook_fired rows). The latter is the issue-#28 silent-failure
  mode and is reported as degraded (see §4.3 exit matrix).
- `unverifiable` (per-row `lands` value, NOT a report-level degraded flag):
  the host does not persist system-prompt content. Recorded as a
  `hook_lands:experimental.chat.system.transform` row with value **-1** (and a
  companion `host_capability:persists-system-content` = 0 row). `--doctor`
  prints an `unverifiableNotice` explaining what can and cannot be proven, and
  **exits 0** (not degraded — a healthy install on this host must never be
  reported DEGRADED by construction). **Reachable from store data alone** via
  `getLatestMetricRow("hook_lands:experimental.chat.system.transform")`.
- `fetch-failed` (per-row `lands` value, NOT degraded): the transcript fetch
  returned null. Recorded as a `hook_lands` row with value **-2**. `--doctor`
  prints a `fetchFailedNotice` ("readback fetch returned no data; re-run after
  another session") and exits 0. Distinct from `unverified` (no row at all =
  readback never attempted, e.g. session.idle never fired).

**Metric-name + value encoding (no-migration constraint, resolves 2-C1).** The
metrics table has no metadata column and the hard constraint forbids a schema
migration. So:

- The **hook name** is encoded in the metric_name: `hook_fired:<hookName>` (value=1).
- The **host version string** is encoded as `host_version:<resolved>` (value=1).
  `--doctor` reads the latest via `getLatestMetricRow("host_version:")` and
  parses the version out of the metric_name (handles host upgrades accumulating
  multiple version rows — the most-recent by `recorded_at` wins).
- The **lands** result is `hook_lands:experimental.chat.system.transform` with
  the outcome in the **value**: `1` (found), `0` (observable-absent — DEGRADED),
  `-1` (unverifiable), `-2` (fetch-failed). **A row is written for EVERY
  readback outcome** (all four states reconstructible from store data alone —
  no process-memory dependence). This is the round-3 fix for 2-C1: the round-2
  design wrote rows for only two outcomes and relied on `ProbeState` in-memory
  fields the doctor could not read.
- The **host capability** is recorded as `host_capability:persists-system-content`
  (value=1 yes / 0 no) once per readback — a human-readable companion to the
  `-1` lands value, so the `UNVERIFIABLE` notice can cite it.
- The doctor distinguishes `unverified` (no `hook_lands` row exists but
  `hook_fired:experimental.chat.system.transform` count > 0) from the four
  recorded outcomes by the *absence* of a `hook_lands` row — the only state
  signaled by absence, and it is constructible from store data (the doctor
  checks `getLatestMetricRow("hook_lands:experimental.chat.system.transform")`
  returns null).

### 4.2 Plugin instrumentation — `src/plugin.ts`

Add `ProbeState` to `PluginState` (line 30 interface): `probe: ProbeState` and
`sessionId: string | null`. Initialize in the `state` literal (line 207):
`probe: createProbeState(), sessionId: null`. After config load (line 211), call
`state.probe.hostVersion = resolveHostVersion(ctx)`.

**Session-boundary mechanism (resolves 1-C3):** `PluginState` is
process-scoped (instantiated once per plugin load), but sessions are sequential
within the host process. `ProbeState` is **session-scoped by reset**:
- On `session.created` (line 271 branch), **before any config gate**, capture
  `sessionId` from the event properties (`event.properties?.sessionID` — same
  shape already used at `plugin.ts:357-358` for `session.idle`) and call
  `resetProbeForSession(state.probe, sessionId)`. This clears
  `sentinelToken`, `sentinelPushedAt`, `sentinelChecked`, `lastLandsValue` to
  null/false so a session ending without an idle event cannot leak its token
  into the next session. `hostVersion` and `hostPersistsSystemContent` are
  preserved (process-lifetime, not session-scoped).
- `state.sessionId` is set to the captured value (used by `recordHookFired` to
  thread through to `recordMetric`'s optional `sessionId` arg at
  `store.ts:1710`, so the doctor `session:` header is populatable).
- If `session.created` fires without a `sessionID` property, `state.sessionId`
  stays null and `recordHookFired` passes `undefined` to `recordMetric` (the
  doctor `session:` header prints "none" — same as before, but now actually
  populated when the property is present).

**Instrumentation points — one detached `recordHookFired` call at the very ENTRY
of each handler, before any config gate, so the probe measures "did the host
invoke this hook" independent of whether the handler does work:**

| Hook | File:line (entry) | Calls |
|------|-------------------|-------|
| `event` (session.created branch) | `src/plugin.ts:271` | `resetProbeForSession(state.probe, sessionId)` + `recordHookFired(getStore, state.probe, "event:session.created")` |
| `event` (session.idle branch) | `src/plugin.ts:318` | `recordHookFired(getStore, state.probe, "event:session.idle")` + detached `checkSentinelLanded` (see below) |
| `tool.execute.after` | `src/plugin.ts:422` (before the `autoCapture:false` fast-no-op at 429) | `recordHookFired(getStore, state.probe, "tool.execute.after")` |
| `chat.message` | `src/plugin.ts:514` (before the `role !== "user"` return at 518) | `recordHookFired(getStore, state.probe, "chat.message")` |
| `experimental.chat.system.transform` | `src/plugin.ts:580` (**at the very top, BEFORE the `!state.pendingInjection` return at 584**) | `recordHookFired(getStore, state.probe, "experimental.chat.system.transform")` + `pushSentinel(state.probe, output)` |
| `experimental.session.compacting` | `src/plugin.ts:602` (entry) | `recordHookFired(getStore, state.probe, "experimental.session.compacting")` |

**Sentinel push placement (resolves 1-C2):** the `experimental.chat.system.transform`
handler body is restructured so that `recordHookFired` and `pushSentinel` run
**before** the existing `if (!state.pendingInjection) return;` guard at line 584.
Concretely:

```ts
"experimental.chat.system.transform": (
  _input: unknown,
  output: { system?: string[] },
) => {
  // PHASE 0 PROBE — runs on EVERY transform fire, independent of
  // pendingInjection. Sentinel is pushed once per session (guarded inside
  // pushSentinel). MUST be before the pendingInjection early return so
  // zero-recall sessions (fresh projects, the most common new-adopter state)
  // still produce a landing check.
  recordHookFired(getStore, state.probe, "experimental.chat.system.transform");
  const r = pushSentinel(state.probe, output);
  // pushSentinel is PURE (resolves 2-C3): it does not touch the store. The
  // handler, which has getStore in scope, records the negative signal when
  // the post-push output.system.includes(token) assertion fails (the host
  // handed us a frozen/replace array that silently dropped the push). A
  // successful assertion does NOT record lands=1 — the in-handler assertion
  // is a negative-only signal; the affirmative landing proof comes from
  // checkSentinelLanded reading the transcript at session.idle.
  if (r.pushed && !r.assertionOk) {
    recordLandsOutcome(getStore, state.probe, 0);
  }

  if (!state.pendingInjection) return;
  if (!Array.isArray(output?.system)) {
    state.pendingInjection = null;
    return;
  }
  output.system.push(state.pendingInjection);
  state.lastInjectedMemoryIds = Array.from(state.injectedMemoryIds).slice(-5);
  state.pendingInjection = null;
},
```

**`recordHookFired` is non-blocking (INV-017):** `void`-wrapped, detached
promise; the host's hook return is never delayed. The underlying
`store.recordMetric` is sync better-sqlite3 (fire-safe try/catch —
[`src/store.ts:1707-1724`]). One INSERT per hook fire is synchronous-cheap
(sub-ms) and matches the existing `memory_bloat_ratio` recording pattern at
[`src/plugin.ts:614`].

**Sentinel push in `experimental.chat.system.transform`:** `pushSentinel` pushes
`<!-- realmemory-probe:<ulid> -->` exactly once per session (guarded by
`state.probe.sentinelToken !== null`). The sentinel is an HTML comment so it is
invisible to the model's reasoning but preserved in any surface that carries
system-prompt text. **In-handler assertion (resolves 2-C3):** `pushSentinel` is
PURE — it pushes the token, then verifies `output.system.includes(token)` and
returns `{ pushed, assertionOk }`; it does **not** touch the store. The handler
inspects the return: on `pushed && !assertionOk` (the host handed us a
frozen/replace array that silently dropped the push), the handler calls
`recordLandsOutcome(getStore, state.probe, 0)` to persist a
`hook_lands:experimental.chat.system.transform` = 0 row — the strongest
negative signal available from inside the plugin. A successful assertion does
NOT record `lands=1` (the affirmative proof comes from `checkSentinelLanded`
reading the transcript). **This is the one place Phase 0 touches the system
prompt content** — a single HTML-comment token, once per session, ~45 chars.
Acceptable diagnostic overhead.

**Sentinel check in `session.idle`** (line 318 branch): add a detached
`checkSentinelLanded` call, independent of the `autoSummarize` gate (line 353).
The check reuses the existing `fetchSessionTranscript(ctx, sessionID)` helper
([`src/plugin.ts:154`]); for Phase 0 simplicity a second fetch is acceptable
since `session.idle` fires once per turn-end and the transcript fetch is already
on a detached promise. The check classifies the transcript per §4.1's four-way
outcome and **records a `hook_lands:experimental.chat.system.transform` row for
EVERY outcome** (value 1 found / 0 observable-absent / -1 unverifiable / -2
fetch-failed — resolves 2-C1) plus a companion
`host_capability:persists-system-content` row. All four states are
reconstructible by the doctor from store data alone (via `getLatestMetricRow`).

### 4.3 `--doctor` CLI subcommand — `src/bin.ts`

Add a `--doctor` branch to `parseArgs` (line 18) and the dispatch (line 41).
`--doctor` is mutually exclusive with `--ui` and the MCP stdio default (it is a
one-shot diagnostic that loads the store, prints, and exits).

**Exit-code matrix (resolves 1-C4 + 2-C2) — four states, four codes:**

| Code | State | Condition |
|------|-------|-----------|
| **0** | healthy | `hook_fired` rows exist for ≥1 ALWAYS-fire hook AND transform `lands ∈ {yes, unverifiable, unverified, fetch-failed}` (no positive evidence of non-landing). `unverifiable` prints the `unverifiableNotice` (exit 0); `fetch-failed` prints the `fetchFailedNotice` (exit 0). CONDITIONAL hooks (`tool.execute.after`, `experimental.session.compacting`) at zero fires are shown as `fires: "no-evidence"` and DO NOT trigger degraded (they fire only on host events / agent actions that may not occur in a healthy session). |
| **2** | degraded | transform `lands === "no"` (system content observable, sentinel pushed, sentinel absent) **OR** evidence of real sessions exists (any metric/memory row in the store) but ≥1 **ALWAYS-fire** hook has `fires === "no"` (the issue-#28 silent-failure mode — the host ran sessions but a hook that must fire every session never did). CONDITIONAL hooks at zero fires are NOT a degraded trigger. Fallback notice printed. |
| **3** | inconclusive | metrics table is **completely empty** (zero rows of any kind — fresh install, no session has run, nothing to judge). Prints "NO DATA — run a session first, then re-run `realmemory-mcp --doctor`." Not degraded (no evidence of failure), not healthy (no evidence of success). |
| **1** | crashed | store init failure or unhandled error in the doctor path. Distinct from 2 so a CI guard can tell "probe ran and found degradation" from "probe crashed." |

```ts
// in parseArgs: else if (a === "--doctor") doctor = true;
// in dispatch:
if (doctor) {
  let exitCode = 0;
  try {
    const config = loadConfig();
    const store = new MemoryStore(config);
    await store.init();
    const report = await getDoctorReport(store);
    printDoctorTable(report);  // to process.stdout
    await store.close();
    exitCode = report.inconclusive ? 3 : (report.degraded ? 2 : 0);
  } catch (err) {
    console.error(`realmemory doctor: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
```

**`printDoctorTable` output format** (literal, what `--doctor` prints):

```
realmemory doctor — hook probe report
host version: <latest host_version:* via getLatestMetricRow, or "unknown">
session: <session_id of latest hook_fired:* row via getLatestMetricRow, or "none">

hook                                          fires        count   last-seen             lands
event:session.created                         yes          14      2026-08-12T17:02:11Z  na
event:session.idle                            yes          14      2026-08-12T17:02:11Z  na
tool.execute.after                            yes|no-evidence N     <iso-ts|—>           na
chat.message                                  yes          14      2026-08-12T17:02:11Z  na
experimental.chat.system.transform            yes          14      2026-08-12T17:02:11Z  yes | no | unverified | unverifiable | fetch-failed
experimental.session.compacting               yes|no-evidence N     <iso-ts|—>           na
```

(`fires` is `yes` if fire count > 0; `no-evidence` if a CONDITIONAL hook has
zero fires — NOT degraded; `no` if an ALWAYS-fire hook has zero fires —
degraded when sessions ran. See §4.3 exit matrix.)

**Verdict lines appended based on state:**

- **`lands === "yes"`** (healthy, exit 0): no further output.
- **`lands === "unverifiable"`** (healthy on this host, exit 0) — reached via
  the latest `hook_lands` row value `-1` (resolves 2-C1):
  ```
  UNVERIFIABLE: this host does not persist system-prompt content in the session
  transcript (only user/assistant messages are stored — recorded as
  host_capability:persists-system-content=0, verified against OpenCode 1.18.17).
  The probe can prove the hook FIRED and that output.system was MUTATED, but
  cannot prove the mutation reached the LLM's context. To verify landing
  manually: trigger a realmemory recall, then ask the agent whether it sees the
  recalled memory in its context. A Phase-1+ mechanism (sentinel-echo: instruct
  the model to echo the probe token in its first reply) would make landing
  observable on this host.
  ```
- **`lands === "fetch-failed"`** (healthy, exit 0) — reached via the latest
  `hook_lands` row value `-2` (resolves 2-C1):
  ```
  FETCH-FAILED: the transform hook fired and a sentinel was pushed, but the
  session.idle transcript fetch returned no data (the client was unavailable
  or the transcript was too thin). Landing could not be evaluated. Re-run
  `realmemory-mcp --doctor` after another session.
  ```
- **`lands === "no"`** (degraded, exit 2):
  ```
  DEGRADED: experimental.chat.system.transform fires and output.system is
  observable in the transcript, but the sentinel did not land. The hook's
  mutation is being dropped downstream.
  Fallback delivery path: <notice text, see §4.4>
  ```
- **`lands === "unverified"`** (transform fired but no `hook_lands` row exists
  — readback never completed; exit 0 unless an always-fire hook failed):
  ```
  UNVERIFIED: the transform hook fired and a sentinel was pushed, but
  session.idle has not yet recorded a readback outcome (the hook may not have
  fired, or the store was unavailable at idle time). Re-run after another session.
  ```
- **Inconclusive (empty store, exit 3):**
  ```
  NO DATA — no metric rows found. Run at least one real session with the
  realmemory plugin loaded, then re-run `realmemory-mcp --doctor`.
  ```
- **Degraded via zero-fires-with-sessions (exit 2 — resolves 2-C2):** if the
  store has any metric/memory rows (evidence sessions ran) but ≥1 **ALWAYS-fire**
  hook (`event:session.created`, `event:session.idle`, `chat.message`,
  `experimental.chat.system.transform`) shows `fires=no`, print:
  ```
  DEGRADED: <hookName> (always-fire) registered 0 fires despite evidence of
  real sessions. The host is silently discarding this hook key — the
  issue-#28 failure mode.
  Fallback delivery path: <notice text, see §4.4 if transform; otherwise
  "this hook is not on the delivery path but its silence indicates a host
  compatibility problem — file an issue.">
  ```
  CONDITIONAL hooks (`tool.execute.after`, `experimental.session.compacting`)
  at zero fires are shown as `fires: "no-evidence"` in the table with **no
  degraded verdict** — they fire only on host events / agent actions that may
  not occur in a healthy session (e.g. a session with no compaction, or a
  chat-only session with no tool calls).

**Host-version + session-header selection rule (resolves 1-C3 + 2-C4):**
`--doctor` calls `store.getLatestMetricRow("host_version:")` and parses the
version from `metric_name` (everything after `host_version:`) — the most-recent
row by `recorded_at` wins (handles host upgrades accumulating multiple version
rows). The `session:` header is populated by
`store.getLatestMetricRow("hook_fired:")` → its `session_id` field (the
session_id of the most-recent hook fire). Both reads use the additive accessor
added in §4.1b — `getMetricSummary` cannot supply either (it returns per-name
aggregates with `MAX(metric_value)` as `latest` and no `session_id`). If either
accessor returns null, the corresponding header prints "unknown" / "none."

### 4.4 Fallback design (concrete for this codebase)

Per the deviation note in §1.1, Phase 0's scope of the fallback is
**declaration only, in `--doctor` output** — auto-activation is deferred to
Phase 1+ pending reporter sign-off (§10 Verify criterion). `--doctor`'s
`fallbackNotice` (non-null iff `degraded`) tells the operator exactly what to do
concretely for THIS codebase:

```
Delivery path degraded. The experimental.chat.system.transform hook does not
reliably land recalled memories in the system prompt. To restore memory delivery
until the hook is fixed:

  1. Ensure the realmemory MCP server is registered in your OpenCode config
     (it exposes the `recall` and `store_memory` tools — the agent can call
     them directly, bypassing the transform hook).
  2. Add this line to your project's AGENTS.md (or the mission-control
     MEMORY.md convention):

       At session start and before any non-trivial task, call the realmemory
       `recall` tool with the project path as the query, and act on the
       returned memories.

  3. Re-run `realmemory-mcp --doctor` after a host upgrade to re-check.
```

**Why this is the right degraded path for this codebase:** the MCP server
([`src/mcp-server.ts`]) already exposes a `recall` tool (9 tools total, per
SYSTEM_MAP §2). That surface does not depend on any `experimental.*` hook — it
is the SDK's stdio transport, which is typed and versioned. The agent calling
`recall` directly is strictly less elegant than auto-injection but is a
known-working path. The AGENTS.md instruction makes the agent consult it
proactively. Auto-activation (Phase 1+, after reporter sign-off) would write
the AGENTS.md line programmatically and/or register a native `tool:` in the
plugin return value (doc §4.7) — both are out of Phase 0 scope.

---

## 5. Alternatives Considered

| Option | Why not chosen |
|--------|----------------|
| **Add a `metadata` JSON column to the `metrics` table** to store `{hook, version, lands}` structuredly, instead of encoding in `metric_name`. | Requires a schema migration (SCHEMA_V5). The hard constraint explicitly forbids it: "No schema migration (additive metrics rows only — the metrics table is name/value/timestamp keyed)." The `metric_name` encoding achieves the same observability with zero migration risk. |
| **Verify landing by reading the system prompt directly** via an OpenCode API like `client.session()` or `client.system()`. | No such API is documented in the plugin context shape ([`src/plugin.ts:14-28`]); the only readback surface available is `client.messages()` (already wrapped by `fetchSessionTranscript` at line 154). Round-1 review established that on the live host (1.18.17) `client.messages()` returns only user/assistant roles — the system prompt is not persisted as a session message. Speculating on an undocumented API would repeat the exact mistake Phase 0 exists to prevent. **Chosen instead:** the honest three-state design (found / observable-absent / unverifiable) that reports `unverifiable` on hosts that don't expose system content, rather than false-alarming. |
| **Inject the sentinel on every transform fire** (not once per session) for faster statistical confidence. | Pollutes the system prompt with a probe token on every turn — visible noise even if HTML-commented. Once-per-session is enough to answer "did the hook land this session" and keeps the diagnostic invisible to the model's reasoning. |
| **Activate the fallback delivery automatically** (write AGENTS.md, register native tool, set a `deliveryDegraded` flag checked in `chat.message`) when `degraded` is true, instead of just printing the notice. | Violates the hard constraint: "Phase 0 is a NO-OP until `--doctor` is invoked." Any auto-fallback that changes delivery behavior before `--doctor` runs is a behavior change. Phase 0 declares; Phase 1+ activates (with reporter sign-off — see §1.1 deviation note). |
| **Use a separate probe-specific SQLite table** (`hook_probe_log`) instead of the metrics table. | Adds a schema object (new table = migration) and a parallel read path. The metrics table already exists for exactly this kind of fire-safe observability row and `getMetricSummary` already aggregates it. Reuse, per ADR-008's "metrics in SQLite" ratification. |
| **Fake a "lands=yes" by treating the in-handler `output.system.includes(token)` assertion as proof of landing.** | Dishonest. The assertion proves the array we were handed contains the token *at the moment we pushed* — it does not prove the host kept the mutation, passed it to the LLM request builder, or that the model saw it. Round-1 review (C1) was specifically about not overclaiming. The assertion is recorded as a *negative* signal only (records `lands=0` if the push was silently dropped at the array level); a successful assertion does NOT record `lands=1`. |
| **Doctor-side derivation rule for `unverifiable`** (transform fired + `event:session.idle` fired + no `hook_lands` row → infer `unverifiable`), instead of persisting every outcome as a metric row. | Round-2 review (2-C1) offered this as option (b). Rejected because it *conflates* `unverifiable` with `fetch-failed` (both leave no `hook_lands` row under the round-2 design) and depends on the idle hook having fired — if `session.idle` never fires on a host, the doctor cannot distinguish `unverifiable` from `unverified`. Persisting every outcome with a distinct value (1/0/-1/-2 — chosen) makes all four states unambiguously reconstructible from store data alone, with no process-memory dependence and no conflation. Cost: one extra metric row per readback (negligible — one row per session.idle fire). |

---

## 6. Intent Constraints

**Classification:** **Additive.** No Active Decision is contradicted; no invariant
is violated. The change adds a diagnostics module + metric rows + a CLI
subcommand. It does not alter the delivery path, the config surface, the public
API, or the schema.

- **ADR-003 / INV-014 (three-dep cap):** Zero new runtime dependencies.
  `src/hook-probe.ts` uses only `MemoryStore` (in-tree) and Node built-ins
  (`process.stdout`, `process.env`). Respects the cap. (Note: INV-014 is already
  violated by `zod` per Drift #6 — Phase 0 does not compound that drift.)
- **ADR-008 (brain-loop behavior + plugin role/boundary):** Phase 0 instruments
  existing handlers; it does NOT register new hooks, does NOT add config knobs
  (the `brain` block is NOT introduced), does NOT change the public/private
  boundary. `hook-probe.ts` is internal (same category as `plugin.ts`).
- **ADR-009 / INV-019 (dist committed to git):** The plan includes a rebuild +
  re-commit of `dist/` (Story 30.2). The `prepare` script cannot bridge this
  because OpenCode installs with `ignoreScripts: true`.
- **INV-017 (non-blocking hooks):** `recordHookFired` is detached and void-wrapped;
  the underlying `recordMetric` is sync-sqlite and fire-safe. The sentinel push is
  pure synchronous state mutation (no DB, no await). The sentinel check runs on
  the existing detached `session.idle` promise. No hook return is delayed. **Design
  risk flagged:** if `recordHookFired`'s detached `getStore()` init is slow on a
  cold first session, the metric row lands slightly after the hook fires, not at
  the literal moment. Acceptable (the probe measures "did the hook fire at all,"
  not microsecond timing) and is the same pattern every other detached hook body
  already uses.
- **INV-005 (schema versioning):** No schema change. SCHEMA_V4 unchanged. New
  metric_name rows are additive data, not schema. The new
  `MemoryStore.getLatestMetricRow` method is an additive *code* addition (new
  method, no existing signature change, no schema change) — consistent with
  INV-005 (it does not touch the schema version) and ADR-008 (metrics-in-SQLite
  pattern).

**No conflict gate required** — classification is Additive, no Active Decision
is superseded. The §1.1 deviation from issue requirement #4 is a **scope
narrowing within an Additive change** (Phase 0 declares the fallback; Phase 1+
activates it), not an intent contradiction — it does not supersede any ADR or
invariant. Reporter sign-off is required per §10 (the issue's own requirement,
not the intent layer).

---

## 7. Design Consistency

**N/A — no user-facing UI.** `--doctor` is a CLI subcommand printing a fixed-width
text table to stdout (no TUI, no color, no design tokens). The graph browser
already surfaces metrics via the generic `/api/metrics` endpoint
([`src/browser/server.ts:193`]); no browser UI change is in scope. A dedicated
"hook health" panel in the browser is a Phase 1+ enhancement → logged to
`PARKING_LOT.md` (out of scope — entry added 2026-08-12 during round-2 revision;
see `PROJECTS/realmemory/PARKING_LOT.md`).

---

## 8. Blast Radius & Regression Risk

| At risk | Why it's in the blast radius | Protection |
|---------|------------------------------|------------|
| The 5 currently-firing plugin hooks (live in this OpenCode env) | Each handler gains a new line at entry. A throwing `recordHookFired` would break the hook. | `recordHookFired` is `void`-wrapped + detached + `recordMetric` is fire-safe (try/catch at `store.ts:1721`). Existing `tests/plugin.test.ts`, `tests/plugin-brain-loop.test.ts`, `tests/plugin-compacting.test.ts` must still pass unchanged. New `tests/plugin-hook-probe.test.ts` asserts the hook still returns normally when the store is unavailable. |
| The system prompt content (sentinel injection) | `experimental.chat.system.transform` now pushes a `<!-- realmemory-probe:<ulid> -->` token once per session, on EVERY fire (including zero-recall sessions). Could theoretically affect model behavior. | HTML comment — invisible to the model's reasoning. One token per session, ~45 chars. Guarded by `sentinelToken !== null` so it fires exactly once. Test asserts the sentinel is present after transform fires and absent on the second fire in the same session, AND present after a zero-recall transform fire (`pendingInjection === null`). |
| `session.idle` transcript fetch (sentinel check adds a call) | `checkSentinelLanded` calls `fetchSessionTranscript` which hits `client.messages()`. If the client is slow/unavailable, the detached promise handles it (existing `fetchSessionTranscript` returns null on error — line 166). | Reuses the existing null-on-error helper. `checkSentinelLanded` records a `hook_lands` row for EVERY outcome (resolves 2-C1): value `0` if a sentinel was pushed AND the transcript returned non-null AND contained ≥1 system-role message without the token (observable-absent — the only `degraded` state); value `1` if found; value `-1` if a non-null transcript had zero system-role messages (the 1.18.17 host → unverifiable, NOT degraded); value `-2` if the transcript fetch returned null (fetch-failed, NOT degraded). A companion `host_capability:persists-system-content` row is recorded alongside. Test covers all four branches with a fixture encoding the real host message shape (roles user/assistant only — see §10). |
| `bin.ts` CLI dispatch (new `--doctor` branch) | A bug in the new branch could break the CLI entry for the default MCP-stdio path if branching is wrong. | `--doctor` is checked first and exits; the existing `ui`/`noBrowser`/default branches are untouched. `tests/bin-dispatch.test.ts` extended to assert `--doctor` exits 0/2/3/1 and does not start an MCP server. |
| `MemoryStore.getLatestMetricRow` (new additive accessor — resolves 2-C1 + 2-C4) | A new method on `MemoryStore`. Although additive (no existing signature/schema change), a bug in its SQL could return wrong rows to `--doctor`. It is NOT called by any existing code path (only `getDoctorReport`). | Pure additive method — `getMetricSummary` and all existing callers are untouched. `tests/hook-probe.test.ts` asserts it returns the most-recent row by `recorded_at` matching the prefix (including `session_id` + `metric_value`) and null when no row matches; `tests/store.test.ts` existing cases unchanged (the method did not exist before). INV-005 (SCHEMA_V4) untouched. |
| `dist/` rebuild (INV-019) | A stale `dist/` would ship uninstrumented code to the live OpenCode install. | Story 30.2 includes `pnpm build` + `git add dist/` + verify the compiled `dist/plugin.js` contains the `recordHookFired` call. `tests/build-assets.test.ts` already guards dist integrity. |
| Metrics table volume | One `hook_fired` row per hook fire per session. `tool.execute.after` fires on every tool call — could be 100s/session. | Each row is ~80 bytes. 1000 rows/session × 100 sessions = 80MB worst case over a long period. Acceptable for a local SQLite diagnostics table; the existing `memory_bloat_ratio` metric and `dedupPass` are unrelated. A future `metrics_retention` config (Phase 1+) can prune — logged to `PARKING_LOT.md` (entry added 2026-08-12 during round-2 revision). Not a Phase 0 blocker. |
| Session-boundary reset on `session.created` | A bug in `resetProbeForSession` could clear `hostVersion` or `hostPersistsSystemContent` (process-lifetime fields that must survive session resets). | `resetProbeForSession` explicitly preserves `hostVersion` and `hostPersistsSystemContent`; test asserts both survive a reset while session-scoped fields are cleared. |

**Migrations:** none. Additive metric rows only; no down migration needed.

---

## 9. Story Breakdown

Two stories, build order. Each becomes a task brief with §6a Intent Constraints
filled from §6 above.

### Story A30.1 — Hook probe module + plugin instrumentation

**As a** realmemory maintainer **I want** every registered plugin hook to record
a `hook_fired` metric and the transform hook to push + verify a landing sentinel
(with honest three-state classification) **so that** ground truth on hook
fire/land status exists in the metrics table without any behavior change to the
live delivery path.

**Acceptance criteria:**
- [ ] `src/hook-probe.ts` exists and exports `ALWAYS_FIRE_HOOKS`,
      `CONDITIONAL_HOOKS`, `PROBED_HOOKS`, `ProbeState`, `createProbeState`,
      `resetProbeForSession`, `resolveHostVersion`, `recordHookFired`,
      `recordLandsOutcome`, `pushSentinel`, `checkSentinelLanded`,
      `getDoctorReport`, `LandsValue`, `DoctorRow`, `DoctorReport`.
- [ ] `ALWAYS_FIRE_HOOKS` = `["event:session.created","event:session.idle",
      "chat.message","experimental.chat.system.transform"]`;
      `CONDITIONAL_HOOKS` = `["tool.execute.after",
      "experimental.session.compacting"]`; `PROBED_HOOKS` is their
      concatenation (6 entries). (Resolves 2-C2.)
- [ ] `MemoryStore.getLatestMetricRow(prefix)` exists in `src/store.ts`
      (additive — new method, no schema change, no existing signature change;
      returns the most-recent row by `recorded_at` matching
      `metric_name LIKE prefix%`, including `session_id` and `metric_value`,
      or null). (Resolves 2-C1 + 2-C4.)
- [ ] All exports are fire-safe (never throw, never reject). `recordHookFired`
      and `recordLandsOutcome` are detached + void-wrapped (INV-017).
- [ ] Each of the 6 instrumentation points in §4.2 (5 hooks, `event` splits into
      created+idle) calls `recordHookFired` at entry, before any config gate.
      File:line references verified: `plugin.ts:271`, `:318`, `:422`, `:514`,
      `:580`, `:602`.
- [ ] `session.created` (line 271) calls `resetProbeForSession(state.probe,
      sessionId)` capturing `sessionId` from `event.properties?.sessionID`,
      BEFORE any config gate. `hostVersion` and `hostPersistsSystemContent`
      survive the reset; session-scoped fields (`sentinelToken`,
      `sentinelPushedAt`, `sentinelChecked`, `lastLandsValue`) are cleared.
- [ ] `recordHookFired` threads `probe.sessionId` through to `recordMetric`'s
      optional `sessionId` arg (`store.ts:1710`).
- [ ] `experimental.chat.system.transform` calls `recordHookFired` AND
      `pushSentinel` **at the very top of the handler, BEFORE the
      `if (!state.pendingInjection) return;` guard at line 584**. The sentinel is
      an HTML comment `<!-- realmemory-probe:<ulid> -->`; pushed exactly once per
      session (second fire in the same session does not push a second token);
      pushed even when `pendingInjection === null` (zero-recall session).
- [ ] `pushSentinel` is PURE (no store access, no IO — resolves 2-C3): it pushes
      the token, verifies `output.system.includes(token)`, and returns
      `{ pushed: boolean, assertionOk: boolean }`. On `pushed && !assertionOk`
      (mock a frozen/replace array that silently drops the push), the HANDLER
      calls `recordLandsOutcome(getStore, state.probe, 0)` to persist
      `hook_lands:experimental.chat.system.transform` = 0. A successful
      assertion does NOT record `lands=1`.
- [ ] `recordLandsOutcome(getStore, probe, value)` records a
      `hook_lands:experimental.chat.system.transform` row with the given
      `LandsValue` (1 / 0 / -1 / -2) and `probe.sessionId`, detached + fire-safe.
- [ ] `session.idle` calls `checkSentinelLanded` on a detached promise,
      independent of the `autoSummarize` gate; it reuses
      `fetchSessionTranscript` (`plugin.ts:154`); it classifies the transcript
      into four outcomes per §4.1 AND **records a `hook_lands` row for EVERY
      outcome** (resolves 2-C1): `found` → value 1, `observable-absent` →
      value 0, `unverifiable` → value -1, `fetch-failed` → value -2. It ALSO
      records a `host_capability:persists-system-content` row (value 1 if any
      system-role message seen, 0 if a non-null transcript had none).
      `hostPersistsSystemContent` is set true if any system-role message is
      seen in any transcript; false if a non-null transcript had none; stays
      null only if fetch failed.
- [ ] Host version is resolved once at plugin init via
      `process.env.OPENCODE_VERSION` → `ctx.client.app?.version` → `"unknown"`,
      and recorded as `host_version:<v>` (value=1) on the first `recordHookFired`
      call of the session.
- [ ] `tests/hook-probe.test.ts` covers: `recordHookFired` writes a
      `hook_fired:<name>` row with the correct `session_id`; `resetProbeForSession`
      clears session-scoped fields and preserves `hostVersion`/`hostPersistsSystemContent`;
      `pushSentinel` pushes once-per-session, is idempotent within a session, AND
      pushes on a zero-recall transform fire (no `pendingInjection`), and returns
      `assertionOk=false` when `output.system` silently drops the push (mock a
      frozen array) — the handler then calls `recordLandsOutcome(...,0)`; the
      `recordLandsOutcome` helper writes a `hook_lands:*` row with value 0;
      `checkSentinelLanded` records a row for ALL FOUR branches (value 1/0/-1/-2)
      AND a `host_capability:persists-system-content` row; `getLatestMetricRow`
      returns the most-recent row by `recorded_at` (including `session_id`) and
      null when no row matches; `getDoctorReport` aggregates rows via
      `getMetricSummary` (fire counts) + `getLatestMetricRow` (lands value,
      session header, host version), sets `degraded` true iff transform
      `lands === "no"`, `inconclusive` true iff zero metric rows total.
- [ ] `tests/plugin-hook-probe.test.ts` covers: each hook still returns normally
      when the store fails to init (probe must not break the hook); the sentinel
      appears in `output.system` after transform fires; the sentinel does NOT
      appear on the second transform fire in the same session; the sentinel
      DOES appear on a transform fire with `pendingInjection === null`.
- [ ] **Host-shape fixture (resolves 1-C1):** `tests/fixtures/host-transcript-1.18.17.json`
      encodes the real host message shape — an array of `{role:"user"|"assistant"}`
      objects with NO system-role rows (matching the live 1.18.17 DB). A test
      asserts `checkSentinelLanded` against this fixture classifies as
      `unverifiable` (value -1), records a `hook_lands` row with value -1 AND a
      `host_capability:persists-system-content=0` row, and `getDoctorReport`
      against a store seeded with that row reports `lands === "unverifiable"`,
      exit 0, NO `DEGRADED` — the 2-C1 end-to-end path (probe → store → doctor)
      is reachable and regression-covered.
- [ ] Existing tests pass unchanged: `pnpm test` green (487 + new tests).
- [ ] `pnpm typecheck` and `pnpm lint` green.

**Experience Script:** see §3a below (shared with Story A30.2's verification —
the `--doctor` command is the observable surface for both stories' end-to-end
proof).

### Story A30.2 — `--doctor` CLI subcommand + dist rebuild

**As a** realmemory maintainer **I want** a `realmemory-mcp --doctor` command
that prints a hook fire/lands table with the four-state exit matrix and loudly
names the fallback path when degraded, plus a rebuilt committed `dist/` **so
that** the live OpenCode install runs the instrumented plugin and I can verify
hook health on demand.

**Acceptance criteria:**
- [ ] `src/bin.ts` `parseArgs` recognizes `--doctor`; the dispatch branch loads
      a store, calls `getDoctorReport`, calls `printDoctorTable` (to
      `process.stdout`), closes the store, and exits per the four-state matrix:
      0 (healthy), 2 (degraded), 3 (inconclusive — empty store), 1 (init
      failure / crash). `--doctor` is mutually exclusive with `--ui` and the
      default MCP-stdio path.
- [ ] `printDoctorTable` output matches the format in §4.3 exactly: header with
      host version (latest `host_version:*` via `getLatestMetricRow`) + session
      (`session_id` of the latest `hook_fired:*` row via `getLatestMetricRow`),
      one row per `PROBED_HOOKS` entry with fires (yes / no / no-evidence) /
      count / last-seen / lands columns, and the appropriate verdict line
      appended per the five lands states (yes / no / unverified / unverifiable /
      fetch-failed) + inconclusive + zero-fires-with-sessions. (Resolves 2-C4 —
      the `session:` header is populatable via the additive `getLatestMetricRow`
      accessor; resolves 2-C2 — conditional hooks show `no-evidence` at zero
      fires and do not trigger degraded.)
- [ ] `tests/bin-doctor.test.ts` covers all exit-code paths: healthy
      (transform lands=yes) → exit 0, no notice; unverifiable (transform
      lands=unverifiable, the 1.18.17 host case — seeded by a `hook_lands` row
      with value -1, REACHABLE from store data — resolves 2-C1) → exit 0,
      `UNVERIFIABLE` notice printed, NO `DEGRADED`; fetch-failed (transform
      lands=fetch-failed — seeded by a `hook_lands` row with value -2) → exit 0,
      `FETCH-FAILED` notice, NO `DEGRADED`; degraded-lands (transform lands=no —
      seeded by a `hook_lands` row with value 0) → exit 2, fallback notice
      printed with the exact AGENTS.md instruction text; degraded-zero-fires
      (store has memories but an ALWAYS-fire hook has fires=no) → exit 2,
      `DEGRADED` + issue-#28 reference; **conditional-zero-not-degraded**
      (store has hook_fired rows for always-fire hooks but
      `experimental.session.compacting` + `tool.execute.after` at zero fires)
      → exit 0, table shows `no-evidence` for those rows, NO `DEGRADED`
      (resolves 2-C2); inconclusive (empty store) → exit 3, `NO DATA` notice;
      crashed (store init throws) → exit 1.
- [ ] `tests/bin-dispatch.test.ts` extended: `--doctor` does not start an MCP
      stdio server or a browser server; process exits with one of {0,1,2,3}.
- [ ] `dist/` rebuilt (`pnpm build`) and re-committed (INV-019, ADR-009). The
      compiled `dist/plugin.js` contains the `recordHookFired` call (grep
      assertion in `tests/build-assets.test.ts` or a new
      `tests/dist-hook-probe.test.ts`).
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.

**Experience Script:** §3a (the `--doctor` run is the end-to-end proof for both
stories).

---

## 3a. Experience Script — `--doctor` command

**Literal walkthrough the Experience Runner replays at build time and again at
Verify (§10).**

```
# Precondition: a realmemory store exists at the configured storagePath with at
# least one session's worth of hook_fired metric rows. If the store is empty,
# the script runs the "inconclusive" path (exit 3). If the store has hook_fired
# rows but the host does not persist system content (the 1.18.17 case), the
# transform row shows lands=unverifiable (latest hook_lands row value = -1,
# persisted by checkSentinelLanded — reachable from store data alone, resolves
# 2-C1) and the command exits 0.

$ node dist/bin.js --doctor

# Expected stdout — HEALTHY (lands=yes), exit 0:
realmemory doctor — hook probe report
host version: <version-or-unknown>
session: <latest-session-id-or-none>

hook                                          fires        count   last-seen             lands
event:session.created                         yes          N       <iso-ts>              na
event:session.idle                            yes          N       <iso-ts>              na
tool.execute.after                            yes|no-evidence N    <iso-ts|—>            na
chat.message                                  yes          N       <iso-ts>              na
experimental.chat.system.transform            yes          N       <iso-ts>              yes
experimental.session.compacting               yes|no-evidence N    <iso-ts|—>            na
# (no further output, exit 0 — a conditional hook at zero fires is "no-evidence",
#  NOT degraded — resolves 2-C2)

# Expected stdout — UNVERIFIABLE (1.18.17 host, lands=unverifiable), exit 0:
# (REACHABLE from store data — the latest hook_lands:experimental.chat.system.transform
#  row has value -1, persisted by checkSentinelLanded — resolves 2-C1)
realmemory doctor — hook probe report
host version: <version-or-unknown>
session: <latest-session-id-or-none>

hook                                          fires        count   last-seen             lands
...                                           ...          ...     ...                   ...
experimental.chat.system.transform            yes          N       <iso-ts>              unverifiable
experimental.session.compacting               yes|no-evidence N    <iso-ts|—>            na

UNVERIFIABLE: this host does not persist system-prompt content in the session
transcript (only user/assistant messages are stored — recorded as
host_capability:persists-system-content=0, verified against OpenCode 1.18.17).
The probe can prove the hook FIRED and that output.system was MUTATED, but
cannot prove the mutation reached the LLM's context. To verify landing
manually: trigger a realmemory recall, then ask the agent whether it sees the
recalled memory in its context. A Phase-1+ mechanism (sentinel-echo: instruct
the model to echo the probe token in its first reply) would make landing
observable on this host.
# (exit 0 — NOT degraded)

# Expected stdout — FETCH-FAILED (lands=fetch-failed), exit 0:
# (REACHABLE — the latest hook_lands row has value -2)
realmemory doctor — hook probe report
...
experimental.chat.system.transform            yes          N       <iso-ts>              fetch-failed
...

FETCH-FAILED: the transform hook fired and a sentinel was pushed, but the
session.idle transcript fetch returned no data (the client was unavailable
or the transcript was too thin). Landing could not be evaluated. Re-run
`realmemory-mcp --doctor` after another session.
# (exit 0 — NOT degraded)

# Expected stdout — DEGRADED (lands=no), exit 2:
realmemory doctor — hook probe report
...
experimental.chat.system.transform            yes          N       <iso-ts>              no
...

DEGRADED: experimental.chat.system.transform fires and output.system is
observable in the transcript, but the sentinel did not land. The hook's
mutation is being dropped downstream.
Fallback delivery path:
  1. Ensure the realmemory MCP server is registered in your OpenCode config...
  2. Add this line to your project's AGENTS.md (or the mission-control MEMORY.md
     convention):
       At session start and before any non-trivial task, call the realmemory
       `recall` tool with the project path as the query, and act on the
       returned memories.
  3. Re-run `realmemory-mcp --doctor` after a host upgrade to re-check.
# (exit 2)

# Expected stdout — INCONCLUSIVE (empty store), exit 3:
realmemory doctor — hook probe report
host version: unknown
session: none

hook                                          fires        count   last-seen             lands
event:session.created                         no           0       —                     na
...                                           ...          ...     ...                   ...

NO DATA — no metric rows found. Run at least one real session with the
realmemory plugin loaded, then re-run `realmemory-mcp --doctor`.
# (exit 3)

# Assertions the Experience Runner checks:
#  - stdout contains "realmemory doctor — hook probe report"
#  - stdout contains exactly one row per PROBED_HOOKS entry (6 rows)
#  - the "experimental.chat.system.transform" row's lands column is one of:
#    yes | no | unverified | unverifiable | fetch-failed
#  - exit code is one of {0, 2, 3} (1 only on crash, not exercised by the
#    seeded-store script)
#  - when exit code is 2, stdout contains "DEGRADED" and "AGENTS.md"
#  - when lands=unverifiable, exit code is 0 (NOT 2) and stdout contains
#    "UNVERIFIABLE" and does NOT contain "DEGRADED"
#  - when lands=fetch-failed, exit code is 0 (NOT 2) and stdout contains
#    "FETCH-FAILED" and does NOT contain "DEGRADED"
#  - a conditional hook (experimental.session.compacting OR tool.execute.after)
#    at zero fires shows fires="no-evidence" and does NOT trigger exit 2
#    (resolves 2-C2)
#  - when exit code is 3, stdout contains "NO DATA"
```

---

## 10. Test & Verification Plan

- **Automated:**
  - `tests/hook-probe.test.ts` — unit tests for the probe module (§9 A30.1
    criteria): metric recording with `session_id`, `resetProbeForSession`
    semantics, sentinel push idempotency + zero-recall push, `pushSentinel`'s
    pure `{pushed, assertionOk}` return + handler-side `recordLandsOutcome(0)`
    on a frozen-array mock (resolves 2-C3), `checkSentinelLanded` recording a
    `hook_lands` row for ALL FOUR outcomes (value 1/0/-1/-2 — resolves 2-C1) +
    `host_capability` row, `getLatestMetricRow` returning the most-recent row
    (incl. `session_id`) / null, `getDoctorReport` aggregation (uses
    `getMetricSummary` for fire counts + `getLatestMetricRow` for lands value /
    session / host version) + `degraded` / `inconclusive` flagging.
  - `tests/fixtures/host-transcript-1.18.17.json` — **encodes the real host
    message shape** (roles user/assistant only, zero system rows, matching the
    live 1.18.17 DB verified during round-1 review). Used by
    `checkSentinelLanded` tests to regression-cover the C1 false-negative class:
    a pushed sentinel + this transcript MUST classify as `unverifiable`, record
    a `hook_lands` row with value -1 + a `host_capability:persists-system-content=0`
    row, and MUST NOT set `degraded=true`. A companion `bin-doctor.test.ts`
    case seeds a store with that -1 row and asserts `getDoctorReport` returns
    `lands === "unverifiable"`, exit 0, `UNVERIFIABLE` notice, NO `DEGRADED` —
    the full probe→store→doctor path is reachable and tested end-to-end
    (resolves 2-C1).
  - `tests/plugin-hook-probe.test.ts` — integration: each hook records
    `hook_fired` on fire; hooks still return normally when store init fails;
    sentinel appears in `output.system` once per session; sentinel appears on
    a zero-recall transform fire (`pendingInjection === null`).
  - `tests/bin-doctor.test.ts` — `printDoctorTable` output format + all exit
    codes (0 healthy / 0 unverifiable / 0 fetch-failed / 2 degraded-lands / 2
    degraded-zero-fires / 0 conditional-zero-not-degraded / 3 inconclusive / 1
    crash) + fallback notice text + `UNVERIFIABLE` notice text + `FETCH-FAILED`
    notice text + `no-evidence` fires column for conditional hooks at zero
    (resolves 2-C1 reachability + 2-C2 no-false-positive).
  - `tests/bin-dispatch.test.ts` (extend) — `--doctor` does not start MCP/browser.
  - `tests/dist-hook-probe.test.ts` (or extend `build-assets.test.ts`) —
    `dist/plugin.js` contains the `recordHookFired` call (guards INV-019).
- **Experience:** the §3a Experience Script — the Experience Runner runs
  `node dist/bin.js --doctor` against a store seeded with metric rows AND
  against the host-shape fixture (to exercise the `unverifiable` path) and
  asserts the table shape + exit code per the four-state matrix. Must return
  PASS before the story clears the build loop.
- **Regression:** the existing **487-test** suite must pass unchanged — the
  probe is additive and must not alter any existing hook's return value or side
  effects. Specifically `tests/plugin.test.ts`, `tests/plugin-brain-loop.test.ts`,
  `tests/plugin-compacting.test.ts`, `tests/browser-metrics.test.ts`,
  `tests/mcp-metrics.test.ts`. (Baseline confirmed via
  `grep -cE '^\s*(it|test)\(' tests/*.test.ts` = 487 during round-2 revision.)
- **Manual / reporter sign-off (resolves 1-C5):** before build begins, Royce
  (the reporter) confirms the §1.1 deviation — Phase 0 narrows issue requirement
  #4 to declaration-only, with auto-activation deferred to Phase 1+. This is a
  named Verify gate: if Royce rejects the narrowing and requests option (a)
  (minimal auto-fallback), the plan re-opens §4.4 and the hard-constraint
  tradeoff before build. Additionally, after build, Royce confirms the
  `--doctor` output matches §3a against the LIVE OpenCode install (the real
  dogfood environment, not a seeded test store) — this is the one criterion that
  proves Phase 0's actual purpose (ground truth from the real host). The
  reporter re-runs `--doctor` after at least one real session in which the
  plugin fired. Autonomous mode may waive the reporter's own re-run per the
  proxy's human-only rules, but the §1.1 sign-off and the Experience Runner PASS
  against a seeded store + the host-shape fixture are never waived.

---

## 11. Rollback Plan

- **Branch:** `issue/30-hook-probe-phase-0` — all commits reference `#30`.
- **Merge:** single merge (or squash) commit per PR; SHA recorded in the issue
  Tracking table.
- **Revert:** `git revert -m 1 <merge SHA>` (or `git revert <squash SHA>`).
- **Migrations:** **none.** Additive metric rows (`hook_fired:*`,
  `hook_lands:*`, `host_capability:*`, `host_version:*`) remain in the `metrics`
  table after revert — they are harmless (read-only consumers `/api/metrics`,
  `get_metrics`, `--doctor` ignore unknown names or simply no longer report
  them). The additive `MemoryStore.getLatestMetricRow` method is removed with
  the code revert (no schema impact, no existing caller — it was only used by
  `getDoctorReport`). No down migration needed; no data implication. If cleanup
  is desired, a one-off `DELETE FROM metrics WHERE metric_name LIKE 'hook_fired:%'
  OR metric_name LIKE 'hook_lands:%' OR metric_name LIKE 'host_capability:%' OR
  metric_name LIKE 'host_version:%'` can be run manually — not required for
  rollback correctness.
- **`dist/`:** the revert restores the prior committed `dist/` automatically
  (dist is committed per INV-019). No separate rebuild step on rollback.
- **Deploy rollback:** N/A — realmemory is a library + stdio MCP server with no
  runtime deploy. The live OpenCode install picks up the reverted `dist/` on
  next plugin reload. Tag rollback per ADR-004 if a release was cut (Phase 0
  would ship as v0.6.0 — if tagged, `npm unpublish` within 72h or bump to
  v0.6.1 with the revert; per release process).
- **PARKING_LOT entries added during round-2 revision** (browser hook-health
  panel, `metrics_retention` config) remain in `PARKING_LOT.md` after rollback —
  they document future enhancements independent of whether Phase 0 ships.

---

## 12. Review Log

| Round | Date | Reviewer verdict | Report | Resolution |
|-------|------|------------------|--------|------------|
| 1 | 2026-08-12 | NEEDS CHANGES | `review-round-1.md` | All 6 comments resolved in round 2 — see below |
| 2 | 2026-08-12 | NEEDS CHANGES | `review-round-2.md` | All 4 comments (2-C1…2-C4) resolved in round 3 — see below |
| 3 | 2026-08-12 | pending (In Review round 3) | — | — |

### Round-1 comment resolutions

- **1-C1 (CRITICAL) — fixed in §1, §2, §4.1, §4.2, §3a, §9, §10.** Redesigned
  the landing verification around the host ground truth the reviewer established
  (1.18.17 persists only user/assistant messages; system prompt is not in any
  readable surface). `checkSentinelLanded` now classifies into four outcomes:
  `found` (record `hook_lands=1`), `observable-absent` (system content present,
  sentinel absent → record `hook_lands=0`, the only `degraded` state),
  `unverifiable` (no system-role messages in transcript → record nothing, host
  cannot expose the signal → exit 0, NOT degraded), `fetch-failed` (record
  nothing). Added `hostPersistsSystemContent` capability flag (set true if any
  system-role message ever observed; until true, zero-sentinel findings are
  unverifiable). `DoctorRow.lands` gains `unverifiable` as a fifth value.
  `getDoctorReport` gains `inconclusive` + `unverifiableNotice`. §2 cites the
  host-behavior evidence (4,786 user / 88,174 assistant / 0 system rows; SDK
  types define only user/assistant). §10 adds `tests/fixtures/host-transcript-1.18.17.json`
  encoding the real host message shape, with a test asserting a pushed sentinel
  against this fixture classifies as `unverifiable` (not `observable-absent`,
  not degraded) — the C1 false-negative class is regression-covered. The
  strongest landing claim from inside the plugin is now the in-handler
  `output.system.includes(token)` assertion after push (records `lands=0` only
  if the array silently dropped the push; a successful assertion does NOT
  record `lands=1`). §3a assertions updated to cover the `unverifiable` path
  (exit 0, `UNVERIFIABLE` notice, no `DEGRADED`).

- **1-C2 — fixed in §4.2, §9 A30.1 criteria.** `recordHookFired` + `pushSentinel`
  now run at the very top of the `experimental.chat.system.transform` handler,
  BEFORE the `if (!state.pendingInjection) return;` guard at line 584. Concrete
  restructured handler body shown in §4.2. New acceptance criterion: the
  sentinel is pushed on a zero-recall transform fire (`pendingInjection === null`),
  and `tests/plugin-hook-probe.test.ts` covers this case explicitly.

- **1-C3 — fixed in §4.1 (`ProbeState`, `resetProbeForSession`), §4.2
  (session-boundary mechanism), §4.3 (host-version selection rule).** Added
  `resetProbeForSession(probe, sessionId)` called from `session.created` (line
  271) before any config gate — clears session-scoped fields (`sentinelToken`,
  `sentinelPushedAt`, `sentinelChecked`, `lastLandsValue`) and captures
  `sessionId` from `event.properties?.sessionID` (same shape already used at
  `plugin.ts:357-358`). `hostVersion` and `hostPersistsSystemContent` are
  preserved (process-lifetime). `recordHookFired` threads `probe.sessionId`
  through to `recordMetric`'s optional `sessionId` arg (`store.ts:1710`), so the
  doctor `session:` header is populatable. Host-version selection rule
  specified: latest `host_version:*` by `recorded_at` (handles upgrades
  accumulating multiple version rows). A session ending without an idle event
  no longer leaks its token into the next session.

- **1-C4 — fixed in §4.1 (`DoctorReport.inconclusive`), §4.3 (four-state exit
  matrix), §3a (assertions), §9 A30.2 criteria.** Defined four exit codes: 0
  (healthy — fires recorded, no positive evidence of non-landing; includes
  `lands=unverifiable` and `lands=unverified`), 2 (degraded — transform
  `lands=no` OR evidence of real sessions exists but ≥1 registered hook has
  `fires=no`, the issue-#28 silent-failure mode), 3 (inconclusive — empty
  store, fresh install, no sessions ran), 1 (crashed — init failure / error).
  The zero-fires-with-sessions condition (the exact issue-#28 failure mode) is
  now degraded, not exit 0. `tests/bin-doctor.test.ts` covers all five paths
  (healthy / unverifiable / degraded-lands / degraded-zero-fires / inconclusive
  / crashed).

- **1-C5 — fixed in §1.1 (deviation note), §4.4, §10 (Verify criterion).**
  Picked option (b): explicitly defer auto-activation to Phase 1+ with a
  reporter sign-off note. Added §1.1 "Deviation note — issue requirement #4"
  mapping requirement #4 → "declared in Phase 0 (doctor notice), activated in
  Phase 1+", with justification (the issue's own hard constraint forbids
  behavior changes before `--doctor` is invoked; a `deliveryDegraded` flag
  checked in `chat.message` is a behavior change that fires before any doctor
  run; auto-writing AGENTS.md is a filesystem side effect on a path the plugin
  does not own). Added a named Verify criterion in §10 requiring Royce to
  confirm the narrowing before build, or to request option (a) which re-opens
  the hard-constraint tradeoff.

- **1-C6 — fixed in §7, §8, §9, §10, plus `PARKING_LOT.md`.** Corrected the
  baseline test count from 498 → **487** (confirmed via
  `grep -cE '^\s*(it|test)\(' tests/*.test.ts` = 487 during round-2 revision;
  noted in §10). The two previously-phantom PARKING_LOT entries are now real:
  added "Browser 'hook health' panel" and "`metrics_retention` config" to
  `PROJECTS/realmemory/PARKING_LOT.md` (2026-08-12), each with justification
  referencing issue #30 Phase 0. §7 and §8 now point at the actual entries
  rather than claiming they exist. Rollback plan §11 notes the PARKING_LOT
  entries persist after rollback (they document future enhancements
  independent of whether Phase 0 ships).

### Round-2 comment resolutions (round 3 submission)

- **2-C1 (CRITICAL) — fixed in §3, §4.1, §4.1b, §4.2, §4.3, §3a, §5, §6, §8,
  §9 (A30.1 + A30.2), §10, §11.** The round-2 design wrote a `hook_lands` row
  for only two of four outcomes and relied on in-memory `ProbeState` fields
  (`hostPersistsSystemContent`, `sentinelToken`) the doctor process could not
  read — making `unverifiable`/`fetch-failed` unreachable from store data and
  the headline `UNVERIFIABLE` verdict unsatisfiable on the real 1.18.17 host.
  **Round-3 fix: persist a `hook_lands:experimental.chat.system.transform` row
  for EVERY readback outcome, with the outcome encoded in the metric VALUE**
  (`1` found / `0` observable-absent / `-1` unverifiable / `-2` fetch-failed),
  plus a companion `host_capability:persists-system-content` (1/0) row. All
  four `DoctorRow.lands` states (plus `unverified` = no row at all) are now
  constructible from store data alone — no process-memory dependence. Added a
  new additive store accessor `MemoryStore.getLatestMetricRow(prefix)`
  (§4.1b) returning the most-recent row by `recorded_at` matching
  `metric_name LIKE prefix%`, including `metric_value` and `session_id` —
  `getMetricSummary` cannot serve this (its `latest` is `MAX(metric_value)`,
  not the most-recent row's value, and it returns no `session_id`). §3a's
  UNVERIFIABLE block is now explicitly marked REACHABLE (latest `hook_lands`
  row value -1); a new FETCH-FAILED block (value -2) added. §5 records the
  rejected alternative (doctor-side derivation rule — rejected because it
  conflates `unverifiable` with `fetch-failed` and depends on `session.idle`
  having fired). §10's `bin-doctor.test.ts` now seeds a -1 row and asserts the
  full probe→store→doctor path returns `lands === "unverifiable"`, exit 0, no
  `DEGRADED`. Same failure class as 1-C1, now closed at both boundaries
  (transcript AND metrics table).

- **2-C2 — fixed in §4.1 (`ALWAYS_FIRE_HOOKS`/`CONDITIONAL_HOOKS`), §4.3 (exit
  matrix + verdict text), §3a (HEALTHY example), §9 (A30.1 + A30.2 criteria),
  §10.** The round-2 zero-fires-with-sessions degraded rule applied to ALL
  registered hooks, false-positiving on `experimental.session.compacting`
  (fires only on host compaction) and `tool.execute.after` (silent in a
  chat-only session) — a healthy install with no compaction printed DEGRADED +
  "file an issue." **Round-3 fix: split `PROBED_HOOKS` into `ALWAYS_FIRE_HOOKS`**
  (`event:session.created`, `event:session.idle`, `chat.message`,
  `experimental.chat.system.transform` — fire every real session) **and
  `CONDITIONAL_HOOKS`** (`tool.execute.after`, `experimental.session.compacting`).
  The zero-fires degraded trigger is scoped to ALWAYS-fire hooks only; a
  conditional hook at zero fires shows `fires: "no-evidence"` in the table and
  does NOT trigger exit 2. §3a's HEALTHY example now shows
  `experimental.session.compacting` and `tool.execute.after` as
  `yes|no-evidence` with exit 0, consistent with §4.3's matrix. A new
  `bin-doctor.test.ts` case (`conditional-zero-not-degraded`) asserts a store
  with always-fire rows but conditional hooks at zero exits 0 with no
  `DEGRADED`. §4.3, §3a, and A30.2 now describe one consistent rule.

- **2-C3 — fixed in §4.1 (`pushSentinel` signature + `recordLandsOutcome`),
  §4.2 (handler snippet + prose), §9 A30.1 criteria, §10.** The round-2
  `pushSentinel(probe, output): boolean` was declared PURE yet specified to
  "record `hook_lands=0` immediately" on assertion failure — unimplementable
  (no store access). **Round-3 fix: `pushSentinel` is now genuinely pure** —
  it pushes the token, verifies `output.system.includes(token)`, and returns
  `{ pushed: boolean, assertionOk: boolean }` (no store, no IO). The HANDLER,
  which has `getStore` in scope, inspects the return and on
  `pushed && !assertionOk` calls a new `recordLandsOutcome(getStore, probe, 0)`
  helper (detached, fire-safe — INV-017) to persist the negative signal. The
  §4.2 handler snippet is updated to the new call shape; A30.1's frozen-array
  criterion asserts `pushSentinel` returns `assertionOk=false` on a frozen
  array and the handler then calls `recordLandsOutcome(...,0)`. Signature
  written down; no Worker invention required.

- **2-C4 — fixed in §3, §4.1b, §4.3 (header + selection rule), §6 (INV-005),
  §8 (blast radius), §9 (A30.1 + A30.2 criteria), §10, §11.** The round-2
  `session:` header had a write path (`probe.sessionId` → `recordMetric`'s
  `sessionId` arg) but no read path — `getMetricSummary` returns no
  `session_id`, so the header always printed "none." **Round-3 fix: add the
  additive `MemoryStore.getLatestMetricRow(prefix)` accessor** (the same one
  that resolves 2-C1) — `--doctor` calls `getLatestMetricRow("hook_fired:")`
  and reads the returned `session_id` for the header, and
  `getLatestMetricRow("host_version:")` for the host version (parsing the
  version from `metric_name`). §4.3's selection rule rewritten to use the
  accessor. Additivity confirmed in §4.1b + §6 (INV-005: new method, no schema
  change, no existing signature change) and §8 (blast-radius row: only
  `getDoctorReport` calls it; `tests/hook-probe.test.ts` asserts its
  behavior + null-on-no-match; existing `store.test.ts` cases unchanged). §11
  notes the method is removed with the code revert (no data impact).
