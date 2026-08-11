# Development Plan — Issue #24: Add Created and Updated columns to the web UI list view

**Author:** Anymake Solution Architect
**Project:** realmemory — `project_type: library`
**Issue:** https://github.com/R3dy/RealMemory/issues/24 — `type: feature`
**Code state analyzed:** main `21303fc` (2026-08-11, issue #20 mobile-UI squash merge) — matches SYSTEM_MAP "Last mapped" HEAD, so the intent layer is fresh
**Status:** In Review (round 1)
**Location:** `PROJECTS/realmemory/docs/06-agile/issue-24/plan.md`

---

## 1. Problem Statement

The graph browser's List view (`#list-view`) shows six columns — Type, Domain, Category, Weight, Content, Tags — but no temporal columns. A user scanning memories cannot tell when each was created or last updated without clicking into the Detail panel. The reporter (issue #24) asks: "add columns for created and updated to the list view of the realmemory web ui."

This is presentation-only: the data (`createdAt`, `updatedAt` — ISO 8601 UTC strings) already arrives on every node via `/api/graph` and is already rendered (raw) in the Detail panel's Timeline field (`assets.ts:762-765`). The list view simply doesn't surface it.

---

## 2. Root Cause / Motivation

**Feature — motivation.** This is a feature request, not a bug, so there is no failing mechanism to trace. The motivation is observability: the graph browser exists to let a user inspect their memory store (ADR-006's purpose), and temporal context is a core axis of memory (the weighting engine already uses `createdAt` for the recency factor — `src/store.ts` weighting, exercised in `tests/weighting.test.ts`). Surfacing created/updated in the list view closes a gap between what the engine already tracks and what the human can see at a glance.

The `library` success model (per `PROJECT_TYPES/library/manifest.md`) centers on adoption via a clean, trustworthy developer surface; the browser is that surface's observability layer. This change is tiny, additive, touches only embedded HTML/JS, and risks nothing in the library's public contract.

---

## 3. Current-State Review

| Touched | Details |
|---------|---------|
| Modules | `src/browser/assets.ts` — embedded single-page dark-theme UI (inlined CSS+JS, 1122 lines). Mobile-first responsive (issue #20). The List view is a `<table>` inside `#list-view`. |
| Data model | none. `Memory.createdAt: string` / `updatedAt: string` (ISO 8601 UTC, e.g. `"2026-08-11T01:13:13.869Z"`) are already on every node returned by `/api/graph` (`src/types.ts:126,128`) and already stored on each node's `_data` (`assets.ts:618`). |
| Flows | `/api/graph` → `fetchGraph()` (`assets.ts:602`) → `updateListBody(data.nodes \|\| [])` (`assets.ts:653`) → `<tbody id="list-body">` rows. The raw `Memory[]` is passed straight through, so `m.createdAt`/`m.updatedAt` are available in the row renderer with no fetch change. Row click → `showDetail(id)` (`assets.ts:678`) — unchanged. |
| Integrations | none. Read-only `node:http` server (`src/browser/server.ts`), 127.0.0.1-only. No third-party service in the path. |

**Intent-layer freshness:** SYSTEM_MAP last mapped 2026-08-11, HEAD `21303fc` — identical to current main. No Cartographer refresh needed.

---

## 4. Solution Design

All changes are in one file: `src/browser/assets.ts`. Four edits, each self-contained.

### 4.1 — Add a `fmtDate` helper (new, near `esc()`)

There is **no** existing date-formatting helper in `assets.ts`. The only string helper is `esc()` (`assets.ts:830-832`), which HTML-escapes. The Detail panel renders timestamps **raw** via `esc(m.createdAt)` (`assets.ts:764`) — e.g. `"2026-08-11T01:13:13.869Z"`. For the list view we want a compact, scannable format.

Add immediately after `esc()` (after line 832):

```js
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
       + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
```

Renders `"2026-08-11T01:13:13.869Z"` → `"2026-08-11 01:13"` (date + HH:MM, local timezone — consistent with `new Date()` semantics elsewhere in the file). Returns `'—'` for null/undefined/invalid (matches the existing `'—'` sentinel used for missing domain/category at `assets.ts:667-668`).

> **Note (out of scope, parked):** the Detail panel Timeline field still renders raw ISO timestamps. Reusing `fmtDate` there would be a nice consistency win, but it is outside issue #24's "list view" scope. Logged to `PARKING_LOT.md` by the calling skill if desired; this plan does not touch the Detail panel.

### 4.2 — Add two `<th>` columns (header)

`assets.ts:495-502` currently:

```html
<div id="list-view"><table><thead><tr>
  <th data-sort="type">Type</th>
  <th data-sort="domain">Domain</th>
  <th data-sort="category">Category</th>
  <th data-sort="weight">Weight</th>
  <th data-sort="content">Content</th>
  <th data-sort="tags">Tags</th>
</tr></thead><tbody id="list-body"></tbody></table></div>
```

Add two columns at the end (least disruptive to existing column widths — the truncated Content column keeps its full width):

```html
  <th data-sort="tags">Tags</th>
  <th data-sort="createdAt">Created</th>
  <th data-sort="updatedAt">Updated</th>
```

> **Click-to-sort auto-wires.** The list-sort click handler (`assets.ts:949-956`) queries `document.querySelectorAll('#list-view th')` at init and reads `th.dataset.sort`. Because it is generic, the two new `<th data-sort="...">` elements are automatically clickable with **no handler change**. The Worker must verify this rather than re-implement it.

### 4.3 — Add two `<td>` cells (row renderer)

`updateListBody` (`assets.ts:657-682`) builds each `<tr>`. The current Tags cell (`assets.ts:671`):

```js
'<td style="color:var(--text-dim)">' + esc(tags) + '</td>' +
```

Append two date cells after it (before the closing `'</tr>'`):

```js
'<td style="color:var(--text-dim)">' + esc(tags) + '</td>' +
'<td style="color:var(--text-dim);white-space:nowrap">' + esc(fmtDate(m.createdAt)) + '</td>' +
'<td style="color:var(--text-dim);white-space:nowrap">' + esc(fmtDate(m.updatedAt)) + '</td>' +
```

`white-space:nowrap` guarantees the compact date never wraps (the global `#list-view td` rule at `assets.ts:177-181` already sets `white-space:nowrap`, but the inline repeat is a belt-and-suspenders guard against any future CSS relaxation and keeps the two new cells self-describing). The `color:var(--text-dim)` matches the Tags column's secondary-text treatment, since timestamps are metadata, not primary content.

### 4.4 — Add two `case`s to `sortNodes`

`sortNodes` (`assets.ts:684-700`) switch currently handles: type, domain, category, weight, content, tags; default falls back to weight. Add two cases (string comparison via `localeCompare` — ISO 8601 UTC strings sort **lexicographically = chronologically**, so no `Date.parse` needed):

```js
case 'tags': av = (a.tags || []).join(','); bv = (b.tags || []).join(','); break;
case 'createdAt': av = a.createdAt || ''; bv = b.createdAt || ''; break;
case 'updatedAt': av = a.updatedAt || ''; bv = b.updatedAt || ''; break;
default: av = a.weight; bv = b.weight;
```

Missing timestamps sort to the top on `asc` / bottom on `desc` (empty string `localeCompare`s before any real date), matching the `'—'` rendered cell.

### 4.5 — CSS: no change required

The list-view CSS uses **generic element selectors** (`#list-view th`, `#list-view td` at `assets.ts:168-190`), so the two new columns inherit all existing styling automatically — sticky header, hover, padding, font size, uppercase header, the row hover/selected states. Specifically `#list-view td { max-width:400px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }` already truncates any cell that overflows, so the new columns cannot break the table. No media query or mobile-specific rule is touched.

### 4.6 — Summary of edits

| Location | Change |
|----------|--------|
| `assets.ts` after line 832 | add `fmtDate(iso)` helper |
| `assets.ts:501` (header) | add `<th data-sort="createdAt">Created</th>` + `<th data-sort="updatedAt">Updated</th>` after the Tags `<th>` |
| `assets.ts:671` (row) | add two `<td>` cells rendering `fmtDate(m.createdAt)` / `fmtDate(m.updatedAt)` after the Tags `<td>` |
| `assets.ts:694` (sort) | add `case 'createdAt'` + `case 'updatedAt'` before the `default` |

No schema, no migration, no server route, no dependency, no public API change. Single file.

---

## 5. Alternatives Considered

| Option | Why not chosen |
|--------|----------------|
| **Relative time ("3h ago")** instead of absolute | Less precise for a memory store where a memory created yesterday vs. last week both read "1d ago"; absolute timestamps sort cleanly and let the user correlate with external logs/sessions. The Detail panel already shows absolute (raw ISO), so absolute-but-compact is also more consistent. |
| **Place new columns before Tags (after Content)** | Pushes the secondary Tags column rightward and shifts the click-target muscle memory for the existing Tags header. Appending at the end is the least-disruptive placement for a table already in use. |
| **Add horizontal scroll (`overflow-x:auto` on `#list-view`) for mobile** | The existing `td { max-width:400px; text-overflow:ellipsis }` already handles overflow by truncating — the table has never scrolled horizontally and adding 2 narrow date columns doesn't require it. If a later mobile audit finds 8 columns too cramped, that's a separate layout pass (parked), not part of this feature. |
| **Reuse the Detail panel's raw `esc(m.createdAt)` rendering** | Raw ISO (`2026-08-11T01:13:13.869Z`) is 24 chars and ugly in a dense table column. Compact (`2026-08-11 01:13`, 16 chars) is scannable. The new `fmtDate` helper could later be applied to the Detail panel too (parked, §4.1 note). |

---

## 6. Intent Constraints

**Classification:** Additive (presentation-only)

- **ADR-006** (#2 localhost-only, #3 read-only GET-only no-framework, #4 no-new-runtime-dep): **none touched** — this changes only embedded HTML/CSS/JS string content inside `assets.ts`. No server route, no `node:http` change, no framework, zero dependency impact. `package.json` diff is empty.
- **ADR-007** (auto-start side channel): **none touched** — browser lifecycle unchanged.
- **INV-013** (localhost-only read-only no-framework): **preserved** — read-only surface gains two display columns; no mutation, no new surface.
- **INV-014** (≤3 runtime deps, currently violated by `zod` per Drift #6): **preserved** — no new dep; `fmtDate` is inline vanilla JS using the built-in `Date`.
- **INV-015** (public API stability): **preserved** — no `MemoryStore` method, no `src/types.ts` type, no exported symbol is touched. The change is entirely inside the inlined browser asset string.

**No contradiction.** No conflict gate required.

---

## 7. Design Consistency

| Question | Answer |
|----------|--------|
| Existing components reused | The `<table>`/`<thead>`/`<tbody>`/`<tr>`/`<th>`/`<td>` structure of `#list-view`; the `#list-view th`/`#list-view td` CSS rules; the `esc()` HTML-escape helper; the `'—'` missing-value sentinel; the generic list-sort click handler; the `var(--text-dim)` secondary-text token. No new component introduced. |
| New components introduced | One inline helper, `fmtDate(iso)` — not a UI component, just a formatter. Reuses the `new Date()` + `padStart` pattern already present in the codebase (e.g. `scripts/bootstrap-memory.mjs:444`, `src/store.ts:378`). |
| Design DNA mapping | New `<th>` cells inherit `#list-view th` (uppercase, 11px, `--text-dim`, sticky, hover→`--text-bright`, cursor pointer). New `<td>` cells inherit `#list-view td` (12px, `--border-dim` bottom rule, ellipsis) and use `color:var(--text-dim)` to read as metadata — identical treatment to the existing Tags column. |
| New visual patterns | none — the new columns use the exact same column styling as the six existing ones. |

No `ux-design.md` update needed — no new visual pattern is introduced.

---

## 8. Blast Radius & Regression Risk

| At risk | Why it's in the blast radius | Protection |
|---------|------------------------------|------------|
| Existing 6 list columns / sort order | Same `<table>`, same `updateListBody`, same `sortNodes` switch | Existing columns untouched in markup; `sortNodes` only **adds** cases (default path unchanged); default `listSort = { col:'weight', dir:'desc' }` unchanged. Experience Script §9 verifies existing columns still render + sort. |
| Row click → Detail panel | `updateListBody` rebuilds `<tr>` rows; the click-binding loop (`assets.ts:674-681`) runs after `innerHTML` set | The two new `<td>` are inside the same `<tr data-id=…>`; the click handler is on the `<tr>`, not the `<td>`, so adding cells cannot detach it. Experience Script verifies row→detail still works. |
| Mobile list view (<640px) | `#list-view` table is `width:100%` with no horizontal scroll; 6 columns → 8 | `td { max-width:400px; text-overflow:ellipsis }` already truncates overflow; date cells are compact (16 chars) + `white-space:nowrap`. Experience Script includes a mobile-width check. |
| Browser build / typecheck | `assets.ts` is a template string of inlined HTML/JS — not typechecked itself, but compiled by tsup into `dist/browser/assets.js`-equivalent | `npm run build` (tsup) must succeed; existing `tests/browser-graph-api.test.ts` (which hits `/api/graph`) must stay green. |
| Dependency cap (INV-014) | A naïve implementer might `npm install` a date lib (date-fns/dayjs) | `tests/deps-cap.test.ts` enforces the cap mechanically; `fmtDate` is inline vanilla JS — no dep added. |

**Migrations:** none.

---

## 9. Story Breakdown

### Story A24.1 — Add Created and Updated columns to the list view

**As a** memory-store operator **I want** the list view to show Created and Updated columns **so that** I can see temporal context at a glance without clicking into each Detail panel.

**Acceptance criteria:**
- [ ] The `#list-view` table header has a `Created` column (`<th data-sort="createdAt">`) and an `Updated` column (`<th data-sort="updatedAt">`), placed after the Tags column.
- [ ] Each list row renders a Created `<td>` and an Updated `<td>` showing the memory's `createdAt`/`updatedAt` in compact form (`YYYY-MM-DD HH:MM`, e.g. `2026-08-11 01:13`); memories without a timestamp render `—`.
- [ ] Clicking the `Created` header sorts rows by `createdAt` (first click desc, second click asc — matching the existing toggle in `assets.ts:952-953`); same for `Updated`. Ascending shows oldest-first; descending shows newest-first.
- [ ] The existing six columns (Type, Domain, Category, Weight, Content, Tags), their sort behavior, row selection, and row→Detail-panel click flow are unchanged.
- [ ] No new runtime dependency is added; `npm test -- deps-cap` stays green (INV-014 preserved).
- [ ] `npm run build` (tsup) succeeds; `npm test` is green (including `tests/browser-graph-api.test.ts`).

**Experience Script** (this is what the Experience Runner drives — carried into the task brief §3a unchanged):

> **Environment:** the graph browser auto-starts as a localhost side channel of the MCP server (ADR-007), default port 9333. For a deterministic run, start it standalone:
>
> ```bash
> cd /home/royce/mission-control/PROJECTS/realmemory/repo
> npm run build
> node dist/bin.js --ui=9333
> # wait for "Graph browser: http://127.0.0.1:9333"
> ```
>
> **Precondition:** the SQLite store at the default path has ≥3 memories with distinct `createdAt`/`updatedAt` values. If empty, seed a couple via the MCP `store_memory` tool or `scripts/bootstrap-memory.mjs` before driving.
>
> 1. Open `http://127.0.0.1:9333` in a browser (or headless drive).
> 2. Click the **List** tab (or, on mobile-width, tap the bottom-tab `List`).
> 3. **Observe:** the table header row reads, left to right: Type · Domain · Category · Weight · Content · Tags · **Created** · **Updated**. The two new columns are present and styled like the others.
> 4. **Observe:** each data row shows a Created value (e.g. `2026-08-11 01:13`) and an Updated value in compact `YYYY-MM-DD HH:MM` form. At least one row where `createdAt !== updatedAt` shows two different times.
> 5. **Sort Created ascending:** click the `Created` header. The rows reorder. Confirm the top row's Created is the **earliest** (oldest) timestamp and the bottom row's is the **latest**. (First click = desc per the existing toggle default in `assets.ts:953`; if so, click once more to reach asc — the script must assert the column is sortable both ways, not assert a specific first-direction. Verify both directions by clicking twice.)
> 6. **Sort Created descending:** click `Created` again. Top row is now the **latest** timestamp, bottom is the **earliest**.
> 7. **Sort Updated:** click the `Updated` header, then click again. Verify rows reorder by `updatedAt` in both directions.
> 8. **Regression — existing columns:** click the `Weight` header. Rows sort by weight (desc, then asc) exactly as before. Click `Content` — sorts alphabetically. The six original columns and their sort still work.
> 9. **Regression — row→detail:** click any row's Content cell. The Detail panel opens (desktop: right pane; mobile: bottom sheet) showing that memory. The Timeline field shows Created/Updated (raw ISO — unchanged behavior).
> 10. **Regression — existing selection:** the clicked row gets the `.selected` highlight; clicking another row moves the highlight. Unchanged.
> 11. **Mobile width (optional but recommended):** shrink the browser window to <640px. Switch to the List tab. Confirm the table still renders without horizontal overflow breakage — columns truncate via ellipsis as before; the two date columns remain visible and compact. (No assertion on exact column widths — only "no layout breakage".)
> 12. Stop the server (`Ctrl-C`).
>
> **PASS condition:** steps 3–10 all hold; step 11 holds if performed. Steps 3, 4, 5–7 are the feature; steps 8–10 are the regression guardrails.

---

## 10. Test & Verification Plan

- **Automated:** no new unit test is strictly required (the change is in an inlined browser asset string that is not unit-tested today, and asserting on HTML string content would be brittle). The existing `tests/browser-graph-api.test.ts` (which exercises `/api/graph` and confirms `createdAt`/`updatedAt` are present on returned nodes) **must stay green** — it guards the data the new columns render. `tests/deps-cap.test.ts` must stay green (guards INV-014). `npm run build` (tsup, which compiles `assets.ts` into the dist browser asset) must succeed — this is the compile gate for the inlined JS.
- **Experience:** the §9 Experience Script — the Experience Runner drives the running browser through the exact walkthrough above and must return PASS before the story clears the build loop. This is the primary verification for a presentation-only change.
- **Regression:** `npm test` (full suite) green; in particular `tests/browser-graph-api.test.ts` (data path) and `tests/deps-cap.test.ts` (dependency cap).
- **Manual:** the reporter (Royce) confirms by reviewing the passing Experience Runner report, and optionally re-drives the original request ("add columns for created and updated to the list view") themselves at `http://127.0.0.1:9333`.

---

## 11. Rollback Plan

Filled before execution so reverting never requires archaeology:

- **Branch:** `issue/24-list-created-updated-columns` — created fresh off `main` (NOT off `issue/22-brain-loop`, which carries unrelated in-progress work). All commits reference `#24`.
- **Merge:** single squash commit per PR; SHA recorded in the issue-24 Tracking table in `docs/06-agile/ISSUES.md`.
- **Revert:** `git revert <squash-sha>` — single file (`src/browser/assets.ts`), no migration, no dependency, no public API change, so revert is clean with no follow-up.
- **Migrations:** none.
- **Deploy rollback:** none — the browser asset is bundled into the npm package at build time; a revert + rebuild + republish restores the prior UI. No runtime state to roll back.

---

## 12. Review Log

Appended each round — never deleted. Review files live beside this plan.

| Round | Date | Reviewer verdict | Report | Resolution |
|-------|------|------------------|--------|------------|
| 1 | 2026-08-11 | (pending) | — | — |
