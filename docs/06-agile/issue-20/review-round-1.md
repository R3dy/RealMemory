# Plan Review — Round 1 — Issue #20: Mobile-First UI Redesign

- **Reviewer:** Plan Reviewer (anymake-agile, independent)
- **Plan reviewed:** `docs/06-agile/issue-20/plan.md` (294 lines)
- **Date:** 2026-08-11
- **Target file verified against code:** `src/browser/assets.ts` (843 lines) — line references confirmed
- **Test environment verified:** `vitest.config.ts` → `environment: "node"`; `package.json` devDeps = eslint/tsup/typescript/vitest/@types/* only (no jsdom, happy-dom, playwright, or puppeteer)
- **vis-network interaction object verified:** line 520 = `{ hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }`

---

## Verdict

`NEEDS CHANGES`

The plan is well-structured, correctly classified (Additive / presentation-only), correctly scoped to `assets.ts` only, and faithful to the reporter's binding override (graph stays primary on mobile). The intent-layer table (§6) is accurate — ADR-006 #2/#3/#4, ADR-007, INV-013/014/015 are genuinely preserved at the system boundary. The story breakdown (CSS → JS → tests, in dependency order) is sound.

However, the plan has **two CRITICAL correctness defects** that will cause desktop regression or non-running tests as literally written, plus several HIGH-severity gaps in the vis-network canvas lifecycle and mobile layout that the Experience Runner will hit on the first drive-through. These must be resolved before Worker dispatch.

---

## Strengths

1. **Correct classification.** Additive / presentation-only, single-file blast radius (`src/browser/assets.ts`). No schema, no server, no API, no dep. INV-013/014/015 genuinely untouched at the system boundary. §6 is accurate.
2. **Reporter override honored.** Graph is explicitly the primary mobile view (§4.1 table, §4.3 #4, Story A20.2 acceptance #3, Experience Script step 3/20-21). The rejected list-as-default alternative is recorded (§5 #3).
3. **Desktop regression-free *strategy* is right.** Gating the existing 3-column grid inside `@media (min-width: 1024px)` verbatim (§4.2 #9, Story A20.1 acceptance #5) is the correct approach — not a rewrite. JS additions short-circuit on `tier === 'desktop'` (§4.3 #6).
4. **Story ordering is correct.** CSS (A20.1) → JS (A20.2) → tests (A20.3); each is independently shippable and testable; each carries a literal §3a Experience Script at 375px. This matches the agile-pipeline contract.
5. **Alternatives section is honest.** §5 rejects the separate `/m` page, vis-network replacement, list-as-primary, SSR, and design-system deferral with correct rationale tied to the invariants and the `library` project type.
6. **Rollback is clean.** §11 — `git revert <merge-sha>`, single file, no migration. Confirmed: no schema/dep/config touch anywhere in the plan.

---

## Numbered Objections

### O1 — CRITICAL: vis-network `interaction` object is *replaced*, not *merged* — drops 3 desktop-active keys → desktop regression

Plan §4.3 #5 and Story A20.2 scope say to `set interaction: { hover: true, zoomView: true, dragView: true, multiselect: false }`. The current object at `assets.ts:520` is:

```js
interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }
```

The plan's literal instruction **replaces** this object. Consequences on the `>=1024px` desktop path (which the plan promises is "byte-for-byte equivalent to today," §4.1, §4.2 #9, A20.1 acceptance #5):

- `tooltipDelay: 200` is removed → hover tooltips appear at the vis-network default delay (≈0ms or undefined). Visible desktop behavior change.
- `keyboard: false` is removed → keyboard navigation may default on. Desktop behavior change.
- `navigationButtons: false` is removed → vis-network's on-canvas navigation buttons may render. Desktop visual change.

This is a direct contradiction of the plan's own "regression-free desktop" guarantee (§4.1, §4.2 #9, §4.4, §8, Story A20.1 acceptance #5, Story A20.2 acceptance #6). It is a real, verifiable regression, not a hypothetical.

**Required fix:** the plan must specify a **merge**, not a replacement:

```js
interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false,
               zoomView: true, dragView: true, multiselect: false }
```

(or spread the existing object and add the new keys). `zoomView`/`dragView`/`multiselect` are additive to both mobile and desktop (vis-network defaults zoomView/dragView to true already, so this is a no-op on desktop and an explicit-enable on mobile). The desktop path then retains `tooltipDelay`/`keyboard`/`navigationButtons` exactly. The plan must also add a desktop-regression test asserting `interaction.tooltipDelay === 200` survives the change (cross-reference O2).

### O2 — CRITICAL: Story A20.3 tests cannot run in the actual vitest environment

`vitest.config.ts` sets `environment: "node"`. `package.json` has **no** jsdom / happy-dom / playwright / puppeteer devDependency. The existing `tests/browser-assets.test.ts` confirms the working pattern: it imports `INDEX_HTML` as a **string** and asserts substring membership — no DOM is instantiated.

Story A20.3 proposes tests that require a live DOM and a live `vis.Network`:

- "hamburger click adds `.open` to `aside#sidebar`" → needs `document`, event dispatch, `classList`.
- "node-click (mobile) adds `.open` to `aside#detail`" → needs DOM + a vis.Network instance with a `click` event.
- "the options object passed to `new vis.Network(...)` includes `interaction.zoomView === true`" → needs the `vis` global, which is a browser-vendored bundle not importable in node.
- "mocked `matchMedia` / `window.innerWidth`" → needs `window`, which does not exist in `environment: "node"`.

As written, **every one of these tests will fail to compile or fail at runtime** before asserting anything. The plan never addresses this gap — it asserts "existing tests pass" (Story A20.3 acceptance #1) without acknowledging that the new tests need infrastructure the repo does not have.

**Required fix:** the plan must pick one of the following and specify it explicitly, with the trade-off:

- **(a) String-assertion parity (recommended).** Mirror the existing `browser-assets.test.ts` pattern: assert the *source* of `INDEX_HTML` contains the expected CSS rules / JS handlers (e.g. `expect(INDEX_HTML).toContain('min-width: 1024px')`, `expect(INDEX_HTML).toContain('zoomView: true')`, `expect(INDEX_HTML).toContain('getViewportTier')`). Zero new devDeps. INV-014 (runtime deps cap) is unaffected — devDeps are not runtime deps. This is the only option that runs in the current `environment: "node"` without new infra.
- **(b) Add a DOM environment.** Add `jsdom` (or `happy-dom`) as a devDep **and** a per-file or per-directory vitest environment override (`// @vitest-environment jsdom`). This is a new devDep and new test infra — must be called out in §8 (blast radius) and §6 (still INV-014-preserving since devDeps ≠ runtime deps, but the plan must say so). `vis.Network` still won't be importable; its `click` event would need to be mocked, which is brittle.
- **(c) Playwright/puppeteer E2E.** Adds a heavy devDep and a runner setup. Out of proportion for a presentation-only change to a dev-observability surface. Not recommended.

The plan should also explicitly reclassify the Story A20.2/A20.3 §3a drive-throughs as **Human-Only** (per §3a of the arbiter: criteria requiring a real browser at 375px are Human-Only when no automation infra exists), since §10's "Experience Runner … Playwright/puppeteer if available in the repo, else Chrome DevTools Protocol" is wishful — neither is available, and CDP requires a manual launcher anyway.

### O3 — HIGH: vis-network canvas lifecycle on tab switch and resize is unaddressed — graph will render blank/stale

The plan's mobile model hides `#network` via `display:none` when the List or Detail tab is active (§4.3 #4: "toggles which of `#network` / `#list-view` / `#detail` is the visible single viewport … `display:block` vs `display:none`"). vis-network renders into a `<canvas>` measured against its container's box. When the container is `display:none`, the canvas is laid out at 0×0. When the Graph tab is reactivated, vis-network does **not** auto-redraw — it will show the last frame at the wrong size, or blank, until `network.redraw()` / `network.setSize()` / `network.fit()` is called. The plan never mentions this. The Experience Runner will hit it on step 20→21 of A20.2's script (tap Graph tab → "VERIFY: graph is primary again") — the graph will be blank or mis-scaled.

The same problem applies to:

- **Viewport-tier transitions on `resize`** (§4.3 #1): the debounced `resize` listener recomputes `getViewportTier()` but never calls `network.redraw()`/`fit()`. Crossing the 640px or 1024px boundary changes the canvas box (bottom tab bar appears/disappears, layout reflows) without telling vis-network.
- **`orientationchange`** on mobile: not mentioned at all.
- **Drawer / sheet open/close**: these overlay the graph; if they cause the canvas box to change (e.g. via reflow), the same redraw issue applies.

**Required fix:** §4.3 must add a "vis-network canvas lifecycle" item:

1. When the Graph tab is reactivated (Detail/List tab → Graph tab), call `network.redraw()` then `network.fit({ animation: { duration: 300 } })`.
2. The `resize` listener (already debounced) must, in addition to recomputing tier, call `network.redraw()`/`network.fit()` if a network exists and `#network` is currently visible.
3. Add an `orientationchange` listener (also debounced) doing the same.
4. The plan must state explicitly that the vis-network **instance is never re-created** on tier change or tab switch — only `setData`/`redraw`/`fit` are called — to satisfy the blast-radius constraint that the graph not be destroyed on viewport change.

Add a corresponding acceptance criterion to A20.2 ("after switching List→Graph, the graph redraws to fill the viewport; after orientation change, the graph fits") and an Experience Script step asserting it.

### O4 — HIGH: Fixed bottom tab bar is out-of-flow — graph bottom is occluded; no safe-area handling

§4.2 #2 specifies `.bottom-tabs { position:fixed; bottom:0; left:0; right:0; height:56px; }`. A `position:fixed` element is removed from normal flow. §4.2 #1 specifies the mobile `#app` as `display:flex; flex-direction:column; height:100vh;` with "graph fills the available space between header and bottom tab bar." But because the tab bar is fixed (not a flex child), the flex column is `header (48px) + center (flex:1)`, where `center` extends to the bottom of `100vh` — i.e. **underneath** the 56px tab bar. The bottom 56px of the graph canvas (and the bottom of any scrollable list/detail content) is occluded by the tab bar. The plan never specifies a spacer, `padding-bottom`, or `margin-bottom` on `#center` / `main` to reserve room for the fixed bar.

Additionally, §4.2 specifies no `env(safe-area-inset-bottom)` anywhere. On iPhones with a home indicator (the SE in the Experience Script is 375×667 without one, but any modern iPhone at 390/393px width has it), a 56px fixed bar at `bottom:0` overlaps the home indicator and is not comfortably tappable. The adversarial checklist explicitly flags this.

**Required fix:** §4.2 must specify, for the mobile base:

- `#center` (or `main#center`) gets `padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px))` (or the tab bar becomes a flex child of `#app` instead of `position:fixed` — either is acceptable, pick one).
- `.bottom-tabs` gets `padding-bottom: env(safe-area-inset-bottom, 0px)` and `height: calc(56px + env(safe-area-inset-bottom, 0px))` so the touch targets sit above the home indicator.
- The same safe-area handling for any sheet/scrim that extends to the bottom edge.

Add an acceptance criterion: "at 390px viewport with safe-area-inset mocked, the bottom tab bar touch targets are fully above the home-indicator inset; the graph's lowest visible node is not occluded by the tab bar."

### O5 — MEDIUM: `min-height:44px` touch-target rule is in *base* (un-gated) CSS → leaks to desktop → desktop layout regression

§4.2 #6 says "every interactive element … gets `min-height:44px; min-width:44px;` **in the base CSS**." Base CSS is un-gated by `@media` — it applies at every width, including `>=1024px`, unless explicitly overridden in the `min-width:1024px` media query. The desktop path is supposed to be "byte-for-byte equivalent to today" (§4.2 #9, A20.1 acceptance #5). Forcing 44px min-height on desktop filter checkboxes, legend items, graph-control buttons, view-toggle buttons, and domain-tree items will change their heights and the overall desktop layout (sidebar content gets taller, footer legend rows get taller, header view-toggle buttons get taller). That is a visible desktop regression.

**Required fix:** gate the mobile touch-target rule inside `@media (max-width: 1023px)` (or scope it to mobile-only selectors). Desktop interactive elements retain their current sizing. Alternatively, if 44px targets are desired at desktop too, the plan must explicitly say so and update A20.1 acceptance #5 from "byte-for-byte" to "byte-for-byte except for touch-target sizing" — but that contradicts the regression-free promise, so the recommended fix is to gate it.

### O6 — MEDIUM: Experience Runner automation claim is not grounded in repo reality

§10 says: "Experience Runner: can drive a headless browser (Playwright/puppeteer if available in the repo, else Chrome DevTools Protocol) at a 375px viewport." Neither Playwright nor puppeteer is a devDep (verified in `package.json`). CDP without a launcher is not a usable automation path either. The §3a scripts in A20.1/A20.2 are written as if automatable (numbered VERIFY steps), but as written they are **manual** drive-throughs for this project.

This is not a code defect, but the plan misrepresents the verification surface. Either:

- **(a)** Reclassify the A20.1/A20.2 §3a scripts as Human-Only (per the §3a arbiter rule: criteria requiring a real browser at 375px, with no automation infra, are Human-Only). State this in §10 and in each story's §3a header. The Validator then defers them to the human reporter (Royce). This is the recommended path — it matches the `library` project type's "developer-observability surface, not a product UI" framing (§7).
- **(b)** Add Playwright as a devDep and a runner script. Heavy; not recommended for a single-file presentation change.

### O7 — LOW: Drawer/sheet accessibility — no focus trap, no Esc-to-close, no `aria-expanded`

The adversarial checklist explicitly flags "drawer that doesn't trap focus or close on backdrop tap." The plan covers backdrop-tap (scrim) close (§4.2 #3, §4.3 #2) but does not specify:

- Focus trap inside the drawer while open (focus will escape to the hidden graph/tab bar behind the scrim).
- `Esc` key closes the drawer/sheet.
- `aria-expanded` on the hamburger button and `aria-hidden` toggling on drawer/sheet for screen readers.

For a `library` dev-observability surface this is low-severity, but the plan should acknowledge the omission explicitly (e.g. "a11y hardening deferred to a follow-up — this surface is a developer tool, not a product UI") rather than leave it implicit. If deferred, log it to PARKING_LOT so it is tracked.

### O8 — LOW: Mobile graph-controls placement unspecified

`main#center` contains `.graph-controls` (fit/refresh buttons) overlaid on the graph (verified at `assets.ts:400`). On mobile, these buttons need a position that doesn't collide with the bottom tab bar, the sheet, or the drawer scrim. §4.2 does not mention `.graph-controls` mobile placement. Likely a Worker detail, but the plan should name it to avoid the Worker inventing an ad-hoc position that conflicts with the tab bar.

---

## Per-section notes

- **§1 Problem statement** — accurate. The "no `@media` breakpoints in assets.ts at all" claim is verified correct (grep for `@media`/`min-width` returns no hits in the file).
- **§2 Root cause** — correct. `grid-template-columns: 280px 1fr 360px` verified at line 91; `height: calc(100vh - 48px - 28px)` verified; `interaction: { hover: true, ... }` verified at line 520.
- **§3 Current-state review** — line ranges cited are accurate within a few lines. The "no explicit touch configuration" claim is verified (no `zoomView`/`dragView`/`manipulation` in the file).
- **§4.1 Viewport strategy** — three-tier model is reasonable. The 640/1024 breakpoints are named (good — addresses the "vague media queries" failure mode). The "graph is primary" mobile invariant is correctly threaded through.
- **§4.2 CSS restructuring** — points 1-9 are the right skeleton. O4 (occlusion), O5 (touch-target leak), O8 (graph-controls) are the gaps.
- **§4.3 JS additions** — points 1-6 are the right skeleton. O1 (interaction merge), O3 (vis canvas lifecycle) are the gaps.
- **§4.4 What does NOT change** — accurate. All six bullets verified against the code/ADR/INV surface.
- **§5 Alternatives** — all five rejections are correct and tied to the right invariants.
- **§6 Intent constraints** — table is accurate. ADR-006 #2/#3/#4, ADR-007, INV-013/014/015 all genuinely preserved at the system boundary. Classification Additive is correct; no superseding ADR needed.
- **§7 Design consistency** — correct that `library` skips the UX track; the "developer-observability surface, not a product UI" framing is consistent with the `library` manifest. Reuse of existing `:root` tokens and "no new color/font/icon" is the right constraint.
- **§8 Blast radius** — "files changed: 1" is correct. The regression-surface note (gate JS behind tier, move desktop CSS into media query verbatim) is the right mitigation *strategy*; O1/O3 show the *execution* is incomplete.
- **§9 Story breakdown** — ordering is correct (CSS → JS → tests, dependency-ordered). Each story has acceptance criteria + a §3a script (good). Story-level gaps are O1 (A20.2), O2/O3 (A20.3), O4/O5 (A20.1).
- **§10 Test & verification plan** — the new-test table (§10) is the right *intent*; O2 shows it is not runnable as written. The "Human-Only desktop visual regression" note is correct and should be extended to the mobile drive-throughs per O6.
- **§11 Rollback plan** — `git revert <merge-sha>`, single file, no migration. Verified accurate.
- **§12 Review log** — pending row present. Correct.

---

## Required changes (must resolve all before Worker dispatch)

1. **(O1, CRITICAL)** Rewrite §4.3 #5 and Story A20.2 scope to specify a **merge** of the interaction object: keep `hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false` and **add** `zoomView: true, dragView: true, multiselect: false`. State explicitly that no desktop-active key is dropped. Add a desktop-regression assertion that `interaction.tooltipDelay === 200` survives (string-assertion on `INDEX_HTML` source is sufficient given O2).
2. **(O2, CRITICAL)** Pick a test strategy for Story A20.3 and specify it explicitly in §10. Recommended: string-assertion parity with the existing `tests/browser-assets.test.ts` (assert `INDEX_HTML` contains the expected CSS rules and JS handler source). If a DOM environment is desired instead, name the devDep (`jsdom`/`happy-dom`), add it to §8 blast radius, and add a per-file `// @vitest-environment jsdom` directive. Either way, the `vis.Network` click-event test must be replaced (vis is not importable in node) — assert the options string in source, or mark that assertion Human-Only.
3. **(O3, HIGH)** Add a "vis-network canvas lifecycle" subsection to §4.3: (a) `network.redraw()` + `network.fit()` when the Graph tab is reactivated; (b) `network.redraw()`/`fit()` in the debounced `resize` handler when a network exists and is visible; (c) an `orientationchange` listener doing the same; (d) an explicit statement that the network instance is never re-created on tier change or tab switch. Add matching acceptance criteria to A20.2 and a VERIFY step to its §3a script.
4. **(O4, HIGH)** In §4.2, specify how the fixed bottom tab bar is kept from occluding graph content: either reserve space on `#center`/`main` via `padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px))`, or make `.bottom-tabs` a flex child of `#app` (not `position:fixed`). Add `env(safe-area-inset-bottom)` to `.bottom-tabs` height/padding and to any sheet that extends to the bottom edge. Add an acceptance criterion for safe-area handling at a 390px viewport with the inset mocked.
5. **(O5, MEDIUM)** Gate the 44px touch-target rule inside `@media (max-width: 1023px)` (or mobile-only selectors) so it does not alter desktop interactive-element heights. Update §4.2 #6 and A20.1 acceptance #5 to reflect this.
6. **(O6, MEDIUM)** Reclassify the A20.1/A20.2 §3a drive-through scripts as **Human-Only** in §10 and in each story's §3a header (no automation infra exists in the repo). Note in §10 that the Validator defers these to the human reporter. (Alternatively, add a Playwright devDep — not recommended.)
7. **(O7, LOW)** Either add focus-trap + `Esc`-to-close + `aria-expanded`/`aria-hidden` to §4.3, or explicitly defer a11y hardening and log it to `PARKING_LOT.md`. State the choice in the plan.
8. **(O8, LOW)** In §4.2, name `.graph-controls` mobile placement so the Worker does not invent an ad-hoc position that collides with the tab bar or sheet.

---

## After revisions

Re-run Plan Reviewer round 2. The CRITICAL items (O1, O2) are blocking — the Worker cannot correctly execute Story A20.2 (interaction merge) or Story A20.3 (tests) without them. The HIGH items (O3, O4) will surface as Experience Runner failures on the first A20.2 drive-through. Resolve all eight before dispatch.

---

*End of review — round 1, issue #20.*
