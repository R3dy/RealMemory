# Graph browser (`--ui`)

realmemory ships a built-in localhost graph browser for inspecting the memory
graph. It is **opt-in, localhost-only, and read-only**.

## Start the browser

```bash
# Default port (9333):
npx realmemory-mcp --ui

# Custom port:
npx realmemory-mcp --ui=9400
# or:
npx realmemory-mcp --ui --port=9400
```

The console prints the URL:

```
[realmemory] UI server listening on http://127.0.0.1:9333
```

Open the URL in a browser to see the graph.

## What you see

- **Graph canvas** — memories as nodes (colored by type, sized by weight),
  relationships as directed arrows (colored by type).
- **Filter sidebar** — filter by type, scope, tags, min weight, date range,
  and free-text content search.
- **Detail panel** — click a node to inspect its content, metadata, and
  one-hop relationships. Click a neighbor to re-center.
- **Legend** — color key for types and relationship types.

## Notes

- `--ui` and the MCP stdio server are mutually exclusive per process. Run
  `realmemory-mcp` (no flag) for the stdio MCP server; run `realmemory-mcp --ui`
  in a separate terminal for the browser.
- The browser reads from the same SQLite database
  (`~/.opencode/realmemory/data.db`). It can run alongside the MCP server
  (SQLite WAL mode allows concurrent reads).
- No new runtime dependency — vis-network is vendored as a static browser
  asset, never a Node.js import.
