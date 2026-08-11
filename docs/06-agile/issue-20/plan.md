# Development Plan — Issue #20: Redesign Web UI to Mobile-First UX Philosophy

- **Issue:** https://github.com/R3dy/RealMemory/issues/20
- **Reporter verbatim:** "redesign the realmemory web ui to follow mobile first ux philosophy"
- **Reporter override (binding):** the graph MUST stay the PRIMARY view on mobile. A list-as-default recommendation was explicitly rejected during intake.
- **Plan author:** Solution Architect (anymake-agile)
- **Target file:** `src/browser/assets.ts` (the single embedded HTML/CSS/JS page, ~843 lines) — and ONLY that file.
- **Classification:** Additive / presentation-only. No schema, no server, no dep, no public API change.
- **Status:** In Review (round 2)

> **Round-2 revision note.** This revision resolves all 8 numbered objections from `review-round-1.md` (2026-08-11, verdict `NEEDS CHANGES`). Per-objection resolutions are flagged inline with `→ O{n}` markers. See §12 for the Review Log.

---

## 1. Problem Statement

The RealMemory graph browser (`src/browser/assets.ts`, served at `http://127.0.0.1:9333` by `src/browser/server.ts`) is desktop-first: a fixed 3-column CSS grid (`280px 1fr 360px`) with a permanent left sidebar (domain tree + filters), a center graph/list, and a permanent right detail panel. On any viewport narrower than ~1024px the layout collapses badly — the three columns squeeze, the graph becomes unusable, the sidebar and detail rail consume most of the screen, and touch interaction is an afterthought (no pinch-zoom, no touch-pan, tiny hit targets).

A user on a phone or a narrow laptop window cannot usefully drive the browser. The reporter wants a mobile-first redesign: the UI should be authored for the narrow viewport first, then progressively enhance back to the current desktop layout — without regressing the desktop experience.

## 2. Root Cause / Motivation

The current CSS assumes a wide viewport. `grid-template-columns: 280px 1fr 360px` hard-codes three columns; `height: calc(100vh - 48px - 28px)` assumes the 48px header + 28px footer are always visible; `aside#sidebar` and `aside#detail` are always-rendered, always-laid-out blocks. There are no `@media` breakpoints in `assets.ts` at all (grep-confirmed: zero `@media` hits in the file today). The JS interaction model assumes mouse (hover, click-to-detail-in-right-rail) — vis-network is initialized with `interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }` (verified at `assets.ts:520`) and no explicit touch configuration.

Root cause = the page was authored as a single desktop layout with no responsive strategy. The fix is to introduce a mobile-first responsive layer (CSS custom media + media queries) and a touch-first interaction layer (drawer, bottom sheet, bottom tab bar, vis-network touch config) — while leaving the `>=1024px` desktop path byte-for-byte equivalent to today.

## 3. Current-State Review

Pre-computed facts (re-verified against `assets.ts` line ranges):

- **Header** (CSS ~lines 47-86, HTML ~lines 316-334): 48px fixed, `display:flex`, logo + search (`max-width:500px`) + stats bar + Graph/List view-toggle buttons.
- **`#app` grid** (CSS ~lines 88-94): `grid-template-columns: 280px 1fr 360px; grid-template-rows: 1fr; height: calc(100vh - 48px - 28px)`.
- **aside#sidebar** (CSS ~lines 96-157, HTML ~lines 336-387): domain tree + type/category/scope/tags/weight/date filters. Always visible.
- **main#center** (CSS ~lines 159-209, HTML ~lines 389-404): `#network` (vis-network graph), `#list-view` (table), `.graph-controls` (fit/refresh buttons overlaid top-right at `assets.ts:400`).
- **aside#detail** (CSS ~lines 211-287, HTML ~lines 406-411): memory detail panel. Always visible, empty until a node is clicked.
- **Footer** (CSS ~lines 289-298, HTML ~lines 413-426): type/edge color legend, `overflow-x:auto`.
- **JS** (~lines 428-843): color maps, `/api/graph` + `/api/domains` fetch, vis-network init with `interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }` at line 520, node click → `/api/memory/:id` → detail panel render, domain click → filter, filters, list sort, search.
- **Server** (`src/browser/server.ts`): localhost-only (127.0.0.1), read-only, GET-only, `node:http`, no framework. vis-network vendored at `/static/vis-network.min.js`.
- **Tests:** `tests/` with vitest. `vitest.config.ts` → `environment: "node"`, `pool: "forks"`, `singleFork: true`. `package.json` devDeps: ONLY `@eslint/js`, `@types/better-sqlite3`, `@types/node`, `eslint`, `tsup`, `typescript`, `vitest` — NO jsdom, happy-dom, playwright, or puppeteer. Runtime deps (INV-014 cap=3, currently 4): `@huggingface/transformers`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`. The existing `tests/browser-assets.test.ts` imports `INDEX_HTML` as a STRING and asserts substring membership — no DOM is instantiated. This is the working test pattern this plan mirrors (see §10, Story A20.3).
- `npm test` runs vitest; `npm run check` is typecheck+lint; `npm run build` uses tsup.

## 4. Solution Design

**Scope boundary:** edit `src/browser/assets.ts` only. No other file. The server, the API surface, the vendored vis-network, the build, and the public MCP API are untouched.

### 4.1 Viewport strategy — three breakpoints, mobile-first

Author the base (un-media-queried) CSS as the narrow layout, then layer enhancements with `min-width` media queries. Three tiers:

| Tier | Viewport | Layout |
|------|----------|--------|
| **Mobile** (base) | `< 640px` | Single column. Graph is primary. Bottom tab bar (Graph \| List \| Detail) switches the single viewport. Sidebar → slide-in drawer. Detail → bottom sheet. |
| **Tablet hybrid** | `640px – 1023px` | Two-pane: graph primary + detail as a slide-up sheet (tap node) + sidebar as drawer. Bottom tab bar hidden; a lighter top control row appears. |
| **Desktop** | `>= 1024px` | **UNCHANGED** — current 3-column grid, current header, current footer, current JS behavior. Regression-free. |

The existing `grid-template-columns: 280px 1fr 360px` ruleset moves INSIDE a `@media (min-width: 1024px)` block. The base (no-media-query) `#app` becomes a single-column flex/stack.

