# Plan Review — Issue #24, Round 1

**Reviewer:** Anymake Plan Reviewer (fresh context — round 1)
**Plan:** `docs/06-agile/issue-24/plan.md` @ Status: In Review (round 1), 2026-08-11
**Issue:** https://github.com/R3dy/RealMemory/issues/24 — "Add Created and Updated columns to the web UI list view"
**Code state checked:** main @ `21303fc` (via `git show main:...`) — the plan's cited commit. Note: the working tree is currently on branch `issue/22-brain-loop`; `git diff main HEAD -- src/browser/assets.ts` is empty, so all cited line numbers hold on both refs.
**Location:** `PROJECTS/realmemory/docs/06-agile/issue-24/review-round-1.md`

---

## Checklist

Every dimension gets a result. FAIL requires a numbered comment below.

| # | Dimension | Result | Evidence |
|---|-----------|--------|----------|
| 1 | **Root cause verified** — the file:line trace in plan §2 was checked against the actual code and genuinely produces the reported symptom (bugs) / motivation is real (features) | PASS | Feature, not a bug — motivation trace verified. `/api/graph` handler (`server.ts:273`) builds `nodes: Memory[]` — full Memory objects, no projection — so `createdAt`/`updatedAt` reach the client. `src/types.ts:126,128` confirm both fields as ISO 8601 strings. `assets.ts:618` (`_data: m`), `:653` (`updateListBody(data.nodes || [])`), `:764-765` (Detail panel renders raw ISO) all match the plan's citations exactly. |
| 2 | **Solves the reported issue** — plan §4 demonstrably resolves the §1 problem statement, not an adjacent one | PASS | §4 adds exactly the two requested columns (header §4.2, row cells §4.3) plus the sorting a column header implies (§4.4) and the formatter they need (§4.1). Nothing adjacent is touched. |
| 3 | **Scope matches the issue** — nothing built beyond what the issue needs; no "while we're in here" | PASS | One file, four edits. The tempting adjacent fix (reformat the Detail panel's raw ISO Timeline with `fmtDate`) is explicitly parked in §4.1, not done. Horizontal-scroll mobile work is parked in §5. |
| 4 | **Intent consistency** — §6 classification is correct; no Active Decision (`docs/DECISIONS.md`) or invariant (`docs/INVARIANTS.md`) contradicted without a resolved conflict gate | PASS | Additive/presentation-only is correct. Checked DECISIONS.md and INVARIANTS.md myself: ADR-006 (localhost-only, read-only GET-only, `node:http`, no new runtime dep) and ADR-007 (auto-start side channel) are accurately characterized and untouched — no route, no server change, no framework. INV-013/015 preserved. INV-014 preserved — no new dep (`fmtDate` is inline vanilla `Date`); the plan correctly notes the pre-existing Drift #6 (`zod`) violation rather than hiding it. No conflict gate needed. |
| 5 | **Design consistency** — §7 complete for UI-touching changes; reuses existing components; any new pattern updates `ux-design.md` | PASS | Spot-checked against main: `#list-view th`/`td` are generic element selectors (168-190); the `td` rule at 177-181 indeed sets `max-width:400px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` — the plan's "new columns cannot break the table" claim holds. New cells reuse `esc()` (830-832, exact), the `'—'` sentinel (667-668, exact), and `color:var(--text-dim)` matching the Tags column (671, exact). No new visual pattern → no `ux-design.md` update required. |
| 6 | **Blast radius honest** — §8 names the real shared paths (spot-checked against SYSTEM_MAP and code); protections exist | PASS | Verified the two load-bearing claims: (a) the list-sort handler (`assets.ts:949-956`) queries `#list-view th` generically and reads `th.dataset.sort` — new columns auto-wire, no handler change needed; (b) the row click binding (674-681) is on the `<tr>`, so added `<td>`s can't detach it. `showDetail` fetches `/api/memory/:id` independently of the row markup. Grepped for other consumers of `updateListBody`/`sortNodes`/`#list-body` — none outside the list view; the graph canvas path is separate. §8 missed nothing. |
| 7 | **Stories buildable** — §9 criteria are specific and testable; bug repro is an acceptance criterion; a Worker could build from these + the plan alone | PASS | Criteria name the exact `data-sort` attributes, column placement (after Tags), the exact format with an example (`2026-08-11 01:13`), the `'—'` empty case, sort behavior both directions, and explicit regression criteria for the existing six columns. A Worker could implement from §4 + §9 without further questions. |
| 7a | **Experience Script present** — every story in §9 has a literal Experience Script scenario (or explicit N/A justification); for a bug, the scenario is the repro rewritten as action/expected-result steps | PASS | Literal and drivable: launch command verified (`node dist/bin.js --ui=9333` — `bin.ts:25` parses `--ui=`), seeding precondition stated, 12 numbered steps with observe/assert expectations, PASS condition naming feature steps vs. regression guardrails. Step 5 correctly handles the real toggle semantics I verified at `assets.ts:952-953` (first click on a fresh column yields `desc`) by asserting both directions via two clicks rather than a brittle first-direction assumption. |
| 8 | **Test plan sufficient** — repro becomes a regression test; the Experience Script scenario is named in §10 as what the Experience Runner replays; blast-radius tests named; no "works correctly" language | PASS | §10 names real files: `tests/browser-graph-api.test.ts` (exists; exercises `/api/graph`, asserts `updatedAt` at lines 163-164 — guards the data path), `tests/deps-cap.test.ts` (exists — mechanically guards INV-014), plus `npm run build` (tsup) as the compile gate for the inlined asset. Skipping a new unit test is justified: the change lives in an inlined HTML/JS template string with no existing unit-test harness, and the Experience Script is the proportionate primary verification for a presentation-only change. |
| 9 | **Rollback complete** — §11 has real branch/revert/migration-down steps, not placeholders | PASS | Branch `issue/24-list-created-updated-columns` off `main` — the plan explicitly warns against branching off `issue/22-brain-loop`, which matches the actual repo state I found (HEAD is on that branch). Revert is a real command (`git revert <squash-sha>`) against a single file; no migration, no dependency, no runtime state. SHA recording in ISSUES.md specified. |
| 10 | **Security** — no auth/authz/tenant-isolation/secret/payment surface weakened; security-relevant plans flagged for real-user approval | PASS | Presentation-only change to an already localhost-only, read-only surface. All rendered values pass through `esc()` (HTML-escaped) — the two new cells follow the same pattern, so no injection vector is introduced. No new route, no new surface, no secrets. |

---

## Comments

No FAILs — no numbered comments required.

**Non-blocking observation (not a review comment, no action required to approve):** §7's supporting aside that `fmtDate` "reuses the `new Date()` + `padStart` pattern already present (e.g. `scripts/bootstrap-memory.mjs:444`, `src/store.ts:378`)" is imprecise — those two lines show `new Date().toISOString()` and JSON serialization, not `padStart`. The substantive claim (the helper needs no dependency) is true regardless; the architect may correct the citations in passing but this does not gate approval.

---

## Verdict

**VERDICT: APPROVED** — all dimensions PASS; near-certainty this plan (1) resolves
the reported issue, (2) breaks nothing in the blast radius, (3) keeps the UI
coherent with the design system, (4) is cleanly revertible.

**Summary:** Every load-bearing claim in the plan was spot-checked against main @ `21303fc` and held: the data already flows (`nodes: Memory[]` through `/api/graph` → `_data` → `updateListBody`), the generic sort handler auto-wires the new `<th data-sort>` columns, the row click binding survives added cells, the CSS truncates overflow generically, and no ADR/invariant is touched (INV-014's pre-existing Drift #6 is honestly noted, not worsened). The scope is exactly the issue, rollback is a single-file revert, and the Experience Script is literal and correctly handles the first-click-desc toggle semantics. Ready for the approval gate.
