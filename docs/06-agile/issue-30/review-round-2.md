# Plan Review — Issue #30, Round 2

**Reviewer:** Anymake Plan Reviewer (fresh context — round 2)
**Plan:** `docs/06-agile/issue-30/plan.md` @ "In Review (round 2)", 2026-08-12
**Issue:** https://github.com/R3dy/RealMemory/issues/30 — "[Feature] Hook probe: prove every registered hook fires AND lands (synthetic-brain Phase 0)"
**Code state checked:** `103effe` (main, post issue #28 merge) — plus live host ground truth: OpenCode 1.18.17 (`~/.opencode/`, DB at `~/.local/share/opencode/opencode.db`)
**Location:** `PROJECTS/realmemory/repo/docs/06-agile/issue-30/review-round-2.md`

---

## Verification notes (what was actually checked)

- **§4.2 line citations — all accurate.** `plugin.ts:271` (session.created branch), `:318` (session.idle), `:357-358` (`event.properties?.sessionID` shape — verified for the idle branch; the plan's reuse of it for session.created is an assumption, but the plan handles absence gracefully), `:422`/`:429` (tool.execute.after + fast-no-op), `:514`/`:518` (chat.message + role return), `:580`/`:584`/`:591` (transform + early return + push), `:602` (compacting), `:614` (memory_bloat_ratio), `:154`/`:166-168` (fetchSessionTranscript + null-on-error), `:207` (state literal — currently has no `probe`/`sessionId`, plan adds both). `bin.ts:18` parseArgs / `:41` dispatch. `store.ts:1707-1724` recordMetric (fire-safe try/catch at `:1721`, optional `sessionId` at `:1710`). `browser/server.ts:193` `/api/metrics` — generic `getMetricSummary` pass-through, confirmed. `mcp-server.ts` exposes 9 tools including `recall` — §4.4 fallback claim accurate. Metrics schema (SCHEMA_V4, `session_id TEXT`) confirmed at `db/schema.ts:136`.
- **Host ground truth re-verified independently:** live DB `message` table roles = `assistant` (88,252) + `user` (4,788), **zero system rows** — the plan's §2 premise holds. SDK types (`~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:42,101`) define `role: "user"` and `role: "assistant"` only. The installed `@opencode-ai/plugin` **does** type both `experimental.*` hooks (`plugin/dist/index.d.ts:261,274`) — the plan's §2 side-observation disclosing its own stale framing is honest.
- **Intent layer spot-checked:** ADR-003 (3-dep cap, Drift #6 zod violation open), ADR-008 (plugin boundary, INV-017 ratified), ADR-009 (dist committed), INV-005/014/017/019 — all verbatim as §6 claims. Plan's classification "Additive" is correct.
- **1-C6 fixes verified in reality:** test baseline = **487** (`grep -cE '^\s*(it|test)\(' tests/*.test.ts` — confirmed); both PARKING_LOT entries (browser hook-health panel, `metrics_retention`) exist in `PROJECTS/realmemory/PARKING_LOT.md` with issue-#30 justifications.
- **Decisive negative finding:** `getMetricSummary` (`store.ts:1731-1784`) returns `{metric_name, count, sum, avg, latest, latest_at}` — **no `session_id`, no raw rows**. There is no store accessor that returns per-row `session_id` values.

## Round-1 resolution check

| Comment | Resolution sound? |
|---------|-------------------|
| 1-C1 | **Partially.** Probe-side redesign is sound (four-outcome classification, `hostPersistsSystemContent` capability flag, in-handler assertion records only the negative signal — §5 row 6 explicitly refuses to fake `lands=1`; fixture test regression-covers the false-negative class). **But the doctor-side readout is broken** — the `unverifiable` verdict cannot be produced from the data `--doctor` can read. See 2-C1. |
| 1-C2 | **Fixed.** Handler restructure is concrete and matches the real code; zero-recall push criterion added. |
| 1-C3 | **Mostly fixed.** `resetProbeForSession` + preserved process-lifetime fields + host-version selection rule (latest by `recorded_at` — constructible from `getMetricSummary.latest_at`). **Read-side gap remains** for the `session:` header — see 2-C4. |
| 1-C4 | **Partially.** Four-state matrix + inconclusive + zero-fires-with-sessions = degraded correctly captures the issue-#28 signature. **But the rule overshoots to conditionally-firing hooks** — a healthy install reports DEGRADED whenever no compaction happened. See 2-C2. |
| 1-C5 | **Fixed.** §1.1 deviation note is explicit; §10 carries a named reporter sign-off gate. |
| 1-C6 | **Fixed and verified** (487 baseline, real PARKING_LOT entries). |

## Checklist

| # | Dimension | Result | Evidence |
|---|-----------|--------|----------|
| 1 | **Root cause verified** | **FAIL** | Motivation and host ground truth independently re-verified (zero system-role rows; SDK types user/assistant only). But the plan's replacement evidence chain breaks at the doctor: the headline `unverifiable` verdict is read from a surface that never carries it (2-C1) — the same failure class as 1-C1, moved one process boundary over. |
| 2 | **Solves the reported issue** | **FAIL** | Req #1 (fires) mechanism sound; req #3 surfaces verified generic/existing; req #4 narrowing now explicit with sign-off gate (1-C5 fixed). Req #2 (lands) and the fire-side degraded rule each retain a path where the report is wrong on a healthy install (2-C1, 2-C2). |
| 3 | **Scope matches the issue** | PASS | Phase 0 only. No `brain` config, no ReflexCache/inhibition/working-memory/prediction-error/schema-formation/native tools. The one system-prompt touch is the issue's own sentinel mechanism. |
| 4 | **Intent consistency** | PASS | Verified against DECISIONS.md/INVARIANTS.md myself: ADR-003 (zero new deps; Drift #6 honestly noted, not compounded), ADR-008 (no new hooks/config; `hook-probe.ts` internal), ADR-009/INV-019 (dist rebuild + grep assertion in A30.2), INV-017 (detached + fire-safe), INV-005 (SCHEMA_V4 untouched, additive rows). Classification "Additive" correct. |
| 5 | **Design consistency** | N/A | Library type; CLI text table + existing generic metrics endpoint. No UI. |
| 6 | **Blast radius honest** | PASS | All 5 hook keys (6 instrumentation points) named; metrics consumers (`/api/metrics` server.ts:193, `get_metrics` MCP tool) verified generic; regression files named all exist; volume analysis present; session-reset preservation covered. |
| 7 | **Stories buildable** | **FAIL** | A30.2's `unverifiable` criterion is unsatisfiable from store data (2-C1); `pushSentinel` cannot record `hook_lands=0` as specified (2-C3); the doctor `session:` header has no read path (2-C4). |
| 7a | **Experience Script present** | **FAIL** | §3a is literal and runnable in form, but its UNVERIFIABLE expected output is unreachable under the plan's own data flow (2-C1), and its HEALTHY example shows `experimental.session.compacting <yes|no>` with exit 0 — contradicting §4.3's matrix when "no" (2-C2). |
| 8 | **Test plan sufficient** | **FAIL** | The 1.18.17 host-shape fixture correctly regression-covers the C1 class at the `checkSentinelLanded` level. But `tests/bin-doctor.test.ts` cannot construct the `lands=unverifiable` case from any store state, since no metric row encodes it (2-C1) — the exact host case the plan is built for is untestable end-to-end as specified. |
| 9 | **Rollback complete** | PASS | Real revert command; additive rows harmless with optional manual DELETE; dist restored by revert (INV-019); conditional tag handling per ADR-004. |
| 10 | **Security** | PASS | No auth/authz/tenant/secret/payment surface. Sentinel is a self-generated ULID in an HTML comment; the fallback notice writes nothing automatically. |

---

## Comments

### 2-C1 — The `unverifiable` lands state is unreachable from the data `--doctor` can read

**Plan section:** §4.1 (`checkSentinelLanded` outcomes, metric-name encoding decision, `DoctorRow.lands`, `getDoctorReport`), §4.3 (exit matrix, verdict lines), §3a (UNVERIFIABLE expected output), §9 A30.2 (unverifiable criterion), §10 (`bin-doctor.test.ts`)

**Problem:** `--doctor` runs in its own process and its only input is the store: `getDoctorReport(store)` reads metric rows via `getMetricSummary`. The plan's four-outcome classification writes rows for exactly two outcomes — `found` (`hook_lands=1`) and `observable-absent` (`hook_lands=0`) — and explicitly writes **nothing** for `unverifiable` and `fetch-failed` ("the absence of a `hook_lands:*` row … is itself the signal"). The state that distinguishes those two unrecorded outcomes — `probe.hostPersistsSystemContent`, `probe.sentinelToken`, whether a readback was attempted — lives only in the **plugin process's** in-memory `ProbeState`. It never crosses into the store. Verified against the code: `getMetricSummary` (`store.ts:1731-1784`) returns per-name aggregates only; no accessor returns anything else about metrics. Consequences:

1. On the real 1.18.17 host (the case this plan is built for), the doctor sees `hook_fired:experimental.chat.system.transform` rows and no `hook_lands` row — and per the plan's own rule can only report `unverified` ("session.idle has not yet completed a readback … Re-run after another session"). That message is wrong on this host and wrong **forever** — re-running changes nothing. The exit code stays 0 (no false DEGRADED — the C1 false-negative is avoided), but the plan's central honesty deliverable — the `UNVERIFIABLE` notice explaining what can and cannot be proven and how to verify manually — is unreachable.
2. §3a's "UNVERIFIABLE (1.18.17 host, lands=unverifiable), exit 0" expected output cannot occur under the described mechanism; the Experience Runner cannot observe it.
3. A30.2's criterion "unverifiable (transform lands=unverifiable, the 1.18.17 host case) → exit 0, `UNVERIFIABLE` notice printed" is unsatisfiable: `tests/bin-doctor.test.ts` cannot construct a store state that makes `getDoctorReport` return `lands === "unverifiable"`, because no metric row encodes it.
4. `unverifiable` and `fetch-failed` are indistinguishable to the doctor by construction, so the plan's stated distinction ("unverifiable if a readback was attempted and `hostPersistsSystemContent` is false") is unevaluable in the process that must evaluate it.

This is 1-C1's failure class — claiming a surface carries a signal it does not carry — shifted from the host transcript to the metrics table.

**Required change:** Make every `DoctorRow.lands` value constructible from store data alone. Fixed looks like (architect chooses the mechanism): either (a) `checkSentinelLanded` persists every outcome — e.g. a metric row for `unverifiable`/`fetch-failed` under a distinct metric_name or sentinel value, and/or a `host_capability:persists-system-content=yes|no` row when the capability is determined — so `getDoctorReport` can reconstruct all four states; or (b) an explicitly specified doctor-side rule over available rows (e.g. transform fired AND `event:session.idle` fired with no `hook_lands` row → `unverifiable`), with the `fetch-failed` conflation acknowledged in the notice text. Whichever is chosen: update §4.1 (encoding + `getDoctorReport`), §4.3, §3a's UNVERIFIABLE block, A30.1/A30.2 criteria, and the `bin-doctor.test.ts` plan so the 1.18.17 case is reachable, printable, and testable end-to-end.

### 2-C2 — The zero-fires-with-sessions degraded rule false-positives on conditionally-firing hooks

**Plan section:** §4.3 (exit matrix code 2, degraded-zero-fires verdict text), §3a (HEALTHY example), §9 A30.2 (degraded-zero-fires criterion)

**Problem:** The degraded rule is "evidence of real sessions exists … but ≥1 registered hook has `fires === 'no'`". That correctly captures the issue-#28 signature (entry point dead → **all** hooks silent) but over-generalizes to hooks that legitimately do not fire in a healthy session. `experimental.session.compacting` fires only when the host decides to compact the context — most sessions never compact (verified: the handler at `plugin.ts:602` is purely reactive to a host event; nothing the plugin does can make it fire). `tool.execute.after` is likewise silent in a zero-tool-call session. Since any real session writes `hook_fired:event:session.created` rows, "evidence of real sessions" is always present after one session — so `--doctor` on a perfectly healthy install with no compaction prints `DEGRADED: experimental.session.compacting registered 0 fires despite evidence of real sessions. The host is silently discarding this hook key`, exits 2, and tells the operator to "file an issue." That is a false DEGRADED on the most common healthy state — the exact outcome the round-1 brief asked to eliminate. The plan contradicts itself on this: §3a's HEALTHY (exit 0) example shows the compacting row as `<yes|no>`, but under §4.3's stated matrix the "no" case is exit 2.

**Required change:** Re-scope the zero-fires degraded condition so a healthy install cannot trip it. Fixed looks like (architect chooses): restrict the any-hook-zero rule to hooks that must fire in every real session (`event:session.created`, `event:session.idle`, `chat.message`, `experimental.chat.system.transform`), or require the full #28 signature (every always-fire hook at zero), and give conditionally-firing hooks (`experimental.session.compacting`, `tool.execute.after`) a distinct non-degraded "no evidence expected this session" treatment in the table/verdict. Align §4.3's matrix and verdict text, §3a's HEALTHY example, and A30.2's degraded-zero-fires criterion so they describe one rule consistently.

### 2-C3 — `pushSentinel` cannot record `hook_lands=0` as specified

**Plan section:** §4.1 (`pushSentinel` signature + in-handler assertion), §4.2 (handler snippet), §9 A30.1 (frozen-array criterion)

**Problem:** `pushSentinel` is declared `export function pushSentinel(probe: ProbeState, output: { system?: string[] }): boolean` — "PURE synchronous state mutation (the existing hook contract)" — yet its spec also says it "records a `hook_lands:experimental.chat.system.transform` = 0 row immediately" when the post-push `includes` assertion fails. The function has no store, no `getStore`, and no callback parameter, and the §4.2 handler snippet passes none — recording a metric requires the store. A Worker implementing the signature literally cannot satisfy the behavior; a Worker implementing the behavior must invent a signature the plan doesn't specify.

**Required change:** Pick one and write it down: either extend `pushSentinel`'s signature with a recorder (a `getStore` it fire-and-forgets, or a `recordLands(value)` callback the handler supplies — INV-017-safe, never-throwing either way), or move the assertion-failure recording out of `pushSentinel` into the handler body (which has `getStore` in scope). Update §4.1's signature and prose, the §4.2 snippet, and A30.1's frozen-array criterion to match.

### 2-C4 — The doctor `session:` header has no read path

**Plan section:** §4.2 (`state.sessionId` threading rationale), §4.3 (`session:` header + output format), §3a (header in expected output), §9 A30.2 (format criterion)

**Problem:** 1-C3's fix threads `probe.sessionId` into `recordMetric`'s optional `sessionId` arg (write side — verified present at `store.ts:1710,1718`) so the header is "populatable." But nothing on the read side returns it: `getMetricSummary` returns per-name aggregates (`count, sum, avg, latest, latest_at`) with no `session_id` (verified `store.ts:1731-1784`), and `getDoctorReport(store)` is specified to read the summary. As specified, `session:` always prints "none" — the plan's own stated purpose for the threading ("so the doctor `session:` header is populatable") is not achieved.

**Required change:** Specify the read path or drop the line. Fixed looks like: add a small additive store accessor to `MemoryStore` (e.g. latest `session_id` among `hook_fired:*` rows by `recorded_at`) and name it in §4.1/§4.3 and A30.1/A30.2, or remove the `session:` header from the §4.3 format and §3a expectations. (An accessor is additive and consistent with ADR-008's metrics-in-SQLite pattern; either resolution is acceptable.)

---

## Verdict

**VERDICT: NEEDS CHANGES** — comments 2-C1…2-C4 must be resolved; architect revises and resubmits for round 3.

**Summary:** The round-2 revision is honest, well-evidenced, and fixes 1-C2, 1-C5, and 1-C6 cleanly (all verified against code, host DB, and PARKING_LOT). But the 1-C1/1-C4 fixes are incomplete at the process boundary: the probe writes no row for `unverifiable`, so the doctor can never print the plan's headline UNVERIFIABLE verdict on the real host (2-C1), and the zero-fires degraded rule flags healthy installs that simply never compacted (2-C2). Two smaller buildability gaps (`pushSentinel`'s impossible recording, the unpopulatable `session:` header) round out the round. The design's *shape* is right; the data flow across the plugin-process/doctor-process boundary needs one more pass.
