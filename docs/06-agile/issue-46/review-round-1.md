# Plan Review — Round 1
**Issue:** #46
**Reviewer:** Plan Reviewer (independent)
**Verdict:** NEEDS CHANGES

## Summary
A well-researched, intent-layer-consistent plan that correctly preserves INV-013/014/015/019 and the ADR-006/007 envelope. The build chain (vite → `src/browser/static/ui/` → tsup onSuccess → `dist/`) is sound. One blocking defect: the `/health` → `/vitals` route rename is incomplete — `Navbar.tsx` also carries the `/health` link and is missed by §2.4. Several non-blocking gaps around build-chain risks and test inventory should also be addressed.

## Comments

### [C1] BLOCKING — Navbar.tsx missed in /health → /vitals rename

§2.4 specifies renaming the route in `App.tsx` and `NavRail.tsx` only. But the prototype has **three** files carrying the `/health` link, not two:

- `app/src/App.tsx:17` — `<Route path="health" element={<Health />} />` ✓ covered
- `app/src/components/NavRail.tsx:10` — `{ to: '/health', label: 'Brain Health', icon: Activity }` ✓ covered
- `app/src/components/Navbar.tsx:13` — `{ to: '/health', label: 'Brain Health' }` ✗ **MISSED**

After the planned rename, the Navbar's top HUD link still points to `/health`. Clicking it routes to the `*` catch-all (which renders `<Home />`), so Brain Health becomes unreachable from the top navbar. The acceptance criterion §5 #4 (all client-side routes work) is indirectly violated — the route exists at `/vitals` but the Navbar sends users to `/health`.

**Fix:** add `ui/src/components/Navbar.tsx` to §2.4: change `{ to: '/health', ... }` → `{ to: '/vitals', ... }`.

---

### [C2] NON-BLOCKING — `tsc -b` in the ui build script is an unacknowledged build-chain risk

The prototype's `app/package.json` build script is `"build": "tsc -b && vite build"`. The plan's `build:ui` script (`cd ui && npm install && npm run build`) inherits this, so `tsc -b` runs before `vite build`. If the prototype has any TypeScript strictness errors (likely for a prototype — the `data.ts` `metadata: Record<string, any>` and loose `raw: any` patterns suggest relaxed typing), `tsc -b` fails and the entire root `npm run build` fails.

