# Validation Report — Issue #30 (synthetic-brain Phase 0 hook probe)

**PR:** https://github.com/R3dy/RealMemory/pull/31
**Branch:** `issue/30-hook-probe-phase-0`
**Plan:** `docs/06-agile/issue-30/plan.md` (1365 lines, 3 review rounds, APPROVED)
**Date:** 2026-08-12

---

## Verdict: **FAIL**

The implementation code is correct — every code-verifiable criterion passes,
the security checklist is clean, and no intent constraint is violated. The
failure is narrow but mandatory: **four runtime-verifiable acceptance criteria
from plan §9 lack the automated test coverage the plan explicitly requires.**
Per the Validator decision tree (rule 4: "Any runtime-verifiable criterion
with no automated test coverage → FAIL"), this goes back to the worker.

The Experience Runner PASS and the 526/531 green tests confirm the *code*
works; the *test suite* does not yet prove it works for these four criteria.

---

## 1. Acceptance-criteria verification

### Story A30.1 — Hook probe module + plugin instrumentation

| # | Criterion | Type | Result | Evidence |
|---|-----------|------|--------|----------|
| 1 | `src/hook-probe.ts` exists and exports all 14 required symbols | Code | **PASS** | `src/hook-probe.ts:27-44` (`ALWAYS_FIRE_HOOKS`, `CONDITIONAL_HOOKS`, `PROBED_HOOKS`); `:51` (`LandsValue`); `:58-67` (`ProbeState`); `:78` (`createProbeState`); `:95` (`resetProbeForSession`); `:108` (`resolveHostVersion`); `:126` (`recordHookFired`); `:160` (`recordLandsOutcome`); `:197` (`pushSentinel`); `:243` (`checkSentinelLanded`); `:325-343` (`DoctorRow`, `DoctorReport`); `:383` (`getDoctorReport`); `printDoctorTable` exported at `:523`. All 14 present. |
| 2 | `ALWAYS_FIRE_HOOKS`=4, `CONDITIONAL_HOOKS`=2, `PROBED_HOOKS`=6 with the exact split | Code | **PASS** | `src/hook-probe.ts:27-32` (4 entries: session.created, session.idle, chat.message, transform); `:38-41` (2 entries: tool.execute.after, session.compacting); `:44` (`PROBED_HOOKS = [...ALWAYS_FIRE_HOOKS, ...CONDITIONAL_HOOKS]` = 6). Matches plan §9 exactly. |
| 3 | `MemoryStore.getLatestMetricRow(prefix)` exists, additive, returns most-recent row by `recorded_at` with `session_id`+`metric_value`, null on no match | Code | **PASS** | `src/store.ts:1796-1819`. New method, no schema change, no existing signature change. Query: `SELECT ... WHERE metric_name LIKE ? ORDER BY recorded_at DESC LIMIT 1` with `${prefix}%`. Returns `{metric_name, metric_value, session_id, recorded_at} | null`. Additive — only caller is `getDoctorReport`. |
| 4 | `MemoryStore.count()` exists, additive | Code | **PASS** | `src/store.ts:1826-1832`. `SELECT COUNT(*) FROM memories WHERE status='active'`. New method, additive. |
| 5 | All 6 instrumentation points call `recordHookFired` at entry, before any config gate | Code | **PASS** | `src/plugin.ts:296` (session.created, after resetProbeForSession at :293, before auto-recall try block); `:346` (session.idle, before brainLoop gate); `:473` (tool.execute.after, before `autoCapture===false` return at :478); `:568` (chat.message, before `role !== "user"` return at :570); `:640` (transform, before `!pendingInjection` return at :649); `:669` (session.compacting, before detached hygiene). All 6 verified at entry, before gates. |
| 6 | `session.created` calls `resetProbeForSession` capturing `sessionID` from `event.properties?.sessionID` before any config gate; preserves `hostVersion`/`hostPersistsSystemContent` | Code | **PASS** | `src/plugin.ts:291-296`. `sid` from `event.properties?.sessionID`; `resetProbeForSession(state.probe, sid)` at :293 before `recordHookFired` at :296 and before auto-recall. `resetProbeForSession` (`hook-probe.ts:95-102`) clears session-scoped fields only, preserves `hostVersion` + `hostPersistsSystemContent`. |
| 7 | `recordHookFired` threads `probe.sessionId` to `recordMetric`'s optional `sessionId` arg | Code | **PASS** | `src/hook-probe.ts:134`: `store.recordMetric(\`hook_fired:${hookName}\`, 1, probe.sessionId ?? undefined)`. |
| 8 | `experimental.chat.system.transform` calls `recordHookFired` AND `pushSentinel` at top, BEFORE `!pendingInjection` guard; sentinel is HTML comment `<!-- realmemory-probe:<ulid> -->`; once-per-session; pushed on zero-recall | Code | **PASS** | `src/plugin.ts:640-649`. `recordHookFired` at :640, `pushSentinel` at :641, `!pendingInjection` return at :649. `pushSentinel` (`hook-probe.ts:197-218`): once-per-session guard at :202; token = `<!-- realmemory-probe:${generateUlid()} -->` at :205; pushes regardless of `pendingInjection` (it has no knowledge of it). |
| 9 | `pushSentinel` is PURE (no store/IO); returns `{pushed, assertionOk}`; on `pushed && !assertionOk` handler calls `recordLandsOutcome(getStore, probe, 0)` | Code | **PASS** | `src/hook-probe.ts:197-218` — pure synchronous, no store/IO. Returns `{pushed, assertionOk}`. Handler at `src/plugin.ts:645-647`: `if (r.pushed && !r.assertionOk) recordLandsOutcome(getStore, state.probe, 0)`. |
| 10 | `recordLandsOutcome(getStore, probe, value)` records `hook_lands:experimental.chat.system.transform` with given `LandsValue`, detached + fire-safe | Code | **PASS** | `src/hook-probe.ts:160-177`. Detached `void (async () => {...})().catch(() => {})`, records `hook_lands:experimental.chat.system.transform` with value, threads `probe.sessionId`. |
| 11 | `session.idle` calls `checkSentinelLanded` detached, independent of autoSummarize gate; records `hook_lands` row for ALL FOUR outcomes + `host_capability` row | Code | **PASS** | `src/plugin.ts:346-363` (detached `void (async () => {...})().catch(() => {})`, before brainLoop gate at :367). `checkSentinelLanded` (`hook-probe.ts:243-319`) records `hook_lands` for all 4: found→1 (`:267`), observable-absent→0 (`:290`), unverifiable→-1 (`:309`), fetch-failed→-2 (`:254`); + `host_capability:persists-system-content` for found(1)/observable-absent(1)/unverifiable(0); fetch-failed records no host_capability row (correct — null transcript). |
| 12 | Host version resolved once at init via env → ctx.client.app.version → "unknown", recorded as `host_version:<v>` on first `recordHookFired` | Code | **PASS** | `resolveHostVersion` (`hook-probe.ts:108-113`): env → ctx → "unknown". Called at `plugin.ts:243`. `recordHookFired` records `host_version:${probe.hostVersion}` at `hook-probe.ts:142-146` on first call (guarded by `sentinelToken===null && !sentinelChecked`). |
| 13 | `tests/hook-probe.test.ts` covers the specified unit cases | Runtime | **PASS** | `tests/hook-probe.test.ts` (447 lines, 114 it/test blocks). Covers: `recordHookFired` writes row with session_id; `resetProbeForSession` clears session fields + preserves hostVersion; `pushSentinel` once-per-session (:176), idempotent (:188), zero-recall (:194), frozen/non-array → assertionOk=false (:203); `recordLandsOutcome` writes value-0 row (:219); `checkSentinelLanded` all 4 branches (:237 found, :257 observable-absent, :273 unverifiable, :292 fetch-failed) + host_capability rows; `getLatestMetricRow` most-recent + null; `getDoctorReport` degraded/inconclusive/unverifiable/conditional-zero. |
| 14 | **`tests/plugin-hook-probe.test.ts`** covers: hooks return normally when store fails; sentinel in output.system; no second-fire sentinel; sentinel on zero-recall transform | Runtime | **FAIL** | **File does not exist.** `ls tests/*.test.ts` shows no `plugin-hook-probe.test.ts`. Coverage analysis: (a) "each hook still returns normally when the store fails to init" — **no test found anywhere** (`grep -rn "store fails|init.*fail|rejecting getStore|returns normally" tests/` → 0 matches in plugin-hook context). (b) sentinel appears in output.system — covered only at unit level (`hook-probe.test.ts:183`), not at the plugin handler integration level. (c) no second-fire sentinel — covered at unit level (`:188-191`). (d) sentinel on zero-recall — covered at unit level (`:194-200`). The plan explicitly named this file and required plugin-handler-level coverage; (a) is entirely uncovered. |
| 15 | Host-shape fixture `tests/fixtures/host-transcript-1.18.17.json` + test asserting `checkSentinelLanded` classifies as unverifiable, records -1 + host_capability=0, doctor reports `lands==="unverifiable"` exit 0 no DEGRADED | Runtime | **PASS** | `tests/fixtures/host-transcript-1.18.17.json` exists. `tests/hook-probe.test.ts:273-300` asserts `lastLandsValue==="unverifiable"` + hook_lands=-1 row; `:350-358` asserts `getDoctorReport` `degraded===false` + `unverifiableNotice` set; `:414-429` asserts `printDoctorTable` exit 0 + "UNVERIFIABLE" + no "DEGRADED". |
| 16 | Existing tests pass; typecheck + lint green | Runtime | **PASS** | Pre-established: 526/531 pass (5 failures pre-existing EADDRINUSE); typecheck clean; lint 0 errors. |

### Story A30.2 — `--doctor` CLI subcommand + dist rebuild

| # | Criterion | Type | Result | Evidence |
|---|-----------|------|--------|----------|
| 17 | `src/bin.ts` `parseArgs` recognizes `--doctor`; dispatch loads store, calls `getDoctorReport`+`printDoctorTable`, exits per four-state matrix (0/2/3/1); mutually exclusive with `--ui` and MCP-stdio | Code | **PASS** | `src/bin.ts:38-39` (`--doctor` flag); `:52-71` dispatch: `new MemoryStore` → `init` → `printDoctorTable` → `close` → `process.exit(exitCode)`, catch → `process.exit(1)`. `if (doctor) ... else if (ui) ... else if (noBrowser) ... else` — mutually exclusive chain. |
| 18 | `printDoctorTable` output matches §4.3 format (header with host version + session, one row per PROBED_HOOKS, fires/count/last-seen/lands, verdict lines per five lands states + inconclusive + zero-fires) | Code | **PASS** | `src/hook-probe.ts:523-609`. Header (`:537-539`), 6 rows from `PROBED_HOOKS` (`:546-554`), verdict lines for inconclusive (`:559-566`), fallback/DEGRADED-lands (`:569-571`), unverifiable (`:572-574`), fetch-failed (`:575-577`), zero-fires DEGRADED (`:580-605`). |
| 19 | **`tests/bin-doctor.test.ts`** covers all 8 exit-code paths (healthy/unverifiable/fetch-failed/degraded-lands/degraded-zero-fires/conditional-zero-not-degraded/inconclusive/crashed) | Runtime | **FAIL** | **File does not exist.** Coverage was consolidated into `tests/hook-probe.test.ts` `printDoctorTable` describe (`:396-446`), but only **3 of 8 required paths** are asserted at the exit-code level: inconclusive→3 (`:405`), unverifiable→0 (`:426`), degraded-lands→2 (`:443`). **Missing exit-code assertions:** healthy(lands=1)→0, fetch-failed(lands=-2)→0 at printDoctorTable level, degraded-zero-fires→2 at printDoctorTable level, conditional-zero→0 at printDoctorTable level, crashed(store init throws)→1. The `getDoctorReport`-level tests cover some of the boolean logic but do NOT assert the exit code that `--doctor` actually returns. The `crashed→exit 1` path (bin.ts catch block) has no test at all. |
| 20 | **`tests/bin-dispatch.test.ts` extended:** `--doctor` does not start MCP stdio or browser server; process exits with one of {0,1,2,3} | Runtime | **FAIL** | `tests/bin-dispatch.test.ts:41-46` adds `parseArgs(["--doctor"])` assertions only. The criterion's dispatch-level claims — "does not start an MCP stdio server or a browser server" and "process exits with one of {0,1,2,3}" — are **not tested**. No spawn/child_process test invokes `bin.js --doctor` and asserts no MCP/browser startup + exit code ∈ {0,1,2,3}. |
| 21 | `dist/` rebuilt and re-committed; compiled `dist/plugin.js` contains `recordHookFired` (grep assertion in `tests/build-assets.test.ts` or new `tests/dist-hook-probe.test.ts`) | Runtime | **FAIL** | **dist is correct** (verified: `grep -c recordHookFired dist/plugin-entry.js` = 7 occurrences; `dist/bin.js` rebuilt 2026-08-12 18:11). **But no automated test asserts this.** `grep -n "recordHookFired|hook-probe|hook_fired" tests/build-assets.test.ts` → 0 matches. No `tests/dist-hook-probe.test.ts` exists. The plan explicitly required a grep assertion in one of these two files; neither has it. The build is correct but unprotected by a regression test. |
| 22 | `pnpm test`, `pnpm typecheck`, `pnpm lint` all green | Runtime | **PASS** | Pre-established: 526/531 (5 pre-existing EADDRINUSE), typecheck clean, lint 0 errors. |

---

## 2. Security checklist

| Check | Result | Evidence |
|-------|--------|----------|
| Non-public endpoints require auth | N/A | realmemory is a library + stdio MCP server; no HTTP endpoints added. `--doctor` is a local CLI diagnostic (reads local SQLite store). |
| User data access authorization | N/A | No new data access paths; `--doctor` reads only the local store the process already owns. |
| User input validated | N/A | No user input processed; `--doctor` takes no arguments. `parseArgs` (`src/bin.ts:21-42`) only matches known flags, ignores unknowns. |
| Parameterized queries | **PASS** | `getLatestMetricRow` (`src/store.ts:1805-1810`) uses `.prepare(...).get(\`${prefix}%\`)` — parameterized. `count` (`:1828-1830`) is a fixed string with no interpolation. All other probe writes go through existing `recordMetric` (already parameterized). |
| File upload validation | N/A | No uploads. |
| No secrets in committed code | **PASS** | Scan of `src/hook-probe.ts`, `src/plugin.ts`, `src/bin.ts`, `src/store.ts` — no `sk_`, `pk_`, connection strings, or API keys. Probe tokens are ULIDs, not secrets. |
| API responses expose no stack traces | **PASS** | `--doctor` catch block (`src/bin.ts:66-71`) prints `err.message` only, not stack. |

**Security verdict: PASS.** No security failures.

---

## 3. Intent-consistency check

Intent layer: `docs/SYSTEM_MAP.md`, `docs/DECISIONS.md`, `docs/INVARIANTS.md`.

| Constraint | Result | Evidence |
|------------|--------|----------|
| ADR-003 (no new runtime deps) | **PASS** | `package.json:70-75` — dependencies unchanged: `@huggingface/transformers`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`. No additions. |
| ADR-008 (no new hooks/config/boundary change in Phase 0) | **PASS** | No new plugin hooks registered — instrumentation added to *existing* hooks only. No new config keys. No behavior change: probe writes are detached + fire-safe, the delivery path (`pendingInjection` push) is untouched. `--doctor` is a new CLI subcommand, not a runtime behavior change (reads-only, invoked manually). |
| ADR-009 / INV-019 (dist committed) | **PASS** | `dist/plugin-entry.js` rebuilt (2026-08-12 18:11), contains `recordHookFired` calls (7 occurrences). `dist/bin.js` rebuilt. Committed on the branch. |
| INV-017 (non-blocking) | **PASS** | All probe exports are detached + void-wrapped: `recordHookFired` (`hook-probe.ts:131-151`), `recordLandsOutcome` (`:165-176`), `checkSentinelLanded` invocation (`plugin.ts:350-361`). None throw into the host hook. |
| INV-005 (no schema migration) | **PASS** | `getLatestMetricRow` + `count` are additive methods on `MemoryStore` — new SELECT queries against existing `metrics`/`memories` tables. No `db/schema.ts` changes, no new migration. |

**Intent verdict: PASS.** No ADR or invariant contradicted.

---

## 4. Experience Script (§3a) coverage

The plan's §3a Experience Script (`--doctor` command drive-through) is covered. Pre-established: Experience Runner PASS — `node dist/bin.js --doctor` produces the expected 6-row table, correct exit code 2 (degraded, zero hook_fired rows because probe was just installed; store has memories from prior sessions = session evidence), and the degraded message matching §3a format.

**No Human-Only criteria.** All criteria are code- or runtime-verifiable.

---

## 5. Failure summary

Four runtime-verifiable criteria fail due to **missing automated test coverage** (decision tree rule 4). The underlying *code* is correct for all of them — the test suite simply does not prove it:

1. **Criterion 14** — `tests/plugin-hook-probe.test.ts` does not exist. The "hooks return normally when store fails to init" sub-criterion has zero test coverage anywhere. The other three sub-criteria (sentinel in output.system, no second-fire, zero-recall) are covered only at the `pushSentinel` unit level, not at the plugin-handler integration level the plan requires.

2. **Criterion 19** — `tests/bin-doctor.test.ts` does not exist. Coverage consolidated into `hook-probe.test.ts` covers only 3 of 8 required exit-code paths at the `printDoctorTable` level. Missing: healthy→0, fetch-failed→0, degraded-zero-fires→2, conditional-zero→0, crashed→1.

3. **Criterion 20** — `tests/bin-dispatch.test.ts` extended only with `parseArgs` assertions. The dispatch-level claims ("does not start MCP/browser", "exits ∈ {0,1,2,3}") are not tested.

4. **Criterion 21** — `dist/` is correctly rebuilt and contains `recordHookFired`, but no automated grep assertion exists in `tests/build-assets.test.ts` or a new `tests/dist-hook-probe.test.ts` to protect against future regressions.

---

## 6. Required changes (for worker)

1. **Create `tests/plugin-hook-probe.test.ts`** (or add an equivalently-named describe block) covering all four sub-criteria at the **plugin handler level** (not just `pushSentinel` unit tests):
   - Each registered hook returns normally when `getStore()` rejects / store init fails (probe must not break the hook).
   - Sentinel appears in `output.system` after `experimental.chat.system.transform` fires.
   - Sentinel does NOT appear on the second transform fire in the same session.
   - Sentinel DOES appear on a transform fire with `pendingInjection === null`.

2. **Add exit-code-path tests** for the 5 missing `--doctor` paths. Either create `tests/bin-doctor.test.ts` or extend the `printDoctorTable` describe in `hook-probe.test.ts` with:
   - healthy (lands=1) → exit 0, no notice.
   - fetch-failed (lands=-2) → exit 0, FETCH-FAILED notice, no DEGRADED.
   - degraded-zero-fires (always-fire at 0 + session evidence) → exit 2, DEGRADED, issue-#28 reference.
   - conditional-zero-not-degraded → exit 0, no DEGRADED.
   - crashed (store init throws) → exit 1. *(Requires spawning `bin.js --doctor` against a store path that fails init, OR refactoring bin.ts to expose the dispatch for testing.)*

3. **Extend `tests/bin-dispatch.test.ts`** (or add a new test) that spawns `node dist/bin.js --doctor` and asserts: (a) no MCP stdio server starts, (b) no browser server starts, (c) exit code ∈ {0,1,2,3}.

4. **Add a dist grep assertion** — either in `tests/build-assets.test.ts` or a new `tests/dist-hook-probe.test.ts` — that reads `dist/plugin-entry.js` (or `dist/plugin.js`) and asserts it contains `recordHookFired`.

---

## 7. Notes

- The implementation itself is high-quality and faithful to the plan. The 3-round plan review is reflected in the code: the four landing outcomes, the always-fire/conditional split, the pure `pushSentinel`, the additive `getLatestMetricRow`, and the four-state exit matrix are all implemented exactly as specified.
- 39 new tests were added (`tests/hook-probe.test.ts` is thorough at the unit level), and the Experience Runner confirms the end-to-end `--doctor` path works on the real store.
- The failure is purely a test-coverage gap against the plan's explicit per-criterion test requirements, not a code defect. The worker consolidated some coverage into `hook-probe.test.ts` rather than creating the named files, and in doing so dropped several required assertions (exit-code paths, store-failure resilience, dist grep).
- Security and intent layers are clean — no escalation needed on either axis.
