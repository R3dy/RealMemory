/**
 * Single source of truth for the realmemory package version.
 *
 * This module must import NOTHING — it is the version leaf. Every surface
 * that needs the version (public API export in src/index.ts, MCP serverInfo
 * in src/mcp-server.ts, the /version HTTP route in src/browser/server.ts)
 * imports from here, so the value cannot drift between surfaces.
 *
 * The drift-guard test (tests/version-single-source.test.ts) asserts this
 * value matches package.json.version and ui/package.json.version.
 */
export const VERSION = "0.20.0";