The plan's §8 (Risk) does not mention this. Either:
- (a) Acknowledge the risk and commit to fixing any TS errors during Story 46.1, or
- (b) Change `ui/package.json` build script to `"build": "vite build"` (skip tsc — vite's esbuild transpile is sufficient for a localhost dev tool; type-checking can be a separate `typecheck` script).

Recommend (b) for a localhost UI — the root `npm run typecheck` already covers the library; the UI doesn't gate the release.

---

### [C3] NON-BLOCKING — Three additional test files start the browser server but aren't listed in §6

`grep -l "startBrowserServer" tests/` reveals **three** test files the plan's §6.1 doesn't acknowledge:

- `tests/browser-graph-api.test.ts` — starts the server, tests `/api/graph`
- `tests/browser-metrics.test.ts` — starts the server (twice, line 63 + 122), tests `/api/metrics`
- `tests/browser-side-channel.test.ts` — intercepts + starts the server, tests side-channel behavior

These will still pass (they test API endpoints, not the UI), **but only if `loadIndexHtml()` succeeds at server startup**. Today `loadVisNetworkJs()` reads the committed `src/browser/static/vis-network.min.js`; after the change, `loadIndexHtml()` reads the committed `src/browser/static/ui/index.html`. If Story 46.1's vite build hasn't been run (or the output isn't committed), every server-starting test throws on `loadIndexHtml()` and the suite collapses.

**Fix:** add a note to §6 confirming these three files require no changes (they test API endpoints), and add an acceptance criterion to Story 46.1: "verify `src/browser/static/ui/index.html` is committed so `loadIndexHtml()` resolves in CI without a prior `build:ui`."

---

### [C4] NON-BLOCKING — `plugin-inspect-react-code` is a dead devDep in ui/package.json

The plan removes `inspectAttr()` from `vite.config.ts` but says "Keep all deps as-is" for `ui/package.json`. The prototype's `package.json:79` lists `"plugin-inspect-react-code": "^1.0.3"` as a devDep. With the plugin removed from the vite config, this dep is dead weight. It IS a real npm package (verified: `npm view plugin-inspect-react-code` → `1.0.3`), so `npm install` won't fail — but it pollutes the install. Recommend removing it from `ui/package.json` devDeps for cleanliness.

---

### [C5] NON-BLOCKING — `.gitignore` verification not mentioned

The plan commits `src/browser/static/ui/` (per §2.1 and INV-019). But if `.gitignore` has a pattern like `*/static/ui/` or `**/assets/`, the built UI won't actually be committable. The plan should add a verification step: `git check-ignore src/browser/static/ui/index.html` returns nothing (not ignored). INV-019 already commits `dist/`, but `src/browser/static/ui/` is a new committed path in the source tree that needs the same guarantee.

---

### [C6] NON-BLOCKING — SPA fallback interaction with `/version` and `/favicon.ico` not explicitly ordered

The routing table in §2.3 lists `/version`, `/favicon.ico`, `/health` before the SPA catch-all, which is correct. But the implementation description (§2.3 "New routing") says "after all known routes are checked, if the path does NOT start with `/api/` … serve `index.html`." This is correct but should explicitly note that `/health`, `/version`, and `/favicon.ico` must be matched BEFORE the SPA fallback, or a careless implementation could serve index.html for `/version` (breaking the test at `browser-server.test.ts:103`). The plan's intent is right; the implementation guidance should be more explicit about route ordering.

---

### [C7] NON-BLOCKING — `deps-cap.test.ts` line 27-31 test is now semantically void

`deps-cap.test.ts` has a test "vis-network is NOT a runtime dependency (vendored browser asset)" (lines 27-32). After this change, vis-network is gone entirely. The test still passes (vis-network is still not a dep), but the test's purpose is moot. The plan's §6.1 says "VERIFY" for this file. Recommend either deleting the vis-network-specific test or rewriting it to assert "ui deps are NOT in root dependencies" (which is the new invariant of interest).

---

### [C8] NON-BLOCKING — Experience script §7 doesn't verify the `/vitals` route via direct URL

§7 step 7 says "Click Brain Health → verify metrics charts" (client-side nav). Step 10 tests SPA fallback on `/memories` refresh. But the `/vitals` route (the renamed one) should also be tested via direct URL / refresh, since it's the route that was renamed and is the most likely to have a stale reference (per C1). Add: "Refresh on `/vitals` → verify SPA fallback loads Brain Health page."

---

### [C9] NON-BLOCKING — Vite `base: "./"` is safe for this app but fragile

`base: "./"` produces relative asset paths (`./assets/index-*.js`). This works for all current routes (`/`, `/memories`, `/domains`, `/brain`, `/vitals`) because they're all single-segment paths without trailing slashes — the browser resolves `./assets/...` against the directory `/`, yielding `/assets/...`. However, if a future route adds a path parameter (e.g., `/memories/:id`), the directory becomes `/memories/` and `./assets/...` breaks. This is not a problem today but is worth a comment in `ui/vite.config.ts` noting why `base: "./"` works and when it would need to change to `base: "/"`.

---

## What the plan gets right

- **Intent-layer consistency** is impeccable: INV-013 (localhost/read-only/no-framework — node:http unchanged, React/Three.js are browser-side vendored static assets, same pattern as vis-network), INV-014 (all new deps in `ui/package.json`, root `dependencies` untouched), INV-015 (no `MemoryStore` method changes, MINOR bump), INV-019 (built UI committed in `src/browser/static/ui/` → copied to `dist/` by existing tsup onSuccess).
- **Route conflict resolution** (rename UI `/health` → `/vitals`, keep server `/health`) is the right call — backward compatible, no `connectLive()` change needed.
- **Security** (SPA fallback must not serve HTML for `/api/*`, path traversal guard) is correctly identified.
- **Build chain** (build:ui → src/browser/static/ui/ → tsup onSuccess → dist/browser/static/ui/) is correct and requires no tsup config change.
- **Rollback** (`git revert`) is correct since everything including `dist/` is committed.
- **Test deletions** are justified — the deleted tests assert on implementation details (embedded HTML strings) that no longer exist.

## Required changes before approval

1. **[C1]** Add `ui/src/components/Navbar.tsx` to §2.4 route rename. (BLOCKING)

## Recommended changes (non-blocking)

2. **[C2]** Address the `tsc -b` build-chain risk — recommend changing ui build script to `"vite build"`.
3. **[C3]** Acknowledge the 3 additional server-starting test files and add a commit-verification step for `src/browser/static/ui/index.html`.
4. **[C4]** Remove `plugin-inspect-react-code` from `ui/package.json` devDeps.
5. **[C5]** Add `.gitignore` verification for `src/browser/static/ui/`.
6. **[C6]** Make route ordering explicit in the implementation guidance.
7. **[C7]** Update or delete the void vis-network test in `deps-cap.test.ts`.
8. **[C8]** Add `/vitals` direct-URL refresh to the experience script.
9. **[C9]** Document why `base: "./"` is safe in `ui/vite.config.ts`.
