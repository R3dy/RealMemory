# Plan Review — Issue #32, Round 1

**Reviewer:** Anymake Plan Reviewer (fresh context — round 1)
**Plan:** `PROJECTS/realmemory/repo/docs/06-agile/issue-32/plan.md` @ In Review (round 1)
**Issue:** https://github.com/R3dy/RealMemory/issues/32 — Synthetic-brain Phase 1: ReflexCache + tool.execute.before warn inhibition (`type:feature`)
**Code state checked:** `9444aaf` (main, v0.6.0, post-issue-#30 hook probe) — verified against the working tree at `PROJECTS/realmemory/repo/`
**Location:** `PROJECTS/realmemory/repo/docs/06-agile/issue-32/review-round-1.md`

---

## Checklist

Every dimension gets a result. FAIL requires a numbered comment below.

| # | Dimension | Result | Evidence |
|---|-----------|--------|----------|
| 1 | **Root cause verified** — the file:line trace in plan §2 was checked against the actual code and motivation is real (feature) | PASS | `src/plugin.ts` (692 lines): the `realmemoryPlugin` default export returns an object at line 282 with 5 hook handlers: `event`, `tool.execute.after`, `chat.message`, `experimental.chat.system.transform`, `experimental.session.compacting`. `tool.execute.before` is genuinely absent. `src/hook-probe.ts:38` `CONDITIONAL_HOOKS = ["tool.execute.after", "experimental.session.compacting"]` — `tool.execute.before` is not probed either. The motivation (all writable behavioral gates unused) is verified against design doc §2 table. |
| 2 | **Solves the reported issue** — plan §4 demonstrably resolves the §1 problem statement | PASS | §4.1 builds `src/reflex.ts` with `ReflexCache`, `compileRule`, `buildReflexCache`, `matchCall`, `emptyReflexCache` — matches design doc §3.1 interface. §4.2 wires a new `tool.execute.before` handler with `warn`-only action (queues a note into `pendingInjection`, does NOT mutate args or throw) — matches design doc §4.3 `warn` grade. §4.3–4.4 add config + hook-probe wiring. Matches design doc §5 Phase 1 row ("Reflex cache + inhibition (`warn`)"). |
| 3 | **Scope matches the issue** — nothing built beyond what the issue needs | PASS | `rewrite`/`block` excluded: `ReflexRule.action` is `"warn"` only (§4.1 comment: "Phase 1: 'warn' only. 'rewrite' and 'block' are Phase 4."); config `inhibition` is `"off" \| "warn"` only. `permission.ask`/`chat.params`/`tool.definition` excluded — not mentioned in implementation. Prediction error (Phase 2) excluded — not in plan. `arousal` field included as stub (always 0) matching design doc §3.1 — forward-looking type field, not scope creep. `preferences` array populated but unused in Phase 1 — harmless forward-looking structure. |
| 4 | **Intent consistency** — §6 classification is correct; no Active Decision or invariant contradicted without a resolved conflict gate | FAIL | See 1-C1. INV-017 amendment is a contradiction, not a clarification — requires a superseding ADR before execution. ADR-008, ADR-009, INV-014, INV-019 all preserved (verified). |
| 5 | **Design consistency** — §7 complete for UI-touching changes | N/A | No UI changes. `reflex_fire` metrics visible via existing `get_metrics` MCP tool and `/api/metrics` endpoint — no new UI. Correctly marked N/A. |
| 6 | **Blast radius honest** — §8 names the real shared paths; protections exist | FAIL | See 1-C2. §8 names plugin load path, config defaults, session.created, transform hook, hook probe, test suite — but misses the race between `chat.message`'s detached recall (assignment overwrite at `plugin.ts:617`) and `tool.execute.before`'s append to `pendingInjection`. The claim "if both are staged, they're concatenated" is not guaranteed under the race. |
| 7 | **Stories buildable** — §9 criteria are specific and testable; a Worker could build from these | PASS | A32.1: 9 acceptance criteria — exports listed by name, `compileRule` logic described (command/filePath/user_preference/no-match), `buildReflexCache` search params specified (`types`, `minWeight: 0.3`, `sortBy: "weight"`, `sortOrder: "desc"`, `limit: 200`), `matchCall` behavior specified, latency assertion `<5ms` via `performance.now()` is a hard test, rule cap enforced, `emptyReflexCache` return shape specified, no new deps. A Worker could build this. A32.2: 13 acceptance criteria — handler registration, `recordHookFired` at top, config gates, synchronous `matchCall`, `pendingInjection` queue, session.created cache build, `PluginState` field, `CONDITIONAL_HOOKS` entry, `MemoryStoreConfig.brain` field, `DEFAULTS.brain`, config toggle test, metric recording test, tsup + dist. Specific and testable. |
| 7a | **Experience Script present** — every story has a literal Experience Script or explicit N/A justification | PASS | A32.1: "N/A — pure logic module with no runtime-verifiable UI/CLI behavior. The Experience Runner will verify the integrated behavior in A32.2." — justified. A32.2: 6-step literal walkthrough (seed memory → load plugin → trigger session.created → call tool.execute.before with matching call → assert pendingInjection contains `[realmemory reflex]` → assert metric row exists). Steps are action/expected-result, not a restatement of criteria. |
| 8 | **Test plan sufficient** — repro becomes a regression test; Experience Script named; blast-radius tests named; no "works correctly" language | PASS | Latency assertion (`<5ms` via `performance.now()`) named in §9 A32.1 and §10 `tests/reflex.test.ts`. Config toggle test named in §9 A32.2 and §10 `tests/plugin-reflex.test.ts`. Metric recording test named (query via `getMetricSummary`/`getLatestMetricRow`). Existing 543-test regression named in §9 A32.2 and §10. Experience Script from §9 A32.2 referenced in §10. No "works correctly" language — criteria are specific assertions. |
| 9 | **Rollback complete** — §11 has real branch/revert/migration-down steps, not placeholders | PASS | Branch: `issue/32-reflex-warn-inhibition`. Merge: single squash. Revert: `git revert -m 1 [merge SHA]` (or `git revert [squash SHA]`) — correct for both merge and squash strategies. Migrations: none (additive metrics rows, in-RAM cache). Intent layer: revert INV-017 amendment section or superseding ADR if written. Deploy: `npm run build` (tsup) to rebuild `dist/` after revert, or `git checkout main -- dist/`. Version: 0.6.0 → 0.7.0 MINOR (pre-1.0 semver per ADR-004). Real commands, no placeholders. |
| 10 | **Security** — no auth/authz/tenant-isolation/secret/payment surface weakened | PASS | `warn` only — handler does not block, rewrite, or throw. Does not weaken any security surface. A malicious memory with `metadata.command: "npm install"` would cause a false-positive warn on every `npm install` call — but the warn is advisory (one-line note appended to system prompt), doesn't block the tool call, and the user can inspect and `forget` the memory (design doc §4.3 guardrail: "every rule traces to a memory ID the user can inspect and forget"). This is a UX concern (design doc §7: "false-positive warn wastes a turn"), not a security concern. INV-001 (secrets scrubbed): ReflexCache reads from the store where memories are already scrubbed — no new unscrubbed path. No ESCALATE needed. |

---

## Comments *(required for every FAIL — each specific and actionable)*

### 1-C1 — INV-017 amendment is a contradiction, not a clarification; superseding ADR required before execution

**Plan section:** §6 (Intent Constraints) + §4.5 (INV-017 amendment)

**Problem:** The plan classifies the INV-017 amendment as "Additive" and says: "No superseding ADR needed (INV-017 amendment is a clarification, not a contradiction — the original invariant said 'non-blocking'; the amendment says 'non-blocking for deliberative-path, synchronous <5ms for reflex-path'). If the reviewer classifies this as a contradiction, a superseding ADR-010 (two-pathway constraint) will be written before execution."

The original INV-017 (verified in `docs/INVARIANTS.md:39`) reads: "**All** OpenCode plugin hooks... are **non-blocking (fire-and-forget)**: store/recall/summarize work runs on detached promises (`void (async () => {...})()`)." The enforcement column says: "`src/plugin.ts` (every handler wraps its body in `void (async () => {...})().catch(...)`)."

The amendment introduces a synchronous pathway: "Reflex-path hooks (`tool.execute.before`, and future `permission.ask`/`chat.params`/`tool.definition`) are synchronous, must complete within 5ms, and may only read `ReflexCache`." The new `tool.execute.before` handler in §4.2 does NOT wrap its body in `void (async () => {...})()` — `matchCall` is a synchronous call, and the note queuing is a string assignment.

This is a contradiction, not a clarification:
- The original uses an absolute quantifier ("**All** OpenCode plugin hooks are non-blocking").
- The amendment narrows it to "deliberative-path hooks are non-blocking; reflex-path hooks are synchronous."
- "All hooks are non-blocking" and "some hooks are synchronous" are mutually exclusive.
- The original's enforcement mechanism (`void (async () => {...})()` on every handler) would be violated by the new handler.

Per `docs/DECISIONS.md` "Superseding a Decision" section: "The only legitimate way to contradict a past decision... A superseding ADR requires a gate — explicit user approval, or the Product Owner Proxy in autonomous mode. An agent never supersedes a decision on its own authority."

The plan makes the ADR conditional ("if the reviewer classifies this as a contradiction") rather than committing to it. As the reviewer, I classify this as a contradiction.

**Required change:** Commit to writing a superseding ADR-010 (two-pathway constraint) BEFORE execution — not conditionally. Update §6 classification from "Additive" to "Additive with one superseding ADR (ADR-010)." The ADR must:
1. Name INV-017 as the invariant being amended.
2. State the two-pathway constraint (deliberative-path: detached, unbounded; reflex-path: synchronous, <5ms, cache-only).
3. Justify the amendment (the design doc §3 argument: synchronous gates are incompatible with detached promises).
4. Be gated through the Product Owner Proxy (autonomous mode) or Royce.

Update `docs/INVARIANTS.md` INV-017 row as part of the execution (Cartographer refresh), not deferred.

### 1-C2 — Race condition: `chat.message` detached recall overwrites warn notes queued by `tool.execute.before`

**Plan section:** §8 (Blast Radius) + §4.2 (New `tool.execute.before` handler) + §3 (Flows)

**Problem:** §8 names `experimental.chat.system.transform` as a shared path and claims: "Warn notes are queued into `pendingInjection` — same mechanism as recall. If both are staged, they're concatenated." The protection says: "Test: recall + warn note coexist in pendingInjection."

This claim is not guaranteed. The `chat.message` handler (`src/plugin.ts:593-625`) runs its recall on a detached promise. At line 617, it sets `state.pendingInjection = formatRecallResults(newResults)` — this is an **assignment** (overwrite), not an append. The `tool.execute.before` handler (§4.2) does `state.pendingInjection = \`${state.pendingInjection}\n${note}\`` — an **append**.

The race:
1. `tool.execute.before` fires, appends a warn note to `pendingInjection` (or sets it if null).
2. `chat.message`'s detached recall resolves later and does `state.pendingInjection = formatRecallResults(newResults)` — **overwrites** the warn note.
3. `experimental.chat.system.transform` fires and delivers only the recall block — the warn note is silently lost.

This happens when the recall is slow (e.g., embedding computation takes hundreds of ms) and hasn't resolved by the time `tool.execute.before` fires. In the normal hook sequence (`chat.message` → `transform` → `tool.execute.before`), the recall usually finishes before `transform` clears `pendingInjection`, but this is not guaranteed — the recall is detached and timing-dependent.

§8 does not name `chat.message` as a co-writer of `pendingInjection` that could overwrite the warn note. The plan's claim "if both are staged, they're concatenated" is only true if the warn note appends to an already-staged recall block, not if the recall overwrites an already-staged warn note.

**Required change:** Either (a) use a separate field for warn notes (e.g., `state.pendingWarnNote: string | null`) that `experimental.chat.system.transform` concatenates with `pendingInjection` at delivery time — eliminating the race entirely; or (b) acknowledge the race in §8 as a known Phase 1 limitation (warn notes may be silently dropped when recall is slow) and document that Phase 3 (working-memory window, design doc §4.2) resolves it by rebuilding the whole window each turn. If (b), add a test that documents the race (warn note lost when recall overwrites).

---

## Verdict

**VERDICT: NEEDS CHANGES** — comments 1-C1 and 1-C2 must be resolved; architect revises and resubmits for round 2.

**Summary:** The plan is well-researched and accurately spot-checks against the codebase (function name, hook registration, config structure, tsup entry, search API all verified). The design is faithful to the synthetic-brain design doc §3.1/§4.3/§5 Phase 1. However, two issues block execution: (1) the INV-017 amendment contradicts the original invariant's "all hooks are non-blocking" wording and must be formalized as a superseding ADR-010 before execution, not left conditional; (2) the blast-radius claim that warn notes and recall blocks "coexist in pendingInjection" is inaccurate under a race condition where `chat.message`'s detached recall (assignment at `plugin.ts:617`) overwrites a warn note already queued by `tool.execute.before` — this needs either a separate field or an explicit acknowledgment as a Phase 1 limitation.

---

## Minor notes (non-blocking, for the architect's awareness)

- **Function name:** §3.1 says "The `createPlugin(ctx)` function returns an object..." The actual function is `realmemoryPlugin` (`src/plugin.ts:217`, default export). Not blocking — a worker will find the right function — but the plan should use the correct name.
- **tsup entry points:** §4.6 and A32.2 criterion say to add `src/reflex.ts` to tsup entry points "if applicable." The tsup config (`tsup.config.ts:6`) uses explicit entries: `["src/index.ts", "src/mcp-server.ts", "src/bin.ts", "src/types.ts", "src/plugin-entry.ts"]`. `src/plugin.ts` is NOT an entry — it's bundled transitively as a dependency of `src/plugin-entry.ts`. `src/reflex.ts` would similarly be bundled transitively when imported by `plugin.ts`. It does NOT need to be a separate entry point. The "if applicable" hedge is correct, but the acceptance criterion "tsup config includes `src/reflex.ts` in entry points" could mislead a worker into adding an unnecessary entry. Recommend rewording to: "verify `src/reflex.ts` is bundled transitively via `plugin.ts` → `plugin-entry.ts` — no entry point change needed unless `reflex.ts` is also imported by a non-plugin entry."
