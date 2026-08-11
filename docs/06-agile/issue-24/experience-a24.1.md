# Experience Report — Issue #24

**Story:** A24.1 — Add Created and Updated columns to the list view
**Date:** 2026-08-11
**Mode:** autonomous
**Branch:** `issue/24-list-created-updated-columns` (off main `21303fc`)
**Verdict:** PASS

## Environment

```
cd /home/royce/mission-control/PROJECTS/realmemory/repo
npm run build
node dist/bin.js --ui=9337
# → [realmemory] UI server listening on http://127.0.0.1:9337
```

Chromium headless (`/snap/bin/chromium --headless --no-sandbox --virtual-time-budget=5000 --dump-dom`) used to drive the running app.

## Results

### Step 3 — New columns present in header

The served HTML (`curl http://127.0.0.1:9337/`) contains:

```
data-sort="createdAt">Created
data-sort="updatedAt">Updated
```

Full 8-column header in correct order:
```
Type | Domain | Category | Weight | Content | Tags | Created | Updated
MATCH: True
```

### Step 4 — Date values render in rows

Headless chromium DOM dump of the running page:

- **500 rows** in `<tbody id="list-body">`
- **4000 td cells** = 500 rows × 8 columns (exactly 8 per row — no extra/missing)
- **1000 date values** in tbody (2 per row × 500) formatted as `YYYY-MM-DD HH:MM`
- Sample: `2026-08-10 19:28`, `2026-08-10 19:28`, `2026-08-10 19:39`

### Step 5–7 — Sort (structural verification)

Interactive header-click sort was verified structurally rather than via a browser click event:

- The generic list-sort handler (`assets.ts:949-956`) auto-wires any `<th data-sort="...">` — confirmed by the Plan Reviewer against main.
- The sort cases `case 'createdAt'` and `case 'updatedAt'` are present in the served HTML (grep confirmed).
- ISO 8601 UTC strings sort lexicographically = chronologically, so `localeCompare` produces correct ascending/descending order.

### Steps 8–10 — Regression (existing columns/selection/detail)

- The 6 existing columns are untouched in markup (only appended after).
- `sortNodes` only adds cases — the `default` path (weight) is unchanged.
- Row click → Detail panel: the click handler is on `<tr>`, not `<td>`, so added cells cannot detach it.
- `npm test` — 409/409 pass (including `tests/browser-graph-api.test.ts` data-path guard and `tests/deps-cap.test.ts` dependency-cap guard).

### Data path

`curl http://127.0.0.1:9337/api/graph?limit=2` returns nodes with:
```
createdAt: 2026-08-11T00:28:45.793Z
updatedAt: 2026-08-11T00:28:45.793Z
All nodes have createdAt+updatedAt: True
```

## Verdict

**PASS** — the Created and Updated columns render with correctly formatted date values in the live list view. All 8 columns present, 500 rows × 8 cells, 1000 date values. Existing columns, sort, and row→detail flow structurally verified. 409/409 tests green.

## Deferred (reporter smoke)

Royce should restart OpenCode (to reload the MCP server with the new UI code) and browse to http://127.0.0.1:9333, click the List tab, and visually confirm the Created/Updated columns and click-sort behavior at his convenience.
