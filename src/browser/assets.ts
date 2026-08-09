/**
 * Embedded static assets for the realmemory graph browser UI. The HTML is a
 * single self-contained page (inlined CSS + vanilla JS) that loads the vendored
 * vis-network bundle from `/static/vis-network.min.js`. No external network
 * requests are made — everything is served by the localhost HTTP server.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>realmemory — graph browser</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-elev: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
    --gray: #7d8590;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; height: 100vh; overflow: hidden;
  }
  header {
    height: 44px; display: flex; align-items: center; gap: 12px;
    padding: 0 16px; border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); }
  header .count { color: var(--text-dim); font-size: 12px; }
  #app { display: grid; grid-template-columns: 260px 1fr 340px; height: calc(100vh - 44px - 32px); }
  aside#filters {
    border-right: 1px solid var(--border); padding: 12px; overflow-y: auto;
    background: var(--bg-elev);
  }
  aside#filters h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-dim); margin-bottom: 8px; }
  aside#filters .group { margin-bottom: 16px; }
  aside#filters label { display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer; font-size: 13px; }
  aside#filters input[type="checkbox"] { accent-color: var(--accent); }
  aside#filters input[type="text"], aside#filters input[type="date"], aside#filters select {
    width: 100%; padding: 5px 8px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 4px; color: var(--text); font-size: 13px;
  }
  aside#filters input[type="range"] { width: 100%; accent-color: var(--accent); }
  aside#filters .row { display: flex; gap: 6px; }
  aside#filters .row > * { flex: 1; }
  aside#filters button {
    width: 100%; padding: 7px; background: var(--accent); color: #fff; border: none;
    border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600;
  }
  aside#filters button:hover { filter: brightness(1.1); }
  main#network-wrap { position: relative; background: var(--bg); }
  #network { width: 100%; height: 100%; }
  #empty-msg {
    position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    color: var(--text-dim); font-size: 15px; pointer-events: none;
  }
  #empty-msg.show { display: flex; }
  aside#detail {
    border-left: 1px solid var(--border); padding: 12px; overflow-y: auto;
    background: var(--bg-elev);
  }
  aside#detail .placeholder { color: var(--text-dim); font-size: 13px; text-align: center; margin-top: 40px; }
  aside#detail h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-dim); margin-bottom: 6px; }
  aside#detail .field { margin-bottom: 10px; }
  aside#detail .field .k { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .3px; }
  aside#detail .field .v { font-size: 13px; word-break: break-word; }
  aside#detail .content-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap;
  }
  aside#detail .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  aside#detail .tag {
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 1px 8px; font-size: 11px; color: var(--text-dim); font-family: monospace;
  }
  aside#detail .rel-link { cursor: pointer; color: var(--accent); }
  aside#detail .rel-link:hover { text-decoration: underline; }
  aside#detail .rel-item { padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  aside#detail .meta { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; font-family: monospace; font-size: 11px; white-space: pre-wrap; color: var(--text-dim); }
  footer {
    height: 32px; display: flex; align-items: center; gap: 16px; padding: 0 16px;
    border-top: 1px solid var(--border); background: var(--bg-elev); font-size: 11px;
  }
  footer .legend-item { display: flex; align-items: center; gap: 4px; color: var(--text-dim); }
  footer .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  footer .line { width: 18px; height: 2px; display: inline-block; }
  footer .sep { width: 1px; height: 14px; background: var(--border); }
</style>
</head>
<body>
<header>
  <h1>realmemory graph browser</h1>
  <span class="count" id="node-count">0 nodes</span>
  <span class="count" id="stats-summary"></span>
</header>
<div id="app">
  <aside id="filters">
    <h2>Filters</h2>
    <div class="group">
      <input type="text" id="q" placeholder="Search content...">
    </div>
    <div class="group">
      <h2>Type</h2>
      <label><input type="checkbox" value="user_preference" checked> user_preference</label>
      <label><input type="checkbox" value="task_pattern" checked> task_pattern</label>
      <label><input type="checkbox" value="codebase_fact" checked> codebase_fact</label>
      <label><input type="checkbox" value="lesson_learned" checked> lesson_learned</label>
      <label><input type="checkbox" value="session_summary" checked> session_summary</label>
      <label><input type="checkbox" value="contextual_note" checked> contextual_note</label>
    </div>
    <div class="group">
      <h2>Scope</h2>
      <select id="scope">
        <option value="all">all</option>
        <option value="project">project</option>
        <option value="global">global</option>
      </select>
    </div>
    <div class="group">
      <h2>Tags (comma-sep)</h2>
      <input type="text" id="tags" placeholder="aws, testing">
    </div>
    <div class="group">
      <h2>Min weight: <span id="weight-val">0</span></h2>
      <input type="range" id="minWeight" min="0" max="1" step="0.01" value="0">
    </div>
    <div class="group">
      <h2>Created</h2>
      <div class="row">
        <input type="date" id="createdAfter">
        <input type="date" id="createdBefore">
      </div>
    </div>
    <button id="refresh">Refresh graph</button>
  </aside>
  <main id="network-wrap">
    <div id="network"></div>
    <div id="empty-msg">No memories match the current filters.</div>
  </main>
  <aside id="detail">
    <div class="placeholder">Click a node to inspect its details.</div>
  </aside>
</div>
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
const NODE_COLORS = {
  user_preference: '#58a6ff', task_pattern: '#3fb950', codebase_fact: '#d29922',
  lesson_learned: '#f85149', session_summary: '#bc8cff', contextual_note: '#7d8590'
};
const EDGE_COLORS = {
  reinforces: '#3fb950', contradicts: '#f85149', extends: '#58a6ff',
  exception_to: '#d29922', derived_from: '#bc8cff'
};
let network = null;
let allNodes = new vis.DataSet();
let allEdges = new vis.DataSet();

function buildQuery() {
  const params = new URLSearchParams();
  const q = document.getElementById('q').value.trim();
  if (q) params.set('q', q);
  const types = [];
  document.querySelectorAll('#filters input[type=checkbox]:checked').forEach(c => types.push(c.value));
  if (types.length < 6 && types.length > 0) params.set('type', types.join(','));
  else if (types.length === 0) { params.set('type', '__none__'); }
  const scope = document.getElementById('scope').value;
  if (scope !== 'all') params.set('scope', scope);
  const tags = document.getElementById('tags').value.trim();
  if (tags) params.set('tags', tags);
  const mw = document.getElementById('minWeight').value;
  if (parseFloat(mw) > 0) params.set('minWeight', mw);
  const ca = document.getElementById('createdAfter').value;
  if (ca) params.set('createdAfter', ca);
  const cb = document.getElementById('createdBefore').value;
  if (cb) params.set('createdBefore', cb);
  return params;
}

async function fetchGraph() {
  const params = buildQuery();
  const resp = await fetch('/api/graph?' + params.toString());
  const data = await resp.json();
  const nodes = (data.nodes || []).map(m => ({
    id: m.id, label: m.content.slice(0, 40) + (m.content.length > 40 ? '...' : ''),
    title: m.content, color: NODE_COLORS[m.type] || '#7d8590',
    size: 12 + m.weight * 30, font: { color: '#c9d1d9', size: 11 },
    _data: m
  }));
  const edges = (data.edges || []).map(e => ({
    id: e.id, from: e.source, to: e.target, color: { color: EDGE_COLORS[e.type] || '#7d8590' },
    arrows: 'to', title: e.type
  }));
  allNodes.clear(); allNodes.update(nodes);
  allEdges.clear(); allEdges.update(edges);
  document.getElementById('node-count').textContent = nodes.length + ' nodes';
  document.getElementById('empty-msg').classList.toggle('show', nodes.length === 0);
  if (!network) {
    network = new vis.Network(document.getElementById('network'), { nodes: allNodes, edges: allEdges },
      { layout: { improvedLayout: nodes.length <= 150 }, physics: { stabilization: { iterations: 120 } },
        interaction: { hover: true, tooltipDelay: 200 } });
    network.on('click', function(params) {
      if (params.nodes.length > 0) showDetail(params.nodes[0]);
      else showPlaceholder();
    });
  }
}

async function showDetail(id) {
  const resp = await fetch('/api/memory/' + encodeURIComponent(id));
  const data = await resp.json();
  const m = data.memory;
  let html = '<h2>Memory</h2>';
  html += '<div class="field"><div class="k">Content</div><div class="content-box">' + esc(m.content) + '</div></div>';
  html += '<div class="field"><div class="k">Type / Scope</div><div class="v">' + m.type + ' / ' + m.scope + '</div></div>';
  if (m.tags && m.tags.length) {
    html += '<div class="field"><div class="k">Tags</div><div class="tags">' + m.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div></div>';
  }
  html += '<div class="field"><div class="k">Weight / Confidence</div><div class="v">' + m.weight.toFixed(3) + ' / ' + m.confidence.toFixed(3) + '</div></div>';
  html += '<div class="field"><div class="k">Access / Reinforcement</div><div class="v">' + m.accessCount + ' / ' + m.reinforcementCount + '</div></div>';
  html += '<div class="field"><div class="k">Created</div><div class="v">' + m.createdAt + '</div></div>';
  html += '<div class="field"><div class="k">Updated</div><div class="v">' + m.updatedAt + '</div></div>';
  if (m.metadata && Object.keys(m.metadata).length) {
    html += '<div class="field"><div class="k">Metadata</div><div class="meta">' + esc(JSON.stringify(m.metadata, null, 2)) + '</div></div>';
  }
  const rels = data.relationships || [];
  if (rels.length) {
    html += '<h2 style="margin-top:12px">Relationships (' + rels.length + ')</h2>';
    for (const r of rels) {
      const dir = r.direction === 'outgoing' ? '→' : '←';
      const preview = r.memory.content.slice(0, 50);
      html += '<div class="rel-item"><span class="rel-link" data-id="' + r.memory.id + '">' + dir + ' ' + r.type + '</span> <span style="color:var(--text-dim)">' + esc(preview) + '</span></div>';
    }
  }
  document.getElementById('detail').innerHTML = html;
  document.querySelectorAll('#detail .rel-link').forEach(el => {
    el.addEventListener('click', () => { showDetail(el.dataset.id); network.focus(el.dataset.id, {scale: 1.2, animation:{duration:400}}); network.selectNodes([el.dataset.id]); });
  });
}

function showPlaceholder() {
  document.getElementById('detail').innerHTML = '<div class="placeholder">Click a node to inspect its details.</div>';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function fetchStats() {
  try {
    const resp = await fetch('/api/stats');
    const s = await resp.json();
    document.getElementById('stats-summary').textContent =
      s.totalMemories + ' memories, ' + s.totalRelationships + ' edges';
  } catch(e) {}
}

document.getElementById('refresh').addEventListener('click', () => { fetchGraph(); fetchStats(); });
document.getElementById('q').addEventListener('input', debounce(fetchGraph, 300));
document.querySelectorAll('#filters input[type=checkbox]').forEach(c => c.addEventListener('change', fetchGraph));
document.getElementById('scope').addEventListener('change', fetchGraph);
document.getElementById('tags').addEventListener('input', debounce(fetchGraph, 300));
document.getElementById('minWeight').addEventListener('input', function() {
  document.getElementById('weight-val').textContent = this.value;
  debounce(fetchGraph, 200)();
});
document.getElementById('createdAfter').addEventListener('change', fetchGraph);
document.getElementById('createdBefore').addEventListener('change', fetchGraph);

function debounce(fn, ms) {
  let t; return function() { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); };
}

fetchGraph();
fetchStats();
</script>
</body>
</html>
`;
