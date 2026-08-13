# Plan Review — Issue #30, Round 1

**Reviewer:** Anymake Plan Reviewer (fresh context — round 1)
**Plan:** `docs/06-agile/issue-30/plan.md` @ "In Review (round 1)", 2026-08-12
**Issue:** https://github.com/R3dy/RealMemory/issues/30 — "[Feature] Hook probe: prove every registered hook fires AND lands (synthetic-brain Phase 0)"
**Code state checked:** `103effe` (main, post issue #28 merge) — plus live host ground truth: OpenCode 1.18.17 install at `~/.local/share/opencode/`
**Location:** `PROJECTS/realmemory/repo/docs/06-agile/issue-30/review-round-1.md`

---

## Verification notes (what was actually checked)

- **§4.2 line citations — all accurate.** `plugin.ts:271` (session.created branch), `:318` (session.idle), `:422` (`tool.execute.after`, fast-no-op at :429), `:514` (`chat.message`, role return at :518), `:580` (transform, `!pendingInjection` return at :584, push at :591), `:602` (compacting), `:614` (`memory_bloat_ratio`). `fetchSessionTranscript` at `:154` (null-on-error at `:166`). `PluginState` at `:30`, state literal at `:207`. `bin.ts` `parseArgs` at `:18`, dispatch at `:41`. `recordMetric` at `store.ts:1707` (fire-safe try/catch at `:1713-1723`), `getMetricSummary` at `:1731` (count + latest_at per name). `/api/metrics` at `browser/server.ts:193` — generic pass-through, confirmed. `plugin-entry.ts` matches ADR-009 shape.
- **Issue fetched via `gh api`** and compared against the plan (requested behaviors #1–4, scope boundary, Restated Understanding).
- **Intent layer read:** DECISIONS.md (ADR-003/006/008/009, Drift #6), INVARIANTS.md (INV-005/014/017/019) — mapped 2026-08-12, fresh as claimed.
- **Host ground truth (decisive for C1):** the live OpenCode 1.18.17 DB (`~/.local/share/opencode/opencode.db`) `message` table contains **only** `role:"user"` (4,786 rows) and `role:"assistant"` (88,174 rows) — zero system-role rows. The installed SDK types (`@opencode-ai/sdk/dist/gen/types.gen.d.ts:42,101`) define message roles as `"user"` and `"assistant"` only. The assembled system prompt is not persisted as a session message.
- **Side observations (not plan defects):** the issue's own Tracking table points at `docs/06-agile/issue-29/...` paths and branch `issue/29-hook-probe` — wrong issue number; the orchestrator should correct the issue body at execution. The installed host's `@opencode-ai/plugin` now *does* type the `experimental.*` hooks; the plan's "absent from the published Hooks type" framing is stale for 1.18.17 but the runtime-recognition risk the probe addresses is real, so this does not affect the verdict.

## Checklist

Every dimension gets a result. FAIL requires a numbered comment below.

| # | Dimension | Result | Evidence |
|---|-----------|--------|----------|
| 1 | **Root cause verified** — motivation real; cited mechanism produces the claimed evidence | **FAIL** | Motivation (silent hook discard; #28, Epic #3 prior art; doc §4.2/§6) is accurately grounded. But the plan's central evidence mechanism — sentinel readback from the session transcript via `client.messages()` — fails spot-check: the live host persists only user/assistant messages, so the sentinel can never be observed. C1. |
| 2 | **Solves the reported issue** | **FAIL** | Requirement #2 (prove landing) cannot work as designed (C1). Requirement #4 ("falls back automatically … degrades delivery") is narrowed to a printed notice without flagging the deviation (C5). |
| 3 | **Scope matches the issue** | PASS | Pure diagnostics. No ReflexCache, inhibition, working-memory window, prediction error, schema formation, native tools, or `brain` config block anywhere in §4/§9. The one system-prompt touch (sentinel) is the issue's own requested mechanism. |
| 4 | **Intent consistency** | PASS | ADR-003: zero new deps (in-tree + Node builtins). ADR-008: no new hooks/config; `hook-probe.ts`/`bin.ts` inside the internal/standalone boundary. ADR-009/INV-019: dist rebuild + grep assertion present (Story A30.2). INV-017: detached + void-wrapped + fire-safe `recordMetric`. INV-005: SCHEMA_V4 untouched, additive rows. INV-014 zod drift acknowledged accurately, not compounded. |
| 5 | **Design consistency** | N/A | No user-facing UI (library type; CLI text table + existing generic metrics endpoint). |
| 6 | **Blast radius honest** | PASS | All 5 registered hook keys identified (6 instrumentation points with the `event` split). Consumers of `metrics` named (`/api/metrics`, `get_metrics` MCP tool, browser) and verified generic. Regression files named all exist. Volume analysis present. |
| 7 | **Stories buildable** | **FAIL** | A30.1's sentinel criterion contradicts §4.2 prose and is unreachable in zero-recall sessions (C2). "Per session" probe semantics are under-specified against process-scoped plugin state; the doctor `session:` header is unpopulatable (C3). Baseline test count wrong (498 vs actual 487 — C6). |
| 7a | **Experience Script present** | PASS | §3a is literal and runnable (`node dist/bin.js --doctor`, exact stdout shape, explicit assertions). Its expectations will need revision under C1/C4, but presence/form is satisfied. |
| 8 | **Test plan sufficient** | **FAIL** | Suite structure is good (unit + plugin integration with mocked ctx + bin dispatch + dist grep), but every transcript fixture is a mock — no test can catch the C1 false-negative. The test plan must encode the real host transcript shape; see C1 required change. |
| 9 | **Rollback complete** | PASS | Real revert command, no migration (additive rows harmless, optional manual DELETE provided), dist restored by revert (INV-019), tag/release handling conditional per ADR-004. |
| 10 | **Security** | PASS | No auth/authz/tenant-isolation/secret/payment surface touched. Sentinel is a self-generated ULID in an HTML comment; fallback notice writes nothing automatically. |

---

## Comments *(required for every FAIL — each specific and actionable)*

### 1-C1 — The landing check observes a surface that never contains the signal

**Plan section:** §4.1 (`checkSentinelLanded`), §4.2 (sentinel check in `session.idle`), §5 (rejected alternative row 2), §3a
**Problem:** The entire "lands" verdict bets that the sentinel pushed into `output.system` appears in the text returned by `fetchSessionTranscript` → `client.messages()`. Verified against the live host (OpenCode 1.18.17): the session store persists **only** `user` and `assistant` messages (opencode.db `message` table: 4,786 user / 88,174 assistant rows, zero system rows), and the SDK message types define only those two roles (`@opencode-ai/sdk/dist/gen/types.gen.d.ts:42,101`). The assembled system prompt — the thing `output.system` mutates — is not persisted as a session message, so `fetchSessionTranscript` (`plugin.ts:154-184`) can never return text containing the sentinel. Consequence: on a perfectly healthy delivery path, `checkSentinelLanded` records `hook_lands=0` on every session, and `--doctor` prints DEGRADED forever — a permanent false negative on the exact deliverable Phase 0 exists to provide. The plan's own §1 defines landing as "reaches the model **and is observable in the session transcript**"; the mechanism satisfies neither half. This is the same class of unverified-assumption failure (trust a surface without checking what it contains) that Phase 0 was chartered to eliminate.
**Required change:** Redesign the landing verification so its evidence can actually exist on an observable surface, and cite host-behavior evidence for the chosen surface. Fixed looks like: (a) the check observes something the host demonstrably persists or exposes — e.g., an assistant-message observable elicited by the sentinel, or another surface the architect demonstrates carries system-prompt-derived content (the design choice is the architect's); (b) the plan cites concrete evidence (host version + DB/API shape) that the chosen surface carries the signal; (c) `checkSentinelLanded` gains a third outcome — "signal unobservable on this host" (record nothing, distinct `lands` state in `DoctorRow` and the §3a table) vs "observable and absent" (record 0) — so a healthy install can never be reported DEGRADED by construction; (d) §10 gains a test fixture encoding the real host message shape (roles user/assistant only) so the C1 false-negative class is regression-covered; (e) §3a, `DoctorRow.lands`, and the doctor table updated to match.

### 1-C2 — Sentinel-push criterion is placed behind the `pendingInjection` early return

**Plan section:** §4.2 (sentinel push prose) vs §9 Story A30.1 acceptance criterion 4
**Problem:** The prose says the sentinel is pushed "(or even when there is no pending injection — the sentinel is independent of recall delivery)". But the handler early-returns at `plugin.ts:584` (`if (!state.pendingInjection) return;`), and the criterion says `pushSentinel` is called "after the existing `output.system.push`" (line 591) — reachable only when `pendingInjection` is non-null. A Worker implementing the criterion literally produces a probe that never pushes a sentinel in a zero-recall session — i.e., a fresh project, the most common new-adopter state and precisely where silent-failure detection matters. In those sessions no check ever runs and the transform row shows "unverified" forever.
**Required change:** Make the criterion match the stated design: `pushSentinel` runs on every transform fire (once-per-session guard), placed before or independent of the `pendingInjection` early return; state explicitly how the handler body is restructured; add an acceptance criterion covering the zero-recall session (first transform fire with `pendingInjection === null` still pushes exactly one sentinel).

### 1-C3 — "Per session" probe semantics under-specified against process-scoped state

**Plan section:** §4.1 (`ProbeState`, `recordHookFired`), §4.2, §4.3 (`session:` header)
**Problem:** `PluginState` is process-scoped (instantiated once per plugin load, `plugin.ts:207`; sessions are sequential within the host process). The plan's per-session claims have no mechanism: (1) nothing resets probe state on `session.created` — the only reset is the sentinel clear inside `checkSentinelLanded` on idle, so a session ending without an idle event leaks its token into the next session, which then never pushes or verifies; (2) `recordHookFired(getStore, probe, hookName)` has no sessionId parameter and `recordMetric`'s optional `sessionId` (`store.ts:1710`) is never passed, so the §4.3 doctor header `session: <last session_id seen in metrics>` is unpopulatable — it will always print "none"; (3) after a host upgrade multiple `host_version:*` metric_names accumulate and the rule for which one `--doctor` prints is unspecified.
**Required change:** Define the session-boundary mechanism (e.g., rekey/reset `ProbeState` on `session.created`, tracking sessionID from event properties); either thread sessionId through to `recordMetric` or delete the `session:` line from the §4.3 format; specify the host-version selection rule (e.g., latest by `recorded_at`).

### 1-C4 — `--doctor` exit 0 conflates "verified healthy" with "no data / hooks never fired"

**Plan section:** §4.3, §3a (precondition note + assertions), §9 Story A30.2 criterion 3
**Problem:** With an empty metrics table every row shows `fires=no` and the command exits 0 ("not degraded — no sentinel has been pushed yet"). But "host ran real sessions and zero `hook_fired` rows exist" is exactly the issue-#28 silent-failure mode — the plugin never fired at all. `degraded` is defined solely by the transform row's `lands` value, so the **fire** half of issue requirement #1 has no exit-code consequence: a CI guard (the plan's own stated use for exit 2) gets exit 0 whether the plugin is verified-healthy or never fired. A truly empty store (fresh install, never used) is indistinguishable from "broken plugin" under this scheme.
**Required change:** Define a third outcome — "inconclusive / no data" — with its own printed verdict and non-zero-but-distinct exit (or an explicit operator-facing "NO DATA — run a session first" that is not exit 0); make "evidence of real sessions (any metric/memory rows) but ≥1 registered hook with zero fires" a degraded condition, since a hook that never fires fails the issue's requirement #1. Update §3a's assertions and A30.2's criteria to cover all three states (healthy / degraded / inconclusive).

### 1-C5 — Issue requirement #4 ("falls back automatically") narrowed without flagging the deviation

**Plan section:** §4.4 (also §5 row 4)
**Problem:** The issue's Requested behavior #4 ("Falls back automatically: if the transform hook does not land, degrades delivery to a known-working path") and its confirmed Restated Understanding ("define an automatic fallback if delivery is broken") describe automatic degradation. The plan delivers declaration-only (manual instructions printed by `--doctor`) and defers all activation to Phase 1+. The engineering rationale (the issue's own "no-op until `--doctor` is invoked" constraint) is sound and the plan is transparent in §4.4/§5 — but it nowhere states plainly that this narrows confirmed requirement #4, nor does it obtain or schedule reporter sign-off on the narrowing. A plan approved against the requirement of record must make its deviations from that record explicit.
**Required change:** Add an explicit deviation note (§1 or §4.4) mapping issue requirement #4 → "declared in Phase 0 (doctor notice), activated in Phase 1+", and add reporter confirmation of this narrowing as a named criterion in §10's Verify step (or record the confirmation before build).

### 1-C6 — Housekeeping: phantom PARKING_LOT entries; wrong test-count baseline

**Plan section:** §7, §8 (metrics-volume row), §9/§10
**Problem:** §7 and §8 assert a browser "hook health" panel and a `metrics_retention` config were "logged to `PARKING_LOT.md`" — neither entry exists in `PROJECTS/realmemory/PARKING_LOT.md` (grep-verified) and there is no repo-level PARKING_LOT.md. §9/§10 cite a "498-test" existing suite; the actual count is 487 (`grep -cE '^\s*(it|test)\(' tests/*.test.ts`).
**Required change:** Actually log both parking-lot entries (or remove the claims), and correct the baseline to 487 so the Worker/Validator compare against reality.

---

## Verdict

**VERDICT: NEEDS CHANGES** — comments 1-C1…1-C6 must be resolved; architect revises and resubmits for round 2.

**Summary:** The plan is well-evidenced on citations, scope, and intent compliance — every file:line reference spot-checked accurate, and the intent-layer analysis is honest. But its core mechanism fails verification: the sentinel landing check reads a transcript that, on the real host, never contains system-prompt content, so Phase 0 would report DEGRADED on every healthy install forever (1-C1). Around that central defect sit a self-contradictory sentinel-placement criterion (1-C2), unspecified session-boundary semantics (1-C3), exit-code semantics that call the exact failure mode this probe exists to catch "healthy" (1-C4), an unflagged narrowing of issue requirement #4 (1-C5), and housekeeping claims that don't check out (1-C6).
