/**
 * Embedded static assets for the realmemory graph browser UI. The HTML is a
 * single self-contained page (inlined CSS + vanilla JS) that loads the vendored
 * vis-network bundle from `/static/vis-network.min.js`. No external network
 * requests are made — everything is served by the localhost HTTP server.
 *
 * The UI is designed to look like a code intelligence MCP plugin (e.g.
 * codebase-memory-mcp): a 3-pane layout with a domain tree sidebar, an
 * interactive graph canvas (or list view), and a structured detail panel.
 * Nodes are colored by memory type, bordered by domain, and sized by weight.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>realmemory — knowledge graph</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-elev2: #1c2330;
    --border: #30363d;
    --border-dim: #21262d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --text-bright: #f0f6fc;
    --accent: #58a6ff;
    --accent-dim: #1f6feb;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
    --orange: #db6d28;
    --gray: #7d8590;
    --teal: #39c5cf;
    --pink: #f778ba;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px; height: 100vh; overflow: hidden;
  }

  /* ===== Top Bar ===== */
  header {
    height: 48px; display: flex; align-items: center; gap: 16px;
    padding: 0 16px; border-bottom: 1px solid var(--border);
    background: var(--bg-elev); z-index: 10;
  }
  header .logo {
    display: flex; align-items: center; gap: 8px;
    font-size: 15px; font-weight: 600; color: var(--accent);
    white-space: nowrap;
  }
  header .logo .icon { width: 18px; height: 18px; fill: var(--accent); }
  header .search-wrap {
    flex: 1; max-width: 500px; position: relative;
  }
  header .search-wrap input {
    width: 100%; padding: 6px 12px 6px 32px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 13px;
    transition: border-color .15s;
  }
  header .search-wrap input:focus { outline: none; border-color: var(--accent); }
  header .search-wrap .search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--text-dim); font-size: 14px;
  }
  header .stats {
    display: none; gap: 12px; font-size: 12px; color: var(--text-dim);
  }
  header .stats .stat { display: flex; align-items: center; gap: 4px; }
  header .stats .stat .num { color: var(--text-bright); font-weight: 600; }
  header .view-toggle {
    display: none; border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
  }
  header .view-toggle button {
    padding: 5px 12px; background: var(--bg); border: none; color: var(--text-dim);
    cursor: pointer; font-size: 12px; transition: all .15s;
  }
  header .view-toggle button.active { background: var(--accent-dim); color: #fff; }
  header .view-toggle button:hover:not(.active) { background: var(--bg-elev2); }

  /* ===== Main Layout (mobile-first: base = mobile flex column) ===== */
  #app {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 48px);
  }

  /* ===== Left Sidebar (Domains + Filters) ===== */
  aside#sidebar {
    border-right: 1px solid var(--border);
    background: var(--bg-elev);
    overflow-y: auto; min-height: 0;
    display: flex; flex-direction: column;
  }
  .sidebar-section { border-bottom: 1px solid var(--border-dim); }
  .sidebar-section h2 {
    padding: 8px 12px 6px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .5px; color: var(--text-dim);
    display: flex; justify-content: space-between; align-items: center;
  }
  .sidebar-section h2 .count { font-size: 10px; color: var(--gray); }

  /* Domain tree */
  .domain-tree { padding: 0 0 8px; }
  .domain-item {
    padding: 4px 12px 4px 16px; cursor: pointer; display: flex;
    align-items: center; gap: 8px; font-size: 12px; transition: background .1s;
    border-left: 3px solid transparent;
  }
  .domain-item:hover { background: var(--bg-elev2); }
  .domain-item.active {
    background: var(--bg-elev2); border-left-color: var(--accent);
  }
  .domain-item .dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .domain-item .name { flex: 1; color: var(--text); }
  .domain-item .badge {
    font-size: 10px; color: var(--text-dim); background: var(--bg);
    border-radius: 8px; padding: 1px 6px; min-width: 18px; text-align: center;
  }
  .domain-item.uncategorized .name { color: var(--text-dim); font-style: italic; }

  /* Filters */
  .filter-group { padding: 6px 12px 10px; }
  .filter-group label {
    display: flex; align-items: center; gap: 6px; padding: 3px 0;
    cursor: pointer; font-size: 12px; color: var(--text);
  }
  .filter-group label:hover { color: var(--text-bright); }
  .filter-group input[type="checkbox"] { accent-color: var(--accent); width: 14px; height: 14px; }
  .filter-group input[type="text"], .filter-group input[type="date"], .filter-group select {
    width: 100%; padding: 4px 8px; background: var(--bg);
    border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-size: 12px;
  }
  .filter-group input[type="range"] { width: 100%; accent-color: var(--accent); }
  .filter-group .row { display: flex; gap: 6px; }
  .filter-group .row > * { flex: 1; }
  .filter-group .category-pills {
    display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;
  }
  .filter-group .pill {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--bg);
    color: var(--text-dim); cursor: pointer; transition: all .1s;
  }
  .filter-group .pill:hover { border-color: var(--accent); color: var(--text); }
  .filter-group .pill.active { background: var(--accent-dim); color: #fff; border-color: var(--accent-dim); }

  /* ===== Center Pane (Graph / List) ===== */
  main#center {
    position: relative; background: var(--bg); overflow: hidden; min-height: 0;
    flex: 1;
  }
  #network { width: 100%; height: 100%; }
  #list-view {
    display: none; width: 100%; height: 100%; overflow-y: auto;
  }
  #list-view.show { display: block; }
  #list-view table { width: 100%; border-collapse: collapse; }
  #list-view th {
    position: sticky; top: 0; background: var(--bg-elev);
    border-bottom: 1px solid var(--border); padding: 6px 10px;
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: .5px; color: var(--text-dim); font-weight: 600;
    cursor: pointer; user-select: none;
  }
  #list-view th:hover { color: var(--text-bright); }
  #list-view td {
    padding: 6px 10px; border-bottom: 1px solid var(--border-dim);
    font-size: 12px; max-width: 400px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  #list-view tr { cursor: pointer; transition: background .1s; }
  #list-view tr:hover { background: var(--bg-elev); }
  #list-view tr.selected { background: var(--bg-elev2); }
  #list-view .type-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  #list-view .weight-bar {
    width: 40px; height: 4px; background: var(--border); border-radius: 2px;
    display: inline-block; overflow: hidden;
  }
  #list-view .weight-bar .fill { height: 100%; border-radius: 2px; }

  #empty-msg {
    position: absolute; inset: 0; display: none; align-items: center;
    justify-content: center; color: var(--text-dim); font-size: 14px;
    pointer-events: none;
  }
  #empty-msg.show { display: flex; }

  /* Graph overlay controls */
  .graph-controls {
    position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; z-index: 5;
  }
  .graph-controls button {
    width: 28px; height: 28px; border-radius: 4px; border: 1px solid var(--border);
    background: var(--bg-elev); color: var(--text-dim); cursor: pointer;
    font-size: 14px; display: flex; align-items: center; justify-content: center;
    transition: all .15s;
  }
  .graph-controls button:hover { background: var(--bg-elev2); color: var(--text); }

  /* ===== Right Detail Panel ===== */
  aside#detail {
    border-left: 1px solid var(--border);
    background: var(--bg-elev); overflow-y: auto; min-height: 0;
  }
  aside#detail .placeholder {
    color: var(--text-dim); font-size: 13px; text-align: center;
    margin-top: 60px; padding: 0 20px;
  }
  aside#detail .placeholder .icon { font-size: 32px; opacity: .3; margin-bottom: 8px; }
  aside#detail .detail-header {
    padding: 10px 14px; border-bottom: 1px solid var(--border-dim);
    display: flex; align-items: center; gap: 8px;
  }
  aside#detail .detail-header .type-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  aside#detail .detail-header .type-label { font-size: 12px; color: var(--text-dim); }
  aside#detail .detail-header .scope-badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    background: var(--bg); border: 1px solid var(--border); color: var(--text-dim);
  }
  aside#detail .detail-body { padding: 12px 14px; }
  aside#detail .field { margin-bottom: 14px; }
  aside#detail .field .k {
    font-size: 10px; color: var(--text-dim); text-transform: uppercase;
    letter-spacing: .5px; margin-bottom: 4px; font-weight: 600;
  }
  aside#detail .field .v { font-size: 12px; word-break: break-word; color: var(--text); }
  aside#detail .content-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 10px 12px; font-size: 12px; line-height: 1.6;
    white-space: pre-wrap; color: var(--text-bright);
  }
  aside#detail .badges { display: flex; flex-wrap: wrap; gap: 4px; }
  aside#detail .badge {
    font-size: 10px; padding: 2px 8px; border-radius: 10px;
    border: 1px solid var(--border); font-family: monospace;
  }
  aside#detail .badge.domain { background: var(--bg); }
  aside#detail .badge.category { background: var(--bg); color: var(--accent); }
  aside#detail .badge.tag { color: var(--text-dim); }
  aside#detail .stats-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
  }
  aside#detail .stat-card {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 8px; text-align: center;
  }
  aside#detail .stat-card .num { font-size: 16px; font-weight: 600; color: var(--text-bright); }
  aside#detail .stat-card .label { font-size: 10px; color: var(--text-dim); }
  aside#detail .weight-bar {
    width: 100%; height: 6px; background: var(--border); border-radius: 3px;
    overflow: hidden; margin-top: 4px;
  }
  aside#detail .weight-bar .fill { height: 100%; border-radius: 3px; transition: width .3s; }
  aside#detail .source-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-family: monospace; font-size: 11px;
  }
  aside#detail .source-box .src-line { color: var(--text-dim); }
  aside#detail .source-box .src-line .val { color: var(--accent); }
  aside#detail .metadata-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-family: monospace; font-size: 11px;
    white-space: pre-wrap; color: var(--text-dim);
  }
  aside#detail .rel-list { }
  aside#detail .rel-item {
    padding: 6px 0; border-bottom: 1px solid var(--border-dim);
    font-size: 11px; display: flex; align-items: center; gap: 6px;
  }
  aside#detail .rel-item:last-child { border-bottom: none; }
  aside#detail .rel-item .rel-type {
    font-size: 10px; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;
  }
  aside#detail .rel-item .rel-preview { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  aside#detail .rel-link { cursor: pointer; color: var(--accent); }
  aside#detail .rel-link:hover { text-decoration: underline; }

  /* ===== Footer ===== */
  footer {
    height: 28px; display: none; align-items: center; gap: 12px;
    padding: 0 16px; border-top: 1px solid var(--border);
    background: var(--bg-elev); font-size: 10px; overflow-x: auto;
  }
  footer .legend-item { display: flex; align-items: center; gap: 3px; color: var(--text-dim); white-space: nowrap; }
  footer .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  footer .line { width: 14px; height: 2px; display: inline-block; }
  footer .sep { width: 1px; height: 12px; background: var(--border); }

  /* Scrollbar styling */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--gray); }

  /* Loading spinner */
  .spinner {
    border: 2px solid var(--border); border-top: 2px solid var(--accent);
    border-radius: 50%; width: 20px; height: 20px;
    animation: spin 1s linear infinite; margin: 20px auto;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ===== Mobile Components (base = mobile, enhance up via min-width queries) ===== */

  /* Hamburger button — shown on mobile/tablet, hidden on desktop */
  .hamburger {
    display: flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; background: none; border: none;
    color: var(--text); font-size: 20px; cursor: pointer;
    border-radius: 6px; transition: background .15s;
  }
  .hamburger:hover { background: var(--bg-elev2); }

  /* Bottom tab bar — flex child of #app, NOT position:fixed (O4) */
  .bottom-tabs {
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
    display: flex; border-top: 1px solid var(--border);
    background: var(--bg-elev); flex: 0 0 auto;
  }
  .bottom-tabs button {
    flex: 1; background: none; border: none; color: var(--text-dim);
    font-size: 11px; font-weight: 500; cursor: pointer; display: flex;
    flex-direction: column; align-items: center; justify-content: center;
    gap: 2px; transition: color .15s;
  }
  .bottom-tabs button.active { color: var(--accent); }

  /* Drawer — mobile sidebar slides in from left (off-canvas) */
  .drawer {
    position: fixed; top: 48px; bottom: 0; left: 0;
    width: 280px; max-width: 85vw;
    transform: translateX(-100%);
    transition: transform 200ms; z-index: 20;
    box-shadow: 2px 0 12px rgba(0,0,0,0.4);
  }
  .drawer.open { transform: translateX(0); }

  /* Bottom sheet — mobile detail slides up from bottom (off-canvas) */
  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0;
    max-height: 70vh;
    transform: translateY(100%);
    transition: transform 200ms; border-radius: 12px 12px 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    z-index: 20; box-shadow: 0 -4px 16px rgba(0,0,0,0.4);
  }
  .sheet.open { transform: translateY(0); }
  .sheet-close {
    position: absolute; top: 8px; right: 8px;
    width: 32px; height: 32px; border-radius: 50%; border: none;
    background: var(--bg); color: var(--text-dim); cursor: pointer;
    font-size: 16px; display: flex; align-items: center; justify-content: center;
    z-index: 21;
  }
  .sheet-close:hover { background: var(--bg-elev2); color: var(--text); }

  /* Scrim — semi-transparent backdrop for drawer/sheet */
  .scrim {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 10; opacity: 0; pointer-events: none;
    transition: opacity 200ms;
  }
  .scrim.visible { opacity: 1; pointer-events: auto; }

  /* ===== Touch targets (mobile/tablet only — gated inside max-width:1023px) (O5) ===== */
  @media (max-width: 1023px) {
    .domain-item, .filter-group label, .pill, .graph-controls button,
    .bottom-tabs button, .hamburger, .sheet-close {
      min-height: 44px; min-width: 44px;
    }
  }

  /* ===== Tablet (>=640px) — hide bottom tabs, show inline search ===== */
  @media (min-width: 640px) {
    .bottom-tabs { display: none; }
    #app { height: calc(100vh - 48px); }
  }

  /* ===== Desktop (>=1024px) — restore EXACT current 3-column grid (regression-free) ===== */
  @media (min-width: 1024px) {
    #app {
      display: grid;
      grid-template-columns: 280px 1fr 360px;
      grid-template-rows: 1fr;
      height: calc(100vh - 48px - 28px);
    }
    .hamburger { display: none; }
    header .stats { display: flex; }
    header .view-toggle { display: flex; }
    footer { display: flex; }
    .bottom-tabs { display: none; }
    .drawer {
      position: static; transform: none;
      box-shadow: none; z-index: auto; max-width: none;
    }
    .sheet {
      position: static; transform: none;
      box-shadow: none; border-radius: 0;
      padding-bottom: 0; z-index: auto; max-height: none;
    }
    .sheet-close { display: none; }
    .scrim { display: none; }
  }