### 4.2 CSS restructuring (inside `assets.ts` `<style>`)

1. **`#app` base (mobile):** `display:flex; flex-direction:column; height: 100vh;` — graph fills the available space between header and bottom tab bar. Sidebar and detail are present in the DOM but translated off-screen (`transform: translateX(-100%)` for drawer, `translateY(100%)` for sheet) and revealed by a class toggle. **`#app`'s flex children, top-to-bottom:** header (48px) → `main#center` (`flex:1; min-height:0;`) → `.bottom-tabs` (see #2). The bottom tab bar is a flex child, NOT `position:fixed` — so `#center`'s box ends exactly above the tab bar; nothing is occluded. → **O4 resolved (option chosen: flex-child, not fixed).**
2. **Bottom tab bar** (new, `.bottom-tabs`): flex child of `#app` (NOT `position:fixed`). `height: calc(56px + env(safe-area-inset-bottom, 0px)); padding-bottom: env(safe-area-inset-bottom, 0px); display:flex;` with three buttons (Graph / List / Detail), each `flex:1`. The 56px content area holds the touch targets; the `env(safe-area-inset-bottom)` padding pushes them above the home indicator. Hidden at `>=640px` (`display:none` in the tablet media query). → **O4 resolved (safe-area applied to height + padding).**
3. **Drawer** (`.drawer` on `aside#sidebar`): base `position:fixed; top:48px; bottom:0; left:0; width:280px; transform:translateX(-100%); transition:transform 200ms;` — `.drawer.open { transform:translateX(0); }`. A backdrop `.scrim` (semi-transparent `--bg-scrim`) sits above the graph, below the drawer, and closes the drawer on tap.
4. **Bottom sheet** (`.sheet` on `aside#detail`): base `position:fixed; left:0; right:0; bottom:0; max-height:70vh; transform:translateY(100%); transition:transform 200ms; border-radius:12px 12px 0 0;` — `.sheet.open { transform:translateY(0); }`. The sheet gets `padding-bottom: env(safe-area-inset-bottom, 0px)` so its content clears the home indicator when extended to the bottom edge. A drag-handle affordance at the top; tap outside or tap close-button dismisses. → **O4 resolved (sheet safe-area).**
5. **Header collapse (mobile):** base header shows logo + hamburger + search icon. The search input expands on tap (`.search-collapsed` → `.search-expanded`). Stats bar hidden on mobile (move into drawer or drop). View-toggle buttons hidden (replaced by bottom tabs). At `>=640px` the tablet header restores search inline; at `>=1024px` the full current header restores.
6. **Touch targets (mobile-only):** every interactive element (filter checkboxes, legend items, graph-control buttons, tab-bar buttons, drawer items) gets `min-height:44px; min-width:44px;` **INSIDE `@media (max-width: 1023px)`** — NOT in the un-gated base CSS. Desktop (`>=1024px`) interactive elements retain their current sizing unchanged. → **O5 resolved (gated inside `max-width:1023px`).**
7. **Footer (mobile):** hidden by default (legend moves into the drawer's "Legend" section), or rendered as a horizontally-scrollable strip above the bottom tab bar. Recommendation: hide on mobile, surface in drawer — keeps the graph maximal.
8. **`.graph-controls` mobile placement:** `.graph-controls` (the fit/refresh button cluster, currently overlaid on the graph at `assets.ts:400`) keeps its desktop position on mobile: `top: 8px; right: 8px;` of `main#center`, ABOVE the bottom tab bar and ABOVE the canvas. Its `z-index` is above the canvas but below the drawer scrim and sheet (e.g. canvas z-index 1, `.graph-controls` z-index 5, `.scrim` z-index 10, `.drawer`/`.sheet` z-index 20). The fit/refresh buttons stay thumb-reachable at the top-right of the graph area on mobile. → **O8 resolved.**
9. **`@media (min-width: 640px)` (tablet):** bottom tab bar `display:none`. `.bottom-tabs` hidden. Detail sheet becomes a right-side or bottom sheet depending on orientation; drawer stays a drawer but can be wider. Two-pane: graph + (detail sheet when a node is tapped).
10. **`@media (min-width: 1024px)` (desktop, regression-free):** restore EXACTLY the current rules: `#app { grid-template-columns: 280px 1fr 360px; grid-template-rows: 1fr; height: calc(100vh - 48px - 28px); }`, sidebar and detail back to grid children (no transform), header full, footer full, bottom tabs `display:none`, sheet/drawer classes inert, `.graph-controls` at its current desktop position. The desktop path must be visually and behaviorally identical to today. The mobile-only `min-height:44px`/`min-width:44px` touch rule does NOT apply at `>=1024px` (it is gated inside `max-width:1023px`). → **O5 resolved (desktop sizing unchanged).**

### 4.3 JS additions (inside `assets.ts` `<script>`)

No framework. Vanilla JS, same style as the existing handlers. Additions:

1. **Viewport detection:** a small `getViewportTier()` returning `'mobile' | 'tablet' | 'desktop'` based on `window.matchMedia('(min-width: 1024px)').matches` / `(min-width: 640px)`. Recompute on `resize` (debounced). Used to gate desktop-only behavior so the desktop path is untouched.
2. **Drawer toggle:** hamburger button in header → `sidebarEl.classList.toggle('open')` + `scrimEl.classList.toggle('visible')`. Scrim tap closes.
3. **Bottom sheet toggle:** on node click (existing handler), IF viewport tier is mobile/tablet, add `detailEl.classList.add('open')` instead of rendering into the always-visible right rail. Close button + scrim tap → `classList.remove('open')`.
4. **Bottom tab view-switching:** three buttons (Graph / List / Detail). On mobile, switching tabs toggles which of `#network` / `#list-view` / `#detail` is the visible single viewport (via a `.active` class, `display:block` vs `display:none` on the others). Graph tab is default-active on load (per reporter override — graph is primary). When Detail tab is activated without a selected memory, show an empty state ("Tap a node to see its detail").
5. **vis-network touch config — MERGE, not replace (→ O1 resolved).** The existing `interaction` object at `assets.ts:520` is:
   ```js
   interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }
   ```
   The plan MERGES new keys into this object; it does NOT replace it. The post-change object is:
   ```js
   interaction: {
     hover: true,
     tooltipDelay: 200,        // KEPT — desktop hover behavior unchanged
     navigationButtons: false, // KEPT — desktop: no on-canvas nav buttons
     keyboard: false,          // KEPT — desktop: no keyboard nav
     zoomView: true,           // ADDED — enables pinch-zoom on touch (no-op on desktop, where vis-network defaults zoomView to true)
     dragView: true,           // ADDED — enables one-finger pan on touch (no-op on desktop)
     multiselect: false        // ADDED — explicit-disable on touch (no-op on desktop)
   }
   ```
   No desktop-active key is dropped. `zoomView`/`dragView`/`multiselect` are additive to both mobile and desktop. Also ensure `manipulation: { enabled: false }` (already-supported vis-network option, no new code/dep). Pinch-zoom is handled natively by vis-network when `zoomView: true`. No touch-event shimming needed.
6. **vis-network canvas lifecycle (→ O3 resolved).** vis-network renders into a `<canvas>` measured against its container's box. When the container is `display:none` (List or Detail tab active on mobile) the canvas is laid out at 0×0; vis-network does NOT auto-redraw on re-show. To handle this, the JS additions include a lifecycle layer:

   (a) **Graph tab reactivation.** When the bottom-tab switcher activates the Graph tab (from List or Detail), call `network.redraw()` then `network.fit({ animation: { duration: 300 } })`. This forces a fresh canvas paint at the correct box size and reframes the graph.

   (b) **Debounced `resize` handler.** The `resize` listener from #1 already recomputes `getViewportTier()`. In addition, after recomputing, IF a `network` instance exists AND `#network` is currently visible (Graph tab active OR tier is desktop), call `network.redraw()` then `network.fit({ animation: { duration: 300 } })`. Crossing the 640px or 1024px boundary changes the canvas box (bottom tab bar appears/disappears, layout reflows) — this tells vis-network to re-measure.

   (c) **`orientationchange` listener.** Add a debounced `orientationchange` listener (separate from `resize`; on mobile `orientationchange` fires after `resize`, and a debounce coalesces both). It does the same: IF `network` exists AND `#network` is visible, `network.redraw()` + `network.fit({ animation: { duration: 300 } })`.

   (d) **Instance is NEVER re-created.** The vis-network `network` instance is created exactly once on page load. Tier transitions, tab switches, drawer/sheet open-close, resize, and orientationchange NEVER call `new vis.Network(...)` again. Only `network.setData(...)` (already in the codebase for filter/search refresh), `network.redraw()`, and `network.fit(...)` are called. This satisfies the blast-radius constraint that the graph not be destroyed/recreated on viewport change.

7. **Desktop guard:** every JS addition above (§4.3 #2, #3, #4, #6) short-circuits when `getViewportTier() === 'desktop'` — the desktop path runs the existing code unchanged. The §4.3 #5 interaction-object MERGE applies at all tiers (it is additive and a no-op on desktop), so it is not gated. This is the regression-free guarantee.

### 4.4 What does NOT change

- `src/browser/server.ts` — untouched.
- The API (`/api/graph`, `/api/domains`, `/api/memory/:id`, `/static/*`) — untouched.
- vis-network vendored static asset — untouched (INV-014 preserved).
- Public MCP API (`index.ts`, server config) — untouched (INV-015).
- Runtime deps — none added (INV-014). vis-network is a browser-side static asset, already vendored.
- localhost-only / read-only / GET-only / no-framework — untouched (ADR-006 #2/#3/#4, INV-013).
- `autoStartBrowser` behavior — untouched (ADR-007).
- The vis-network `network` instance is never re-created on tier change or tab switch (only `setData`/`redraw`/`fit`). → **O3 resolved.**
- Desktop `interaction` keys (`hover`, `tooltipDelay: 200`, `navigationButtons: false`, `keyboard: false`) are preserved; new keys are additive. → **O1 resolved.**
- Desktop interactive-element sizing is unchanged (44px touch rule is gated to `max-width:1023px`). → **O5 resolved.**

## 5. Alternatives Considered

1. **Build a separate mobile page (`/m`).** Rejected — doubles the surface, forks the rendering logic, violates "single embedded page" simplicity of ADR-006. Mobile-first responsive within the same page is strictly better.
2. **Replace vis-network with a touch-friendly lib.** Rejected — violates INV-014 (no new dep) and ADR-006 #4. vis-network already supports touch; we just need to enable it.
3. **Make the list the primary mobile view** (smaller graph, scannable list). Rejected by the reporter explicitly — graph stays primary.
4. **Server-side rendering / templating.** Rejected — violates ADR-006 #4 (no framework) and the single-page embedded design. The fix is purely client CSS+JS.
5. **Defer to a Phase 2 design-system sprint.** Rejected — `library` project type has no UX track (see §7). There is no design-system gate to wait for. This is a developer-observability surface; the redesign is a direct presentation fix.

## 6. Intent Constraints

| Constraint | Status | Notes |
|-----------|--------|-------|
| ADR-006 #2 (localhost-only 127.0.0.1) | **PRESERVED** | No server change. UI still served only at 127.0.0.1:9333. |
| ADR-006 #3 (read-only, GET-only) | **PRESERVED** | No new routes, no new methods. UI still only GETs. |
| ADR-006 #4 (no new runtime dep, node:http, vis-network vendored) | **PRESERVED** | Purely CSS+JS within `assets.ts`. vis-network touch options are already-shipped features of the vendored bundle. No import added. |
| ADR-007 (auto-start side channel, defeasurable) | **PRESERVED** | No change to server lifecycle. |
| INV-013 (localhost, read-only, no framework) | **PRESERVED** | Still no framework. Still localhost. Still read-only. |
| INV-014 (runtime deps capped at 3, no new dep) | **PRESERVED** | Zero new runtime deps. No new devDeps either (see §10 — string-assertion parity, no DOM env added). |
| INV-015 (public API stable) | **PRESERVED** | MCP API surface unchanged. |

**Classification: Additive (presentation-only).** No conflict gate needed. No superseding ADR required. The redesign touches none of the invariants — it is CSS + JS interaction within the existing single embedded page.

## 7. Design Consistency

realmemory is a **`library`** project type. The `library` manifest **skips the UX track** — there is no `docs/ux-design.md`, no design-system sprint, no Prototype Sprint gate. This plan does not need to (and cannot) reconcile against a design system that does not exist for this project type.

The web UI is a **developer-observability surface** — a localhost browser for inspecting the memory graph during development — not a product UI shipped to end users. The design bar is "clean, consistent, usable on a phone," not "funded-company product UI."

**Design DNA:** reuse the existing dark-theme tokens already defined as `:root` CSS custom properties in `assets.ts`. All new components (bottom tab bar, drawer, bottom sheet, scrim, mobile header) MUST use the same `--bg-*`, `--fg-*`, `--accent-*`, `--border-*` variables. No new color palette. No new font. No new icon set (use Unicode glyphs / existing SVGs already in the page). The mobile layout is a re-arrangement of the existing visual language, not a new one.

**Accessibility (→ O7 resolved — DEFERRED).** Full a11y hardening — focus trap inside the drawer/sheet while open, `Esc`-to-close, `aria-expanded` on the hamburger button, `aria-hidden` toggling on drawer/sheet/scrim, `role="dialog"` — is explicitly DEFERRED to a follow-up. This surface is a developer-observability tool, not a product UI, and the `library` project type skips the UX track. The deferral is logged to `PROJECTS/realmemory/PARKING_LOT.md` (see new "Mobile UI a11y hardening" entry). Backdrop-tap-to-close IS included in this plan (§4.2 #3, §4.3 #2); only the keyboard/screen-reader hardening is deferred.

## 8. Blast Radius

- **Files changed:** 1 (`src/browser/assets.ts`).
- **Files at risk:** 0 beyond it. The server, API, build, and public surface are untouched.
- **Public API impact:** none (INV-015).
- **Runtime dep impact:** none (INV-014).
- **Dev dep impact:** none. Story A20.3 uses string-assertion parity (mirrors `tests/browser-assets.test.ts`); no jsdom/happy-dom/playwright/puppeteer is added. → **O2 resolved.**
- **Migration needed:** none. No schema, no config, no env.
- **Regression surface:** the `>=1024px` desktop path. Mitigated by: (a) gating every JS addition behind `getViewportTier() !== 'desktop'` (except the additive interaction MERGE, which is a no-op on desktop); (b) moving the existing desktop CSS into a `min-width:1024px` media query verbatim; (c) gating the 44px touch rule inside `max-width:1023px`; (d) MERGING (not replacing) the vis-network interaction object so `tooltipDelay: 200` / `navigationButtons: false` / `keyboard: false` survive. → **O1, O5 resolved.**
- **Test surface:** existing browser tests (vitest, `environment:"node"`) must pass unchanged. New tests added for mobile behavior use string-assertion parity only (see §10). → **O2 resolved.**

## 9. Story Breakdown

Three stories. Each is independently shippable; the order is required (CSS before JS before tests).

---

### Story A20.1 — CSS restructure: mobile-first layout, bottom tabs, drawer, sheet, desktop regression-free

**Scope:** edit only the `<style>` block of `src/browser/assets.ts`.

- Move the current `#app` grid ruleset (`grid-template-columns: 280px 1fr 360px`, etc.) inside `@media (min-width: 1024px)`.
- Add base (mobile) `#app` as single-column flex stack: header (48px) → `main#center` (`flex:1; min-height:0;`) → `.bottom-tabs` (flex child, NOT `position:fixed`). → **O4**
- Add `.bottom-tabs` as a flex child of `#app` with `height: calc(56px + env(safe-area-inset-bottom, 0px)); padding-bottom: env(safe-area-inset-bottom, 0px);` three buttons, hidden at `>=640px`. → **O4**
- Add `.drawer` / `.drawer.open` on `aside#sidebar` (off-canvas translate), restored to grid child at `>=1024px`.
- Add `.sheet` / `.sheet.open` on `aside#detail` (bottom-sheet translate, `padding-bottom: env(safe-area-inset-bottom, 0px)`), restored to grid child at `>=1024px`. → **O4**
- Add `.scrim` (semi-transparent backdrop).
- Collapse header on mobile: hamburger + search icon, hide stats bar + view-toggle buttons. Restore full header at `>=1024px`. Tablet (`640-1023`) shows inline search.
- Hide footer on mobile (legend moves to drawer section); restore at `>=1024px`.
- Touch targets: `min-height:44px; min-width:44px;` on all interactive elements **INSIDE `@media (max-width: 1023px)`** — NOT in un-gated base CSS. → **O5**
- `.graph-controls` mobile placement: `top: 8px; right: 8px;` of `main#center`; `z-index` above canvas, below `.scrim`/`.drawer`/`.sheet`. → **O8**
- All new rules use existing `:root` CSS custom properties — no new color/font.

**Acceptance criteria:**

1. At 375px viewport, the page renders a single column with the graph as the primary visible viewport, a bottom tab bar with Graph/List/Detail, and a header showing hamburger + search icon.
2. At 375px, `aside#sidebar` is translated off-canvas (not visible) until `.open` is added.
3. At 375px, `aside#detail` is translated off-canvas (not visible) until `.open` is added.
4. At 750px (tablet), the bottom tab bar is hidden; graph is primary; sidebar still drawer-mode; detail still sheet-mode.
5. At 1280px (desktop), the layout is byte-for-byte the current 3-column grid — same column widths, same header, same footer, same behavior, same interactive-element sizing (the 44px touch rule is gated to `max-width:1023px` and does NOT apply at `>=1024px`). No visual regression. → **O5 reflected.**
6. At 390px viewport with `env(safe-area-inset-bottom)` mocked to e.g. 34px, the bottom tab bar's touch targets sit fully above the 34px home-indicator inset (the 56px content area is above the inset), and the graph's lowest visible node is NOT occluded by the tab bar (the tab bar is a flex child, so `#center`'s box ends above it). → **O4 reflected.**
7. All new CSS uses existing `:root` custom properties. No new color literals.
8. `npm run check` passes. `npm run build` passes.

**Experience Script (§3a) — Human-Only (→ O6):**

> **§3a classification: Human-Only.** This script drives a real browser at 375px. The repo has NO automation infra (no Playwright/puppeteer devDep; `vitest.config.ts` is `environment:"node"`). Per the §3a arbiter rule, criteria requiring a real browser with no automation infra are Human-Only. The Validator defers this script to the human reporter (Royce). In autonomous mode, the Product Owner Proxy may waive the Experience Runner pass per its human-only rules — CDP/headless automation is NOT available for this project, so the proxy waiver applies and Royce does the final visual confirm.

```
1. Run: npm run build && node -e "require('./dist/index.js')" (or the project's standard start) to launch the browser server on 127.0.0.1:9333.
2. Open Chrome DevTools → Toggle device toolbar → set to "iPhone SE" (375×667).
3. Navigate to http://127.0.0.1:9333.
4. VERIFY: graph (#network) is the primary visible viewport, filling the screen above the bottom tab bar. The graph's bottom edge is NOT occluded by the tab bar (the tab bar is a flex child below #center).
5. VERIFY: header shows a hamburger button on the left and a search icon; stats bar and Graph/List toggle buttons are NOT visible.
6. VERIFY: a bottom tab bar is at the screen bottom (flex child of #app) with three tabs labeled Graph / List / Detail. The Graph tab is visually active.
7. VERIFY: aside#sidebar is NOT visible on screen (off-canvas left).
8. VERIFY: aside#detail is NOT visible on screen (off-canvas bottom).
9. (CSS-only story — no interactivity yet. Drawer/sheet do not need to open in this story.)
10. Resize DevTools viewport to 750px (tablet).
11. VERIFY: bottom tab bar is hidden. Graph remains primary. Sidebar and detail are still off-canvas.
12. Resize DevTools viewport to 1280px (desktop).
13. VERIFY: the page shows the EXACT current desktop layout — 280px sidebar (visible), center graph, 360px detail panel (visible), full header with search + stats + view toggles, full footer legend. No visual difference from the pre-redesign build. Interactive-element heights match the pre-redesign build (44px touch rule did not leak to desktop).
14. (Safe-area check) Switch DevTools to a 390px viewport (e.g. "iPhone 12 Pro" or custom 390×844 with safe-area-inset enabled). VERIFY: the bottom tab bar's touch targets sit above the home-indicator inset; the graph's lowest visible node is not occluded.
```

---

### Story A20.2 — JS interaction: drawer toggle, sheet toggle, bottom-tab switching, vis-network touch config (MERGE), canvas lifecycle

**Scope:** edit only the `<script>` block of `src/browser/assets.ts`.

- Add `getViewportTier()` (`'mobile' | 'tablet' | 'desktop'`) via `matchMedia`, debounced `resize` listener.
- Hamburger button → toggles `.open` on `aside#sidebar` + `.visible` on `.scrim`. Scrim tap closes.
- Existing node-click handler: when tier is mobile/tablet, add `.open` to `aside#detail` (sheet slides up) instead of relying on the always-visible rail. Desktop path unchanged.
- Close button on sheet + scrim tap → remove `.open`.
- Bottom tab buttons: on mobile, toggle `.active` among `#network` / `#list-view` / `#detail` (only one visible at a time). Graph tab active on load. Detail tab shows empty-state ("Tap a node to see its detail") when no memory selected.
- vis-network init: MERGE the interaction object (→ O1). Keep `hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false`; ADD `zoomView: true, dragView: true, multiselect: false`. Ensure `manipulation: { enabled: false }`. No desktop-active key dropped.
- vis-network canvas lifecycle (→ O3): on Graph tab reactivation → `network.redraw()` + `network.fit({ animation: { duration: 300 } })`; debounced `resize` calls `redraw()`/`fit()` if network exists and `#network` is visible; debounced `orientationchange` does the same; the `network` instance is NEVER re-created on tier change or tab switch — only `setData`/`redraw`/`fit`.
- Every new handler (except the additive interaction MERGE) short-circuits when tier === `'desktop'` — desktop behavior is identical to today.

**Acceptance criteria:**

1. On mobile, tapping the hamburger opens the sidebar drawer (slides in from left); a scrim appears; tapping the scrim closes the drawer.
2. On mobile, tapping a graph node opens the detail bottom sheet (slides up from bottom) showing that memory's detail; tapping the sheet's close button or the scrim closes it.
3. On mobile, tapping the List tab makes `#list-view` the visible viewport and hides `#network`/`#detail`; tapping Detail tab makes `#detail` visible (with empty-state if nothing selected); tapping Graph tab restores the graph as primary.
4. On mobile, pinch-zoom on the graph works (vis-network `zoomView:true`).
5. On mobile, one-finger drag pans the graph.
6. On mobile, after switching List → Graph tab, the graph redraws to fill the viewport and `network.fit()` reframes it (not blank, not mis-scaled). After an `orientationchange`, the graph fits the new viewport. → **O3 reflected.**
7. On desktop, none of the mobile handlers fire — the hamburger is hidden, the sidebar and detail are always-visible grid children, node click renders detail in the right rail exactly as today, and the existing Graph/List toggle buttons work as before. The vis-network interaction object still contains `tooltipDelay: 200`, `navigationButtons: false`, `keyboard: false` (MERGE, not replace). → **O1 reflected.**
8. `npm run check` passes. `npm run build` passes. Existing tests pass.

**Experience Script (§3a) — Human-Only (→ O6):**

> **§3a classification: Human-Only.** Same rationale as A20.1 — real browser at 375px, no automation infra in the repo. Validator defers to Royce. In autonomous mode, Product Owner Proxy waiver applies (CDP/headless not available); Royce does the final visual confirm.

```
1. Launch the browser server on 127.0.0.1:9333.
2. Open Chrome DevTools → device toolbar → "iPhone SE" (375×667). Navigate to http://127.0.0.1:9333.
3. VERIFY: graph is primary. Graph tab is active in the bottom tab bar.
4. Tap the hamburger button in the header.
5. VERIFY: the sidebar drawer slides in from the left (domain tree + filters visible). A semi-transparent scrim covers the graph.
6. Tap the scrim.
7. VERIFY: the drawer slides back off-canvas; scrim disappears.
8. Tap a node in the graph.
9. VERIFY: the detail bottom sheet slides up from the bottom, showing the selected memory's fields (id, type, content, etc.).
10. Tap the sheet's close button (or the scrim).
11. VERIFY: the sheet slides back down off-screen.
12. On the graph, perform a pinch-zoom gesture (DevTools touch emulation: two-finger pinch).
13. VERIFY: the graph zooms in/out.
14. Perform a one-finger drag on the graph.
15. VERIFY: the graph pans.
16. Tap the "List" tab in the bottom tab bar.
17. VERIFY: the list view (#list-view) is now the visible viewport; the graph and detail are hidden.
18. Tap the "Detail" tab.
19. VERIFY: the detail panel is the visible viewport, showing an empty-state message ("Tap a node to see its detail") since nothing is selected.
20. Tap the "Graph" tab.
21. VERIFY: the graph is primary again. VERIFY (→ O3): the graph is NOT blank or mis-scaled — it redraws to fill the viewport and reframes via network.fit().
22. (→ O3) Rotate the device (DevTools → rotate). VERIFY: after the debounced orientationchange, the graph redraws and fits the new viewport orientation.
23. (→ O3) Resize DevTools viewport slowly across 640px then 1024px. VERIFY: the graph redraws at each breakpoint transition; the network instance is not recreated (graph data persists, no flash of empty canvas).
24. Resize DevTools viewport to 1280px (desktop).
25. VERIFY: the hamburger is gone; the full header (logo + inline search + stats + Graph/List toggles) is back; the 3-column grid is back; sidebar and detail are always visible. Tap a node → detail renders in the right rail as before. No mobile-only handler fires. VERIFY (→ O1): hover a node — the tooltip appears after ~200ms (tooltipDelay: 200 preserved). Keyboard nav is OFF (keyboard: false preserved). No on-canvas nav buttons (navigationButtons: false preserved).
```

---

### Story A20.3 — Tests: string-assertion parity for mobile CSS + JS source (no DOM environment)

**Scope:** add tests under `tests/` (vitest, `environment:"node"`). No production-code change beyond what A20.1/A20.2 shipped.

**Test strategy (→ O2 resolved):** mirror the existing `tests/browser-assets.test.ts` pattern — import `INDEX_HTML` as a STRING and assert substring membership. NO new devDep. NO DOM environment. NO `vis.Network` instantiation. The `vis.Network` click-event test from the round-1 draft is REPLACED with a source-string assertion on the interaction object. This is the only strategy that runs in the current `vitest.config.ts` (`environment:"node"`) without new infra.

Tests to add (all are `expect(INDEX_HTML).toContain(...)` or `expect(INDEX_HTML).toMatch(/.../)` style):

- **CSS mobile-base assertions:** `INDEX_HTML` contains `min-width: 1024px` (desktop gate), `max-width: 1023px` (mobile-only gate for touch targets), `bottom-tabs`, `env(safe-area-inset-bottom`, `calc(56px + env(safe-area-inset-bottom, 0px))`, `transform:translateX(-100%)` (drawer), `transform:translateY(100%)` (sheet), `.drawer.open`, `.sheet.open`, `.scrim`.
- **JS handler source assertions:** `INDEX_HTML` contains `getViewportTier`, `matchMedia`, `orientationchange`, `zoomView: true`, `dragView: true`, `multiselect: false`, `redraw`, `network.fit`, `manipulation: { enabled: false }` (or `manipulation:{enabled:false}`).
- **Desktop-regression assertion (→ O1):** `INDEX_HTML` contains `tooltipDelay: 200` AFTER the change (i.e. the merge preserved the desktop key). Also assert `navigationButtons: false` and `keyboard: false` are present.
- **Touch-target gating assertion (→ O5):** the `min-height:44px` / `min-width:44px` rule appears inside a `@media (max-width: 1023px)` block in the source (assert via a regex that the 44px rule follows a `max-width: 1023px` media-query opener, or assert the 44px rule does NOT appear in un-gated base CSS — pick the more robust regex at implementation time).
- **Existing tests pass unchanged.** The existing `tests/browser-assets.test.ts` assertions (which check for the current desktop structure) must still pass — this is the regression guard.

**Acceptance criteria:**

1. `npm test` passes, including all new tests.
2. New tests cover (via string-assertion parity): mobile CSS rules present, desktop CSS gated inside `min-width:1024px`, touch-target rule gated inside `max-width:1023px`, safe-area handling present, JS handlers present in source, vis-network interaction object MERGE preserves `tooltipDelay: 200` / `navigationButtons: false` / `keyboard: false` and adds `zoomView: true` / `dragView: true` / `multiselect: false`.
3. `npm run check` passes.
4. No production file other than `src/browser/assets.ts` is modified across A20.1–A20.3.
5. No new devDep is added (`package.json` devDeps unchanged). No DOM environment is added to vitest. → **O2 reflected.**

**Experience Script (§3a):**

```
1. Run: npm test
2. VERIFY: all tests pass (existing + new).
3. Run: npm run check
4. VERIFY: typecheck + lint pass.
5. Run: npm run build
6. VERIFY: build succeeds; dist/ contains the updated assets.
7. (Regression guard) With the browser server running, open a desktop Chrome at 1280px → http://127.0.0.1:9333. Drive the existing pre-redesign happy path (graph renders, node click → detail in right rail, search works, domain filter works). VERIFY: no regression.
```

> Note: the A20.3 §3a script is runnable as-written (steps 1-6 are CLI; step 7 is the Human-Only desktop visual regression check already noted in §10). Steps 1-6 are NOT Human-Only — they are automated CLI invocations.

---

## 10. Test & Verification Plan

**Existing tests:** all tests under `tests/` (vitest, `environment:"node"`) must pass unchanged. The redesign is presentation-only; no API contract changes.

**New tests (Story A20.3) — string-assertion parity (→ O2 resolved):**

| Test | What it asserts (all via `expect(INDEX_HTML).toContain(...)` or `.toMatch(...)`) |
|------|-----------------|
| CSS mobile-base | `INDEX_HTML` contains `min-width: 1024px`, `max-width: 1023px`, `bottom-tabs`, `env(safe-area-inset-bottom`, `calc(56px + env(safe-area-inset-bottom, 0px))`, `transform:translateX(-100%)`, `transform:translateY(100%)`, `.drawer.open`, `.sheet.open`, `.scrim`. |
| JS handler source | `INDEX_HTML` contains `getViewportTier`, `matchMedia`, `orientationchange`, `zoomView: true`, `dragView: true`, `multiselect: false`, `redraw`, `network.fit`, `manipulation: { enabled: false }`. |
| Desktop-regression (→ O1) | `INDEX_HTML` contains `tooltipDelay: 200`, `navigationButtons: false`, `keyboard: false` (the MERGE preserved the desktop keys). |
| Touch-target gating (→ O5) | The 44px touch-target rule appears inside a `@media (max-width: 1023px)` block (regex assertion), NOT in un-gated base CSS. |
| Existing tests unchanged | The current `tests/browser-assets.test.ts` assertions still pass — this is the regression guard. |

**No DOM environment added (→ O2 reflected).** `vitest.config.ts` stays `environment:"node"`. No jsdom/happy-dom/playwright/puppeteer devDep. The `vis.Network` click-event test from the round-1 draft is REPLACED with the source-string assertion above. devDeps do not count against INV-014 (runtime deps cap), but this plan adds none of either.

**Experience Runner (→ O6 reflected):** A CDP/headless automation path is NOT available for this project — no Playwright/puppeteer devDep exists, and `vitest.config.ts` is `environment:"node"`. The A20.1 and A20.2 §3a drive-through scripts (real browser at 375px) are therefore classified **Human-Only**. The Validator defers them to the human reporter (Royce). In autonomous mode, the Product Owner Proxy may waive the Experience Runner pass per its human-only rules — the proxy waiver applies because CDP/headless is not available; Royce does the final visual confirm. The A20.3 §3a script (CLI steps 1-6) is NOT Human-Only and runs as normal; step 7 is the Human-Only desktop visual regression check.

**Manual verification (Human-Only criteria):** the desktop `>=1024px` visual regression check — open desktop Chrome at 1280px, confirm the 3-column layout is visually identical to the pre-redesign build. This is a human-eyes check; the automated regression test only asserts source-string membership, not pixel equality.

## 11. Rollback Plan

`git revert <merge-sha>` — single commit, single file (`src/browser/assets.ts`). No schema, no migration, no deps, no config, no env. After revert, the page returns byte-for-byte to the pre-redesign desktop-first layout. No cleanup step needed.

## 12. Review Log

| Round | Date | Reviewer | Role | Verdict | Report | Resolution |
|-------|------|----------|------|---------|--------|------------|
| 1 | 2026-08-11 | Plan Reviewer (anymake-agile, independent) | Independent review | `NEEDS CHANGES` | `docs/06-agile/issue-20/review-round-1.md` | All 8 objections addressed in this revision — see per-objection resolutions inline (O1: §4.3 #5 MERGE; O2: §10 string-assertion parity; O3: §4.3 #6 canvas lifecycle; O4: §4.2 #1-#4 flex-child + safe-area; O5: §4.2 #6/#10 gated touch rule; O6: §10 + per-story §3a Human-Only; O7: §7 deferred + PARKING_LOT; O8: §4.2 #8 graph-controls placement). |
| 2 | _(pending)_ | Plan Reviewer | Independent review | _pending_ | _(pending)_ | _(pending)_ |

---

*End of plan — Issue #20, mobile-first UI redesign of `src/browser/assets.ts`. Round-2 revision: all 8 objections from `review-round-1.md` resolved.*
