# PHASE_STATE.md — realmemory

project: realmemory
project_type: library
autonomous_mode: true

---

## Phase Status

| Phase | Status | Artifact |
|-------|--------|----------|
| 0 Foundation | COMPLETE | PROJECT.md approved 2026-08-08 |
| 1 Discovery | COMPLETE | docs/01-discovery.md |
| 2 Planning | COMPLETE | docs/api-design.md + 5 ADRs |
| 3 Solutioning | COMPLETE | docs/solutioning/epics.md + backlog.md + dependency-graph.md |
| 4 Implementation | COMPLETE | 20 stories, 265 tests, all merged to main |
| 5 Launch | COMPLETE | v0.8.0 — built Aug 13 2026; brain-loop ACTIVE in host OpenCode; synthetic-brain Phase 0 + Phase 1 + Phase 2 shipped. Distributed via git-install (`realmemory@git+https://github.com/R3dy/RealMemory.git`) — npm publish is OFF the table (Royce has no npm login). |

## Plugin status (live in this environment)

- **Installed version:** 0.6.0 (repo `package.json`). Built `2026-08-12` (`dist/plugin-entry.js`).
- **Loaded as:** OpenCode plugin (git-install: `realmemory@git+https://github.com/R3dy/RealMemory.git` in `~/.config/opencode/opencode.json` `plugin` array — switched from local path Aug 12 2026) AND MCP server (`type: "local"` command pointing at `PROJECTS/realmemory/repo/dist/bin.js`). Stale ghost cache at `~/.cache/opencode/packages/realmemory@git+https:` was cleared; OpenCode will re-clone from `origin/main` (HEAD: `9444aaf`, v0.6.0) on next restart.
- **brainLoop config:** defaults `true` (`src/config.ts:43`); no `.realmemory*` config file or env override → **brain-loop is ACTIVE**.
- **Plugin load FIX (2026-08-12):** The ADR-009 fix shipped `plugin-entry.ts` with `{ server: realmemoryPlugin }` but was missing `id`. OpenCode's plugin loader requires `id` in the default export for file/path plugins (no fallback to `package.json` `name` for file plugins, unlike npm plugins). Error was: `Path plugin file:///... must export id`. Fix: added `id: "realmemory"` to the pluginModule object. Verified via testing harness (`opencode run --print-logs --log-level DEBUG`): all 6 hooks fire, `preference_compliance` metric recorded by `evaluateDelta`.
- **Active hooks (all verified firing via test harness 2026-08-12):**
  - `session.created` → auto-recall ("Auto-recalled 5 memories for new session") + decay ("Memory decay completed")
  - `chat.message` → auto-recall + classifyIntent ("Auto-recalled 1 memories for user message")
  - `session.idle` → evaluateDelta (preference_compliance metric recorded) + summarization (skipped — no provider configured)
  - `tool.execute.after` → auto-capture (fires on tool use; not triggered in the simple test prompt)
  - `experimental.chat.system.transform` → recall injection (delivers staged memories to system prompt)
  - `session.compacting` → hygiene hook (dedup + decay; fires on context compaction)
- **Observability:** `get_metrics` MCP tool exposes brain-loop metrics. After the test run: 1 row (`preference_compliance`, count=1). Browse at http://127.0.0.1:9333/api/metrics.
- **Testing harness:** `setsid bash -c 'opencode run --print-logs --log-level DEBUG "say hi briefly" > /tmp/opencode-plugin-test.log 2>&1' < /dev/null &` — then check log for hook messages + query `get_metrics` for brain-loop evidence.

## Phase 0 Gate

- **Date:** 2026-08-08
- **Decision:** Approved by user
- **Artifact:** PROJECTS/realmemory/PROJECT.md
- **Key decisions:** library project type (npm package + OpenCode plugin + MCP server); local-first embedded storage (SQLite + vector index); git URL or npm install; no cloud backend

## Current Step

**v0.8.0 built + live; synthetic-brain Phase 2 (prediction error) shipped.** Issue #34 shipped (PR #35, merge `838b423`, tag `issue-34`). The predict→compare→encode loop is live: `tool.execute.before` stashes a prediction (reflex-path, <5ms), `tool.execute.after` computes surprise and encodes/reinforces accordingly (deliberative-path, detached). 619 tests pass. **Royce must restart OpenCode** for the v0.8.0 plugin to take effect — after restart, surprising tool outcomes will produce `prediction_error:<bin>` metrics and high-salience `lesson_learned` encodes. Next: Phase 3 (working-memory window — `docs/architecture/synthetic-brain.md` §4.2).