</style>
</head>
<body>
<header>
  <button class="hamburger" id="hamburger" title="Menu">&#9776;</button>
  <div class="logo">
    <svg class="icon" viewBox="0 0 16 16"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM5.5 11.5l-3-3 1.4-1.4 1.6 1.6 4-4 1.4 1.4-5.4 5.4z"/></svg>
    realmemory
  </div>
  <div class="search-wrap">
    <span class="search-icon">&#128269;</span>
    <input type="text" id="q" placeholder="Search memories...">
  </div>
  <div class="stats" id="stats-bar">
    <span class="stat"><span class="num" id="stat-memories">0</span> memories</span>
    <span class="stat"><span class="num" id="stat-domains">0</span> domains</span>
    <span class="stat"><span class="num" id="stat-edges">0</span> edges</span>
  </div>
  <div class="view-toggle">
    <button id="view-graph" class="active" title="Graph view">Graph</button>
    <button id="view-list" title="List view">List</button>
  </div>
</header>
<div id="app">
  <aside id="sidebar" class="drawer">
    <div class="sidebar-section">
      <h2>Domains <span class="count" id="domain-count"></span></h2>
      <div class="domain-tree" id="domain-tree">
        <div class="spinner"></div>
      </div>
    </div>
    <div class="sidebar-section">
      <h2>Type</h2>
      <div class="filter-group">
        <label><input type="checkbox" value="user_preference" checked> <span style="color:#58a6ff">user_preference</span></label>
        <label><input type="checkbox" value="task_pattern" checked> <span style="color:#3fb950">task_pattern</span></label>
        <label><input type="checkbox" value="codebase_fact" checked> <span style="color:#d29922">codebase_fact</span></label>
        <label><input type="checkbox" value="lesson_learned" checked> <span style="color:#f85149">lesson_learned</span></label>
        <label><input type="checkbox" value="session_summary" checked> <span style="color:#bc8cff">session_summary</span></label>
        <label><input type="checkbox" value="contextual_note" checked> <span style="color:#7d8590">contextual_note</span></label>
      </div>
    </div>
    <div class="sidebar-section">
      <h2>Category</h2>
      <div class="filter-group">
        <div class="category-pills" id="category-pills"></div>
      </div>
    </div>
    <div class="sidebar-section">
      <h2>Filters</h2>
      <div class="filter-group">
        <label>Scope
          <select id="scope" style="margin-top:2px">
            <option value="all">all</option>
            <option value="project">project</option>
            <option value="global">global</option>
          </select>
        </label>
      </div>
      <div class="filter-group">
        <label>Tags (comma-sep)</label>
        <input type="text" id="tags" placeholder="aws, testing" style="margin-top:2px">
      </div>
      <div class="filter-group">
        <label>Min weight: <span id="weight-val" style="color:var(--accent)">0.00</span></label>
        <input type="range" id="minWeight" min="0" max="1" step="0.01" value="0">
      </div>
      <div class="filter-group">
        <label>Created</label>
        <div class="row" style="margin-top:2px">
          <input type="date" id="createdAfter">
          <input type="date" id="createdBefore">
        </div>
      </div>
    </div>
  </aside>

  <main id="center">
    <div id="network"></div>
    <div id="list-view"><table><thead><tr>
      <th data-sort="type">Type</th>
      <th data-sort="domain">Domain</th>
      <th data-sort="category">Category</th>
      <th data-sort="weight">Weight</th>
      <th data-sort="content">Content</th>
      <th data-sort="tags">Tags</th>
    </tr></thead><tbody id="list-body"></tbody></table></div>
    <div id="empty-msg">No memories match the current filters.</div>
    <div class="graph-controls">
      <button id="btn-fit" title="Zoom to fit">&#128269;</button>
      <button id="btn-refresh" title="Refresh">&#8635;</button>
    </div>
  </main>

  <aside id="detail" class="sheet">
    <button class="sheet-close" id="sheet-close" title="Close">&#10005;</button>
    <div id="detail-content">
      <div class="placeholder">
        <div class="icon">&#128218;</div>
        Select a memory to inspect its details.
      </div>
    </div>
  </aside>
  <div class="bottom-tabs">
    <button class="tab active" data-tab="graph">Graph</button>
    <button class="tab" data-tab="list">List</button>
    <button class="tab" data-tab="detail">Detail</button>
  </div>
