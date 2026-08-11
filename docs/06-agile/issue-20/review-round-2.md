# Plan Review — Round 2 — Issue #20: Mobile-First UI Redesign

- **Reviewer:** Plan Reviewer (anymake-agile, independent — fresh context, round-1 work re-verified against code)
- **Plan reviewed:** `docs/06-agile/issue-20/plan.md` (349 lines, round-2 revision)
- **Round-1 review:** `docs/06-agile/issue-20/review-round-1.md` (8 objections)
- **Date:** 2026-08-11
- **Code re-verified this round:**
  - `src/browser/assets.ts:520` → `interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }` ✓ (matches plan §4.3 #5 quoted source)
  - `vitest.config.ts` → `environment: "node"`, `pool: "forks"`, `singleFork: true` ✓ (no DOM env)
  - `package.json` devDeps (per round-1, not re-grepped): eslint/tsup/typescript/vitest/@types/* only — no jsdom/happy-dom/playwright/puppeteer ✓
  - `PROJECTS/realmemory/PARKING_LOT.md` → existing 7 entries preserved; new "Mobile UI a11y hardening" section appended at end (file was NOT overwritten) ✓

---

## Verdict

`APPROVED`

All 8 round-1 objections are resolved in the revised plan. Resolutions were verified against the actual code (not just the plan's self-assertion). No new blocking issues introduced by the revision. The plan is ready for the approval gate and Worker dispatch.

---

## Per-objection verification

### O1 — vis-network `interaction` MERGE (was CRITICAL) — RESOLVED

- **Plan §4.3 #5 (lines 79-95):** explicitly says "The plan MERGES new keys into this object; it does NOT replace it." Quotes the current object verbatim (matches `assets.ts:520`), lists all 4 kept keys (`hover: true`, `tooltipDelay: 200`, `navigationButtons: false`, `keyboard: false`) and 3 added keys (`zoomView: true`, `dragView: true`, `multiselect: false`). Post-change object shown in full. States "No desktop-active key is dropped."
- **Desktop-regression string-assertion in Story A20.3:** yes — line 288 asserts `INDEX_HTML` contains `tooltipDelay: 200`, `navigationButtons: false`, `keyboard: false` post-change. Also §10 test table line 326.
- **§4.4 (line 118) + §8 (line 161):** cross-reference the MERGE as the regression-free guarantee.
- Verified: the quoted current object at plan line 81 matches `assets.ts:520` character-for-character.

### O2 — Story A20.3 test strategy (was CRITICAL) — RESOLVED

- **Plan §10 (lines 320-330) + Story A20.3 (lines 282-298):** explicitly picks **string-assertion parity** (option (a) from round-1). "NO new devDep. NO DOM environment. NO `vis.Network` instantiation." (line 282). "The `vis.Network` click-event test from the round-1 draft is REPLACED with a source-string assertion on the interaction object." (line 282).
- **Specific assertions named (lines 286-289, §10 table 324-327):** `min-width: 1024px`, `max-width: 1023px`, `bottom-tabs`, `env(safe-area-inset-bottom`, `calc(56px + env(safe-area-inset-bottom, 0px))`, `transform:translateX(-100%)`, `transform:translateY(100%)`, `.drawer.open`, `.sheet.open`, `.scrim`, `getViewportTier`, `matchMedia`, `orientationchange`, `zoomView: true`, `dragView: true`, `multiselect: false`, `redraw`, `network.fit`, `manipulation: { enabled: false }`, `tooltipDelay: 200`, `navigationButtons: false`, `keyboard: false`.
- **No new devDep:** §8 line 159 "Story A20.3 uses string-assertion parity … no jsdom/happy-dom/playwright/puppeteer is added." §10 line 330 reaffirms `vitest.config.ts` stays `environment:"node"`.
- Verified: `vitest.config.ts` is `environment: "node"` — the chosen strategy runs without infra changes.

### O3 — vis-network canvas lifecycle (was HIGH) — RESOLVED

- **Plan §4.3 #6 (lines 96-104):** full lifecycle subsection present with all 4 parts:
  - (a) Graph tab reactivation → `network.redraw()` + `network.fit({ animation: { duration: 300 } })` (line 98)
  - (b) Debounced `resize` → redraw+fit if network exists AND `#network` visible (line 100)
  - (c) Debounced `orientationchange` listener → same (line 102)
  - (d) Instance is NEVER re-created — only `setData`/`redraw`/`fit` (line 104)
- **Acceptance criterion:** A20.2 #6 (line 240) — "after switching List→Graph tab, the graph redraws to fill the viewport and `network.fit()` reframes it … After an `orientationchange`, the graph fits the new viewport."
- **VERIFY step in §3a:** A20.2 script steps 21, 22, 23 (lines 269-271) — reactivation redraw, orientationchange, resize-across-breakpoints with explicit "network instance is not recreated" check.
- **§4.4 (line 117):** restates instance never re-created.

### O4 — Bottom tab bar occlusion + safe-area (was HIGH) — RESOLVED

- **Option chosen: flex-child (not fixed).** §4.2 #1 (line 60): "`.bottom-tabs` is a flex child, NOT `position:fixed` — so `#center`'s box ends exactly above the tab bar; nothing is occluded."
- **`.bottom-tabs` safe-area:** §4.2 #2 (line 61): `height: calc(56px + env(safe-area-inset-bottom, 0px)); padding-bottom: env(safe-area-inset-bottom, 0px);`
- **Sheet safe-area:** §4.2 #4 (line 63): "The sheet gets `padding-bottom: env(safe-area-inset-bottom, 0px)` so its content clears the home indicator when extended to the bottom edge."
- **Acceptance criterion:** A20.1 #6 (line 193) — 390px viewport with `env(safe-area-inset-bottom)` mocked to 34px: touch targets sit above inset, graph's lowest visible node NOT occluded (flex child, so `#center` ends above tab bar).

### O5 — 44px touch rule gated (was MEDIUM) — RESOLVED

- **Plan §4.2 #6 (line 65):** "`min-height:44px; min-width:44px;` … **INSIDE `@media (max-width: 1023px)`** — NOT in the un-gated base CSS. Desktop (`>=1024px`) interactive elements retain their current sizing unchanged."
- **§4.2 #10 (line 69):** desktop path restores EXACTLY current rules; "The mobile-only `min-height:44px`/`min-width:44px` touch rule does NOT apply at `>=1024px` (it is gated inside `max-width:1023px`)."
- **§4.4 (line 119):** "Desktop interactive-element sizing is unchanged (44px touch rule is gated to `max-width:1023px`)."
- **Acceptance criterion:** A20.1 #5 (line 192) — at 1280px, "same interactive-element sizing (the 44px touch rule is gated to `max-width:1023px` and does NOT apply at `>=1024px`)."
- **Test assertion:** A20.3 (line 289) + §10 (line 327) — regex assertion that 44px rule appears inside `@media (max-width: 1023px)` block, not in un-gated base CSS.

### O6 — §3a scripts marked Human-Only (was MEDIUM) — RESOLVED

- **§10 (line 332):** "The A20.1 and A20.2 §3a drive-through scripts (real browser at 375px) are therefore classified **Human-Only**. The Validator defers them to the human reporter (Royce). In autonomous mode, the Product Owner Proxy may waive the Experience Runner pass … the proxy waiver applies because CDP/headless is not available; Royce does the final visual confirm."
- **Per-story headers:**
  - A20.1 (line 197): "**§3a classification: Human-Only.** … Validator defers this script to the human reporter (Royce)."
  - A20.2 (line 244): "**§3a classification: Human-Only.** Same rationale as A20.1 …"
- **A20.3 correctly NOT marked Human-Only** (line 312): steps 1-6 are CLI (`npm test`, `npm run check`, `npm run build`); only step 7 (desktop visual regression) is the Human-Only check already noted in §10. This is the correct split.

### O7 — a11y deferral + PARKING_LOT (was LOW) — RESOLVED

- **Plan §7 (line 151):** "Full a11y hardening — focus trap inside the drawer/sheet while open, `Esc`-to-close, `aria-expanded` on the hamburger button, `aria-hidden` toggling on drawer/sheet/scrim, `role="dialog"` — is explicitly DEFERRED to a follow-up." Backdrop-tap-to-close IS included (§4.2 #3, §4.3 #2); only keyboard/screen-reader hardening deferred.
- **PARKING_LOT.md verified:** file read this round — existing 7 entries (Memory export/import, Memory dashboard, Conflict resolution, Decay scheduler, Embedding model flexibility, Memory versioning, Team memory) all preserved. New "## Mobile UI a11y hardening" section appended at the end (lines 28-29) with the full deferral justification. File was **appended, not overwritten**.

### O8 — `.graph-controls` mobile placement (was LOW) — RESOLVED

- **Plan §4.2 #8 (line 67):** ".graph-controls … keeps its desktop position on mobile: `top: 8px; right: 8px;` of `main#center`, ABOVE the bottom tab bar and ABOVE the canvas." Z-index stack specified: canvas z-index 1, `.graph-controls` z-index 5, `.scrim` z-index 10, `.drawer`/`.sheet` z-index 20. "The fit/refresh buttons stay thumb-reachable at the top-right of the graph area on mobile."
- **A20.1 scope (line 183):** cross-references the same placement + z-index ordering.

---

## Check for NEW issues introduced by the revision

- **Scope creep:** none. §4.4 + §8 + A20.3 acceptance #4 (line 297) all reaffirm single-file scope (`src/browser/assets.ts` only). No new runtime dep, no new devDep, no schema/migration/config/env touch.
- **Contradictions:** none found. The `→ O{n}` inline markers are consistent with the actual resolutions. Cross-references between §4.3, §4.4, §8, §9 stories, and §10 are coherent.
- **`manipulation: { enabled: false }` (§4.3 #5, line 95):** a new additive vis-network option not in round-1. It is an already-supported vis-network feature (no new code/dep), additive to both mobile and desktop (no-op on desktop where manipulation is already off by default). Tested via string assertion (A20.3 line 287, §10 line 325). Not scope creep — it is a defensive explicit-disable consistent with the touch-config intent. Acceptable.
- **A20.3 §3a step 7 (line 309):** a Human-Only desktop visual regression check embedded in an otherwise-CLI script. Correctly noted at line 312 that steps 1-6 are NOT Human-Only. No issue.
- **Review log §12 (lines 342-345):** round-1 row filled with resolution summary; round-2 row pending. Correct.
- **Round-2 revision note (line 11):** accurately flags that all 8 objections are addressed inline. Verified.

No new blocking issues. No new non-blocking issues worth surfacing.

---

## Summary

The round-2 revision is a clean, thorough response to round-1. Both CRITICAL defects (O1 interaction MERGE, O2 test-strategy grounded in the actual vitest environment) are concretely fixed with verifiable specifics — the quoted `assets.ts:520` source matches the code, and the string-assertion strategy runs in the existing `environment:"node"` config without new infra. Both HIGH defects (O3 canvas lifecycle, O4 occlusion + safe-area) are addressed with a complete 4-part lifecycle subsection and a flex-child tab-bar design that structurally prevents occlusion. The MEDIUM/LOW items (O5 touch-rule gating, O6 Human-Only classification, O7 a11y deferral with PARKING_LOT append verified, O8 graph-controls placement) are all resolved with explicit plan text and cross-referenced acceptance criteria. The plan is internally consistent, scope is tightly bounded to a single file, and no new issues were introduced. Ready for the approval gate.

---

*End of review — round 2, issue #20. Verdict: APPROVED.*