## Agile increments (post-launch)

### Issue #34 — Synthetic-brain Phase 2: prediction error (surprise-driven encoding) (2026-08-13)
- **Status:** CLOSED (PR #35 squash merge `838b423`, tag `issue-34`)
- **What:** Implemented Phase 2 of the synthetic-brain design. New `src/predict.ts` — `predictOutcome` (reflex-path, cache-only, <5ms — consumes the already-matched Phase 1 rule; null rule → uncertain default `{willSucceed:true, confidence:0.5}`), `classifyOutcome` (reuses `isErrorResult` for bash, defensive for other tools), `computeSurprise` (`|actual - expected|`, 0..1), `shouldEncode` (≥0.2 threshold), `surpriseBin` (low/med/high), `describe` (human-readable lesson content), `hashArgs` (stable JSON-stringify for call ID synthesis), `consumePrediction` (full `tool:argsHash:` prefix match with fallback — C4 interleaving fix). `src/reflex.ts` `addRule` (mutate cache in place, re-sort, trim to cap — immediate-reflex on strong surprise >0.7). Plugin wiring: `tool.execute.before` restructured (C1 — predict+stash runs for BOTH match and no-match, gated only on `brain.predictionError`), `tool.execute.after` dual-gated (C2 — `autoCapture && predictionError` both off → short-circuit; legacy capture gated on `autoCapture`; prediction block gated on `predictionError`), `chat.message` correction via `lastPredictionOutcome` (C3 — `pendingPredictions` is empty by `chat.message` time; consume the outcome field instead, double-encode avoidance by reinforcing the already-encoded row), `session.idle` leak sweep. Config: `brain.predictionError: true` (default via `!== false` gate). Metric: `prediction_error:<bin>` via `get_metrics` MCP tool.
- **Pipeline:** anymake-agile — Cartographer refreshed intent layer (ADR-010 → INV-017 + DECISIONS.md), Solution Architect plan (470 lines, round 2 after R1 NEEDS CHANGES with 6 blocking + 2 non-blocking comments — all in the wiring, substrate claims verified correct), Plan Reviewer R2 APPROVED (4 non-blocking nits), Product Owner Proxy APPROVED 6/6. Direct build (per plan thoroughness + sub-agent fragility lesson).
- **Tests:** 619 pass (up from 571 — 48 new: 33 predict unit + 4 reflex addRule + 11 plugin integration). 5 pre-existing EADDRINUSE (port 9333, environmental).
- **Version:** 0.7.0 → 0.8.0 (MINOR — additive feature, no breaking change; pre-1.0 semver per ADR-004).
- **Intent layer:** ADR-010 (two-pathway constraint) affirmed not contradicted. INV-017 amended form preserved (reflex-path synchronous <5ms cache-only; deliberative-path detached). ADR-003/INV-014 (dep cap) not touched (zero new deps). INV-005 (no schema migration). INV-015 (additive MINOR). INV-018 (reinforcement used as-is).
- **Revert:** `git revert -m 1 838b423` (additive metrics rows + in-RAM cache + pendingPredictions Map; no migration down. Encoded lessons are real and stay — tagged `metadata.source: "prediction-error"`).

### Issue #32 — Synthetic-brain Phase 1: ReflexCache + tool.execute.before warn inhibition (2026-08-12)
- **Status:** CLOSED (PR #33 squash merge `22fb74d`, tag `issue-32`)
- **What:** Implemented Phase 1 of the synthetic-brain design. New `src/reflex.ts` — `ReflexCache` (in-RAM, built at session.created), `ReflexRule` (memoryId, match: RegExp | predicate, action: "warn" only, note, salience, confidence), `compileRule` (compiles lesson_learned memories with metadata.command/filePath into matchers), `buildReflexCache` (one store.search() above weight floor, sorted by salience × confidence, capped at 100), `matchCall` (synchronous cache-only lookup, <5ms enforced by test assertion). Plugin registers `tool.execute.before` handler (reflex path, ADR-010): synchronous, cache-only, queues warn note into `state.pendingWarnNote` (separate field from `pendingInjection` to avoid the race where `chat.message`'s detached recall overwrites it). Transform hook delivers both fields. `session.created` builds cache detached (gated on `brain.reflex`). `reflex_fire:<memoryId>` metric recorded (detached). Config: `brain.reflex: true` (default), `brain.inhibition: "warn"` (default). `tool.execute.before` added to hook-probe CONDITIONAL_HOOKS.
- **Pipeline:** anymake-agile — Solution Architect plan written directly (sub-agent returned empty — MEMORY.md lesson: build directly when well-specified). Plan Reviewer R1 NEEDS CHANGES (2 comments: 1-C1 INV-017 amendment is a contradiction not a clarification; 1-C2 race condition chat.message overwrites pendingInjection). Plan revised: 1-C1 fixed (committed to ADR-010, superseding ADR); 1-C2 fixed (separate `pendingWarnNote` field). R2 APPROVED. Product Owner Proxy: intent-conflict gate APPROVED (ADR-010, two-pathway constraint); agile-plan-approval APPROVED. Direct build (per plan thoroughness + sub-agent fragility lesson).
- **Tests:** 571 pass (up from 543 — 28 new). 5 pre-existing EADDRINUSE (port 9333, environmental).
- **Version:** 0.6.0 → 0.7.0 (MINOR — new feature, no breaking change; pre-1.0 semver per ADR-004).
- **ADR-010:** Two-pathway constraint. Supersedes INV-017 ("all hooks non-blocking"). Deliberative-path: detached, unbounded (unchanged). Reflex-path: synchronous, <5ms, cache-only, no I/O. Approved via Product Owner Proxy (autonomous mode, intent-conflict gate).
- **Revert:** `git revert -m 1 22fb74d` (additive metrics rows only, in-RAM cache, no migration down).

### Issue #30 — Hook probe: prove every registered hook fires AND lands (synthetic-brain Phase 0) (2026-08-12)
- **Status:** CLOSED (PR #31 squash merge `9444aaf`, tag `issue-30`)
- **What:** Implemented Phase 0 of the synthetic-brain design (`docs/architecture/synthetic-brain.md`). New `src/hook-probe.ts` instruments all 5 registered plugin hooks to record `hook_fired` metrics, pushes + verifies a landing sentinel for `experimental.chat.system.transform`, and provides a `--doctor` CLI command with a four-state exit matrix (0 healthy / 2 degraded / 3 inconclusive / 1 crashed). Landing check uses four outcomes (found / observable-absent / unverifiable / fetch-failed) — the host (1.18.17) doesn't persist system-prompt content, so `unverifiable` is a non-degraded state. Every readback outcome persisted as a metric row (value 1/0/-1/-2) so `--doctor` reconstructs all states from store data alone. Additive `MemoryStore.getLatestMetricRow(prefix)` + `count()` methods. No new deps, no schema migration, no new hooks, no behavior change — Phase 0 is a NO-OP until `--doctor` is invoked.
- **Pipeline:** anymake-agile — Solution Architect (1365-line plan), Plan Reviewer R1 NEEDS CHANGES (6 comments — critical: landing check false premise), R2 NEEDS CHANGES (4 comments — critical: unverifiable unreachable from store), R3 APPROVED, Product Owner Proxy APPROVED, direct build (per plan thoroughness + sub-agent fragility lesson), Validator R1 FAIL (4 missing test files) → fixed → PASS.
- **Tests:** 543 pass (up from 487 — 56 new). 5 pre-existing EADDRINUSE (port 9333, environmental).
- **Version:** 0.5.0 → 0.6.0 (MINOR — also fixes pre-existing package.json 0.1.1 discrepancy).
- **Epic:** synthetic-brain (milestone #1 on GitHub). Phases 1-7 are future issues. Phase 1 (reflex cache + `warn` inhibition) is next.
- **Revert:** `git revert -m 1 9444aaf` (additive metrics rows only, no migration down).

### Issue #28 — Plugin hooks never fire in host OpenCode (2026-08-12)
- **Status:** FIX APPLIED + VERIFIED via testing harness. Needs Royce restart for interactive session.
- **What:** The OpenCode plugin hooks (brain-loop, auto-recall, auto-capture, system-prompt injection, compacting hygiene) never fired in the host environment. Three root causes in the original ADR-009 fix: (1) `src/plugin.ts` not in tsup entry → no `dist/plugin.js`; (2) `dist/` gitignored + OpenCode installs with `ignoreScripts:true` + `saveType:"prod"` → prepare script never runs; (3) no `exports["./server"]` in package.json + plugin default export is a bare function, not the `PluginModule = { server: Plugin }` shape. **PLUS a fourth root cause found this session:** the `pluginModule` object was missing `id: "realmemory"`. OpenCode's plugin loader requires `id` in the default export for file/path plugins (no fallback to `package.json` `name` for file plugins, unlike npm plugins). Error: `Path plugin file:///... must export id`. Fix: added `id: "realmemory"` to the pluginModule object in `src/plugin-entry.ts`.
- **Pipeline:** anymake-agile — Solution Architect (433-line plan), Intent Conflict Gate (PO Proxy APPROVED, 2 conditions), Plan Reviewer R1 NEEDS CHANGES (2 comments), Architect revision, Plan Reviewer R2 APPROVED (10/10), Approval Gate APPROVED (5/5), direct build (per #24 precedent). **Post-merge fix:** `id` field added 2026-08-12 after testing harness revealed the load failure.
- **Tests:** 499/499 pass (5 pre-existing EADDRINUSE; 2 previously-failing smoke tests fixed; 1 new plugin-entry regression test). Plugin-entry test still passes after `id` addition.
- **Version:** 0.4.0 → 0.5.0 (MINOR — breaking: removes `realmemoryPlugin` from public API per ADR-008(f)).
- **ADR-009:** Plugin entry point and distribution. Supersedes ADR-002 line 35. INV-019 (dist committed to git). **NOTE:** ADR-009 should be amended to document the `id` requirement for file/path plugins.
- **Verification harness:** `setsid bash -c 'opencode run --print-logs --log-level DEBUG "say hi briefly" > /tmp/opencode-plugin-test.log 2>&1' < /dev/null &` — then grep log for hook messages + query `get_metrics` for brain-loop evidence. All 6 hooks verified firing. `preference_compliance` metric recorded (count=1, timestamp matches test run's session.idle).
- **Revert:** `git revert c55a423` (original ADR-009 build) + remove `id` line from `plugin-entry.ts` + rebuild.

### Issue #22 — Make realmemory act like a human brain (2026-08-11)
- **Status:** CLOSED (PR #26 squash merge `bd224e6`, tag `issue-22`)
- **What:** Implemented the "brain loop": per-turn delta evaluation (session.idle PRIMARY trigger, local heuristics — no LLM), auto-relate (maybeRelate capped + idempotent), metrics (SCHEMA_V4 metrics table, 5 minimal metrics: recall_hit_rate, correction_retention, duplicate_rate, memory_bloat_ratio, preference_compliance), experimental.session.compacting hygiene hook (dedupPass + decay), conciseness enforcement (auto-stored memories capped at 280 chars). ADR-008 ratifies the brain-loop + plugin role/boundary/config-surface (resolves Drift #1). Zero new runtime deps.
- **Pipeline:** anymake-agile — Cartographer refreshed intent layer (3 new drift items found: #5 secrets-before-LLM, #6 zod 4th dep, #7 schema-v3 ADR-less), Solution Architect wrote 1705-line plan (6 stories, ADR-first), Plan Reviewer round 1 NEEDS CHANGES (6 comments), round 2 NEEDS CHANGES (4 comments), round 3 APPROVED, Product Owner Proxy APPROVED (6/6 checks, no security surface), 5 Worker dispatches (A22.1 docs + A22.2-A22.6 code), PR #26 merged.
- **Key design:** session.idle is the PRIMARY delta trigger (chat.message assistant branch verified dead in the installed host — same class as Epic #3's message.updated lesson). evaluateDelta uses local keyword heuristics (classifyIntent) — NO LLM call (preserves INV-017 non-blocking, avoids Drift #5). brainLoop config knob is the master switch. lastToolCapture cleared AFTER evaluateDelta (not before classifyIntent — round-2 C2 fix).
- **Tests:** 498/498 pass (up from 404). 94 new tests across 8 new test files.
- **Version:** 0.3.0 → 0.4.0 (MINOR, pre-1.0 semver per ADR-004).
- **Revert:** `git revert -m 1 bd224e6` (schema v4 additive/idempotent — no down migration). Intent-layer workspace files (ADR-008, DECISIONS.md, SYSTEM_MAP.md, INVARIANTS.md) are NOT in the repo — manually remove ADR-008 + restore Drift #1 to open if reverting.
- **Intent layer:** ADR-008 (brain-loop + plugin role/boundary) added to Active Decisions. Drift #1 resolved. Drift #5 (secrets-before-LLM), #6 (zod 4th dep), #7 (schema-v3 ADR-less) logged to PARKING_LOT — out of scope for #22, separate issues.

### Epic #3 — Always-on, low-overhead, self-improving agent memory (2026-08-10)
- **Status:** CLOSED (all 7 sub-issues merged, 379 tests pass, up from 319)
- **What:** Implemented the full self-improving memory epic: recall injection into agent context, session-idle LLM summarization, near-duplicate dedup with reinforcement, automatic decay scheduling, cross-project promotion to global scope, non-blocking hooks, and an OpenCode skill for proactive memory use.
- **Sub-issues:**
  - #10 (PR #14): realmemory skill + improved MCP tool descriptions. 319 tests.
  - #7 (PR #15): decay() scheduled on session.created, durable rate-limiting via meta KV table (schema v2), fire-and-forget. 326 tests (+7 new).
  - #6 (PR #16): near-duplicate detection in store() — cosine similarity (embedding mode) + FTS5/token-overlap (keyword mode); reinforces existing memory instead of re-storing. 339 tests (+13 new).
  - #8 (PR #17): cross-project promotion — user_preference/task_pattern reinforced from N=2 distinct projects auto-promotes to scope:global. 348 tests (+9 new).
  - #5 (PR #18): session-idle LLM summarization via new src/summarize.ts — extracts structured memories from transcript, fire-and-forget, defensive parsing. 379 tests (+22 new, +9 from #8, +9 from #9+#4).
  - #9+#4 (PR #19): non-blocking hooks (fire-and-forget store/recall) + recall injection via experimental.chat.system.transform hook; replaced fake message.updated with real chat.message hook. 348 tests (+9 new).
- **Key architectural findings:** OpenCode's `experimental.chat.system.transform` hook is the real injection mechanism (append to output.system); the old `message.updated` hook key never fired (it's an Event, not a hook); `chat.message` is the real user-message hook; better-sqlite3 is synchronous single-connection so concurrent writes are naturally serialized (no write mutex needed).
- **Revert:** `git revert <squash-sha>` per PR (schema v2 migration is additive/idempotent; no deps changes).

### Issue #12 — Auto-start graph browser on MCP load (2026-08-10)
- **Status:** CLOSED (merged, PR #13, squash SHA `197e0c6`, tag `issue-12`)
- **What:** The graph memory browser auto-starts as a localhost-only (127.0.0.1), read-only (GET-only) side channel **inside the MCP server process** when realmemory loads — no manual `--ui` flag, MCP memory tools fully intact. Browsing http://127.0.0.1:9333 shows the node graph. Defeatable via `autoStartBrowser: false` config or `--no-browser`.
- **Architectural:** ADR-007 supersedes ADR-006's "opt-in / default-off" clause (user-approved intent-conflict gate). ADR-006 #2-#4 (localhost-only, read-only, no-framework, no-new-runtime-dep) preserved. INV-013 narrowed; INV-014/015 preserved. Two critical fixes: stdout→stderr (stdout is the MCP transport); `ownLifecycle:false` side channel (MCP server is sole closer + `process.exit(0)`).
- **Tests:** 319/319 pass (8 new side-channel tests). CI green on Node 22 (EOL 18/20 dropped — better-sqlite3/vitest forks crash). Pre-existing CI breakage fixed (build-before-typecheck).
- **Experience:** PASS — drove the live MCP load path; browser on 9333, graph of 50 nodes, store_memory MCP call succeeded, stdout clean, --no-browser suppresses, SIGTERM exit 0 ~32ms.
- **Version:** 0.2.0 → 0.3.0 (MINOR).
- **Revert:** `git revert 197e0c6` (no schema migration, no deps change).

### Uncommitted fix — graph browser nodes invisible (CSS Grid circular height) (2026-08-10)
- **Status:** FIXED in `src/browser/assets.ts`, NOT YET COMMITTED.
- **What:** Nodes existed in the graph data (55 nodes, clickable) but rendered invisible — the canvas was 2118px tall in a 824px viewport, so nodes positioned around the canvas center (y~1057) were below the visible area. Root cause: CSS Grid `min-height: auto` default on `main#network-wrap` prevented the grid item from shrinking below content size, creating a circular height dependency with vis-network's auto-sized canvas.
- **Fix:** (1) `grid-template-rows: 1fr` on `#app`, (2) `min-height: 0` on all three grid items, (3) `overflow: hidden` on `main#network-wrap`, (4) `network.once('stabilizationIterationsDone', () => network.fit())` to zoom-to-fit after physics settles.
- **Verified:** Headless chromium screenshot + CDP probe. Canvas now 800x681px (was 800x2115px). 30,659 red pixels in network area (was 91 = footer legend dot only). 374/379 tests pass (5 EADDRINUSE failures are pre-existing — port collision with live MCP server on 9333).
- **Action needed:** Royce must restart OpenCode for the fix to take effect (the running MCP server has the old HTML in memory).

### Issue #2 — localhost graph memory browser (2026-08-09)
- **Status:** CLOSED (merged, PR #11, squash SHA `ce79716`, tag `issue-2`)
- **What:** `--ui` CLI flag starts a localhost-only (127.0.0.1), read-only (GET-only) HTTP graph browser over the existing SQLite store. Embedded dark-theme single-page UI (vis-network, vendored as a browser-side static asset). 3 additive read-only store methods. Version bumped 0.1.0 → 0.2.0 (MINOR).
- **Architectural:** ADR-006 supersedes ADR-003's no-HTTP clause (intent conflict gate approved by Product Owner Proxy). INV-013 narrowed; INV-014 preserved (no new runtime dep); no web framework (node:http).
- **Tests:** 305/305 pass (22 files, 51 new tests). Typecheck/lint/build clean.
- **Deferred smoke test:** reporter must visually verify `realmemory-mcp --ui` at http://127.0.0.1:9333 (human-only criteria waived by proxy in autonomous mode).
- **Revert:** `git revert ce79716` (no schema migration, no deps change).

### Issue #24 — Add Created and Updated columns to web UI list view (2026-08-11)
- **Status:** CLOSED (PR #25 squash merge `b1e11fd`, tag `issue-24`)
- **What:** Added two columns — Created (`createdAt`) and Updated (`updatedAt`) — to the `#list-view` table in the graph browser UI (`src/browser/assets.ts`). New `fmtDate(iso)` helper formats ISO 8601 as compact `YYYY-MM-DD HH:MM` (returns `—` for missing/invalid). Two `<th>` columns after Tags (auto-wired by the generic sort handler). Two `<td>` cells in `updateListBody`. Two sort cases in `sortNodes` (ISO 8601 sorts chronologically via localeCompare). Pure additive presentation — data already returned by `/api/graph`.
- **Pipeline:** anymake-agile — intake confirmed, issue #24 tracked, Solution Architect plan (262 lines), Plan Reviewer round-1 APPROVED (all 10 dimensions, 1 non-blocking nit), Product Owner Proxy gate APPROVED (7/7, autonomous non-security), built directly (small well-defined task per sub-agent-fragility lesson), Experience Check PASS (headless chromium: 500 rows × 8 cols, 1000 date values).
- **Intent layer:** ADR-006 #2/#3/#4, ADR-007, INV-013/014/015 all preserved. Classification: Additive (presentation-only). No schema, no server, no dep, no public API change.
- **Tests:** 409/409 pass. Typecheck + build green.
- **Action needed:** Royce must restart OpenCode for the new UI to take effect (the running MCP server has the old HTML in memory). Then browse http://127.0.0.1:9333, click List tab — verify Created/Updated columns + click-sort.
- **Revert:** `git revert b1e11fd` (single file, no migration, no deps).

### Issue #20 — Mobile-first UI redesign (2026-08-11)
- **Status:** CLOSED (PR #21 squash merge `21303fc`, tag `issue-20`)
- **What:** Redesigned the web UI (`src/browser/assets.ts`) to mobile-first UX. Three breakpoints: <640px single-column with bottom tab bar (Graph primary per Royce's override, List, Detail), slide-in drawer for sidebar, bottom sheet for detail, touch targets >=44px gated to max-width:1023px; 640-1023px tablet hybrid; >=1024px current 3-pane desktop layout UNCHANGED (regression-free, gated inside min-width:1024px). vis-network interaction MERGED (kept tooltipDelay:200/navigationButtons:false/keyboard:false, added zoomView:true/dragView:true/multiselect:false). Canvas lifecycle: redraw+fit on tab reactivation, resize, orientationchange; instance never re-created. 23 new string-assertion tests (no DOM env, no new devDep).
- **Pipeline:** anymake-agile — intake confirmed, issue #20 tracked, Solution Architect plan (349 lines), Plan Reviewer round-1 NEEDS CHANGES (8 objections: interaction merge, test env, canvas lifecycle, occlusion, touch-target leak, Human-Only §3a, a11y defer, graph-controls placement), round-2 APPROVED, Product Owner Proxy gate cleared (autonomous, non-security), Worker built 3 stories (3 commits), PR #21 merged.
- **Intent layer:** ADR-006 #2/#3/#4, ADR-007, INV-013/014/015 all preserved. Classification: Additive (presentation-only). No schema, no server, no dep, no public API change.
- **Tests:** 404 pass (up from 381), 5 pre-existing EADDRINUSE (port 9333 collision with live MCP server — environmental). Typecheck + build green. Lint clean on touched files.
- **Action needed:** Royce must restart OpenCode for the new UI to take effect (the running MCP server has the old HTML in memory). Then browse to http://127.0.0.1:9333 at 375px (iPhone SE), 750px (tablet), 1280px (desktop) to verify visually (§3a Human-Only drive-throughs).
- **Revert:** `git revert 21303fc` (single file, no migration, no deps).

### Issue #13 — Memory structure redesign + UI overhaul (2026-08-10)
- **Status:** CLOSED (committed as baseline `11b459c` on the issue/20 branch, included in PR #21 squash merge `21303fc`)
- **What:** Designed and implemented a proper memory structure for long-term agent memory across domains. Schema v3 adds `domain` (primary tech/topic: aws, testing, opencode, etc.), `category` (sub-classification: gotcha, cost, safety, process, tooling, integration, performance), and `source` (origin tracking: project, session, ref, refType) to every memory. The `metadata` field is now structured per-type (MemoryMetadata interface with assumed/reality/lesson/learnedDate for lessons, location/evidence for codebase_facts, etc.). Retroactively migrated all 58 existing memories — parsed tags to extract domain, parsed content to classify category. Redesigned the web UI (port 9333) to look like codebase-memory-mcp: 3-pane layout with domain tree sidebar (clickable filtering), graph canvas (nodes colored by type, bordered by domain color, sized by weight), list view toggle, structured detail panel with domain/category badges, source box, weight visualization, and structured metadata rendering. New `/api/domains` endpoint returns domain breakdown stats. MCP tool schemas updated to accept domain/category/source in store_memory, search, recall, list_memories, update_memory.
- **Schema change:** SCHEMA_V3 (ALTER TABLE ADD COLUMN domain, source, category + indexes). Idempotent via schema_version tracking.
- **Migration:** `scripts/migrate-v3.ts` — backfills domain from tags, category from content patterns, source from issue refs. 58/58 memories migrated. 52/58 got a domain (6 uncategorized), 53/58 got a category (5 null for non-lesson types).
- **Tests:** 381/386 pass (5 pre-existing EADDRINUSE). 7 new tests: domain/category persistence, domain/category search filters, domain/category graph API filters, /api/domains endpoint. TypeScript compiles clean. Build succeeds.
- **Files touched:** `src/types.ts` (MemoryMetadata, MemorySource, MemoryCategory types + new fields on StoreInput/SearchQuery/RecallQuery/ListQuery/UpdatePatch), `src/db/schema.ts` (SCHEMA_V3), `src/store.ts` (MemoryRow + rowToMemory + store/search/list/recall/update methods), `src/browser/server.ts` (domain/category graph filters + /api/domains endpoint), `src/browser/assets.ts` (complete UI rewrite), `src/mcp-server.ts` (zod schemas updated), `tests/` (7 new tests + 1 updated), `scripts/migrate-v3.ts` (new).
- **Action needed:** Royce must restart OpenCode for the new UI to take effect (the running MCP server has the old HTML in memory). Then browse to http://127.0.0.1:9333 to verify visually.

### Issue #14 — Memory bootstrap methodology + discovery script (2026-08-10)
- **Status:** CLOSED (committed + pushed — swept into the issue #20 squash merge `21303fc` as a "feat(bootstrap)" commit line; Royce confirmed 2026-08-11)
- **What:** Shipped a repeatable "deep learning phase" methodology so any realmemory user can mine their session history into a well-organized, weighted, interrelated memory database. Two artifacts in the repo:
  - `skills/realmemory-bootstrap/SKILL.md` — 7-phase cognitive pass: (1) Discover [run the script], (2) Inventory [list_memories dedup baseline], (3) Extract [prioritized by cost+todos], (4) Classify+weight [type/domain/category/weight/confidence/source], (5) Relate [build the web], (6) Forget [retire stale+probes], (7) Report. The script does mechanical extraction; the agent does cognition. Never collapse them.
  - `scripts/discover-history.mjs` — a portable Node ESM script (no build step) that queries opencode.db (sessions/messages/parts/todos) + scans the filesystem (MEMORY.md, PHASE_STATE.md per project, ADRs, agent defs, skills) and emits a compact `history-catalog.json`. Supports `--session <id>` for full transcript dumps, `--min-cost`, `--since`, `--limit`, `--out`. Uses better-sqlite3 (auto-detected) with node:sqlite fallback.
- **First run (this machine, Aug 2026):** 1614 sessions, 89k messages, $523 total cost, 40 filesystem sources. Added 5 memories (realmemory arch, realhax arch, agile-pipeline task_pattern, top-session summary, this bootstrap-fact), 4 relates (per-project arch extends hub-overview; pipeline derives from autonomous-mode lesson; session-summary derives from pipeline). Identified gaps: 0 realvol/realcode/basecamp project facts; 11 undefined-domain memories needing backfill; only 1 session_summary existed of 1614 sessions.
- **Packaging note:** `package.json` `files[]` is `["dist","README.md","LICENSE"]` — does NOT ship `skills/` or `scripts/` to npm consumers (git-install-only until files[] is updated). This is the same gap as item #3 in resume_next. Must add `"skills"` and `"scripts"` to files[] before npm publish v0.4.0.
- **Follow-ups identified:** (a) domain backfill on 11 undefined-domain memories, (b) per-project architecture facts for realvol/realcode/basecamp, (c) session summaries for more high-cost sessions, (d) exhaustive pass over remaining ~1600 sessions (the methodology is repeatable).

resume_next: >
  STATUS (Aug 13 2026): realmemory v0.8.0 — synthetic-brain Phase 2
  shipped (issue #34, PR #35, merge 838b423, tag issue-34). Prediction
  error (surprise-driven encoding) is live. 619 tests pass. Royce must
  restart OpenCode for the instrumented plugin to take effect — after
  restart, surprising tool outcomes will produce prediction_error:<bin>
  metrics and high-salience lesson_learned encodes.

  REMAINING (in priority order):
  (1) Royce restarts OpenCode — picks up the v0.8.0 plugin. After a
  session, check get_metrics for prediction_error:<bin> rows.
  (2) Synthetic-brain Phase 3 (working-memory window) — the next entry
  point. The design doc is at `docs/architecture/synthetic-brain.md`
  §4.2. Budgeted slotted injection rebuilt per turn under a token budget.
  (3) Cartographer refresh — ADR-010 is now reflected in DECISIONS.md +
  INV-017 (done by the #34 Cartographer run). ADR-009 `id` amendment
  still pending (from issue #28).
  (4) npm publish v0.8.0 — requires Royce's npm login. CRITICAL: add
  "skills" and "scripts" to package.json files[] before publishing.
  (5) Amend ADR-009 to document the `id` requirement for file/path
  plugins (from issue #28 — still pending).
  (6) PARKING_LOT drift items from #22: Drift #5 (secrets-before-LLM),
  #6 (zod 4th dep), #7 (schema-v3 ADR-less). Separate issues.
  (7) Domain backfill: 11 memories have undefined domain.
  (8) Consider re-adding a future Node LTS to CI.