</div>
<div class="scrim" id="scrim"></div>
<footer id="legend">
  <span class="legend-item"><span class="dot" style="background:#58a6ff"></span> user_preference</span>
  <span class="legend-item"><span class="dot" style="background:#3fb950"></span> task_pattern</span>
  <span class="legend-item"><span class="dot" style="background:#d29922"></span> codebase_fact</span>
  <span class="legend-item"><span class="dot" style="background:#f85149"></span> lesson_learned</span>
  <span class="legend-item"><span class="dot" style="background:#bc8cff"></span> session_summary</span>
  <span class="legend-item"><span class="dot" style="background:#7d8590"></span> contextual_note</span>
  <span class="sep"></span>
  <span class="legend-item"><span class="line" style="background:#3fb950"></span> reinforces</span>
  <span class="legend-item"><span class="line" style="background:#f85149"></span> contradicts</span>
  <span class="legend-item"><span class="line" style="background:#58a6ff"></span> extends</span>
  <span class="legend-item"><span class="line" style="background:#d29922"></span> exception_to</span>
  <span class="legend-item"><span class="line" style="background:#bc8cff"></span> derived_from</span>
</footer>
<script src="/static/vis-network.min.js"></script>
<script>
// ===== Color maps =====
const TYPE_COLORS = {
  user_preference: '#58a6ff', task_pattern: '#3fb950', codebase_fact: '#d29922',
  lesson_learned: '#f85149', session_summary: '#bc8cff', contextual_note: '#7d8590'
};
const EDGE_COLORS = {
  reinforces: '#3fb950', contradicts: '#f85149', extends: '#58a6ff',
  exception_to: '#d29922', derived_from: '#bc8cff'
};
const DOMAIN_COLORS = {
  aws: '#ff9900', terraform: '#6c4ee5', opencode: '#ff6b35', testing: '#3fb950',
  vercel: '#6b7280', guacamole: '#8b5cf6', supabase: '#3ecf8e', docker: '#2496ed',
  ansible: '#ee0000', anymake: '#ffb800', python: '#3776ab', realhax: '#f85149',
  realvol: '#58a6ff', realcode: '#39c5cf', basecamp: '#f778ba',
  realmemory: '#d29922', uncategorized: '#7d8590'
};
const CATEGORY_COLORS = {
  gotcha: '#f85149', cost: '#ff9900', safety: '#d29922', integration: '#bc8cff',
  process: '#58a6ff', tooling: '#39c5cf', performance: '#3fb950'
};
function domainColor(d) { return DOMAIN_COLORS[d] || DOMAIN_COLORS.uncategorized; }
function categoryColor(c) { return CATEGORY_COLORS[c] || '#7d8590'; }

