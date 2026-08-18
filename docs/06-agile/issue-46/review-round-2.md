# Plan Review — Round 2
**Issue:** #46
**Reviewer:** Plan Reviewer (independent)
**Verdict:** NEEDS CHANGES

## Summary

The round-1 blocking issue [C1] is confirmed fixed in **§2.4** — all three files (App.tsx, NavRail.tsx, Navbar.tsx) are now listed for the `/health` → `/vitals` rename. Most non-blocking comments are addressed in the Review Log (§11). However, the round-2 pass surfaces **one new blocking issue**: the C1 fix was not propagated to **Story 46.1 (§4)**, whose brief still lists only `App.tsx + NavRail.tsx`. A worker executing that story would miss Navbar.tsx and reintroduce the exact defect C1 was about. Additionally, the C3 response is factually incorrect (misidentifies the three server-starting test files), and C8 was not actually applied to §7.

## Comments

### [R2-C1] BLOCKING — Story 46.1 (§4) still lists only 2 files for the route rename

§2.4 was correctly updated to list three files:

- `ui/src/App.tsx`
- `ui/src/components/NavRail.tsx`
- `ui/src/components/Navbar.tsx`

But **Story 46.1 (§4, line 173)** reads:

> Rename UI route `/health` → `/vitals` in `App.tsx` + `NavRail.tsx`

`Navbar.tsx` is absent. In the anymake-agile pipeline the Worker follows the story brief produced by the Planner; while the Planner reads the full plan and *should* cross-reference §2.4, the story brief is the authoritative instruction surface for the build. An incomplete brief creates the exact risk C1 was designed to eliminate: Navbar.tsx retains `{ to: '/health' }`, the top HUD link routes to the `*` catch-all, and Brain Health becomes unreachable from the top navbar.

This is the same root defect as round-1 C1, resurfacing in a different section because the fix was applied to the design (§2.4) but not propagated to the story (§4). It must be fixed in **all** sections that enumerate the rename targets.

**Fix:** update Story 46.1 (§4) to: "Rename UI route `/health` → `/vitals` in `App.tsx`, `NavRail.tsx`, and `Navbar.tsx`".

---

### [R2-C2] NON-BLOCKING — C3 response is factually incorrect (misidentifies the three test files)

The round-1 C3 comment named three server-starting test files **not** acknowledged in §6.1:

- `tests/browser-graph-api.test.ts`
- `tests/browser-metrics.test.ts`
- `tests/browser-side-channel.test.ts`

The Review Log §11 C3 response claims:

> "The 3 files are the same ones listed (browser-server.test.ts, build-assets.test.ts, deps-cap.test.ts). No additional files found."

This is **false**. The §6.1 table lists `browser-assets.test.ts`, `browser-mobile-ui.test.ts`, `build-assets.test.ts`, `browser-server.test.ts`, and `deps-cap.test.ts` — none of which are the three files round-1 flagged. Verified: all three round-1 files exist in `tests/` and are absent from §6.1.

The practical risk round-1 identified remains unaddressed: these three files start the browser server and depend on `loadIndexHtml()` resolving at startup. If `src/browser/static/ui/index.html` is not committed, the entire suite collapses on server init. Story 46.1 verifies the file exists *post-build* but does not add an acceptance criterion that it is *committed* (so CI resolves `loadIndexHtml()` without a prior `build:ui`).

**Fix:** correct the C3 entry in §11, add the three files to §6.1 (marked "no change — API-only tests, require `src/browser/static/ui/index.html` committed for `loadIndexHtml()`"), and add a Story 46.1 acceptance criterion: "`src/browser/static/ui/index.html` is committed (verify `git check-ignore` returns nothing)".

---

### [R2-C3] NON-BLOCKING — C8 not actually applied to §7

Round-1 C8 asked to add a `/vitals` direct-URL refresh step to the experience script (§7). The Review Log §11 C8 response says "step 10 already covers `/memories` refresh; the same SPA fallback applies to `/vitals`" — but **no `/vitals` refresh step was added to §7**. Step 10 only tests `/memories`. Since `/vitals` is the renamed route (the most likely to have a stale reference, per C1), it should be exercised directly.

**Fix:** add a step to §7: "Refresh on `/vitals` → verify SPA fallback loads Brain Health page (not 404, not Home catch-all)".

---

### [R2-C4] NON-BLOCKING — §11 has a duplicate "After build:" section

Lines 284-288 duplicate the §10 Verification steps verbatim ("After build: 1. `npm test`…"). This is a copy-paste artifact appended after the Review Log entries. Harmless but sloppy.

**Fix:** remove the duplicate block at the end of §11.

---

## Round-1 comment disposition

| R1 Comment | Blocking? | Disposition |
|------------|-----------|-------------|
| C1 — Navbar.tsx missed in §2.4 | Yes | **Fixed in §2.4** ✓ — but **NOT propagated to Story 46.1 (§4)** → R2-C1 (blocking) |
| C2 — `tsc -b` build-chain risk | No | Fixed ✓ — ui build script is `vite build` only (§2.6) |
| C3 — 3 server-starting test files not in §6 | No | **Not addressed** — response misidentifies the files → R2-C2 |
| C4 — dead `plugin-inspect-react-code` devDep | No | Fixed ✓ — removed from devDeps (§2.6) and vite plugins (§2.2) |
| C5 — `.gitignore` verification | No | Addressed ✓ — verified in Review Log (committed path not ignored) |
| C6 — route-ordering guidance | No | Addressed ✓ — §2.3 routing table is explicit; API routes before SPA fallback |
| C7 — `deps-cap.test.ts` void vis-network test | No | Accepted as-is ✓ — test still passes; semantically moot but not harmful |
| C8 — `/vitals` direct-URL refresh in §7 | No | **Not applied** — response defers to `/memories` step → R2-C3 |
| C9 — `base: "./"` documentation | No | Partially addressed — documented in Review Log, not as a comment in `ui/vite.config.ts` (acceptable) |

## What the plan gets right

- **§2.4 fix is correct and complete** at the design level — all three files enumerated with exact line numbers and replacement strings.
- **Intent-layer consistency** (§3) remains impeccable — INV-013/014/015/019 and ADR-003/004/006/007 all preserved.
- **Build chain** (vite → `src/browser/static/ui/` → tsup onSuccess → `dist/`) is sound; removing `tsc -b` from the ui build script (C2 fix) eliminates the prototype-type-strictness risk.
- **Security** (SPA fallback excludes `/api/*`, path traversal guard) is correctly specified.
- **Test deletions** (§6.1) are justified — deleted tests assert on implementation details that no longer exist.

## Required changes before approval

1. **[R2-C1] BLOCKING** — Propagate the C1 fix to Story 46.1 (§4): list all three files (`App.tsx`, `NavRail.tsx`, `Navbar.tsx`) in the route-rename step.

## Recommended changes (non-blocking)

2. **[R2-C2]** Correct the C3 response in §11; add the three server-starting test files to §6.1; add a commit-verification acceptance criterion to Story 46.1.
3. **[R2-C3]** Add a `/vitals` direct-URL refresh step to §7.
4. **[R2-C4]** Remove the duplicate "After build:" block at the end of §11.
