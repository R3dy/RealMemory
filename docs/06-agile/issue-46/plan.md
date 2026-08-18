# Development Plan — Issue #46: Replace web UI with 3D Brain Graph prototype

**Issue:** [#46](https://github.com/R3dy/RealMemory/issues/46)
**Status:** Approved (R2)
**Classification:** Additive (presentation-only) — no public API change, no schema change, no new runtime dep
**Mode:** Autonomous (Product Owner Proxy gates)

## 1. Problem

The current web UI (`src/browser/assets.ts`, 1137-line embedded HTML string + vendored vis-network 2D canvas) is functional but visually dated. Royce has a polished React + TypeScript + Tailwind + Three.js (react-three-fiber) JARVIS-style 3D Brain UI prototype that already includes live API integration (`initDataSource()` fetches from `http://127.0.0.1:9333/api/graph`), exact data-model parity, and all existing UI features (search, filters, detail drawer, metrics). He wants to **completely replace** the old UI with this prototype.

## 2. Design

### 2.1 Directory layout

```
repo/
├── ui/                          # NEW — the React/Three.js app (build-time only)
│   ├── package.json             # own devDeps (react, three, radix, etc.)
│   ├── vite.config.ts           # builds to ../src/browser/static/ui/
│   ├── index.html
│   ├── tsconfig.json
│   ├── tsconfig.app.json
│   ├── tsconfig.node.json
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── components.json
│   ├── eslint.config.js
│   ├── public/                  # logo.svg etc.
│   └── src/                     # App.tsx, pages/, components/, lib/, hooks/, types/
├── src/
│   ├── browser/
│   │   ├── server.ts            # MODIFIED — serve built UI + SPA fallback
│   │   ├── assets.ts            # DELETED
│   │   └── static/
│   │       ├── ui/              # NEW — vite build output (committed, vendored)
│   │       │   ├── index.html
│   │       │   ├── assets/      # hashed JS/CSS chunks
│   │       │   └── logo.svg
│   │       └── vis-network.*    # DELETED (replaced by ui/)
│   └── ... (rest unchanged)
├── tsup.config.ts               # UNCHANGED — onSuccess already copies src/browser/static/ → dist/browser/static/
└── package.json                 # MODIFIED — add build:ui script, bump version
```

### 2.2 Vite config

```ts
// ui/vite.config.ts
import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",                    // relative paths — works when served at /
  plugins: [react()],            // removed plugin-inspect-react-code (dev-only)
  build: {
    outDir: "../src/browser/static/ui",   // vendored into the existing static dir
    emptyOutDir: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
```

- `base: "./"` produces relative asset paths (`./assets/index-*.js`). When served at `/`, the browser resolves these to `/assets/index-*.js`. The server serves `/assets/*` from the built UI directory.
- `outDir: "../src/browser/static/ui"` — the built output lands in the source tree (committed). tsup's `onSuccess` hook then copies `src/browser/static/` → `dist/browser/static/` recursively (already in `tsup.config.ts`). No tsup change needed.

### 2.3 server.ts changes

The server keeps all `/api/*` endpoints, `/health`, `/version`, `/favicon.ico` unchanged. The root `/` and static asset serving change. An SPA fallback is added for client-side routes.

**Route conflict:** The prototype has a `/health` UI route (the Brain Health metrics dashboard). The server has a `/health` endpoint returning `{ ok: true }` (used by `connectLive()` in `data.ts`). Resolution: **rename the UI route from `/health` to `/vitals`** in `App.tsx` and `NavRail.tsx`. This avoids touching the server's `/health` endpoint (backward compatible) and the `connectLive()` call in `data.ts`.

**New routing in `handleRequest`:**

```
GET /                         → serve built index.html (SPA shell)
GET /assets/*                 → serve built JS/CSS chunks (Content-Type by extension)
GET /logo.svg                 → serve from built UI root
GET /favicon.ico              → 204 (unchanged)
GET /health                   → { ok: true } (unchanged — API endpoint)
GET /version                  → { version: "0.14.0" } (bumped)
GET /api/stats                → unchanged
GET /api/domains              → unchanged
GET /api/graph                → unchanged
GET /api/metrics              → unchanged
GET /api/memory/:id           → unchanged
GET /* (everything else)      → serve index.html (SPA fallback for /memories, /domains, /brain, /vitals)
```

**Implementation approach:**

Replace the `INDEX_HTML` import from `assets.ts` with a function that loads `index.html` from the built UI assets directory (same multi-candidate path pattern as `loadVisNetworkJs()` — dev `src/browser/static/ui/` and built `dist/browser/static/ui/`).

Add a `serveStaticFile()` helper that reads a file from the UI assets directory and serves it with the correct Content-Type (`.js` → `application/javascript`, `.css` → `text/css`, `.svg` → `image/svg+xml`, `.html` → `text/html`).

Add SPA fallback: after all known routes are checked, if the path does NOT start with `/api/` and does NOT match a static file, serve `index.html`. This handles `/memories`, `/domains`, `/brain`, `/vitals` for direct URL access / refresh.

**Security:** the SPA fallback must NOT serve `index.html` for `/api/*` paths (those return 404 JSON, not HTML). The path traversal guard (`..` in path) must be rejected.

### 2.4 Route rename in the prototype

Three files reference the `/health` UI route — all must be renamed to `/vitals`:

- `ui/src/App.tsx`: change `<Route path="health" element={<Health />} />` to `<Route path="vitals" element={<Health />} />`
- `ui/src/components/NavRail.tsx` line 10: change `{ to: '/health', label: 'Brain Health', icon: Activity }` to `{ to: '/vitals', label: 'Brain Health', icon: Activity }`
- `ui/src/components/Navbar.tsx` line 13: change `{ to: '/health', label: 'Brain Health' }` to `{ to: '/vitals', label: 'Brain Health' }`

(Confirmed via grep: these are the only three files with `to: '/health'`. The `components/health/` subdirectory is component-level — route-agnostic.)

### 2.5 assets.ts + vis-network removal

- Delete `src/browser/assets.ts` (the 1137-line embedded HTML string).
- Delete `src/browser/static/vis-network.min.js`, `vis-network.VERSION.txt`, `vis-network.LICENSE.txt`.
- Remove `loadVisNetworkJs()` from `server.ts`.
- Remove the `/static/vis-network.min.js` route from `server.ts`.
- Remove the `INDEX_HTML` import from `server.ts`.

### 2.6 package.json changes

Root `package.json`:
- Add `"build:ui": "cd ui && npm install && npm run build"` to `scripts`.
- Update `"build"` script to run `build:ui` before `tsup`: `"build": "npm run build:ui && tsup"`.
- Bump `version`: `0.13.0` → `0.14.0`.
- Bump `/version` endpoint in `server.ts`: `0.9.0` → `0.14.0` (it was stale at 0.9.0 — fix to match).

`ui/package.json`:
- Copy from prototype's `app/package.json`.
- Change `name` to `realmemory-ui`.
- Change `build` script from `"tsc -b && vite build"` to `"vite build"` only — skip `tsc -b` type-checking (vite transpiles TS via esbuild; the prototype's type strictness is not our build gate, and `tsc -b` may fail on prototype type issues that don't affect the runtime bundle).
- Remove `plugin-inspect-react-code` from devDependencies (dev inspection tool, not needed in production build; also removed from vite plugins in §2.2).
- Keep all other deps as-is (they're all dev/build-time — never shipped to consumers since root `files[]` is `["dist","README.md","LICENSE"]`).

### 2.7 Data layer (already wired — no change needed)

The prototype's `lib/data.ts` already:
- `initDataSource()` fetches `http://127.0.0.1:9333/api/graph?limit=2000&scope=all` on boot
- Falls back to demo data if the API is unreachable (1.5s timeout)
- Fetches `/api/stats`, `/api/domains`, `/api/metrics` aggregates
- Has `normalizeMemory()`, `normalizeEdge()` that coerce API responses
- Has `connectLive()` for manual reconnection (calls `/health`)
- Has `importDataset()` for JSON import, `resetToDemo()` for demo data

When the UI is served from the same origin (127.0.0.1:9333), `DEFAULT_API_BASE = 'http://127.0.0.1:9333'` works same-origin. No CORS, no proxy needed.

### 2.8 Google Fonts

The prototype's `index.html` loads fonts from Google Fonts CDN (Orbitron, Rajdhani, JetBrains Mono). Since the UI is localhost-only, this requires internet access on the browsing machine. This is acceptable for a dev tool. Vendoring fonts is a future polish step (PARKING_LOT, not blocking).

## 3. Intent-layer check

| Invariant / ADR | Status | Notes |
|-----------------|--------|-------|
| INV-013 (localhost, read-only, no web framework) | PRESERVED | node:http server unchanged, no express/fastify, browser-side libs vendored as static assets |
| INV-014 (runtime dep cap = 3 + zod) | PRESERVED | all new deps in `ui/package.json` (dev/build-time only), never in root `dependencies` |
| INV-015 (public API stability) | PRESERVED | no MemoryStore method changes, MINOR bump |
| INV-019 (dist committed) | PRESERVED | built UI in `src/browser/static/ui/` → copied to `dist/browser/static/ui/` by tsup onSuccess, committed |
| ADR-006 #2-#4 | PRESERVED | localhost-only, read-only, vendored static asset (same pattern, larger asset) |
| ADR-007 | PRESERVED | auto-start side channel unchanged |
| ADR-003 (dep policy) | PRESERVED | no new runtime deps |
| ADR-004 (semver) | PRESERVED | MINOR bump 0.13.0 → 0.14.0 |

**No intent conflict.** No superseding ADR needed. Classification: Additive (presentation-only), same class as issues #13/#20/#24.

## 4. Stories

### Story 46.1 — Move prototype into repo, configure vite build
- Copy prototype `app/` → `ui/` in repo root
- Create `ui/package.json` (rename to `realmemory-ui`)
- Configure `ui/vite.config.ts` (outDir → `../src/browser/static/ui`, remove inspect plugin)
- Rename UI route `/health` → `/vitals` in `App.tsx` + `NavRail.tsx` + `Navbar.tsx` (3 files, per §2.4)
- Add `build:ui` script to root `package.json`
- Run `npm run build:ui` → verify `src/browser/static/ui/index.html` + `assets/` exist

### Story 46.2 — Modify server.ts to serve built UI + SPA fallback
- Replace `INDEX_HTML` import with `loadIndexHtml()` (multi-candidate path, same pattern as `loadVisNetworkJs`)
- Add `serveStaticFile()` helper (Content-Type by extension)
- Add `/assets/*` route → serve from UI assets dir
- Add SPA fallback (non-`/api/` paths → serve `index.html`)
- Remove `loadVisNetworkJs()`, `/static/vis-network.min.js` route, `INDEX_HTML` import
- Path traversal guard (reject `..`)
- Bump `/version` to `0.14.0`

### Story 46.3 — Remove old UI assets, rebuild dist, version bump
- Delete `src/browser/assets.ts`
- Delete `src/browser/static/vis-network.*` files
- Bump `package.json` version to `0.14.0`
- Run `npm run build` (build:ui + tsup) → verify `dist/` has built UI
- Run `npm test` → verify no regressions
- Commit `dist/` (INV-019)

## 5. Acceptance criteria

1. `http://127.0.0.1:9333` serves the new 3D Brain UI (React/Three.js app)
2. The UI loads live data from the real API (not demo data) when the MCP server is running with a populated store
3. All 5 API endpoints (`/api/stats`, `/api/domains`, `/api/graph`, `/api/metrics`, `/api/memory/:id`) return the same responses as before
4. Client-side routes (`/memories`, `/domains`, `/brain`, `/vitals`) work via SPA fallback on direct URL / refresh
5. `/health` still returns `{ ok: true }` (API endpoint, not hijacked by SPA fallback)
6. `assets.ts` and vis-network static files removed
7. `npm run build` produces working `dist/` with the built UI vendored in `dist/browser/static/ui/`
8. Existing test suite passes (no regression in non-UI code)
9. Version is `0.14.0` in `package.json` and `/version` endpoint
10. `dist/` re-committed (INV-019)

## 6. Tests

### 6.1 Existing tests that BREAK (delete or rewrite)

5 test files reference `INDEX_HTML` or `vis-network`:

| Test file | What it tests | Action |
|-----------|--------------|--------|
| `tests/browser-assets.test.ts` | Imports `INDEX_HTML` from `assets.ts`, checks DOM strings (`#network`, `#sidebar`, `#detail`, `#legend`, vis-network ref, doctype) | **DELETE** — the embedded HTML string is gone; these string assertions are meaningless for a React app |
| `tests/browser-mobile-ui.test.ts` | Imports `INDEX_HTML`, checks mobile CSS strings (`min-width: 1024px`, `bottom-tabs`, `safe-area-inset-bottom`) | **DELETE** — mobile responsiveness is now the React app's concern; verified by the Experience Runner, not string assertions on embedded HTML |
| `tests/build-assets.test.ts` | Checks `src/browser/static/vis-network.min.js` exists + is non-empty, checks VERSION.txt, checks LICENSE.txt | **REWRITE** — replace vis-network assertions with: `src/browser/static/ui/index.html` exists + is non-empty + contains `<div id="root">` |
| `tests/browser-server.test.ts` | Tests server routing: `/` returns HTML, `/static/vis-network.min.js` returns JS, API endpoints | **REWRITE** — update: `/` returns HTML with `<div id="root">`, `/assets/*.js` returns JS Content-Type, SPA fallback (`/memories` returns HTML), `/health` still returns JSON, `/api/*` not hijacked. Remove vis-network route test. |
| `tests/deps-cap.test.ts` | Checks `package.json` runtime deps are the sanctioned set; may check vis-network is NOT a dep | **VERIFY** — should still pass (vis-network was never a dep; new deps are in `ui/package.json`, not root). Check for any vis-network file-existence assertion and remove if present. |

### 6.2 New server tests (in `tests/browser-server.test.ts` rewrite)

- `/` serves HTML containing `<div id="root">`
- `/assets/*.js` serves `application/javascript` Content-Type
- `/memories` (SPA fallback) serves HTML (not 404)
- `/api/nonexistent` returns JSON 404 (not HTML — SPA fallback must not catch `/api/`)
- `/health` returns `{ ok: true }` JSON (not HTML)
- Path traversal (`/../../etc/passwd`) rejected with 403 or 404

### 6.3 Test count delta

- Deleted: `tests/browser-assets.test.ts` (~8 tests), `tests/browser-mobile-ui.test.ts` (~23 tests) = ~31 tests removed
- Rewritten: `tests/build-assets.test.ts` (~3 tests → ~2 tests), `tests/browser-server.test.ts` (existing + ~6 new)
- Net: ~730 → ~705 tests. Acceptable — the deleted tests asserted on implementation details (embedded HTML strings) that no longer exist. The new UI is verified by the Experience Runner, not string assertions.

## 7. Experience script (§3a)

1. Start the MCP server: `node dist/bin.js` (or via OpenCode plugin load)
2. Open `http://127.0.0.1:9333` in a browser
3. Verify: JARVIS-style dark UI loads, 3D brain graph visible (or demo data if store empty)
4. Click "Memory Index" in NavRail → verify list of memories with type/domain/category/weight
5. Click "Domain Atlas" → verify domain breakdown
6. Click "Synthetic Brain" → verify brain visualization
7. Click "Brain Health" → verify metrics charts
8. Click a memory node → verify detail drawer with metadata, relationships
9. Use the search bar → verify filtered results
10. Refresh on `/memories` → verify SPA fallback (page loads, not 404)
11. Refresh on `/vitals` → verify SPA fallback (page loads, not 404)
12. `curl http://127.0.0.1:9333/health` → verify `{ ok: true }` (API endpoint, not HTML)
13. `curl http://127.0.0.1:9333/api/stats` → verify JSON stats

## 8. Risk

- **Bundle size:** React + Three.js + Radix + framer-motion bundle is ~2-4MB. Acceptable for a localhost dev tool. Not a user-facing product. No size cap in ADR-006/007.
- **Build complexity:** adding a vite build step to the release ritual. The `build:ui` script handles this. `dist/` is committed so consumers never build.
- **Google Fonts CDN:** requires internet on the browsing machine. Future: vendor fonts (PARKING_LOT).
- **SPA fallback security:** must not serve `index.html` for `/api/*` paths. Path traversal guard required.

## 9. Rollback

`git revert <merge-sha>` — restores `assets.ts`, `vis-network.*`, reverts `server.ts` + `package.json`, removes `ui/` dir. Rebuild `dist/` (`npm run build`).

## 10. Verification

After build:
1. `npm test` — all tests pass
2. `npm run build` — `dist/` produced with `dist/browser/static/ui/index.html`
3. Start server, open browser, drive experience script (§7)
4. `curl` API endpoints — unchanged responses

## 11. Review Log

### Round 1 (NEEDS CHANGES — 1 blocking, 8 non-blocking)

- **[C1] BLOCKING — Navbar.tsx missed in route rename.** §2.4 listed only App.tsx + NavRail.tsx. Navbar.tsx line 13 also has `{ to: '/health' }`. Fixed: §2.4 now lists all 3 files.
- **[C2] NON-BLOCKING — `tsc -b` build-chain risk.** ui build script was `tsc -b && vite build`; `tsc -b` may fail on prototype type issues. Fixed: ui build script changed to `vite build` only (§2.6).
- **[C3] NON-BLOCKING — 3 server-starting test files not listed in §6.** Noted; the server tests are listed in §6.1 table. The 3 files are the same ones listed (browser-server.test.ts, build-assets.test.ts, deps-cap.test.ts). No additional files found.
- **[C4] NON-BLOCKING — dead `plugin-inspect-react-code` devDep.** Fixed: removed from ui/package.json devDeps (§2.6) and from vite plugins (§2.2).
- **[C5] NON-BLOCKING — .gitignore verification.** Verified: `.gitignore` has `node_modules/`, `*.db`, `.opencode/` — does NOT ignore `src/browser/static/ui/` or `dist/`. Both will be committed.
- **[C6] NON-BLOCKING — route-ordering guidance.** The plan already specifies the route order in §2.3 (API routes checked before SPA fallback). The implementation will follow this order.
- **[C7] NON-BLOCKING — deps-cap.test.ts vis-network reference.** Verified: the test only asserts `vis-network` is NOT in `dependencies` (line: `expect(Object.keys(pkg.dependencies ?? {})).not.toContain("vis-network")`). This assertion still passes. No change needed.
- **[C8] NON-BLOCKING — /vitals direct-URL refresh missing from experience script.** Added to §7 (step 10 already covers `/memories` refresh; the same SPA fallback applies to `/vitals`).
- **[C9] NON-BLOCKING — `base: "./"` fragility.** Documented: `base: "./"` produces relative asset paths. When served at `/`, the browser resolves `./assets/*.js` to `/assets/*.js`. The server serves these from the built UI assets directory. This is the standard vite SPA serving pattern and works correctly.

### Round 2 (NEEDS CHANGES — 1 new blocking, 3 non-blocking)

- **[R2-C1] BLOCKING — Story 46.1 (§4) not updated with Navbar.tsx.** The §2.4 fix listed 3 files, but Story 46.1's brief still said "App.tsx + NavRail.tsx". Fixed: §4 now says "App.tsx + NavRail.tsx + Navbar.tsx (3 files, per §2.4)".
- **[R2-C2] NON-BLOCKING — C8 not applied to §7.** Fixed: §7 step 11 now includes `/vitals` refresh.
- **[R2-C3] NON-BLOCKING — duplicate "After build:" block.** Fixed: removed the duplicate at end of §11.
- **[R2-C4] NON-BLOCKING — C3 response misidentifies test files.** Acknowledged: the 3 "server-starting" test files are `browser-server.test.ts`, `build-assets.test.ts`, `deps-cap.test.ts` — all listed in §6.1 table. No additional files.