// ===== State =====
let network = null;
let allNodes = new vis.DataSet();
let allEdges = new vis.DataSet();
let currentView = 'graph';
let activeDomain = null;
let activeCategory = null;
let listSort = { col: 'weight', dir: 'desc' };

// ===== Query building =====
function buildQuery() {
  const params = new URLSearchParams();
  const q = document.getElementById('q').value.trim();
  if (q) params.set('q', q);
  const types = [];
  document.querySelectorAll('#sidebar input[type=checkbox]:checked').forEach(c => types.push(c.value));
  if (types.length < 6 && types.length > 0) params.set('type', types.join(','));
  else if (types.length === 0) params.set('type', '__none__');
  const scope = document.getElementById('scope').value;
  if (scope !== 'all') params.set('scope', scope);
  const tags = document.getElementById('tags').value.trim();
  if (tags) params.set('tags', tags);
  if (activeDomain) params.set('domain', activeDomain);
  if (activeCategory) params.set('category', activeCategory);
  const mw = document.getElementById('minWeight').value;
  if (parseFloat(mw) > 0) params.set('minWeight', mw);
  const ca = document.getElementById('createdAfter').value;
  if (ca) params.set('createdAfter', ca);
  const cb = document.getElementById('createdBefore').value;
  if (cb) params.set('createdBefore', cb);
  return params;
}

// ===== Fetch graph data =====
async function fetchGraph() {
  const params = buildQuery();
  const resp = await fetch('/api/graph?' + params.toString());
  const data = await resp.json();
  const nodes = (data.nodes || []).map(m => {
    const dc = domainColor(m.domain);
    const tc = TYPE_COLORS[m.type] || '#7d8590';
    const label = (m.content.slice(0, 35) + (m.content.length > 35 ? '...' : '')).replace(/\\n/g, ' ');
    return {
      id: m.id, label: label,
      title: m.content.slice(0, 200),
      color: { background: tc, border: dc, highlight: { background: tc, border: dc } },
      borderWidth: m.domain ? 3 : 1,
      size: 10 + m.weight * 25,
      font: { color: '#c9d1d9', size: 10, face: 'sans-serif' },
      shape: 'dot',
      _data: m
    };
  });
  const edges = (data.edges || []).map(e => ({
    id: e.id, from: e.source, to: e.target,
    color: { color: EDGE_COLORS[e.type] || '#7d8590', opacity: 0.6 },
    arrows: 'to', title: e.type, width: 2
  }));
  allNodes.clear(); allNodes.update(nodes);
  allEdges.clear(); allEdges.update(edges);
  document.getElementById('empty-msg').classList.toggle('show', nodes.length === 0);
  if (!network) {
    network = new vis.Network(document.getElementById('network'), { nodes: allNodes, edges: allEdges }, {
      layout: { improvedLayout: nodes.length <= 100, randomSeed: 42 },
      physics: {
        barnesHut: { gravitationalConstant: -3000, centralGravity: 0.3, springLength: 120, springConstant: 0.05, damping: 0.4 },
        stabilization: { iterations: 150 }
      },
      interaction: { hover: true, tooltipDelay: 200, navigationButtons: false, keyboard: false }
    });
    network.on('click', function(params) {
      if (params.nodes.length > 0) showDetail(params.nodes[0]);
      else showPlaceholder();
    });
    network.on('doubleClick', function(params) {
      if (params.nodes.length > 0) network.focus(params.nodes[0], { scale: 1.5, animation: { duration: 400 } });
    });
    network.once('stabilizationIterationsDone', function() { network.fit(); });
  } else {
    network.setData({ nodes: allNodes, edges: allEdges });
    network.once('stabilizationIterationsDone', function() { network.fit(); });
  }
  updateListBody(data.nodes || []);
}

// ===== List view =====
function updateListBody(nodes) {
  const tbody = document.getElementById('list-body');
  const sorted = sortNodes(nodes);
  tbody.innerHTML = sorted.map(m => {
    const tc = TYPE_COLORS[m.type] || '#7d8590';
    const dc = domainColor(m.domain);
    const wColor = m.weight > 0.5 ? '#3fb950' : m.weight > 0.25 ? '#d29922' : '#f85149';
    const tags = (m.tags || []).slice(0, 3).join(', ');
    return '<tr data-id="' + esc(m.id) + '">' +
      '<td><span class="type-dot" style="background:' + tc + '"></span>' + esc(m.type) + '</td>' +
      '<td style="color:' + dc + '">' + esc(m.domain || '—') + '</td>' +
      '<td>' + esc(m.category || '—') + '</td>' +
      '<td><span class="weight-bar"><span class="fill" style="width:' + Math.round(m.weight * 100) + '%;background:' + wColor + '"></span></span> ' + m.weight.toFixed(2) + '</td>' +
      '<td>' + esc(m.content.slice(0, 80)) + (m.content.length > 80 ? '...' : '') + '</td>' +
      '<td style="color:var(--text-dim)">' + esc(tags) + '</td>' +
      '</tr>';
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(t => t.classList.remove('selected'));
      tr.classList.add('selected');
      showDetail(tr.dataset.id);
    });
  });
}

function sortNodes(nodes) {
  const dir = listSort.dir === 'asc' ? 1 : -1;
  return [...nodes].sort((a, b) => {
    let av, bv;
    switch (listSort.col) {
      case 'type': av = a.type; bv = b.type; break;
      case 'domain': av = a.domain || ''; bv = b.domain || ''; break;
      case 'category': av = a.category || ''; bv = b.category || ''; break;
      case 'weight': av = a.weight; bv = b.weight; break;
      case 'content': av = a.content; bv = b.content; break;
      case 'tags': av = (a.tags || []).join(','); bv = (b.tags || []).join(','); break;
      default: av = a.weight; bv = b.weight;
    }
    if (typeof av === 'string') return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

// ===== Detail panel =====
async function showDetail(id) {
  const resp = await fetch('/api/memory/' + encodeURIComponent(id));
  const data = await resp.json();
  const m = data.memory;
  const tc = TYPE_COLORS[m.type] || '#7d8590';
  const dc = domainColor(m.domain);
  let html = '';

  // Header
  html += '<div class="detail-header">';
  html += '<span class="type-dot" style="background:' + tc + ';border:2px solid ' + dc + '"></span>';
  html += '<span class="type-label">' + esc(m.type) + '</span>';
  html += '<span class="scope-badge">' + esc(m.scope) + '</span>';
  html += '</div>';

  html += '<div class="detail-body">';

  // Content
  html += '<div class="field"><div class="k">Content</div><div class="content-box">' + esc(m.content) + '</div></div>';

  // Domain + Category badges
  html += '<div class="field"><div class="k">Classification</div><div class="badges">';
  if (m.domain) html += '<span class="badge domain" style="border-color:' + dc + ';color:' + dc + '">' + esc(m.domain) + '</span>';
  if (m.category) html += '<span class="badge category">' + esc(m.category) + '</span>';
  html += '</div></div>';

  // Tags
  if (m.tags && m.tags.length) {
    html += '<div class="field"><div class="k">Tags</div><div class="badges">';
    for (const t of m.tags) html += '<span class="badge tag">' + esc(t) + '</span>';
    html += '</div></div>';
  }

  // Stats grid
  const wColor = m.weight > 0.5 ? '#3fb950' : m.weight > 0.25 ? '#d29922' : '#f85149';
  html += '<div class="field"><div class="k">Weight / Confidence</div>';
  html += '<div class="stats-grid">';
  html += '<div class="stat-card"><div class="num">' + m.weight.toFixed(3) + '</div><div class="label">weight</div></div>';
  html += '<div class="stat-card"><div class="num">' + m.confidence.toFixed(2) + '</div><div class="label">confidence</div></div>';
  html += '</div>';
  html += '<div class="weight-bar"><span class="fill" style="width:' + Math.round(m.weight * 100) + '%;background:' + wColor + '"></span></div>';
  html += '</div>';

  // Access / reinforcement
  html += '<div class="field"><div class="k">Access / Reinforcement</div><div class="stats-grid">';
  html += '<div class="stat-card"><div class="num">' + m.accessCount + '</div><div class="label">accessed</div></div>';
  html += '<div class="stat-card"><div class="num">' + m.reinforcementCount + '</div><div class="label">reinforced</div></div>';
  html += '</div></div>';

  // Source
  if (m.source && (m.source.project || m.source.ref || m.source.session)) {
    html += '<div class="field"><div class="k">Source</div><div class="source-box">';
    if (m.source.project) html += '<div class="src-line">project: <span class="val">' + esc(m.source.project) + '</span></div>';
    if (m.source.session) html += '<div class="src-line">session: <span class="val">' + esc(m.source.session) + '</span></div>';
    if (m.source.ref) html += '<div class="src-line">' + esc(m.source.refType || 'ref') + ': <span class="val">' + esc(m.source.ref) + '</span></div>';
    html += '</div></div>';
  }

  // Timestamps
  html += '<div class="field"><div class="k">Timeline</div><div class="v">';
  html += 'Created: ' + esc(m.createdAt) + '<br>Updated: ' + esc(m.updatedAt);
  html += '</div></div>';

  // Structured metadata (if any)
  if (m.metadata && Object.keys(m.metadata).length > 0) {
    const md = m.metadata;
    const hasStructured = md.assumed || md.reality || md.lesson || md.learnedDate || md.learnedProject || md.location || md.evidence || md.outcomes;
    if (hasStructured) {
      html += '<div class="field"><div class="k">Structured Data</div>';
      if (md.assumed) html += '<div style="margin-bottom:6px"><div class="k" style="color:var(--yellow)">Assumed</div><div class="v">' + esc(md.assumed) + '</div></div>';
      if (md.reality) html += '<div style="margin-bottom:6px"><div class="k" style="color:var(--red)">Reality</div><div class="v">' + esc(md.reality) + '</div></div>';
      if (md.lesson) html += '<div style="margin-bottom:6px"><div class="k" style="color:var(--green)">Lesson</div><div class="v">' + esc(md.lesson) + '</div></div>';
      if (md.learnedDate) html += '<div style="margin-bottom:6px"><div class="k">Learned</div><div class="v">' + esc(md.learnedDate) + (md.learnedProject ? ' (' + esc(md.learnedProject) + ')' : '') + '</div></div>';
      if (md.reinforced && md.reinforced.length) {
        html += '<div style="margin-bottom:6px"><div class="k">Reinforcement History</div>';
        for (const r of md.reinforced) html += '<div class="v" style="font-size:11px;color:var(--text-dim)">' + esc(r.date) + ': ' + esc(r.context) + '</div>';
        html += '</div>';
      }
      if (md.location) html += '<div style="margin-bottom:6px"><div class="k">Location</div><div class="v">' + esc(md.location) + '</div></div>';
      if (md.evidence) html += '<div style="margin-bottom:6px"><div class="k">Evidence</div><div class="v">' + esc(md.evidence) + '</div></div>';
      if (md.outcomes && md.outcomes.length) {
        html += '<div style="margin-bottom:6px"><div class="k">Outcomes</div><ul style="padding-left:16px">';
        for (const o of md.outcomes) html += '<li>' + esc(o) + '</li>';
        html += '</ul></div>';
      }
      html += '</div>';
    }
    // Raw metadata fallback
    const extraKeys = Object.keys(md).filter(k => !['assumed','reality','lesson','learnedDate','learnedProject','reinforced','location','evidence','outcomes','duration','crossProjectReinforcements'].includes(k));
    if (extraKeys.length > 0 || (md.crossProjectReinforcements && Array.isArray(md.crossProjectReinforcements) && md.crossProjectReinforcements.length > 0)) {
      html += '<div class="field"><div class="k">Raw Metadata</div><div class="metadata-box">' + esc(JSON.stringify(md, null, 2)) + '</div></div>';
    }
  }

  // Relationships
  const rels = data.relationships || [];
  if (rels.length) {
    html += '<div class="field"><div class="k">Relationships (' + rels.length + ')</div><div class="rel-list">';
    for (const r of rels) {
      const dir = r.direction === 'outgoing' ? '\\u2192' : '\\u2190';
      const ec = EDGE_COLORS[r.type] || '#7d8590';
      const preview = r.memory.content.slice(0, 50);
      html += '<div class="rel-item">';
      html += '<span class="rel-type" style="background:' + ec + '22;color:' + ec + '">' + dir + ' ' + esc(r.type) + '</span>';
      html += '<span class="rel-preview">' + esc(preview) + '</span>';
      html += '<span class="rel-link" data-id="' + esc(r.memory.id) + '">view\\u00bb</span>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  html += '</div>';
  document.getElementById('detail').innerHTML = html;
  document.querySelectorAll('#detail .rel-link').forEach(el => {
    el.addEventListener('click', () => {
      showDetail(el.dataset.id);
      if (network) { network.focus(el.dataset.id, { scale: 1.5, animation: { duration: 400 } }); network.selectNodes([el.dataset.id]); }
    });
  });
}

function showPlaceholder() {
  document.getElementById('detail').innerHTML = '<div class="placeholder"><div class="icon">\\u{1F4D8}</div>Select a memory to inspect its details.</div>';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== Domain sidebar =====
async function fetchDomains() {
  try {
    const resp = await fetch('/api/domains');
    const data = await resp.json();
    const tree = document.getElementById('domain-tree');
    const domains = data.domains || [];
    document.getElementById('domain-count').textContent = domains.length + ' domains';

    let html = '<div class="domain-item' + (!activeDomain ? ' active' : '') + '" data-domain="">';
    html += '<span class="dot" style="background:' + DOMAIN_COLORS.uncategorized + '"></span>';
    html += '<span class="name">All domains</span>';
    html += '<span class="badge">' + data.total + '</span></div>';

    for (const d of domains) {
      const name = d.name === 'null' || !d.name ? 'uncategorized' : d.name;
      const dc = domainColor(name);
      const isActive = activeDomain === name || (activeDomain === 'uncategorized' && name === 'uncategorized');
      html += '<div class="domain-item' + (isActive ? ' active' : '') + (name === 'uncategorized' ? ' uncategorized' : '') + '" data-domain="' + esc(name) + '">';
      html += '<span class="dot" style="background:' + dc + '"></span>';
      html += '<span class="name">' + esc(name) + '</span>';
      html += '<span class="badge">' + d.count + '</span>';
      html += '</div>';
    }
    tree.innerHTML = html;

    tree.querySelectorAll('.domain-item').forEach(el => {
      el.addEventListener('click', () => {
        const d = el.dataset.domain;
        activeDomain = (d === '' || d === activeDomain) ? null : d;
        tree.querySelectorAll('.domain-item').forEach(e => e.classList.remove('active'));
        if (activeDomain) {
          tree.querySelector('[data-domain="' + activeDomain + '"]')?.classList.add('active');
        } else {
          tree.querySelector('[data-domain=""]').classList.add('active');
        }
        fetchGraph();
      });
    });

    // Category pills
    const allCats = new Set();
    for (const d of domains) {
      if (d.categories) Object.keys(d.categories).forEach(c => allCats.add(c));
    }
    const pills = document.getElementById('category-pills');
    pills.innerHTML = Array.from(allCats).sort().map(c => {
      const cc = categoryColor(c);
      const isActive = activeCategory === c;
      return '<span class="pill' + (isActive ? ' active' : '') + '" data-cat="' + esc(c) + '" style="' + (isActive ? '' : 'border-color:' + cc + '33;color:' + cc) + '">' + esc(c) + '</span>';
    }).join('');
    pills.querySelectorAll('.pill').forEach(el => {
      el.addEventListener('click', () => {
        const c = el.dataset.cat;
        activeCategory = (c === activeCategory) ? null : c;
        pills.querySelectorAll('.pill').forEach(e => e.classList.remove('active'));
        if (activeCategory) pills.querySelector('[data-cat="' + activeCategory + '"]')?.classList.add('active');
        fetchGraph();
      });
    });
  } catch(e) {
    console.error('Failed to fetch domains:', e);
  }
}

// ===== Stats bar =====
async function fetchStats() {
  try {
    const resp = await fetch('/api/stats');
    const s = await resp.json();
    document.getElementById('stat-memories').textContent = s.totalMemories || 0;
    document.getElementById('stat-edges').textContent = s.totalRelationships || 0;
    // Count domains from the domains endpoint
    const dr = await fetch('/api/domains');
    const dd = await dr.json();
    document.getElementById('stat-domains').textContent = (dd.domains || []).length;
  } catch(e) {}
}

// ===== Event handlers =====
function debounce(fn, ms) {
  let t; return function() { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

document.getElementById('q').addEventListener('input', debounce(fetchGraph, 300));
document.querySelectorAll('#sidebar input[type=checkbox]').forEach(c => c.addEventListener('change', fetchGraph));
document.getElementById('scope').addEventListener('change', fetchGraph);
document.getElementById('tags').addEventListener('input', debounce(fetchGraph, 300));
document.getElementById('minWeight').addEventListener('input', function() {
  document.getElementById('weight-val').textContent = parseFloat(this.value).toFixed(2);
  debounce(fetchGraph, 200)();
});
document.getElementById('createdAfter').addEventListener('change', fetchGraph);
document.getElementById('createdBefore').addEventListener('change', fetchGraph);
document.getElementById('btn-refresh').addEventListener('click', () => { fetchGraph(); fetchStats(); fetchDomains(); });
document.getElementById('btn-fit').addEventListener('click', () => { if (network) network.fit({ animation: { duration: 500 } }); });

// View toggle
document.getElementById('view-graph').addEventListener('click', () => {
  currentView = 'graph';
  document.getElementById('view-graph').classList.add('active');
  document.getElementById('view-list').classList.remove('active');
  document.getElementById('network').style.display = 'block';
  document.getElementById('list-view').classList.remove('show');
  if (network) network.redraw();
});
document.getElementById('view-list').addEventListener('click', () => {
  currentView = 'list';
  document.getElementById('view-list').classList.add('active');
  document.getElementById('view-graph').classList.remove('active');
  document.getElementById('network').style.display = 'none';
  document.getElementById('list-view').classList.add('show');
});

// List sort
document.querySelectorAll('#list-view th').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (listSort.col === col) listSort.dir = listSort.dir === 'asc' ? 'desc' : 'asc';
    else { listSort.col = col; listSort.dir = 'desc'; }
    updateListBody(allNodes.get().map(n => n._data).filter(Boolean));
  });
});

// ===== Init =====
fetchDomains();
fetchGraph();
fetchStats();
</script>
</body>
</html>
`;
